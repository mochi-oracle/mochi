import { expect, test } from 'bun:test';
import { MockTeeProvider, MockQuoteVerifier, signProvenance } from '@mochi/tee';
import { privateKeyToAccount } from 'viem/accounts';
import { docCommit, docHash } from '@mochi/core';
import { aad, provenanceFromJson } from '@mochi/protocol';
import { QueryStatus, SchemaId } from '@mochi/core';
import { zeroHash } from 'viem';
import { normalizeParams, paramsHash, resolveSchema } from '@mochi/schemas';
import { PaymentNotSentError, createProtocolClient, loadProtocolConfig, parseClaimRecovery, payForClaimReview, preparePaidClaimReview, waitForPaidClaimReview } from '../site/src/claim-protocol-client.js';
import { PAYMENT_STAGE, paymentNotSent, slowDownMessage } from '../site/src/live-client.js';

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
      const normalized = normalizeParams(resolveSchema(SchemaId.FREEFORM_FACT, plain.params), plain.params);
      // The intake signs the sealed open binding (wallet, result-key commitment, consent, nonce) into the grant.
      const provenance = {
        docCommit: commit, kind: 0, originId: zeroHash, fetchedAt: String(Math.floor(Date.now() / 1000)), tokensK: 1, transcriptHash: zeroHash,
        schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, paramsHash: paramsHash(normalized.params), expiry: String(Math.floor(Date.now() / 1000) + 900), ...plain.open,
      };
      const intake = { provenance, docCommit: commit, paramsHash: paramsHash(normalized.params), intake: config.intakeAddress, intakeSig: await signProvenance(tee.signer(), 31337, config.contracts.queryEscrow, provenanceFromJson(provenance)), schemaId: SchemaId.FREEFORM_FACT, tokensK: 1 };
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
  expect(plain.open).toMatchObject({ opener: a('6'), isPublic: false, allowPanelDisclosure: false });
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

test('an expired query returns a distinct terminal EXPIRED result instead of an unresolved wait', async () => {
  expect(QueryStatus.EXPIRED).toBe(6); // mirrors MochiTypes.QueryStatus.EXPIRED in the contracts
  let verdictLookups = 0;
  const client = {
    read: async (_contract, _abi, method) => {
      if (method === 'getQuery') return { status: QueryStatus.EXPIRED, schemaId: SchemaId.FREEFORM_FACT, deadline: 1n };
      verdictLookups++;
      return `0x${'0'.repeat(64)}`;
    },
  };
  const progress = [];
  const result = await waitForPaidClaimReview(client, { prepared: { queryId: h('8') } }, { timeoutMs: 1_000, onProgress: p => progress.push(p) });
  expect(result).toEqual({ execution: 'onchain_protocol', status: 'EXPIRED' });
  expect(progress).toEqual(['Expired']);
  // Read in the same batched request as the query, and not used.
  expect(verdictLookups).toBe(1);
});

test('resume wait reads the query and its verdict id together, and backs off on a rate-limited round instead of failing', async () => {
  const reads = [];
  let refusals = 2;
  const progress = [];
  const client = {
    read: async (_contract, _abi, method) => {
      reads.push(method);
      // Like viem: the website's 429 is an HttpRequestError (status, headers) inside the contract error's causes.
      if (refusals > 0) { refusals--; throw Object.assign(new Error('ContractFunctionExecutionError'), { cause: Object.assign(new Error('HTTP request failed.'), { status: 429, headers: new Headers({ 'retry-after': '1' }) }) }); }
      return method === 'getQuery' ? { status: QueryStatus.OPEN, schemaId: SchemaId.FREEFORM_FACT, deadline: 0n } : `0x${'0'.repeat(64)}`;
    },
  };
  const result = await waitForPaidClaimReview(client, { prepared: { queryId: h('8') } }, { timeoutMs: 200, onProgress: p => progress.push(p) });
  expect(result).toEqual({ execution: 'onchain_protocol', status: 'unresolved' });
  expect(reads.slice(0, 2).sort()).toEqual(['getQuery', 'latestVerdictOf']);
  // At least twice the 4 s polling interval, whatever Retry-After asked for.
  expect(progress).toEqual([slowDownMessage(8)]);
  // A verdict fetch the website refuses with 429 also waits rather than failing the resume.
  const limited = waitFixture();
  limited.client.fetcher = async () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } });
  const seen = [];
  expect(await waitForPaidClaimReview(limited.client, limited.claim, { timeoutMs: 100, onProgress: p => seen.push(p) })).toMatchObject({ status: 'unresolved' });
  expect(seen).toEqual(['Decided', slowDownMessage(20)]);
  // Any other failure still ends the wait with an error.
  const broken = waitFixture();
  broken.client.fetcher = async () => new Response('{}', { status: 500 });
  await expect(waitForPaidClaimReview(broken.client, broken.claim, { timeoutMs: 100 })).rejects.toThrow('Verdict retrieval failed');
});

test('a timed-out wait flags an open query whose one-hour deadline has passed', async () => {
  const read = deadline => async (_contract, _abi, method) => method === 'getQuery' ? { status: QueryStatus.SEALED, schemaId: SchemaId.FREEFORM_FACT, deadline } : `0x${'0'.repeat(64)}`;
  const past = BigInt(Math.floor(Date.now() / 1000) - 60);
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  expect(await waitForPaidClaimReview({ read: read(past) }, { prepared: { queryId: h('8') } }, { timeoutMs: 20 })).toEqual({ execution: 'onchain_protocol', status: 'unresolved', deadlinePassed: true });
  expect(await waitForPaidClaimReview({ read: read(future) }, { prepared: { queryId: h('8') } }, { timeoutMs: 20 })).toEqual({ execution: 'onchain_protocol', status: 'unresolved' });
});

// A LiveClient whose chain, wallet provider and wallet are fakes; `wallet` decides how each transaction request ends.
function submitFixture({ allowance = 21_000n, createdAt = Date.now(), wallet, receipt = async () => ({ status: 'success' }) } = {}) {
  const sent = [];
  const publicClient = {
    getChainId: async () => 31337,
    readContract: async ({ functionName }) => functionName === 'quote' ? [20_000n, 1_000n] : functionName === 'allowance' ? allowance : undefined,
    call: async () => ({}),
    waitForTransactionReceipt: receipt,
  };
  const client = createProtocolClient(config, { publicClient });
  client.provider = { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : [a('6')] };
  client.wallet = { sendTransaction: async tx => { sent.push(tx.to); return wallet(tx, sent.length); } };
  const prepared = { chainId: 31337, escrow: config.contracts.queryEscrow, account: a('6'), createdAt, schemaId: SchemaId.FREEFORM_FACT, n: 3, tokensK: 1, amount: 21_000n, displayAmount: '0.021', data: '0xdeadbeef', queryId: h('8') };
  return { client, prepared, sent };
}
const rejected = () => Object.assign(new Error('Transaction execution failed.'), { name: 'TransactionExecutionError', cause: Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError', code: 4001 }) });

test('submit marks failures before the escrow payment request as definitely not sent', async () => {
  const expired = submitFixture({ createdAt: Date.now() - 6 * 60 * 1000, wallet: () => h('e') });
  const error = await expired.client.submit(expired.prepared).catch(e => e);
  expect(error.message).toContain('Quote expired');
  expect(error.paymentAttempt).toEqual({ stage: PAYMENT_STAGE.CHECKS });
  expect(paymentNotSent(error)).toBe(true);
  expect(expired.sent).toEqual([]);
  // Rejecting the USDG approval popup also leaves the escrow payment unrequested.
  const approval = submitFixture({ allowance: 0n, wallet: () => { throw rejected(); } });
  const approvalError = await approval.client.submit(approval.prepared).catch(e => e);
  expect(approval.sent).toEqual([config.contracts.usdg]);
  expect(paymentNotSent(approvalError)).toBe(true);
});

test('submit separates a rejected payment popup from a payment that may have been broadcast', async () => {
  const popup = submitFixture({ wallet: () => { throw rejected(); } });
  const popupError = await popup.client.submit(popup.prepared).catch(e => e);
  expect(popupError.paymentAttempt.stage).toBe(PAYMENT_STAGE.REQUESTED);
  expect(paymentNotSent(popupError)).toBe(true);
  // A transport failure while the wallet holds the payment request is ambiguous: the wallet may have broadcast it.
  const transport = submitFixture({ wallet: () => { throw new Error('wallet transport stopped'); } });
  expect(paymentNotSent(await transport.client.submit(transport.prepared).catch(e => e))).toBe(false);
  // Once a payment hash exists, a later failure never unlocks the quote, and the hash is kept for recovery.
  const broadcast = submitFixture({ wallet: () => h('f'), receipt: async () => { throw new Error('receipt timeout'); } });
  const broadcastError = await broadcast.client.submit(broadcast.prepared).catch(e => e);
  expect(broadcastError.paymentAttempt).toEqual({ stage: PAYMENT_STAGE.BROADCAST, hash: h('f') });
  expect(paymentNotSent(broadcastError)).toBe(false);
  expect(paymentNotSent(new Error('untagged'))).toBe(false);
});

test('a definitive pre-send failure releases the quote; a possibly broadcast payment keeps it locked', async () => {
  const { client, prepared } = submitFixture({ wallet: () => { throw rejected(); } });
  const claim = { prepared };
  const first = await payForClaimReview(client, claim).catch(e => e);
  expect(first).toBeInstanceOf(PaymentNotSentError);
  expect(first.paymentSent).toBe(false);
  expect(first.message).toBe('The wallet request was rejected. No payment was sent.');
  client.wallet.sendTransaction = async () => h('f');
  expect(await payForClaimReview(client, claim)).toBe(h('f'));
  expect(() => payForClaimReview(client, claim)).toThrow('already been submitted or attempted');

  const expired = submitFixture({ createdAt: Date.now() - 6 * 60 * 1000, wallet: () => h('e') });
  const expiredError = await payForClaimReview(expired.client, { prepared: expired.prepared }).catch(e => e);
  expect(expiredError).toBeInstanceOf(PaymentNotSentError);
  expect(expiredError.message).toBe('Quote expired. Prepare a new quote. No payment was sent.');

  const broadcast = submitFixture({ wallet: () => h('f'), receipt: async () => { throw new Error('receipt timeout'); } });
  const locked = { prepared: broadcast.prepared };
  const ambiguous = await payForClaimReview(broadcast.client, locked).catch(e => e);
  expect(ambiguous).not.toBeInstanceOf(PaymentNotSentError);
  expect(ambiguous.paymentAttempt.hash).toBe(h('f'));
  expect(() => payForClaimReview(broadcast.client, locked)).toThrow('already been submitted or attempted');
});
