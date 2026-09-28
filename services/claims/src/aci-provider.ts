import { AciClient, AciVerificationError } from '@mochi/aci';
import type { EvidenceBundle, Juror } from './types.ts';
import { CLAIMS_MAX_RESPONSE_BYTES, createClaimChatRequest, parseClaimChatResponse, reportedClaimUsage, type ChatJurorTelemetry } from './providers.ts';
import { phalaDcap } from '../../juror/src/phala-dcap.ts';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 1200;

export interface AciJurorOptions {
  id: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  allowedWorkloads?: string[];
  client?: AciClient;
  onTelemetry?: (event: ChatJurorTelemetry) => void;
}

function buildClient(options: AciJurorOptions): AciClient {
  if (options.client) return options.client;
  if (!options.apiKey) throw new TypeError('ACI API key is required');
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new TypeError('Invalid ACI provider URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new TypeError('ACI provider URL must use HTTPS');
  return new AciClient({
    baseUrl: url.toString().replace(/\/$/u, ''),
    apiKey: options.apiKey,
    ...(options.allowedWorkloads ? { allowedWorkloads: options.allowedWorkloads } : {}),
    dcap: async (quote) => {
      const result = await phalaDcap(quote);
      const attrs = result.tdReport?.tdAttributes;
      // Debug TDs are never accepted by claims, even if the shared verifier's
      // operator setting permits debug measurements for another service.
      if (result.status !== 'UpToDate' || (attrs?.[0] !== undefined && (attrs[0] & 1) !== 0)) return { ...result, ok: false };
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
  const client = buildClient(options);
  return {
    id: options.id,
    model: options.model,
    async assess(bundle: EvidenceBundle, parentSignal?: AbortSignal): Promise<unknown> {
      const startedAt = Date.now();
      let usage: ChatJurorTelemetry['usage'];
      let stage: NonNullable<ChatJurorTelemetry['stage']> = 'request_build';
      let errorCode: string | undefined;
      const report = (outcome: ChatJurorTelemetry['outcome']) => emit(options.onTelemetry, {
        id: options.id,
        model: options.model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        outcome,
        stage: outcome === 'success' ? 'complete' : stage,
        ...(errorCode ? { errorCode } : {}),
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
        const result = await client.chat(JSON.parse(request), { signal: controller.signal, maxResponseBytes: CLAIMS_MAX_RESPONSE_BYTES, requireUpToDate: true });
        if (result.established.tcbStatus !== 'UpToDate') { stage = 'attestation'; errorCode = 'TCB_STATUS_NOT_UP_TO_DATE'; throw new Error('Provider request unavailable'); }
        stage = 'response_parse';
        usage = reportedClaimUsage(result.json);
        const answer = parseClaimChatResponse(result.json);
        report('success');
        return answer;
      } catch (error) {
        if (!errorCode) {
          if (timeoutTriggered) { stage = 'aci_exchange'; errorCode = 'ACI_TIMEOUT'; }
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
