import { describe, expect, test } from 'bun:test';
import { aad, payerCommit } from '@mochi/protocol';
import { SchemaId, VerdictStatus, canonicalJson } from '@mochi/core';
import { buildPayload, normalizeAnswer, normalizeParams, resolveSchema } from '@mochi/schemas';
import { MockTeeProvider, MockQuoteVerifier, seal } from '@mochi/tee';
import { x25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { fromHex, keccak256, toHex, type Address, type Hex } from 'viem';
import { MochiClient } from '../src/client.ts';
import { askClaimReview, interpretClaimReviewVerdict, prepareClaimReview, waitForClaimReview } from '../src/claims.ts';
import { fakeChain, fakeIntakeReply, honestOpenData, honestQuery, honestQueryId } from './fake-intake.ts';

const measurement = `0x${'11'.repeat(32)}` as Hex;
const root = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const intake = new MockTeeProvider({ seed: `0x${'33'.repeat(32)}`, measurement, mockRoot: root });
const sender = '0x0000000000000000000000000000000000000001' as Address;
const input = { claim: 'The board approved the transaction.', evidence: [{ id: 'minute-1', title: 'Meeting minutes', url: 'https://issuer.example/minutes', excerpt: 'The board approved the transaction at its meeting.' }], sender };

function fixture(handler?: (url: string, init?: RequestInit) => unknown | Promise<unknown>, chain = fakeChain({ activeIntakes: [intake.signer().address] })) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    let data: unknown;
    if (url.endsWith('/v1/intake/attestation')) data = { role: 'INTAKE', address: intake.signer().address.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: await intake.quote() };
    else if (url.includes('/v1/intake/')) data = await fakeIntakeReply(intake, String(init?.body));
    else data = await handler?.(url, init) ?? {};
    return Response.json(data);
  }) as typeof fetch;
  const client = new MochiClient({ gatewayUrl: 'https://gateway.test', fetch: fetcher, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement, chain: { deployment: chain.deployment, publicClient: chain.publicClient } });
  return { client, requests, chain };
}

describe('claim review SDK adapter', () => {
  test('prepares a private, unsubmitted FREEFORM_FACT query with exact source text and SUBMITTED provenance', async () => {
    const { client, requests } = fixture(async (url, init) => url.endsWith('/v1/query') ? honestQuery(init) : {});
    const review = await prepareClaimReview(client, input);
    expect(review).toMatchObject({ kind: 'mochi-claim-review', execution: 'prepared_unsubmitted', sourceProvenance: 'SUBMITTED', sourcesFetchedOrVerified: false });
    expect(review.prepared.queryId).toBe(honestQueryId(String(requests.find((request) => request.url.endsWith('/v1/query'))?.init?.body)));
    expect(requests.some((request) => request.url.includes('/v1/relay/'))).toBe(false);
    expect(requests.filter((request) => request.url.endsWith('/v1/query'))).toHaveLength(1);
    const qBody = JSON.parse(String(requests.find((request) => request.url.endsWith('/v1/query'))?.init?.body));
    expect(qBody).toMatchObject({ n: 3, pay: { path: 'usdg' } });
    expect(review.prepared.tx.data).toBe(honestOpenData(String(requests.find((request) => request.url.endsWith('/v1/query'))?.init?.body)));
    expect(qBody.payerResultPubKey).toBeDefined();
    // Private, no panel consent, result key bound: all signed into the grant from the sealed binding.
    expect(qBody.intake.provenance).toMatchObject({ opener: sender, isPublic: false, allowPanelDisclosure: false, payerCommit: payerCommit(qBody.payerResultPubKey) });
    const envelope = JSON.parse(String(requests.find((request) => request.url.includes('/v1/intake/upload'))?.init?.body)).envelope;
    const plain = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
    expect(plain.open).toMatchObject({ opener: sender, isPublic: false, allowPanelDisclosure: false, payerCommit: payerCommit(qBody.payerResultPubKey) });
    expect(plain.schemaId).toBe(SchemaId.FREEFORM_FACT);
    expect(plain.params.answer_type).toBe('STRING');
    expect(plain.params.question).toContain('supported, contradicted, missing_context, insufficient_evidence');
    expect(plain.params.question).toContain('Do not imply that sources were fetched');
    const document = new TextDecoder().decode(Uint8Array.from(atob(plain.docB64), (char) => char.charCodeAt(0)));
    expect(document).toContain(input.claim);
    expect(document).toContain(input.evidence[0]!.excerpt);
    expect(document).toContain('FIELD source-1-excerpt UTF8_BYTES=');
    expect(document).toContain(input.evidence[0]!.url);
    expect(plain.salt).not.toBe(`0x${'00'.repeat(32)}`);
    expect(JSON.stringify(requests.map((request) => request.init?.body))).not.toContain(input.claim);
    const answerSchema = resolveSchema(SchemaId.FREEFORM_FACT, plain.params);
    const normalized = normalizeAnswer(answerSchema, { fields: { answer: 'supported' }, evidence: { answer: input.evidence[0]!.excerpt } }, document);
    expect(normalized.spans).toHaveLength(1);
    const span = normalized.spans[0]!;
    expect(document.slice(span.start, span.end)).toBe(input.evidence[0]!.excerpt);
  });

  test('rejects malformed or oversized claims and evidence before any network request', async () => {
    const { client, requests } = fixture();
    await expect(prepareClaimReview(client, { ...input, claim: '  ' })).rejects.toThrow('non-empty');
    await expect(prepareClaimReview(client, { ...input, claim: 'x'.repeat(4001) })).rejects.toThrow('claim exceeds');
    await expect(prepareClaimReview(client, { ...input, evidence: [] })).rejects.toThrow('between 1 and 5');
    await expect(prepareClaimReview(client, { ...input, evidence: [{ ...input.evidence[0]!, excerpt: 'x'.repeat(18_001) }] })).rejects.toThrow('exceeds 18000');
    await expect(prepareClaimReview(client, { ...input, evidence: [{ ...input.evidence[0]!, url: 'http://issuer.example/doc' }] })).rejects.toThrow('HTTPS');
    await expect(prepareClaimReview(client, { ...input, evidence: [{ ...input.evidence[0]!, id: 'bad id' }] })).rejects.toThrow('source IDs');
    expect(requests).toHaveLength(0);
  });

  test('explicit ask delegates submission and decrypts the private verdict only against the chain', async () => {
    const txHash = `0x${'88'.repeat(32)}` as Hex;
    let privateCiphertext: Hex | undefined;
    let queryId = '';
    const { client, requests, chain } = fixture(async (url, init) => {
      if (url.endsWith('/v1/query')) { const reply = honestQuery(init); queryId = reply.queryId; return reply; }
      // The gateway's own id, status, hashes and agreement are never used: all of them come from the chain.
      if (url.endsWith('/v1/queries/' + queryId)) return { latestVerdictId: `0x${'98'.repeat(32)}`, query: { status: 3 } };
      if (url.endsWith('/v1/verdict/' + `0x${'99'.repeat(32)}`)) return { verdictId: `0x${'99'.repeat(32)}`, ciphertext: privateCiphertext, chain: { status: VerdictStatus.HUNG, schemaId: SchemaId.INVOICE, answerHash: `0x${'01'.repeat(32)}`, payloadHash: `0x${'02'.repeat(32)}`, agreementBps: 10_000 } };
      return {};
    });
    let sent = 0;
    const wallet = { account: root, chain: null, sendTransaction: async () => { sent++; return txHash; } } as never;
    const ask = await askClaimReview(client, input, wallet);
    expect(sent).toBe(1);
    const verdictId = `0x${'99'.repeat(32)}` as Hex;
    const answerJson = canonicalJson({ salt: ask.secrets.salt, schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, fields: { answer: { t: 'str', v: 'supported' } } });
    const params = { question: 'Q', answer_type: 'STRING' };
    const normalized = normalizeParams(resolveSchema(SchemaId.FREEFORM_FACT, params), params);
    if (!normalized.ok) throw new Error('params');
    const built = buildPayload(resolveSchema(SchemaId.FREEFORM_FACT, params), { answer: { t: 'str', v: 'supported' } }, normalized.params, { openedAt: 1n, privateSalt: ask.secrets.salt });
    chain.verdicts.set(verdictId, { queryId: ask.queryId, isPublic: false, answerHash: keccak256(toHex(answerJson)), payloadHash: built.payloadHash, status: VerdictStatus.VERDICT, schemaId: SchemaId.FREEFORM_FACT, agreementBps: 6_666, dissentMask: 4, timeoutMask: 0 });
    chain.latest.set(ask.queryId, verdictId);
    chain.queryStatus.set(ask.queryId, 3);
    const privatePlain = { v: 1, verdictId, salt: ask.secrets.salt, answerJson, payload: built.payload, fields: [] };
    const resultPublicKey = x25519.getPublicKey(fromHex(ask.secrets.resultPrivateKey!, 'bytes'));
    const encrypted = seal(toHex(resultPublicKey), new TextEncoder().encode(canonicalJson(privatePlain)), aad.result(verdictId));
    privateCiphertext = toHex(new TextEncoder().encode(JSON.stringify(encrypted)));
    const result = await waitForClaimReview(client, ask.queryId, ask.secrets, { pollMs: 1, timeoutMs: 100 });
    expect(result).toEqual({ execution: 'chain_derived', status: 'VERDICT', answer: 'supported', agreementBps: 6_666, dissentMask: 4, timeoutMask: 0, verdictId });
    expect(requests.some((request) => request.url.startsWith('https://gateway.test/v1/verdict/'))).toBe(true);
    expect(requests.some((request) => request.url.includes('/v1/queries/'))).toBe(false);
    // HUNG on chain: reported as HUNG with the chain's agreement, nothing decrypted.
    chain.verdicts.set(verdictId, { ...chain.verdicts.get(verdictId)!, status: VerdictStatus.HUNG, agreementBps: 3_333, dissentMask: 6 });
    expect(await waitForClaimReview(client, ask.queryId, ask.secrets, { pollMs: 1, timeoutMs: 100 })).toEqual({ execution: 'chain_derived', status: 'HUNG', agreementBps: 3_333, dissentMask: 6, timeoutMask: 0, verdictId });
    // A verdict recorded on chain for another query is refused, whatever the gateway says.
    chain.verdicts.set(verdictId, { ...chain.verdicts.get(verdictId)!, status: VerdictStatus.VERDICT, queryId: `0x${'ac'.repeat(32)}` });
    await expect(waitForClaimReview(client, ask.queryId, ask.secrets, { pollMs: 1, timeoutMs: 100 })).rejects.toThrow('another query');
    await expect(waitForClaimReview(client, ask.queryId, ask.secrets.resultPrivateKey as never)).rejects.toThrow('query secrets');
  });

  test('preserves HUNG disagreement and refuses to interpret an unsubmitted preview or invalid enum as a verdict', () => {
    expect(interpretClaimReviewVerdict({ answer: 'supported' })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
    expect(interpretClaimReviewVerdict({ verdictId: `0x${'aa'.repeat(32)}`, chain: { status: VerdictStatus.HUNG, schemaId: SchemaId.FREEFORM_FACT, agreementBps: 6_666, dissentMask: 1, timeoutMask: 2 } })).toMatchObject({ execution: 'gateway_reported', status: 'HUNG', agreementBps: 6_666, dissentMask: 1, timeoutMask: 2 });
    expect(interpretClaimReviewVerdict({ chain: { status: VerdictStatus.HUNG, schemaId: SchemaId.INVOICE } })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
    expect(interpretClaimReviewVerdict({ chain: { status: VerdictStatus.VERDICT, schemaId: SchemaId.FREEFORM_FACT }, decodedPayload: { body: { answerType: 2, stringAnswer: 'maybe' } } })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
  });
});
