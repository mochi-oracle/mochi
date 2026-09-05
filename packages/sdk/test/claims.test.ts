import { describe, expect, test } from 'bun:test';
import { aad, type IntakeResult } from '@mochi/protocol';
import { SchemaId, VerdictStatus, canonicalJson } from '@mochi/core';
import { normalizeAnswer, resolveSchema } from '@mochi/schemas';
import { MockTeeProvider, MockQuoteVerifier, seal } from '@mochi/tee';
import { x25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { fromHex, keccak256, toHex, type Address, type Hex } from 'viem';
import type { Deployment } from '@mochi/chain';
import { MochiClient } from '../src/client.ts';
import { askClaimReview, interpretClaimReviewVerdict, prepareClaimReview, waitForClaimReview } from '../src/claims.ts';

const measurement = `0x${'11'.repeat(32)}` as Hex;
const root = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const intake = new MockTeeProvider({ seed: `0x${'33'.repeat(32)}`, measurement, mockRoot: root });
const intakeResult: IntakeResult = {
  provenance: { docCommit: `0x${'44'.repeat(32)}`, kind: 0, originId: `0x${'00'.repeat(32)}`, fetchedAt: '1', tokensK: 1, transcriptHash: `0x${'55'.repeat(32)}` },
  intakeSig: '0x', intake: intake.signer().address.toLowerCase() as Hex,
  docCommit: `0x${'44'.repeat(32)}`, paramsHash: `0x${'66'.repeat(32)}`, schemaId: SchemaId.FREEFORM_FACT, tokensK: 1,
};
const sender = '0x0000000000000000000000000000000000000001' as Address;
const input = { claim: 'The board approved the transaction.', evidence: [{ id: 'minute-1', title: 'Meeting minutes', url: 'https://issuer.example/minutes', excerpt: 'The board approved the transaction at its meeting.' }], sender };

function fixture(handler?: (url: string, init?: RequestInit) => unknown | Promise<unknown>, chain?: { deployment: Deployment; publicClient?: unknown }) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    let data: unknown;
    if (url.endsWith('/v1/intake/attestation')) data = { role: 'INTAKE', address: intake.signer().address.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: await intake.quote() };
    else if (url.includes('/v1/intake/')) data = intakeResult;
    else data = await handler?.(url, init) ?? {};
    return Response.json(data);
  }) as typeof fetch;
  const client = new MochiClient({ gatewayUrl: 'https://gateway.test', fetch: fetcher, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement, ...(chain ? { chain: chain as never } : {}) });
  return { client, requests };
}

describe('claim review SDK adapter', () => {
  test('prepares a private, unsubmitted FREEFORM_FACT query with exact source text and SUBMITTED provenance', async () => {
    const { client, requests } = fixture(async (url) => url.endsWith('/v1/query') ? { queryId: `0x${'77'.repeat(32)}`, to: sender, data: '0x1234', quote: { jurorFees: '10', protocolFee: '2' } } : {});
    const review = await prepareClaimReview(client, input);
    expect(review).toMatchObject({ kind: 'mochi-claim-review', execution: 'prepared_unsubmitted', sourceProvenance: 'SUBMITTED', sourcesFetchedOrVerified: false });
    expect(review.prepared.queryId).toBe(`0x${'77'.repeat(32)}`);
    expect(review.prepared.tx.data).toBe('0x1234');
    expect(requests.some((request) => request.url.includes('/v1/relay/'))).toBe(false);
    expect(requests.filter((request) => request.url.endsWith('/v1/query'))).toHaveLength(1);
    const qBody = JSON.parse(String(requests.find((request) => request.url.endsWith('/v1/query'))?.init?.body));
    expect(qBody).toMatchObject({ n: 3, isPublic: false, allowPanelDisclosure: false, pay: { path: 'usdg' } });
    expect(qBody.payerResultPubKey).toBeDefined();
    const envelope = JSON.parse(String(requests.find((request) => request.url.includes('/v1/intake/upload'))?.init?.body)).envelope;
    const plain = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
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

  test('explicit ask delegates submission and decrypts the gateway-reported private verdict', async () => {
    const txHash = `0x${'88'.repeat(32)}` as Hex;
    const publicClient = { waitForTransactionReceipt: async () => ({ status: 'success' }) };
    const chain = { deployment: { contracts: { verdicts: sender, receiptAnchor: sender } }, publicClient } as never;
    let privateCiphertext: Hex | undefined;
    let privateAnswerHash = '';
    const { client, requests } = fixture(async (url) => {
      if (url.endsWith('/v1/query')) return { queryId: `0x${'77'.repeat(32)}`, to: sender, data: '0x1234', quote: {} };
      if (url.endsWith('/v1/queries/' + `0x${'77'.repeat(32)}`)) return { latestVerdictId: `0x${'99'.repeat(32)}`, query: { status: 3 } };
      if (url.endsWith('/v1/verdict/' + `0x${'99'.repeat(32)}`)) return { verdictId: `0x${'99'.repeat(32)}`, ciphertext: privateCiphertext, chain: { status: VerdictStatus.VERDICT, schemaId: SchemaId.FREEFORM_FACT, answerHash: privateAnswerHash, agreementBps: 10_000 } };
      return {};
    }, chain);
    let sent = 0;
    const wallet = { account: root, chain: null, sendTransaction: async () => { sent++; return txHash; } } as never;
    const ask = await askClaimReview(client, input, wallet);
    expect(sent).toBe(1);
    const verdictId = `0x${'99'.repeat(32)}` as Hex;
    const answerJson = canonicalJson({ salt: ask.secrets.salt, schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, fields: { answer: { t: 'str', v: 'supported' } } });
    privateAnswerHash = keccak256(toHex(answerJson));
    const privatePlain = { v: 1, verdictId, salt: ask.secrets.salt, answerJson, payload: '0x', fields: [] };
    const resultPublicKey = x25519.getPublicKey(fromHex(ask.secrets.resultPrivateKey!, 'bytes'));
    const encrypted = seal(toHex(resultPublicKey), new TextEncoder().encode(canonicalJson(privatePlain)), aad.result(verdictId));
    privateCiphertext = toHex(new TextEncoder().encode(JSON.stringify(encrypted)));
    const result = await waitForClaimReview(client, ask.queryId, ask.secrets.resultPrivateKey!, { pollMs: 1, timeoutMs: 100 });
    expect(result).toMatchObject({ execution: 'gateway_reported', status: 'VERDICT', answer: 'supported', agreementBps: 10_000 });
    expect(requests.some((request) => request.url.startsWith('https://gateway.test/v1/verdict/'))).toBe(true);
  });

  test('preserves HUNG disagreement and refuses to interpret an unsubmitted preview or invalid enum as a verdict', () => {
    expect(interpretClaimReviewVerdict({ answer: 'supported' })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
    expect(interpretClaimReviewVerdict({ verdictId: `0x${'aa'.repeat(32)}`, chain: { status: VerdictStatus.HUNG, schemaId: SchemaId.FREEFORM_FACT, agreementBps: 6_666, dissentMask: 1, timeoutMask: 2 } })).toMatchObject({ execution: 'gateway_reported', status: 'HUNG', agreementBps: 6_666, dissentMask: 1, timeoutMask: 2 });
    expect(interpretClaimReviewVerdict({ chain: { status: VerdictStatus.HUNG, schemaId: SchemaId.INVOICE } })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
    expect(interpretClaimReviewVerdict({ chain: { status: VerdictStatus.VERDICT, schemaId: SchemaId.FREEFORM_FACT }, decodedPayload: { body: { answerType: 2, stringAnswer: 'maybe' } } })).toEqual({ execution: 'unresolved', status: 'unknown_or_pending' });
  });
});
