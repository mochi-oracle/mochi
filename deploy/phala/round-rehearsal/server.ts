import { join } from 'node:path';
import { DcapQuoteVerifier, DstackQuoteSource, FileSealedStore, PcsCollateralSource, TdxTeeProvider, tdxQuoteMeasurement, type QuoteVerifier, parseTdxQuote, pemChain, verifyTdxQuote } from '@mochi/tee';
import { PhalaAciRunner, type ModelRunner } from '../../../services/juror/src/runner.ts';
import { boundedHttpsFetch } from '../rehearsal/http.ts';
import { createRoundHandler } from './app.ts';
import { createRoundRehearsal, ROUND_REHEARSAL_FIXTURE, ROUND_REHEARSAL_MODEL_OUTPUT, type RoundRehearsalInput } from './round.ts';
import { AciClient } from '@mochi/aci';
import { createInferenceCallBudget, loadRealModeConfig, REAL_MAX_INPUT_BYTES, REAL_MAX_OUTPUT_TOKENS, REAL_MODELS, REAL_ESTIMATED_COST_USD } from './real-mode.ts';

const realConfig = process.env.MOCHI_ROUND_MODE === 'real-phala-aci' ? loadRealModeConfig(process.env) : undefined;
const REAL_PASSPORTS = REAL_MODELS.map((modelId) => ({ modelId, lineage: modelId.split('/')[0]!, weightsSha256: `0x${'00'.repeat(32)}` as `0x${string}`, openWeights: false, provider: 'phala-aci', zdr: false })) as unknown as NonNullable<Parameters<typeof createRoundRehearsal>[0]['passports']>;
const realMode = process.env.MOCHI_ROUND_MODE === 'real-phala-aci';

// Real mode spends credits only on the fixed public fixture under strict limits.
if (process.env.TEE_MODE !== 'dstack' || process.env.TEE_KEYS !== 'ephemeral' || !['synthetic-only', 'real-phala-aci'].includes(process.env.MOCHI_ROUND_MODE ?? '')) {
  throw new Error('Round rehearsal requires dstack, ephemeral keys and an explicit supported mode.');
}
const quoteSource = new DstackQuoteSource({ socketPath: process.env.DSTACK_SOCKET ?? '/var/run/dstack.sock' });
const tees: TdxTeeProvider[] = [];
for (let i = 0; i < 5; i++) tees.push(await TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, quoteSource }));
const [intake, consensus, one, two, three] = tees as [TdxTeeProvider,TdxTeeProvider,TdxTeeProvider,TdxTeeProvider,TdxTeeProvider];
if (new Set(tees.map(tee => tee.measurement())).size !== 1) throw new Error('Co-resident rehearsal measurements differ.');
const dcap = new DcapQuoteVerifier({
  collateral: new PcsCollateralSource({ fetch: boundedHttpsFetch as typeof fetch }),
  policy: { allowedStatuses: ['UpToDate'], allowDebug: false },
});
const quoteVerifier: QuoteVerifier = {
  async verify(quote, expected) {
    const result = await dcap.verify(quote, { ...expected, maxAgeSec: 300 });
    if (!result.ok || result.tcbStatus !== 'UpToDate' || result.advisoryIds.length) return { ok: false, reason: 'Strict rehearsal attestation policy rejected quote.' };
    return result;
  },
};
// Synthetic defaults exercise only protocol handoffs. Real mode accepts the
// fixed public fixture and three explicitly pinned provider model identifiers.
const callBudget = createInferenceCallBudget(3);
const runner = (modelIndex: number): ModelRunner & { lastReceipt?: PhalaAciRunner['lastReceipt']; lastProviderReceipt?: PhalaAciRunner['lastProviderReceipt']; lastFailure?: PhalaAciRunner['lastFailure'] } => realMode ? (() => {
  const aciRunner = new PhalaAciRunner({
  client: new AciClient({
    baseUrl: realConfig!.baseUrl, apiKey: realConfig!.apiKey,
    dcap: async (raw) => {
      const parsed = parseTdxQuote(raw), chain = pemChain(parsed.pckPem), leaf = chain[0], intermediate = chain[1];
      if (!leaf?.sgx || !intermediate) return { ok: false, status: 'Invalid', reportData: new Uint8Array() };
      const ca = intermediate.subjectCN === 'Intel SGX PCK Platform CA' ? 'platform' : intermediate.subjectCN === 'Intel SGX PCK Processor CA' ? 'processor' : undefined;
      if (!ca) return { ok: false, status: 'Invalid', reportData: new Uint8Array() };
      const collateral = await new PcsCollateralSource({ fetch: boundedHttpsFetch as typeof fetch }).get(Array.from(leaf.sgx.fmspc, b => b.toString(16).padStart(2, '0')).join('').toUpperCase(), ca);
      const verified = verifyTdxQuote(raw, collateral, Math.floor(Date.now() / 1000));
      const debug = (verified.td.tdAttributes[0]! & 1) !== 0;
      return { ok: verified.status === 'UpToDate' && verified.advisoryIds.length === 0 && !debug, status: verified.status, reportType: 'tdx', reportData: verified.td.reportData, tdReport: verified.td };
    },
  }), model: REAL_MODELS[modelIndex]!, timeoutMs: 25_000, maxTokens: REAL_MAX_OUTPUT_TOKENS, maxInputBytes: REAL_MAX_INPUT_BYTES, compactReceiptMetadata: true,
  });
  return {
    get lastReceipt() { return aciRunner.lastReceipt; },
    get lastProviderReceipt() { return aciRunner.lastProviderReceipt; },
    get lastFailure() { return aciRunner.lastFailure; },
    async run(input) {
      if (!callBudget.reserve()) throw new Error('Real inference call budget exhausted.');
      return aciRunner.run(input);
    },
  };
})() : {
  async run(input) {
    if (input.document !== ROUND_REHEARSAL_FIXTURE.evidence) throw new Error('Synthetic runner accepts only the fixed fixture.');
    return ROUND_REHEARSAL_MODEL_OUTPUT;
  },
};
const directory = process.env.SEALED_STORE_DIR ?? '/tmp/round';
const runners = [runner(0), runner(1), runner(2)] as const;
const diagnosticStages = new Set(['authorization', 'request', 'intake', 'attestation', 'dispatch', 'consensus_open', 'juror', 'model_inference', 'juror_delivery', 'consensus_close']);
const diagnosticCauses = new Set(['auth_rejected', 'request_rejected', 'fixture_rejected', 'fixture_already_bound', 'intake_failed', 'intake_binding_failed', 'peer_attestation_failed', 'dispatch_failed', 'consensus_open_failed', 'consensus_close_failed', 'answer_not_delivered', 'juror_rejected', 'private_result_missing', 'receipt_missing', 'aborted', 'attestation_http', 'attestation_redirect', 'inference_http', 'inference_redirect', 'receipt_header', 'receipt_redirect', 'receipt_unavailable', 'receipt_binding', 'receipt_signature', 'receipt_model', 'body_hash', 'upstream_unverified', 'response_json', 'response_body', 'response_too_large', 'invalid_report', 'report_binding', 'report_stale', 'quote_missing', 'quote_binding', 'dcap_failed', 'compose_measurement', 'tcb_status', 'workload_not_allowed', 'request_shape', 'request_provider', 'request_confidentiality', 'timeout', 'request_too_large', 'runner_failed', 'aci_error']);
const reportDiagnostic = (event: { stage: string; causeCode: string; seat?: number; httpStatus?: number }) => {
  if (!diagnosticStages.has(event.stage) || !diagnosticCauses.has(event.causeCode)) return;
  const seat = event.seat !== undefined && Number.isInteger(event.seat) && event.seat >= 0 && event.seat < 3 ? event.seat : undefined;
  const httpStatus = event.httpStatus !== undefined && Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 ? event.httpStatus : undefined;
  console.error(JSON.stringify({ event: 'round_diagnostic', stage: event.stage, causeCode: event.causeCode, ...(seat === undefined ? {} : { seat }), ...(httpStatus === undefined ? {} : { httpStatus }) }));
};
const service = createRoundRehearsal({
  tees: { intake, consensus, jurors: [one,two,three] }, quoteVerifier,
  stores: {
    intake: new FileSealedStore(join(directory,'intake'),intake),
    consensus: new FileSealedStore(join(directory,'consensus'),consensus),
    jurors: [one,two,three].map((tee,i) => new FileSealedStore(join(directory,`juror-${i}`),tee)) as [FileSealedStore,FileSealedStore,FileSealedStore],
  },
  runners,
  ...(realMode ? { passports: REAL_PASSPORTS } : {}),
  onDiagnostic: reportDiagnostic,
  clock: { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve,ms)) },
});
const handler = createRoundHandler({
  attestations: () => service.attestations(),
  async run(input) {
    const result = await service.run(input as RoundRehearsalInput);
    if (!realMode) return result;
    const receipts = runners.map((runner, i) => {
      const receipt = runner.lastProviderReceipt;
      return receipt && receipt.modelId === REAL_MODELS[i] ? {
        ...receipt, seat: i, modelId: REAL_MODELS[i],
        verification: 'ACI client verified provider signature and exact request/response body hashes in server process',
      } : undefined;
    });
    if (receipts.some(receipt => !receipt)) { reportDiagnostic({ stage: 'model_inference', causeCode: 'receipt_missing' }); throw new Error('Missing verified provider receipt.'); }
    return { ...result, realInference: { provider: 'phala-aci', models: REAL_MODELS, receipts, estimatedCostUsd: REAL_ESTIMATED_COST_USD, costEstimateBasis: 'catalog token rates; requested max_tokens and input-byte reservation; actual provider usage may differ', receiptVerification: 'server-side ACI verification; response metadata is not an independent proof' } };
  },
}, { mode: realMode ? 'real-aci' : 'synthetic', ...(realMode ? { roundAuthSecret: realConfig!.roundAuthSecret } : {}), onDiagnostic: reportDiagnostic });
const server = Bun.serve({
  hostname: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? '8080'),
  maxRequestBodySize: 24*1024, idleTimeout: 120, fetch: handler,
});
const timer = setTimeout(() => { server.stop(true); process.exit(0); },30*60*1000);
timer.unref();
console.info(`Mochi ${realMode ? 'real Phala ACI' : 'synthetic'} confidential round rehearsal ready`);
