import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { markStaleCollateral, parseCollateralJson, type CollateralSource, type TdxCollateral } from "./collateral.ts";
import { parseCrl } from "./crl.ts";
import { DcapError, verifyCollateralComponent, verifyCollateralSignatures, type CollateralComponent } from "./verify.ts";

export type PcsOptions = {
  baseUrl?: string;
  /** Aborts every PCS request this source makes (in addition to the per-round timeout). */
  signal?: AbortSignal;
  rootCaCrlUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Unix seconds. */
  now?: () => number;
  /** Persist the cache here (one JSON file per FMSPC/CA). The files hold public, Intel-signed data only. */
  cacheDir?: string;
  /** Refresh a cached entry in the background once it is this old. Default 24 h, like Intel PCCS's daily refresh. */
  refreshAfterSec?: number;
  /** Refresh in the background at the latest this long before the entry's earliest nextUpdate. Default 6 h. */
  refreshAheadSec?: number;
  /**
   * Serve-stale grace: while Intel PCS is unreachable (network failure, timeout, HTTP 408/429/5xx), keep serving the
   * cached collateral for up to this long past its earliest nextUpdate. Never used when PCS answered, so fresh CRLs or
   * TCB info (including revocations) always win. Default 48 h; 0 disables; at most 72 h.
   */
  staleGraceSec?: number;
  /** Exponential backoff with jitter after a failed PCS round: first delay and cap. Defaults 15 s and 15 min. */
  backoffBaseSec?: number;
  backoffMaxSec?: number;
  /** Timeout of one PCS round (all four requests). Default 30 s. */
  timeoutMs?: number;
  /** Uniform [0, 1) source for backoff jitter (tests). */
  random?: () => number;
};

export const PCS_DEFAULT_BASE_URL = "https://api.trustedservices.intel.com";
export const PCS_DEFAULT_ROOT_CA_CRL_URL = "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";
export const PCS_STALE_GRACE_MAX_SEC = 72 * 3600;
const DEFAULTS = {
  refreshAfterSec: 24 * 3600,
  refreshAheadSec: 6 * 3600,
  staleGraceSec: 48 * 3600,
  backoffBaseSec: 15,
  backoffMaxSec: 15 * 60,
  timeoutMs: 30_000,
} as const;
/** Never start a background refresh sooner than this after a successful fetch. */
const MIN_REFRESH_INTERVAL_SEC = 600;

/**
 * A PCS request failed. `outage` is true only when PCS was unreachable (network error, timeout, HTTP 408/429/5xx);
 * any answer from PCS, including an error status or a malformed body, is not an outage.
 */
export class PcsFetchError extends Error {
  constructor(message: string, readonly outage: boolean) {
    super(message);
    this.name = "PcsFetchError";
  }
}

type Component = "tcb" | "qe" | "pckCrl" | "rootCrl";
const COMPONENTS: readonly Component[] = ["tcb", "qe", "pckCrl", "rootCrl"];
const COMPONENT_FIELDS: Record<Component, readonly (keyof TdxCollateral)[]> = {
  tcb: ["tcb_info", "tcb_info_signature", "tcb_info_issuer_chain"],
  qe: ["qe_identity", "qe_identity_signature", "qe_identity_issuer_chain"],
  pckCrl: ["pck_crl", "pck_crl_issuer_chain"],
  rootCrl: ["root_ca_crl"],
};
type Entry = { collateral: TdxCollateral; fetchedAt: number; nextUpdate: number; origin: "pcs" | "disk" };
type KeyState = {
  entry?: Entry;
  diskChecked: boolean;
  inflight?: Promise<Entry>;
  failures: number;
  retryAt: number;
  lastFailure?: "outage" | "answered";
  /** Fingerprints of collateral that failed verification here; the persisted cache never brings these back. */
  rejected: string[];
};
const MAX_REJECTED = 8;

/**
 * Intel PCS v4 collateral per FMSPC/CA pair, with:
 * - one in-flight request per pair, shared by concurrent callers;
 * - an optional persisted cache (`cacheDir`), so a restart does not depend on PCS;
 * - background refresh ahead of expiry (daily, and at the latest `refreshAheadSec` before the earliest nextUpdate);
 * - serve-stale for at most `staleGraceSec` past nextUpdate, only while PCS is unreachable;
 * - exponential backoff with jitter after failures.
 * Each component (TCB info, QE identity, PCK CRL, root CRL) is replaced as soon as PCS returns it, so a fresh CRL or TCB
 * info is never masked by a stale copy of it.
 *
 * Nothing is trusted because it is cached: every component PCS returns and every persisted entry is authenticated
 * against the pinned Intel root (verifyCollateralComponent) before it is used, so its nextUpdate is Intel's; an answer
 * or file that fails is refused. The TCB evaluation data never goes backwards: a TCB info or QE identity with a lower
 * tcbEvaluationDataNumber (or, at the same number, an earlier issueDate), or a CRL with an earlier thisUpdate, never
 * replaces the cached one. A copy that later fails verification is dropped through invalidate() and fetched again.
 */
export class PcsCollateralSource implements CollateralSource {
  private readonly states = new Map<string, KeyState>();
  private cacheDir?: string;
  private readonly settings: { refreshAfterSec: number; refreshAheadSec: number; staleGraceSec: number; backoffBaseSec: number; backoffMaxSec: number; timeoutMs: number };

  constructor(private readonly options: PcsOptions = {}) {
    const grace = options.staleGraceSec ?? DEFAULTS.staleGraceSec;
    if (!Number.isFinite(grace) || grace < 0 || grace > PCS_STALE_GRACE_MAX_SEC) {
      throw new RangeError(`staleGraceSec must be between 0 and ${PCS_STALE_GRACE_MAX_SEC}`);
    }
    const positive = (value: number | undefined, fallback: number, name: string) => {
      const chosen = value ?? fallback;
      if (!Number.isFinite(chosen) || chosen <= 0) throw new RangeError(`${name} must be positive`);
      return chosen;
    };
    this.settings = {
      refreshAfterSec: positive(options.refreshAfterSec, DEFAULTS.refreshAfterSec, "refreshAfterSec"),
      refreshAheadSec: positive(options.refreshAheadSec, DEFAULTS.refreshAheadSec, "refreshAheadSec"),
      staleGraceSec: grace,
      backoffBaseSec: positive(options.backoffBaseSec, DEFAULTS.backoffBaseSec, "backoffBaseSec"),
      backoffMaxSec: positive(options.backoffMaxSec, DEFAULTS.backoffMaxSec, "backoffMaxSec"),
      timeoutMs: positive(options.timeoutMs, DEFAULTS.timeoutMs, "timeoutMs"),
    };
    if (options.cacheDir) this.cacheDir = resolve(options.cacheDir);
  }

  /** Start persisting to `dir` if this source has no cache directory yet (the first configured directory wins). */
  persistTo(dir: string): void {
    if (this.cacheDir) return;
    this.cacheDir = resolve(dir);
    for (const state of this.states.values()) state.diskChecked = false;
  }

  get persistenceDir(): string | undefined { return this.cacheDir; }

  async get(fmspc: string, ca: "platform" | "processor", signal?: AbortSignal): Promise<TdxCollateral> {
    const callerSignal = signal ?? this.options.signal;
    callerSignal?.throwIfAborted();
    const normalizedFmspc = fmspc.toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(normalizedFmspc) || (ca !== "platform" && ca !== "processor")) {
      throw new PcsFetchError("PCS invalid FMSPC or CA", false);
    }
    return withSignal(this.resolveCollateral(normalizedFmspc, ca), callerSignal);
  }

  /** Wait for background refreshes to settle (tests and orderly shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => state.inflight?.catch(() => undefined)));
  }

  /**
   * `collateral` failed signature or chain verification. If it is still the cached copy, drop it (and never adopt it
   * from the persisted cache again) so the next get fetches a new one. A copy PCS itself served within the last
   * MIN_REFRESH_INTERVAL_SEC is not requested again at once: that refetch backs off like a failed request.
   */
  invalidate(fmspc: string, ca: "platform" | "processor", collateral: TdxCollateral): void {
    const state = this.states.get(`${fmspc.toUpperCase()}:${ca}`);
    const entry = state?.entry;
    if (!state || !entry) return;
    const print = fingerprint(collateral);
    if (fingerprint(entry.collateral) !== print) return;
    const now = this.now();
    state.entry = undefined;
    this.reject(state, print);
    if (entry.origin === "pcs" && now - entry.fetchedAt < MIN_REFRESH_INTERVAL_SEC) this.recordFailure(state, "answered", now);
    else state.retryAt = 0;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now() / 1000;
  }

  private async resolveCollateral(fmspc: string, ca: "platform" | "processor"): Promise<TdxCollateral> {
    const key = `${fmspc}:${ca}`;
    let state = this.states.get(key);
    if (!state) {
      state = { diskChecked: false, failures: 0, retryAt: 0, rejected: [] };
      this.states.set(key, state);
    }
    const firstLook = !state.diskChecked;
    if (firstLook) await this.adoptDiskEntry(state, fmspc, ca);
    const now = this.now();
    const cached = state.entry;
    if (cached && now <= cached.nextUpdate) {
      if (now >= this.refreshAt(cached) && now >= state.retryAt && !state.inflight) {
        void this.refresh(state, fmspc, ca).catch(() => undefined);
      }
      return cached.collateral;
    }

    // Missing (never cached, or dropped by invalidate) or past nextUpdate: another process may have refreshed the shared
    // cache directory.
    if (!firstLook && await this.adoptDiskEntry(state, fmspc, ca) && now <= state.entry!.nextUpdate) return state.entry!.collateral;
    let failure: unknown = new PcsFetchError("PCS backoff after a failed request", state.lastFailure === "outage");
    if (now >= state.retryAt || state.inflight) {
      try {
        const entry = await this.refresh(state, fmspc, ca);
        if (this.now() <= entry.nextUpdate) return entry.collateral;
        failure = new PcsFetchError("PCS collateral already expired", false);
      } catch (error) {
        failure = error;
      }
    }
    // A partial answer may already have replaced the expired component.
    const current = state.entry;
    const at = this.now();
    if (current && at <= current.nextUpdate) return current.collateral;
    if (current && state.lastFailure === "outage" && this.settings.staleGraceSec > 0
      && at <= current.nextUpdate + this.settings.staleGraceSec) {
      return markStaleCollateral({ ...current.collateral }, this.settings.staleGraceSec);
    }
    throw failure;
  }

  private refreshAt(entry: Entry): number {
    const due = Math.min(entry.fetchedAt + this.settings.refreshAfterSec, entry.nextUpdate - this.settings.refreshAheadSec);
    return Math.max(entry.fetchedAt + MIN_REFRESH_INTERVAL_SEC, due);
  }

  private refresh(state: KeyState, fmspc: string, ca: "platform" | "processor"): Promise<Entry> {
    state.inflight ??= this.fetchRound(state, fmspc, ca).finally(() => { state.inflight = undefined; });
    return state.inflight;
  }

  private async fetchRound(state: KeyState, fmspc: string, ca: "platform" | "processor"): Promise<Entry> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? PCS_DEFAULT_BASE_URL).replace(/\/$/, "");
    const rootUrl = this.options.rootCaCrlUrl ?? PCS_DEFAULT_ROOT_CA_CRL_URL;
    const signals = [AbortSignal.timeout(this.settings.timeoutMs), ...(this.options.signal ? [this.options.signal] : [])];
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const request = async (url: string): Promise<Response> => {
      let response: Response;
      try {
        response = await fetcher(url, { signal });
      } catch (error) {
        throw new PcsFetchError(`PCS unreachable: ${error instanceof Error ? error.name : "error"}`, true);
      }
      if (!response.ok) throw new PcsFetchError(`PCS HTTP ${response.status}`, isOutageStatus(response.status));
      return response;
    };
    const body = async <T>(read: () => Promise<T>): Promise<T> => {
      try { return await read(); } catch { throw new PcsFetchError("PCS response interrupted", true); }
    };
    const answered = <T>(parse: () => T): T => {
      try { return parse(); } catch (error) {
        throw new PcsFetchError(error instanceof Error ? error.message : "PCS malformed response", false);
      }
    };

    const fetchers: Record<Component, () => Promise<Partial<TdxCollateral>>> = {
      tcb: async () => {
        const response = await request(`${baseUrl}/tdx/certification/v4/tcb?fmspc=${fmspc}`);
        const text = await body(() => response.text());
        return answered(() => {
          const signature = (JSON.parse(text) as { signature: unknown }).signature;
          if (typeof signature !== "string") throw new Error("PCS missing signature");
          const tcbInfo = extractSignedBody(text, "tcbInfo");
          signedNextUpdate(tcbInfo);
          return { tcb_info: tcbInfo, tcb_info_signature: signature, tcb_info_issuer_chain: requiredHeader(response, "TCB-Info-Issuer-Chain") };
        });
      },
      qe: async () => {
        const response = await request(`${baseUrl}/tdx/certification/v4/qe/identity`);
        const text = await body(() => response.text());
        return answered(() => {
          const signature = (JSON.parse(text) as { signature: unknown }).signature;
          if (typeof signature !== "string") throw new Error("PCS missing signature");
          const qeIdentity = extractSignedBody(text, "enclaveIdentity");
          signedNextUpdate(qeIdentity);
          return { qe_identity: qeIdentity, qe_identity_signature: signature, qe_identity_issuer_chain: requiredHeader(response, "SGX-Enclave-Identity-Issuer-Chain") };
        });
      },
      pckCrl: async () => {
        const response = await request(`${baseUrl}/sgx/certification/v4/pckcrl?ca=${ca}&encoding=der`);
        const bytes = new Uint8Array(await body(() => response.arrayBuffer()));
        return answered(() => {
          parseCrl(bytes);
          return { pck_crl: toHex(bytes), pck_crl_issuer_chain: requiredHeader(response, "SGX-PCK-CRL-Issuer-Chain") };
        });
      },
      rootCrl: async () => {
        const response = await request(rootUrl);
        const bytes = new Uint8Array(await body(() => response.arrayBuffer()));
        return answered(() => {
          parseCrl(bytes);
          return { root_ca_crl: toHex(bytes) };
        });
      },
    };

    const accept = async (component: Component): Promise<Partial<TdxCollateral>> => {
      const part = await fetchers[component]();
      try {
        verifyCollateralComponent(component, part, { fmspc, ca });
      } catch (error) {
        throw new PcsFetchError(`PCS ${component} rejected: ${error instanceof DcapError ? error.code : "invalid"}`, false);
      }
      const cached = state.entry?.collateral;
      if (cached && isOlderCollateral(component, part, cached)) throw new PcsFetchError(`PCS ${component} older than cached`, false);
      return part;
    };
    const results = await Promise.allSettled(COMPONENTS.map(accept));
    const now = this.now();
    const fresh: Partial<TdxCollateral> = {};
    const errors: unknown[] = [];
    results.forEach((result) => {
      if (result.status === "fulfilled") Object.assign(fresh, result.value);
      else errors.push(result.reason);
    });

    if (errors.length === 0) {
      const collateral = parseCollateralJson(fresh);
      const entry: Entry = { collateral, fetchedAt: now, nextUpdate: collateralNextUpdate(collateral), origin: "pcs" };
      state.entry = entry;
      if (entry.nextUpdate < now) this.recordFailure(state, "answered", now);
      else { state.failures = 0; state.retryAt = 0; state.lastFailure = undefined; }
      await this.persist(fmspc, ca, entry);
      return entry;
    }

    // Keep every component PCS did return: a fresh CRL or TCB info must never be masked by a cached copy.
    if (state.entry && Object.keys(fresh).length > 0) {
      const collateral = { ...state.entry.collateral, ...fresh };
      state.entry = { collateral, fetchedAt: state.entry.fetchedAt, nextUpdate: collateralNextUpdate(collateral), origin: state.entry.origin };
      await this.persist(fmspc, ca, state.entry);
    }
    const outage = errors.every((error) => error instanceof PcsFetchError && error.outage);
    this.recordFailure(state, outage ? "outage" : "answered", now);
    throw errors.find((error) => !(error instanceof PcsFetchError && error.outage)) ?? errors[0];
  }

  private reject(state: KeyState, print: string): void {
    if (!state.rejected.includes(print)) state.rejected = [...state.rejected.slice(1 - MAX_REJECTED), print];
  }

  private recordFailure(state: KeyState, kind: "outage" | "answered", now: number): void {
    state.failures += 1;
    state.lastFailure = kind;
    const ceiling = Math.min(this.settings.backoffMaxSec, this.settings.backoffBaseSec * 2 ** Math.min(state.failures - 1, 30));
    const random = this.options.random ?? Math.random;
    // Equal jitter: at least half the exponential delay, so callers never retry in lockstep.
    state.retryAt = now + ceiling / 2 + random() * (ceiling / 2);
  }

  private fileFor(fmspc: string, ca: "platform" | "processor"): string | undefined {
    return this.cacheDir ? join(this.cacheDir, `${fmspc}-${ca}.json`) : undefined;
  }

  /**
   * Adopt a persisted entry when it is authentic and newer than the in-memory one. The file is written by this or
   * another process but read back as untrusted: unreadable, malformed or unsigned files, collateral for another
   * FMSPC/CA, anything rejected here before and anything older than the in-memory copy are ignored (and overwritten
   * by the next fetch).
   */
  private async adoptDiskEntry(state: KeyState, fmspc: string, ca: "platform" | "processor"): Promise<boolean> {
    state.diskChecked = true;
    const file = this.fileFor(fmspc, ca);
    if (!file) return false;
    try {
      const stored = JSON.parse(await readFile(file, "utf8")) as { v?: unknown; fmspc?: unknown; ca?: unknown; fetchedAt?: unknown; collateral?: unknown };
      if (stored.v !== 1 || stored.fmspc !== fmspc || stored.ca !== ca) return false;
      const collateral = parseCollateralJson(stored.collateral);
      const print = fingerprint(collateral);
      if (state.rejected.includes(print)) return false;
      try {
        verifyCollateralSignatures(collateral, { fmspc, ca });
      } catch {
        this.reject(state, print);
        return false;
      }
      const nextUpdate = collateralNextUpdate(collateral);
      const fetchedAt = typeof stored.fetchedAt === "number" && Number.isFinite(stored.fetchedAt) ? Math.min(stored.fetchedAt, this.now()) : 0;
      const current = state.entry;
      if (current) {
        if (COMPONENTS.some((component) => isOlderCollateral(component, collateral, current.collateral))) return false;
        if (nextUpdate <= current.nextUpdate && fetchedAt <= current.fetchedAt) return false;
      }
      state.entry = { collateral, fetchedAt, nextUpdate, origin: "disk" };
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort atomic write; a read-only or missing state directory only costs the cache after a restart. */
  private async persist(fmspc: string, ca: "platform" | "processor", entry: Entry): Promise<void> {
    const file = this.fileFor(fmspc, ca);
    if (!file || !this.cacheDir) return;
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ v: 1, fmspc, ca, fetchedAt: entry.fetchedAt, collateral: entry.collateral }), { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      // Ignore: the in-memory cache still serves this process.
    }
  }
}

const shared = new Map<string, PcsCollateralSource>();

/**
 * The process-wide PCS collateral cache for a PCS endpoint. Every verifier in a process (attestor checks, consensus and
 * juror quote checks, the juror's Phala ACI DCAP check) shares it, so concurrent checks issue one PCS request per
 * FMSPC/CA. A `cacheDir` enables persistence; the first one supplied wins.
 */
export function sharedPcsCollateralSource(options: { baseUrl?: string; rootCaCrlUrl?: string; cacheDir?: string } = {}): PcsCollateralSource {
  const baseUrl = (options.baseUrl || PCS_DEFAULT_BASE_URL).replace(/\/$/, "");
  const rootCaCrlUrl = options.rootCaCrlUrl || PCS_DEFAULT_ROOT_CA_CRL_URL;
  const key = JSON.stringify([baseUrl, rootCaCrlUrl]);
  let source = shared.get(key);
  if (!source) {
    source = new PcsCollateralSource({ baseUrl, rootCaCrlUrl });
    shared.set(key, source);
  }
  if (options.cacheDir) source.persistTo(options.cacheDir);
  return source;
}

/** Earliest nextUpdate (unix seconds) of the TCB info, QE identity and both CRLs. Throws on malformed collateral. */
export function collateralNextUpdate(collateral: TdxCollateral): number {
  const values = [
    signedNextUpdate(collateral.tcb_info),
    signedNextUpdate(collateral.qe_identity),
    parseCrl(fromHex(collateral.root_ca_crl)).nextUpdate,
    parseCrl(fromHex(collateral.pck_crl)).nextUpdate,
  ];
  if (values.some((value) => !Number.isFinite(value))) throw new Error("collateral nextUpdate");
  return Math.min(...values);
}

/** Version of one component, for the never-go-backwards rule: TCB evaluation number, then issue time. */
function componentVersion(component: CollateralComponent, collateral: Partial<TdxCollateral>): { evaluation?: number; issued: number } {
  if (component === "pckCrl" || component === "rootCrl") {
    return { issued: parseCrl(fromHex(component === "pckCrl" ? collateral.pck_crl! : collateral.root_ca_crl!)).thisUpdate };
  }
  const body = JSON.parse(component === "tcb" ? collateral.tcb_info! : collateral.qe_identity!) as { tcbEvaluationDataNumber?: unknown; issueDate?: unknown };
  const evaluation = Number.isSafeInteger(body.tcbEvaluationDataNumber) ? body.tcbEvaluationDataNumber as number : undefined;
  const issued = Date.parse(String(body.issueDate)) / 1000;
  if (!Number.isFinite(issued)) throw new Error("collateral issueDate");
  return { evaluation, issued };
}

/**
 * True when `candidate`'s component is older than `current`'s and must not replace it: a TCB info or QE identity with a
 * lower tcbEvaluationDataNumber (or none where the current one has one), or the same number and an earlier issueDate;
 * a CRL with an earlier thisUpdate.
 */
export function isOlderCollateral(component: CollateralComponent, candidate: Partial<TdxCollateral>, current: TdxCollateral): boolean {
  const next = componentVersion(component, candidate);
  const now = componentVersion(component, current);
  if (now.evaluation !== undefined) {
    if (next.evaluation === undefined || next.evaluation < now.evaluation) return true;
    if (next.evaluation > now.evaluation) return false;
  }
  return next.issued < now.issued;
}

function fingerprint(collateral: TdxCollateral): string {
  const canonical = JSON.stringify([
    collateral.pck_crl_issuer_chain, collateral.root_ca_crl, collateral.pck_crl, collateral.tcb_info_issuer_chain,
    collateral.tcb_info, collateral.tcb_info_signature, collateral.qe_identity_issuer_chain, collateral.qe_identity,
    collateral.qe_identity_signature,
  ]);
  return toHex(sha256(new TextEncoder().encode(canonical)));
}

function signedNextUpdate(body: string): number {
  const value = Date.parse(String((JSON.parse(body) as { nextUpdate?: unknown }).nextUpdate)) / 1000;
  if (!Number.isFinite(value)) throw new Error("PCS malformed nextUpdate");
  return value;
}

function isOutageStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function fromHex(value: string): Uint8Array {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new Error("collateral malformed");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}


function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`PCS missing ${name}`);
  return decodeURIComponent(value);
}

function extractSignedBody(text: string, key: string): string {
  let offset = 0;
  while (/\s/.test(text[offset] ?? "")) offset++;
  if (text[offset++] !== "{") throw new Error("PCS malformed JSON");

  while (offset < text.length) {
    while (/[\s,]/.test(text[offset] ?? "")) offset++;
    if (text[offset] === "}") break;
    if (text[offset] !== '"') throw new Error("PCS malformed JSON");
    const keyStart = offset;
    offset = quotedEnd(text, offset);
    const name = JSON.parse(text.slice(keyStart, offset)) as string;
    while (/\s/.test(text[offset] ?? "")) offset++;
    if (text[offset++] !== ":") throw new Error("PCS malformed JSON");
    while (/\s/.test(text[offset] ?? "")) offset++;

    const valueStart = offset;
    const valueEnd = scanValueEnd(text, offset);
    if (name === key) {
      if (text[offset] !== "{") throw new Error("PCS malformed JSON");
      return text.slice(valueStart, valueEnd);
    }
    offset = valueEnd;
  }
  throw new Error(`PCS missing ${key}`);
}

function quotedEnd(text: string, start: number): number {
  let escaped = false;
  for (let offset = start + 1; offset < text.length; offset++) {
    const character = text[offset]!;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return offset + 1;
  }
  throw new Error("PCS malformed JSON");
}

function scanValueEnd(text: string, start: number): number {
  if (text[start] === '"') return quotedEnd(text, start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = start; offset < text.length; offset++) {
    const character = text[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth++;
    } else if (character === "}" || character === "]") {
      if (depth === 0) return offset;
      depth--;
      if (depth === 0) return offset + 1;
    } else if (character === "," && depth === 0) {
      return offset;
    }
  }
  return text.length;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
