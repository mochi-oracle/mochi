import { expect, test } from 'bun:test';
import { MockTeeProvider, MockQuoteVerifier, signProvenance } from '@mochi/tee';
import { privateKeyToAccount } from 'viem/accounts';
import { docCommit, docHash } from '@mochi/core';
import { aad } from '@mochi/protocol';
import { SchemaId } from '@mochi/core';
import { zeroHash } from 'viem';
import { normalizeParams, paramsHash, resolveSchema } from '@mochi/schemas';
import { createProtocolClient, loadProtocolConfig, parseClaimRecovery, payForClaimReview, preparePaidClaimReview, waitForPaidClaimReview } from '../site/src/claim-protocol-client.js';

const h = c => `0x${c.repeat(64)}`;
const a = c => `0x${c.repeat(40)}`;
const root = privateKeyToAccount(h('1'));
const tee = new MockTeeProvider({ seed: h('2'), measurement: h('3'), mockRoot: root });
const config = { enabled: true, chainId: 31337, contracts: { queryEscrow: a('1'), jurorRegistry: a('2'), verdicts: a('3'), usdg: a('4'), receiptAnchor: a('5') }, intakeAddress: tee.signer().address.toLowerCase(), intakeMeasurement: h('3'), jurySizes: [3], rpcUrl: '/rpc' };
const evidence = [{ title: 'Meeting minutes', url: 'https://issuer.example/minutes', text: 'The board approved the transaction at its meeting.' }];

test('disabled deployment config prevents creating a payment client', async () => {
  const state = await loadProtocolConfig(async () => Response.json({ enabled: false }));
  expect(state.enabled).toBe(false);
  expect(state.reason).toContain('pending');
  expect(() => createProtocolClient(state)).toThrow('not enabled');
});

test('prepares a private FREEFORM_FACT quote through verified LiveClient intake', async () => {
  let plain;
  const urls = [];
  const requests = [];
  const publicClient = { getChainId: async () => 31337, readContract: async ({ functionName }) => {
    if (functionName === 'paused') return false;
    if (functionName === 'isActive') return true;
    if (functionName === 'computeQueryId') return h('8');
    if (functionName === 'quote') return [20_000n, 1_000n];
    if (functionName === 'decimals') return 6;
    throw new Error(`unexpected read ${functionName}`);
  } };
  const client = createProtocolClient(config, { publicClient, verifier: new MockQuoteVerifier({ mockRootAddress: root.address }), fetcher: async (path, init) => {
    urls.push(String(path));
    requests.push({ path: String(path), body: init?.body });
    if (String(path).endsWith('/attestation')) return Response.json({ role: 'INTAKE', address: config.intakeAddress, encryptionPubKey: tee.encryptionPublicKey(), measurement: h('3'), quote: await tee.quote() });
    if (String(path).includes('/upload')) {
      const envelope = JSON.parse(init.body).envelope;
      plain = JSON.parse(new TextDecoder().decode(tee.decryptEnvelope(envelope, aad.intake())));
      const bytes = Uint8Array.from(atob(plain.docB64), c => c.charCodeAt(0));
      const commit = docCommit(plain.salt, docHash(bytes));
      const provenance = { docCommit: commit, kind: 0, originId: zeroHash, fetchedAt: BigInt(Math.floor(Date.now() / 1000)), tokensK: 1, transcriptHash: zeroHash };
      const normalized = normalizeParams(resolveSchema(SchemaId.FREEFORM_FACT, plain.params), plain.params);
      const intake = { provenance: { ...provenance, fetchedAt: String(provenance.fetchedAt) }, docCommit: commit, paramsHash: paramsHash(normalized.params), intake: config.intakeAddress, intakeSig: await signProvenance(tee.signer(), 31337, config.contracts.queryEscrow, provenance), schemaId: SchemaId.FREEFORM_FACT, tokensK: 1 };
      return Response.json(intake);
    }
    if (String(path).endsWith('/v1/query')) return Response.json({ queryId: h('8'), to: a('9'), data: '0xdeadbeef' });
    throw new Error(`unexpected request ${path}`);
  } });
  client.account = a('6');
  client.provider = { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : [a('6')] };
  const prepared = await preparePaidClaimReview(client, { claim: 'The board approved the transaction.', evidence });
  expect(prepared).toMatchObject({ execution: 'prepared_unsubmitted', provenance: 'SUBMITTED', sourcesFetched: false });
  expect(prepared.prepared).toMatchObject({ n: 3, isPublic: false, schema: 'FREEFORM_FACT', displayAmount: '0.021' });
  expect(prepared.prepared.secrets.resultPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
  expect(plain.params.answer_type).toBe('STRING');
  expect(plain.params.question).toContain('supported, contradicted, missing_context, insufficient_evidence');
  expect(JSON.stringify(requests)).not.toContain('The board approved the transaction.');
  expect(JSON.stringify(requests)).not.toContain('issuer.example');
  expect(urls).toContain('/api/v1/query');
});

test('rejects an unavailable three-juror deployment and malformed evidence before intake', async () => {
  const client = createProtocolClient({ ...config, jurySizes: [5] }, { publicClient: { getChainId: async () => 31337 } });
  client.account = a('6');
  await expect(preparePaidClaimReview(client, { claim: 'A sufficiently clear claim.', evidence })).rejects.toThrow('does not support a three-juror');
  await expect(preparePaidClaimReview(client, { claim: 'A sufficiently clear claim.', evidence: [{ ...evidence[0], url: 'http://issuer.example' }] })).rejects.toThrow('HTTPS');
});

test('a quote is one-shot even when the submit attempt fails', async () => {
  let attempts = 0;
  const prepared = { prepared: { queryId: h('8') } };
  const client = { submit: async () => { attempts++; throw new Error('wallet transport stopped'); } };
  await expect(payForClaimReview(client, prepared)).rejects.toThrow('wallet transport stopped');
  expect(() => payForClaimReview(client, prepared)).toThrow('already been submitted or attempted');
  expect(attempts).toBe(1);
});

function waitFixture({ queryStatus = 3, querySchema = SchemaId.FREEFORM_FACT, verdictStatus = 1, verdictSchema = SchemaId.FREEFORM_FACT, answerType = 'str', answer = 'supported' } = {}) {
  let requestSignal;
  const client = {
    read: async (_contract, _abi, method) => method === 'getQuery' ? { status: queryStatus, schemaId: querySchema } : h('a'),
    fetcher: async (_url, init) => { requestSignal = init.signal; return Response.json({ ciphertext: 'encrypted packet' }); },
    verifyResult: async () => ({ verified: true, chain: { status: verdictStatus, schemaId: verdictSchema }, answer: { fields: { answer: { t: answerType, v: answer } } } }),
  };
  const claim = { prepared: { queryId: h('8'), secrets: { salt: h('1'), resultPrivateKey: h('2') } } };
  return { client, claim, requestSignal: () => requestSignal };
}

test('resume wait returns only a FREEFORM_FACT VERDICT with a string enum answer and combines caller cancellation', async () => {
  const { client, claim, requestSignal } = waitFixture();
  const controller = new AbortController();
  const result = await waitForPaidClaimReview(client, claim, { signal: controller.signal, timeoutMs: 100 });
  expect(result).toMatchObject({ status: 'VERDICT', answer: 'supported', verified: true });
  expect(requestSignal()).not.toBe(controller.signal);
  controller.abort();
  expect(requestSignal().aborted).toBe(true);
});

test('resume wait preserves HUNG and rejects wrong schema, verdict status, typed answer, or enum', async () => {
  const hung = waitFixture({ queryStatus: 4 });
  expect(await waitForPaidClaimReview(hung.client, hung.claim, { timeoutMs: 50 })).toMatchObject({ status: 'HUNG' });
  for (const options of [
    { querySchema: SchemaId.INVOICE },
    { verdictSchema: SchemaId.INVOICE },
    { verdictStatus: 0 },
    { answerType: 'bool', answer: true },
    { answer: 'not-an-enum' },
  ]) {
    const { client, claim } = waitFixture(options);
    expect(await waitForPaidClaimReview(client, claim, { timeoutMs: 100 })).toMatchObject({ status: 'unresolved' });
  }
});

test('an unresolved timed wait can be resumed without invoking payment again and recovery files are deployment-bound', async () => {
  const { client, claim } = waitFixture({ queryStatus: 1 });
  expect(await waitForPaidClaimReview(client, claim, { timeoutMs: 0 })).toMatchObject({ status: 'unresolved' });
  client.read = async (_contract, _abi, method) => method === 'getQuery' ? { status: 3, schemaId: SchemaId.FREEFORM_FACT } : h('a');
  expect(await waitForPaidClaimReview(client, claim, { timeoutMs: 100 })).toMatchObject({ status: 'VERDICT', answer: 'supported' });
  const recovery = parseClaimRecovery({ kind: 'MOCHI_QUERY_RECOVERY', chainId: 31337, escrow: config.contracts.queryEscrow, queryId: h('8'), secrets: { salt: h('1'), resultPrivateKey: h('2') } }, config);
  expect(recovery.execution).toBe('submitted_recovery');
  expect(() => parseClaimRecovery({ ...recovery.prepared, kind: 'MOCHI_QUERY_RECOVERY', chainId: 1 }, config)).toThrow('does not match');
});
