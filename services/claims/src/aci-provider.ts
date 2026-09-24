import { AciClient } from '@mochi/aci';
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
      const report = (outcome: ChatJurorTelemetry['outcome']) => emit(options.onTelemetry, {
        id: options.id,
        model: options.model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        outcome,
        ...(usage ? { usage } : {}),
      });
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(parentSignal?.reason);
      if (parentSignal?.aborted) abortFromParent();
      else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const request = createClaimChatRequest(options.model, bundle, outputTokens);
        if (controller.signal.aborted) throw new Error('Provider request unavailable');
        const result = await client.chat(JSON.parse(request), { signal: controller.signal, maxResponseBytes: CLAIMS_MAX_RESPONSE_BYTES, requireUpToDate: true });
        if (result.established.tcbStatus !== 'UpToDate') throw new Error('Provider request unavailable');
        usage = reportedClaimUsage(result.json);
        const answer = parseClaimChatResponse(result.json);
        report('success');
        return answer;
      } catch {
        report('failure');
        throw new Error('Provider request unavailable');
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abortFromParent);
      }
    },
  };
}
