import { AciClient, AciVerificationError, ProviderCallAborted, ProviderRetryError, withProviderRetries, type ProviderAttemptFailure, type ProviderRetryOptions } from '@mochi/aci';
import type { EvidenceBundle, Juror } from './types.ts';
import { CLAIMS_MAX_RESPONSE_BYTES, createClaimChatRequest, parseClaimChatResponse, reportedClaimUsage, type ChatJurorTelemetry } from './providers.ts';
import { phalaDcap } from '../../juror/src/phala-dcap.ts';
import { estimateCallTokens, ProviderBudgetExceeded, reportedTotalTokens, type ProviderBudget } from './budget.ts';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 1200;
/** Provider attempts per assess() call (retries included) unless `maxAttempts` overrides it. */
export const DEFAULT_ACI_MAX_ATTEMPTS = 3;

export interface AciJurorOptions {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** ACI pinning policy (`os:`/`compose:` pins); see parseAciPolicy in @mochi/aci. */
  allowedWorkloads?: string[];
  /**
   * Intel TCB statuses accepted for the ACI gateway: the runtime config's tdxAllowedTcbStatuses, the one policy every
   * DCAP check on the CVM shares. Default ["UpToDate"]; "Revoked" is never accepted.
   */
  allowedTcbStatuses?: readonly string[];
  /**
   * Local daily call/token budget; every provider attempt reserves from it before it is sent. An attempt is refunded
   * only when this juror's client provably never dispatched the inference request (see inferenceDispatchTracker).
   */
  budget?: ProviderBudget;
  /**
   * A prebuilt client (its requests are invisible here, so every reserved attempt stays charged), or a factory that
   * builds the client on a fetch wrapped with `track`; only then can attempts that never sent anything be refunded.
   */
  client?: AciClient | ((track: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) => AciClient);
  onTelemetry?: (event: ChatJurorTelemetry) => void;
  /** Attempts including the first (1..5, default 3); transient provider failures are retried within timeoutMs. */
  maxAttempts?: number;
  retry?: Partial<Pick<ProviderRetryOptions, 'now' | 'sleep' | 'random' | 'minAttemptMs' | 'attemptCapMs'>>;
}

/**
 * Counts every request of the juror's AciClient that could carry the inference request. AciClient sends nothing before
 * the chat body except the body-less GET of the attestation report, so only that request is exempt; the chat POST,
 * receipt reads and anything unrecognised all count. The count rises before the request is handed to fetch, so an
 * unchanged count across an attempt proves its request body never left this process. All of the juror's attempts share
 * the counter: overlapping attempts can only make a refund less likely, never more. `active` stays false (no refunds)
 * unless the client was actually built on a tracked fetch.
 */
function inferenceDispatchTracker() {
  let dispatched = 0;
  let active = false;
  return {
    track(base: typeof globalThis.fetch): typeof globalThis.fetch {
      active = true;
      return ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        if (!isAttestationRead(input, init)) dispatched++;
        return base(input, init);
      }) as typeof globalThis.fetch;
    },
    count: () => dispatched,
    active: () => active,
  };
}

function isAttestationRead(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): boolean {
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  if (init?.body !== undefined && init.body !== null) return false;
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return false;
  try { return new URL(input).pathname.endsWith('/aci/attestation'); } catch { return false; }
}

const DEFAULT_TCB_STATUSES = ['UpToDate'] as const;
const tcbAllowed = (allowed: readonly string[], status: string | undefined) => status !== undefined && status !== 'Revoked' && allowed.includes(status);
const strictTcb = (allowed: readonly string[]) => allowed.length === 1 && allowed[0] === 'UpToDate';

function buildClient(options: AciJurorOptions, track: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch): AciClient {
  const allowed = options.allowedTcbStatuses ?? DEFAULT_TCB_STATUSES;
  if (options.client) return typeof options.client === 'function' ? options.client(track) : options.client;
  if (!options.apiKey) throw new TypeError('ACI API key is required');
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new TypeError('Invalid ACI provider URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new TypeError('ACI provider URL must use HTTPS');
  return new AciClient({
    baseUrl: url.toString().replace(/\/$/u, ''),
    apiKey: options.apiKey,
    fetch: track(globalThis.fetch),
    // With an `attestation` policy the gateway must match its os:/compose: pins. Without one, the pilot explicitly
    // accepts any DCAP-verified TDX gateway whose TCB status is allowed (signed receipts and confidential routing are
    // still verified).
    ...(options.allowedWorkloads ? { allowedWorkloads: options.allowedWorkloads } : { allowUnpinned: true }),
    // Each juror requests exactly its configured model; the signed receipt must name it too.
    allowedModels: [options.model],
    dcap: async (quote) => {
      const result = await phalaDcap(quote);
      const attrs = result.tdReport?.tdAttributes;
      // Debug TDs are never accepted by claims, even if the shared verifier's
      // operator setting permits debug measurements for another service.
      if (!tcbAllowed(allowed, result.status) || (attrs?.[0] !== undefined && (attrs[0] & 1) !== 0)) return { ...result, ok: false };
      return result;
    },
  });
}

function emit(callback: AciJurorOptions['onTelemetry'], event: ChatJurorTelemetry): void {
  try { void Promise.resolve(callback?.(event)).catch(() => {}); } catch { /* Telemetry must not affect review behavior. */ }
}

export function createAciJuror(options: AciJurorOptions): Juror {
  const outputTokens = options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  if (!options.id || !options.model || !Number.isInteger(outputTokens) || outputTokens < 64 || outputTokens > 8000) throw new TypeError('Invalid juror configuration');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS)) throw new TypeError('Invalid juror timeout');
  const maxAttempts = options.maxAttempts ?? DEFAULT_ACI_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError('Invalid juror attempt limit');
  const allowedTcb = options.allowedTcbStatuses ?? DEFAULT_TCB_STATUSES;
  if (!allowedTcb.length || !allowedTcb.includes('UpToDate') || allowedTcb.includes('Revoked')) throw new TypeError('Invalid TCB policy');
  const tracker = inferenceDispatchTracker();
  const client = buildClient(options, tracker.track);
  // Without a tracked fetch (e.g. a prebuilt client) no attempt can be proven unsent, so none is refunded.
  const dispatch = tracker.active() ? tracker : undefined;
  return {
    id: options.id,
    model: options.model,
    async assess(bundle: EvidenceBundle, parentSignal?: AbortSignal): Promise<unknown> {
      const startedAt = Date.now();
      let usage: ChatJurorTelemetry['usage'];
      let stage: NonNullable<ChatJurorTelemetry['stage']> = 'request_build';
      let errorCode: string | undefined;
      let attempts = 0;
      let attemptFailures: ProviderAttemptFailure[] = [];
      const report = (outcome: ChatJurorTelemetry['outcome']) => emit(options.onTelemetry, {
        id: options.id,
        model: options.model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        outcome,
        stage: outcome === 'success' ? 'complete' : stage,
        ...(errorCode ? { errorCode } : {}),
        attempts,
        ...(attemptFailures.length ? { attemptFailures } : {}),
        ...(usage ? { usage } : {}),
      });
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(parentSignal?.reason);
      if (parentSignal?.aborted) abortFromParent();
      else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
      let timeoutTriggered = false;
      const timer = setTimeout(() => { timeoutTriggered = true; controller.abort(); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const request = createClaimChatRequest(options.model, bundle, outputTokens, { aciVerified: true });
        if (controller.signal.aborted) { stage = 'aci_exchange'; errorCode = 'REQUEST_ABORTED'; throw new Error('Provider request unavailable'); }
        stage = 'attestation';
        const body = JSON.parse(request);
        const estimate = estimateCallTokens(request, outputTokens);
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Retry transient provider failures with the identical request, inside the same overall timeout.
        const outcome = await withProviderRetries({
          maxAttempts,
          totalMs: timeoutMs,
          attemptCapMs: Math.max(15_000, Math.floor(timeoutMs * 2 / 3)),
          signal: controller.signal,
          ...options.retry,
        }, async signal => {
          const hold = options.budget?.reserve(estimate);
          if (options.budget && !hold) throw new ProviderBudgetExceeded();
          const dispatchedBefore = dispatch?.count();
          try {
            const result = await client.chat(body, strictTcb(allowedTcb)
              ? { signal, maxResponseBytes: CLAIMS_MAX_RESPONSE_BYTES, requireUpToDate: true }
              : { signal, maxResponseBytes: CLAIMS_MAX_RESPONSE_BYTES, allowedTcbStatuses: allowedTcb });
            hold?.settle(reportedTotalTokens(reportedClaimUsage(result.json)));
            return result;
          } catch (error) {
            // chat() has settled, so it dispatches nothing more. Refund the attempt only if the inference request never
            // left this process (request policy, attestation, TCB refusal or abort before sending); anything that may
            // have reached the provider (sent, timed out after sending, failed receipt) keeps the estimate charged.
            if (dispatch && dispatch.count() === dispatchedBefore) hold?.release();
            else hold?.settle();
            throw error;
          }
        }).catch((error: unknown) => {
          if (error instanceof ProviderCallAborted) { attemptFailures = error.failures; attempts = error.attemptsStarted; throw error; }
          if (!(error instanceof ProviderRetryError)) throw error;
          attemptFailures = error.failures; attempts = error.failures.length;
          if (error.attemptTimedOut) timeoutTriggered = true;
          throw error.lastError;
        });
        attempts = outcome.attempts;
        attemptFailures = outcome.failures;
        const result = outcome.value;
        if (!tcbAllowed(allowedTcb, result.established.tcbStatus)) { stage = 'attestation'; errorCode = strictTcb(allowedTcb) ? 'TCB_STATUS_NOT_UP_TO_DATE' : 'TCB_STATUS_NOT_ALLOWED'; throw new Error('Provider request unavailable'); }
        stage = 'response_parse';
        usage = reportedClaimUsage(result.json);
        const answer = parseClaimChatResponse(result.json);
        report('success');
        return answer;
      } catch (error) {
        if (!errorCode) {
          if (error instanceof ProviderBudgetExceeded) { stage = 'request_build'; errorCode = 'BUDGET_EXHAUSTED'; }
          else if (timeoutTriggered) { stage = 'aci_exchange'; errorCode = 'ACI_TIMEOUT'; }
          else if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') || (error instanceof AciVerificationError && error.code === 'aborted')) {
            stage = 'aci_exchange'; errorCode = 'REQUEST_ABORTED';
          } else if (error instanceof AciVerificationError) {
            const code = error.code;
            if (/^(?:attestation_|report_|quote_|dcap_|compose_|workload_|tcb_status$)/u.test(code)) stage = 'attestation';
            else if (/^inference_/u.test(code)) stage = 'inference';
            else if (/^receipt_|^body_hash$|^upstream_/u.test(code)) stage = 'receipt';
            else if (/^response_json$|^response_too_large$|^response_body$/u.test(code)) stage = 'response_parse';
            else stage = 'aci_exchange';
            errorCode = `ACI_${code.toUpperCase()}`;
          } else if (stage === 'request_build') errorCode = 'REQUEST_BUILD_FAILED';
          else if (stage === 'response_parse') errorCode = 'RESPONSE_INVALID';
          else { stage = 'aci_exchange'; errorCode = 'ACI_EXCHANGE_FAILED'; }
        }
        report('failure');
        throw new Error('Provider request unavailable');
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abortFromParent);
      }
    },
  };
}
