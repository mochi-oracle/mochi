// Ported with attribution from Phala's Apache-2.0 reference verifier @phala/aci-verifier
// (commit c51c76c013c309e028e5fe944e2ae797f5207f03; license in ../LICENSE-APACHE-2.0).
// Formulas follow its report.ts, receipt.ts, digest.ts and crypto.ts; this implementation is
// rewritten and extended (DCAP policy, compose-hash replay, workload binding).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type AciReport = Record<string, any>;
export type EstablishedAciReport = {
  workloadId: string; keysetDigest: string; receiptKeys: any[]; staleAfter: number; tcbStatus: string;
  /** sha256 of the dstack app compose, when the report carried event-log evidence that replays to RTMR3. */
  composeHash?: string;
  /** aciOsMeasurement() of the quoted TD (firmware, VM configuration, kernel, initrd and command line). */
  osMeasurement?: string;
};
export class AciVerificationError extends Error {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  constructor(readonly code: string, http?: { status: number; retryAfterMs?: number }) {
    super(`ACI verification failed: ${code}`); this.name = "AciVerificationError";
    if (http && Number.isInteger(http.status) && http.status >= 100 && http.status <= 599) this.httpStatus = http.status;
    if (http?.retryAfterMs !== undefined && Number.isFinite(http.retryAfterMs) && http.retryAfterMs >= 0) this.retryAfterMs = Math.min(http.retryAfterMs, 120_000);
  }
}
function httpFailure(code: string, response: Response): AciVerificationError {
  const value = response.headers.get("retry-after");
  const seconds = value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  // Retain only bounded numbers; provider bodies and headers can contain private data.
  return new AciVerificationError(code, { status: response.status, ...(seconds !== undefined ? { retryAfterMs: seconds * 1000 } : {}) });
}
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => sha256(bytes);
const hex = (bytes: Uint8Array) => bytesToHex(bytes);
const fromHex = (value: string) => hexToBytes(value.replace(/^0x/, ""));
const MAX_ATTESTATION_BYTES = 1_048_576;
const MAX_RECEIPT_BYTES = 262_144;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AciVerificationError("aborted");
}

async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  aborted(signal);
  if (!response.body) throw new AciVerificationError("response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      aborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AciVerificationError("response_too_large");
      }
      chunks.push(value);
    }
    aborted(signal);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    aborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new AciVerificationError("aborted")); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** RFC 8785 object member ordering and compact JSON for the ACI JSON domain. */
export function jcsBytes(value: unknown): Uint8Array {
  const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])])) : v;
  return encoder.encode(JSON.stringify(normalize(value)));
}
export function workloadKeysetDigest(keyset: unknown): string { return `sha256:${hex(hash(jcsBytes(keyset)))}`; }
export function attestationStatement(digest: string, nonce: string | null): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || (nonce !== null && !/^[0-9a-f]{64}$/.test(nonce))) throw new AciVerificationError("invalid_report_input");
  return encoder.encode(`{"keyset_digest":"${digest}","nonce":${nonce === null ? "null" : `"${nonce}"`},"purpose":"aci.report_data.v1"}`);
}
export function reportData(digest: string, nonce: string | null): string { return hex(hash(attestationStatement(digest, nonce))); }

export interface DcapResult {
  ok: boolean;
  status: string;
  reportType?: string;
  reportData: Uint8Array | string;
  tdReport?: { reportData: Uint8Array; rtmr: readonly Uint8Array[]; mrTd?: Uint8Array };
  measurement?: string;
}
export interface VerifyAciReportOptions {
  signal?: AbortSignal;
  nonce: string; dcap: (quote: Uint8Array, signal?: AbortSignal) => Promise<DcapResult> | DcapResult;
  now?: number; maxAgeSec?: number;
  /** Policy entries; see parseAciPolicy. Plain entries are workload IDs. */
  allowedWorkloads?: string[];
  allowedComposeHashes?: string[];
  allowedOsMeasurements?: string[];
  /**
   * Accept a report without any `os:`/`compose:` pin, i.e. from any genuine TDX VM. Off by default (fails with
   * `workload_unpinned`); intended only for discovering a workload's pin, or for an explicitly unpinned client.
   */
  allowUnpinned?: boolean;
}

/**
 * Workload pinning policy. `workload_id` is not covered by the quote's report data, so a workload-ID allow-list alone
 * proves nothing: any TDX VM can claim any ID. The attested pins are the dstack compose hash (RTMR3 event-log replay)
 * and the OS measurement (firmware, VM configuration, kernel, initrd and command line). Entries:
 * `compose:<64 hex>`, `os:<64 hex>`, `model:<id>`, and plain workload IDs (optionally `workload:<id>`).
 */
export type AciPolicy = { workloads: string[]; composeHashes: string[]; osMeasurements: string[]; models: string[] };
export function parseAciPolicy(entries: readonly string[] = []): AciPolicy {
  const policy: AciPolicy = { workloads: [], composeHashes: [], osMeasurements: [], models: [] };
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;
    const typed = /^(compose|os|model|workload):(.*)$/i.exec(entry);
    if (!typed) { policy.workloads.push(entry); continue; }
    const kind = typed[1]!.toLowerCase(), value = typed[2]!.trim();
    if (kind === "compose" || kind === "os") {
      const digest = value.toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new AciVerificationError("invalid_policy");
      (kind === "compose" ? policy.composeHashes : policy.osMeasurements).push(digest);
    } else if (!value || value.length > 256) throw new AciVerificationError("invalid_policy");
    else (kind === "model" ? policy.models : policy.workloads).push(value);
  }
  return policy;
}

/** sha256(MRTD ‖ RTMR0 ‖ RTMR1 ‖ RTMR2): the TD's firmware, VM configuration and boot chain, stable across instances. */
export function aciOsMeasurement(td: { mrTd?: Uint8Array; rtmr: readonly Uint8Array[] }): string | undefined {
  const registers = [td.mrTd, td.rtmr?.[0], td.rtmr?.[1], td.rtmr?.[2]];
  if (registers.some((register) => !(register instanceof Uint8Array) || register.length !== 48)) return undefined;
  const joined = new Uint8Array(48 * 4);
  registers.forEach((register, i) => joined.set(register!, 48 * i));
  return hex(hash(joined));
}

export async function verifyAciReport(report: AciReport, options: VerifyAciReportOptions): Promise<EstablishedAciReport> {
  const policy = parseAciPolicy(options.allowedWorkloads);
  policy.composeHashes.push(...parseAciPolicy((options.allowedComposeHashes ?? []).map((value) => `compose:${value}`)).composeHashes);
  policy.osMeasurements.push(...parseAciPolicy((options.allowedOsMeasurements ?? []).map((value) => `os:${value}`)).osMeasurements);
  const pinned = policy.composeHashes.length > 0 || policy.osMeasurements.length > 0;
  // Fail closed: without an attested pin any TDX VM is accepted, so that must be requested explicitly, and a
  // workload-ID list (not covered by the quote) never substitutes for a pin.
  if (!pinned && (policy.workloads.length || !options.allowUnpinned)) throw new AciVerificationError("workload_unpinned");
  const att = report?.attestation;
  const keyset = att?.workload_keyset;
  if (report?.api_version !== "aci/1" || att?.tee_type !== "tdx" || !keyset || typeof keyset !== "object" || Array.isArray(keyset)) throw new AciVerificationError("invalid_report");
  const digest = workloadKeysetDigest(keyset);
  if (report.workload_keyset_digest !== digest || att.report_data !== reportData(digest, options.nonce)) throw new AciVerificationError("report_binding");
  const identity = typeof report.workload_id === "string" ? report.workload_id : digest;
  if (policy.workloads.length && !policy.workloads.includes(identity)) throw new AciVerificationError("workload_not_allowed");
  const staleAfter = keyset.not_after;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof staleAfter !== "number" || !(now < staleAfter)) throw new AciVerificationError("report_stale");
  const quote = att.evidence?.quote ?? att.evidence?.quote_hex;
  if (typeof quote !== "string") throw new AciVerificationError("quote_missing");
  let dcap: DcapResult;
  try { dcap = await options.dcap(fromHex(quote), options.signal); } catch { throw new AciVerificationError("dcap_failed"); }
  if (!dcap.ok) throw new AciVerificationError("dcap_failed");
  if (dcap.reportType !== "tdx") throw new AciVerificationError("quote_binding");
  if (typeof att.report_data !== "string" || !/^[0-9a-f]{64}$/.test(att.report_data)) throw new AciVerificationError("quote_binding");
  const got = typeof dcap.reportData === "string" ? fromHex(dcap.reportData) : dcap.reportData;
  const expected = new Uint8Array(64);
  expected.set(fromHex(att.report_data));
  if (got.length !== 64 || !expected.every((b, i) => b === got[i])) throw new AciVerificationError("quote_binding");
  const established: EstablishedAciReport = { workloadId: identity, keysetDigest: digest, receiptKeys: keyset.receipt_signing_keys ?? [], staleAfter, tcbStatus: dcap.status };
  const evidence = att.evidence;
  if (typeof evidence?.event_log === "string" || typeof evidence?.app_compose === "string") {
    const result = await verifyComposeMeasurement(evidence, dcap.tdReport);
    if (!result.ok || (policy.composeHashes.length && (!result.composeHash || !policy.composeHashes.includes(result.composeHash)))) throw new AciVerificationError("compose_measurement");
    established.composeHash = result.composeHash;
  } else if (policy.composeHashes.length) {
    throw new AciVerificationError("compose_measurement");
  }
  const osMeasurement = dcap.tdReport ? aciOsMeasurement(dcap.tdReport) : undefined;
  if (policy.osMeasurements.length && (!osMeasurement || !policy.osMeasurements.includes(osMeasurement))) throw new AciVerificationError("os_measurement");
  if (osMeasurement) established.osMeasurement = osMeasurement;
  return established;
}

interface DstackEvent { imr: number; digest: string; event: string; event_payload: string }
export async function verifyComposeMeasurement(
  evidence: Record<string, any>,
  tdReport?: { rtmr: readonly Uint8Array[] },
): Promise<{ ok: boolean; composeHash?: string }> {
  if (typeof evidence.event_log !== "string" || typeof evidence.app_compose !== "string" || !tdReport) return { ok: false };
  let events: DstackEvent[];
  try { events = JSON.parse(evidence.event_log); } catch { return { ok: false }; }
  if (!Array.isArray(events) || !Array.isArray(tdReport.rtmr) || tdReport.rtmr[3]?.length !== 48) return { ok: false };
  let rtmr: Uint8Array<ArrayBufferLike> = new Uint8Array(48);
  for (const event of events) {
    if (event.imr !== 3) continue;
    let digest: Uint8Array;
    try { digest = fromHex(event.digest); } catch { return { ok: false }; }
    const input = new Uint8Array(48 + Math.max(48, digest.length));
    input.set(rtmr); input.set(digest, 48);
    rtmr = hash384(input);
  }
  const preReady: DstackEvent[] = [];
  for (const event of events) {
    if (event.imr !== 3) continue;
    if (event.event === "system-ready") break;
    if (event.event === "compose-hash") preReady.push(event);
  }
  const composeHash = hex(hash(encoder.encode(evidence.app_compose)));
  const matches = preReady.length === 1 && preReady[0]?.event_payload?.toLowerCase() === composeHash;
  const rtmrMatches = rtmr.every((b, i) => b === tdReport.rtmr[3]![i]);
  return { ok: matches && rtmrMatches, ...(matches && rtmrMatches ? { composeHash } : {}) };
}

function hash384(bytes: Uint8Array): Uint8Array {
  // Noble's synchronous SHA-384 keeps event-log replay deterministic in Bun and browsers.
  return sha384(bytes);
}
export async function verifyAciReceipt(receipt: any, options: { established: EstablishedAciReport; requestBody: Uint8Array; responseBody: Uint8Array; requireConfidential: true }): Promise<{ receiptId: string; modelId: string; requestedModelId: string; provider: string; sessionId: string }> {
  if (!receipt || receipt.api_version !== "aci/1" || receipt.workload_keyset_digest !== options.established.keysetDigest) throw new AciVerificationError("receipt_binding");
  if (receipt.workload_id !== undefined && receipt.workload_id !== options.established.workloadId) throw new AciVerificationError("receipt_binding");
  const key = options.established.receiptKeys.find((k) => k.key_id === receipt.key_id);
  if (!key || key.algo !== "ed25519") throw new AciVerificationError("receipt_signature");
  const { signature, ...unsigned } = receipt;
  try { if (!ed25519.verify(fromHex(signature), jcsBytes(unsigned), fromHex(key.public_key))) throw new AciVerificationError("receipt_signature"); }
  catch { throw new AciVerificationError("receipt_signature"); }
  const events = Array.isArray(receipt.event_log) ? receipt.event_log : [];
  const req = events.find((e: any) => e.type === "request.received")?.body_hash;
  const res = events.find((e: any) => e.type === "response.returned")?.wire_hash ?? events.find((e: any) => e.type === "response.returned")?.body_hash;
  if (req !== `sha256:${hex(hash(options.requestBody))}` || res !== `sha256:${hex(hash(options.responseBody))}`) throw new AciVerificationError("body_hash");
  const upstream = events.find((e: any) => e.type === "upstream.verified");
  if (options.requireConfidential && (upstream?.result !== "verified" || upstream?.required !== true || typeof upstream?.session_id !== "string" || upstream.session_id.length === 0)) throw new AciVerificationError("upstream_unverified");
  // The gateway records its routing decision as `route.selected` with target_route_id "<provider>:<model>".
  const route = events.find((e: any) => e.type === "route.selected")?.target_route_id;
  const routedProvider = typeof route === "string" && route.includes(":") ? route.slice(0, route.indexOf(":")) : undefined;
  return { receiptId: String(receipt.receipt_id ?? ""), modelId: String(upstream?.model_id ?? receipt.model ?? ""), requestedModelId: typeof receipt.model === "string" ? receipt.model : "", provider: String(upstream?.provider ?? routedProvider ?? receipt.provider ?? "phala-aci"), sessionId: String(upstream?.session_id ?? "") };
}

export class AciClient {
  private established?: EstablishedAciReport;
  private cacheUntil = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly models: string[];
  constructor(private readonly options: {
    baseUrl: string; apiKey: string; fetch?: typeof fetch; dcap: VerifyAciReportOptions["dcap"]; now?: () => number;
    /** Pinning policy (parseAciPolicy); invalid entries fail construction. */
    allowedWorkloads?: string[];
    /** Model IDs this client may request; the signed receipt must name the same model. Merged with `model:` entries. */
    allowedModels?: string[];
    /**
     * Accept any DCAP-verified TDX gateway when allowedWorkloads has no `os:`/`compose:` pin. Without a pin and
     * without this explicit opt-in, construction fails (`workload_unpinned`).
     */
    allowUnpinned?: boolean;
  }) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    const policy = parseAciPolicy(options.allowedWorkloads);
    if (policy.osMeasurements.length + policy.composeHashes.length === 0 && (policy.workloads.length || options.allowUnpinned !== true)) throw new AciVerificationError("workload_unpinned");
    this.models = [...policy.models, ...(options.allowedModels ?? []).filter((model) => typeof model === "string" && model.length > 0)];
  }
  async attest(signal?: AbortSignal): Promise<EstablishedAciReport> {
    aborted(signal);
    if (this.established && this.cacheUntil > this.now() && this.established.staleAfter > this.now()) return this.established;
    // Do not share an in-flight nonce-bound report across callers. Each request
    // owns its abort signal and can only establish the report it requested.
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/aci/attestation?nonce=${nonce}`, { headers: { authorization: `Bearer ${this.options.apiKey}` }, signal, redirect: "error" });
    if (!response.ok || response.redirected) throw httpFailure(response.redirected ? "attestation_redirect" : "attestation_http", response);
    const report = JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_ATTESTATION_BYTES, signal))) as AciReport;
    aborted(signal);
    const verified = await verifyAciReport(report, { nonce, signal, dcap: this.options.dcap, now: this.now(), allowedWorkloads: this.options.allowedWorkloads, allowUnpinned: this.options.allowUnpinned === true });
    aborted(signal);
    this.established = verified;
    this.cacheUntil = Math.min(verified.staleAfter, this.now() + 3600);
    return verified;
  }
  /**
   * Sends one confidential chat request and returns it only after the report, receipt and body hashes verify. A gateway
   * whose TDX TCB status is not UpToDate is refused before any request is sent, unless `requireUpToDate: false`. An
   * explicit `allowedTcbStatuses` list (the operator's TDX_ALLOWED_TCB_STATUSES policy) replaces that UpToDate rule.
   */
  async chat(body: unknown, options: { signal?: AbortSignal; maxResponseBytes?: number; requireUpToDate?: boolean; allowedTcbStatuses?: readonly string[] } = {}): Promise<{ json: any; receipt: Awaited<ReturnType<typeof verifyAciReceipt>>; established: EstablishedAciReport }> {
    const signal = options.signal;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError("maxResponseBytes must be a positive safe integer");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AciVerificationError("request_shape");
    const request = body as Record<string, unknown>;
    if (typeof request.model !== "string" || !request.model) throw new AciVerificationError("request_model");
    if (this.models.length && !this.models.includes(request.model)) throw new AciVerificationError("model_not_allowed");
    const provider = request.provider;
    if (provider !== undefined && (!provider || typeof provider !== "object" || Array.isArray(provider))) throw new AciVerificationError("request_provider");
    const routing = (provider ?? {}) as Record<string, unknown>;
    if (routing.aci_verified !== undefined && routing.aci_verified !== true) throw new AciVerificationError("request_confidentiality");
    // Receipt verification happens after inference. Require attested routing
    // before forwarding so an unavailable confidential route cannot leak input.
    const bytes = encoder.encode(JSON.stringify({ ...request, provider: { ...routing, aci_verified: true } }));
    aborted(signal);
    const established = await this.attest(signal);
    if (options.allowedTcbStatuses !== undefined
      ? established.tcbStatus === "Revoked" || !options.allowedTcbStatuses.includes(established.tcbStatus)
      : options.requireUpToDate !== false && established.tcbStatus !== "UpToDate") throw new AciVerificationError("tcb_status");
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` }, body: bytes, signal, redirect: "error" });
    if (!response.ok || response.redirected) throw httpFailure(response.redirected ? "inference_redirect" : "inference_http", response);
    const responseBytes = await readBounded(response, maxResponseBytes, signal);
    const receiptId = response.headers.get("x-receipt-id");
    if (!receiptId) throw new AciVerificationError("receipt_header");
    let receipt: Awaited<ReturnType<typeof verifyAciReceipt>> | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      aborted(signal);
      const r = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/aci/receipts/${encodeURIComponent(receiptId)}`, { headers: { authorization: `Bearer ${this.options.apiKey}` }, signal, redirect: "error" });
      if (r.redirected) throw new AciVerificationError("receipt_redirect");
      if (r.ok) {
        try { receipt = await verifyAciReceipt(JSON.parse(new TextDecoder().decode(await readBounded(r, MAX_RECEIPT_BYTES, signal))), { established, requestBody: bytes, responseBody: responseBytes, requireConfidential: true }); break; } catch (error) { aborted(signal); if (attempt === 3) throw error; }
      }
      if (attempt < 3) await abortableDelay(100 * (attempt + 1), signal);
    }
    if (!receipt) throw new AciVerificationError("receipt_unavailable");
    if (receipt.requestedModelId !== request.model || (this.models.length && !this.models.includes(receipt.requestedModelId))) throw new AciVerificationError("receipt_model");
    aborted(signal);
    try { return { json: JSON.parse(new TextDecoder().decode(responseBytes)), receipt, established }; } catch { throw new AciVerificationError("response_json"); }
  }
}

export * from "./retry.ts";
