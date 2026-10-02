import { keyBinding } from "@mochi/tee";
import type { Quote } from "@mochi/tee";
import { Role } from "@mochi/core";
import { ContractFunctionRevertedError, recoverMessageAddress, type Address, type Hex } from "viem";
import { JurorAttestationDocSchema, passportHash } from "@mochi/protocol";
import type { JurorAttestationDoc } from "@mochi/protocol";
import { log } from "./log.ts";
import type { AttestorDeps, Endpoint, JurorRecord } from "./ports.ts";
import { EndpointUnavailableError } from "./adapters/enclave-http.ts";

export interface CheckResult {
  address: Address;
  ok: boolean;
  reason: string | null;
  checkedAt: string;
}

const BATCH_SIZE = 50;
const CURSOR_NAME = "attestor";
const LOG_SCAN_BLOCKS = 2_000n;
const DEFAULT_ENDPOINT_CACHE_SEC = 300;
/** Never re-send a refresh for a key whose on-chain attestation was extended less than this long ago. */
const MIN_REFRESH_GAP_SEC = 300;

type Checked = {
  result: CheckResult;
  passed: boolean;
  role?: number;
  juror?: JurorRecord;
  passportDoc?: JurorAttestationDoc;
};

type RefreshFailure = { kind: "transient" } | { kind: "revert"; errorName?: string; args: readonly unknown[] };
type RefreshOutcome = { reverted: Set<Address>; deferred: Address[] };

export function createAttestor(deps: AttestorDeps) {
  const keys = new Set<Address>();
  const reportedFailures = new Set<Address>();
  const lastChecks = new Map<Address, CheckResult>();
  /** On-chain attestedUntil (unix seconds) per key as of its last check. */
  const attestedUntil = new Map<Address, number>();
  /** Lineage of each LARGE_A juror that passed its last check. */
  const largeALineages = new Map<Address, string>();
  const endpoints = new Map<string, { endpoint: Endpoint | null; readAt: number }>();
  const endpointCacheSec = deps.endpointCacheSec ?? DEFAULT_ENDPOINT_CACHE_SEC;
  // Enrolled keys are rebuilt from the registry's Enrolled logs at process start and then scanned incrementally. The
  // store cursor is only a progress record: a database outage must never stop the scan or the refreshes.
  let scannedTo: bigint | undefined;

  async function indexEnrollments(): Promise<void> {
    const head = await deps.chain.blockNumber();
    if (head < deps.startBlock) return;
    let from = scannedTo === undefined ? deps.startBlock : scannedTo + 1n;
    while (from <= head) {
      const end = from + LOG_SCAN_BLOCKS - 1n < head ? from + LOG_SCAN_BLOCKS - 1n : head;
      await addEnrollments(from, end);
      scannedTo = end;
      from = end + 1n;
    }
    await deps.store.setCursor(CURSOR_NAME, head)
      .catch((error: unknown) => log("warn", "attestor_cursor_write_failed", { error: errorText(error) }));
  }

  async function addEnrollments(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const enrolled = await deps.chain.getEnrolled(fromBlock, toBlock);
    for (const row of enrolled) keys.add(row.key.toLowerCase() as Address);
  }

  /** Endpoint for a key, cached in memory; a store failure falls back to the last value read, however old. */
  async function endpointFor(key: Address): Promise<Endpoint | null> {
    const id = key.toLowerCase();
    const cached = endpoints.get(id);
    const now = deps.clock.nowSeconds();
    if (cached && now - cached.readAt < endpointCacheSec) return cached.endpoint;
    try {
      const endpoint = await deps.store.getEndpoint(key);
      endpoints.set(id, { endpoint, readAt: now });
      return endpoint;
    } catch (error) {
      if (cached) {
        log("warn", "endpoint_store_unavailable_using_cache", { address: key, error: errorText(error) });
        return cached.endpoint;
      }
      throw new EndpointStoreUnavailableError();
    }
  }

  /** Allowlist reads, memoized for one pass. */
  function allowlist() {
    const seen = new Map<string, Promise<boolean>>();
    return (measurement: Hex, role: number) => {
      const id = `${measurement.toLowerCase()}:${role}`;
      let value = seen.get(id);
      if (!value) { value = deps.chain.measurementAllowed(measurement, role); seen.set(id, value); }
      return value;
    };
  }

  async function checkOne(key: Address, allowed: ReturnType<typeof allowlist>): Promise<Checked> {
    const checkedAt = deps.clock.nowDate().toISOString();
    const failed = (reason: string, extra: Omit<Checked, "result" | "passed"> = {}): Checked => ({
      result: { address: key, ok: false, reason, checkedAt }, passed: false, ...extra,
    });
    // The registry record comes first: its attestedUntil bounds this key's retry delay even when the endpoint is down.
    let juror: JurorRecord;
    try {
      juror = await deps.chain.getJuror(key);
    } catch {
      return failed("registry read failed");
    }
    const withJuror = { role: juror.role, juror };

    let endpoint: Endpoint | null;
    try {
      endpoint = await endpointFor(key);
    } catch {
      // A database outage is an availability problem of this service, never evidence about the enclave.
      return failed("endpoint store unavailable", withJuror);
    }
    if (!endpoint) return failed("endpoint not registered", withJuror);

    let doc;
    try {
      doc = await deps.http.fetchAttestation(endpoint.url);
    } catch (error) {
      // Network and HTTP transport failures are availability issues, never slashable verification failures.
      if (error instanceof EndpointUnavailableError) return failed("endpoint unreachable", withJuror);
      return failed("invalid attestation document", withJuror);
    }

    let reason: string | undefined;
    if (doc.address.toLowerCase() !== key.toLowerCase()) reason = "attestation address mismatch";
    else if (doc.role !== roleName(endpoint.role) || doc.role !== roleName(juror.role)) reason = "attestation role mismatch";
    else if (juror.role === Role.JUROR && doc.jurorClass !== juror.jurorClass) reason = "juror class mismatch";
    // The measurement decision below uses only the measurement the verified quote proves, never the document's claim.
    let measurement: Hex | undefined;
    if (!reason) {
      try {
        const verified = await deps.quoteVerifier.verify(doc.quote as Quote, {
          reportData: keyBinding(key, doc.encryptionPubKey as Hex),
          maxAgeSec: deps.maxQuoteAgeSec,
        });
        if (!verified.ok) reason = verified.reason ?? "quote verification failed";
        else if (!verified.measurement) reason = "quote verification failed";
        else measurement = verified.measurement;
      } catch {
        // A verifier crash (collateral service, parser bug) says nothing about the enclave.
        reason = "quote verifier unavailable";
      }
    }
    // A document that claims a measurement its own genuine quote does not prove misrepresents the enclave.
    if (!reason && doc.measurement.toLowerCase() !== measurement!.toLowerCase()) reason = "unexpected measurement";
    if (!reason) {
      // The verified measurement must be the key's enrolled one or, after an upgrade, another measurement governance
      // allows for the same role: the registry keeps the measurement a key was enrolled with, while the same KMS-derived
      // key now runs the new build. A genuine quote of any other build only lets the attestation lapse. It is never
      // slashed, so deploying before the allowlist update, or governance removing a build that is still running,
      // deactivates keys without costing their bonds.
      if (measurement!.toLowerCase() !== juror.measurement.toLowerCase()) {
        try {
          if (!(await allowed(measurement!, juror.role))) reason = "measurement not allowed";
        } catch {
          reason = "registry read failed";
        }
      }
    }
    let passportDoc: JurorAttestationDoc | undefined;
    if (!reason && juror.role === Role.JUROR) {
      const parsed = JurorAttestationDocSchema.safeParse(doc);
      if (!parsed.success) reason = "passport missing or invalid";
      else {
        passportDoc = parsed.data;
        const passport = passportDoc.passport;
        try {
          const recovered = await recoverMessageAddress({ message: { raw: passportHash(passport) }, signature: passportDoc.passportSig as Hex });
          if (recovered.toLowerCase() !== key.toLowerCase()) reason = "passport signature mismatch";
          else if (passport.juror !== key.toLowerCase()) reason = "passport juror mismatch";
          else if (passport.jurorClass !== juror.jurorClass) reason = "passport class mismatch";
          else if (passport.tee !== doc.quote.kind) reason = "passport tee mismatch";
          else if (juror.jurorClass === 4 && deps.dissenterExcludedLineages.map((x) => x.toLowerCase()).includes(passport.lineage.toLowerCase())) {
            reason = "dissenter_lineage_excluded";
          }
        } catch {
          reason = "passport signature mismatch";
        }
      }
    }
    if (!reason) {
      // refreshAttestation reverts for a key whose enrolled measurement governance has since removed, which would also
      // block every other key in the same transaction. Such a key needs a new enrollment, not a refresh.
      try {
        if (!(await allowed(juror.measurement, juror.role))) reason = "enrolled measurement no longer allowed";
      } catch {
        reason = "registry read failed";
      }
    }
    return {
      result: { address: key, ok: !reason, reason: reason ?? null, checkedAt },
      passed: !reason,
      role: juror.role,
      juror,
      passportDoc,
    };
  }

  /**
   * Send refreshes for the keys that need one. Only a simulated revert is evidence about the keys: the key it names
   * (NotEnrolled, MeasurementNotAllowed) is dropped and the rest resent, and a revert that names no key splits the
   * batch until the failing key is isolated. A timeout or RPC error says nothing about the keys and may even have
   * been mined, so the whole batch, and every batch after it in this pass, is left for the next retry; that retry
   * reads attestedUntil again and so never sends a duplicate for a refresh that did land.
   */
  async function refresh(batch: Address[], until: bigint, jurors: ReadonlyMap<Address, JurorRecord>): Promise<RefreshOutcome> {
    const outcome: RefreshOutcome = { reverted: new Set(), deferred: [] };
    let pending = batch;
    while (pending.length > 0) {
      let failure: RefreshFailure;
      try {
        await deps.chain.refreshAttestation(pending, until);
        return outcome;
      } catch (error) {
        failure = classifyRefreshError(error);
        if (failure.kind === "transient") {
          log("warn", "attestation_refresh_deferred", { keys: pending.length, error: errorText(error) });
          outcome.deferred.push(...pending);
          return outcome;
        }
        if (failure.errorName === "AccessControlUnauthorizedAccount") {
          // No subset of keys can succeed: the attestor key itself lacks the role.
          log("error", "attestation_refresh_unauthorized", { error: errorText(error) });
          outcome.deferred.push(...pending);
          return outcome;
        }
      }
      const culprits = new Set(culpritsOf(failure, pending, jurors));
      if (culprits.size > 0) {
        for (const key of culprits) {
          log("error", "attestation_refresh_reverted", { address: key, error: failure.errorName });
          outcome.reverted.add(key);
        }
        pending = pending.filter((key) => !culprits.has(key));
        continue;
      }
      if (pending.length === 1) {
        log("error", "attestation_refresh_reverted", { address: pending[0], error: failure.errorName ?? "unknown revert" });
        outcome.reverted.add(pending[0]!);
        return outcome;
      }
      const middle = Math.ceil(pending.length / 2);
      const left = await refresh(pending.slice(0, middle), until, jurors);
      for (const key of left.reverted) outcome.reverted.add(key);
      if (left.deferred.length > 0) {
        outcome.deferred.push(...left.deferred, ...pending.slice(middle));
        return outcome;
      }
      const right = await refresh(pending.slice(middle), until, jurors);
      for (const key of right.reverted) outcome.reverted.add(key);
      outcome.deferred.push(...right.deferred);
      return outcome;
    }
    return outcome;
  }

  /**
   * Check the enrolled keys `isDue` selects (every key by default; a key never checked before is always included),
   * report forged evidence, and refresh the keys that passed.
   */
  async function checkAll(isDue: (key: Address) => boolean = () => true): Promise<CheckResult[]> {
    await indexEnrollments();
    const allowed = allowlist();
    const checkedRows: Checked[] = [];
    for (const key of keys) {
      if (lastChecks.has(key) && !isDue(key)) continue;
      try {
        checkedRows.push(await checkOne(key, allowed));
      } catch (error) {
        // Isolate unexpected failures to this key; never slashable.
        log("error", "attestation_check_crashed", { address: key, error: errorText(error) });
        checkedRows.push({ result: { address: key, ok: false, reason: "check failed", checkedAt: deps.clock.nowDate().toISOString() }, passed: false });
      }
    }
    // A DISSENTER's lineage must differ from every LARGE_A juror currently passing, including those not checked in
    // this pass.
    for (const row of checkedRows) {
      const key = row.result.address;
      if (row.passed && row.juror?.jurorClass === 0 && row.passportDoc) largeALineages.set(key, row.passportDoc.passport.lineage.toLowerCase());
      else largeALineages.delete(key);
    }
    const largeA = new Set(largeALineages.values());
    for (const row of checkedRows) {
      if (row.passed && row.juror?.jurorClass === 4 && row.passportDoc && largeA.has(row.passportDoc.passport.lineage.toLowerCase())) {
        row.passed = false;
        row.result = { ...row.result, ok: false, reason: "dissenter_lineage_not_distinct" };
      }
    }
    const now = deps.clock.nowSeconds();
    const due: Address[] = [];
    for (const checked of checkedRows) {
      const key = checked.result.address;
      if (checked.passed) {
        reportedFailures.delete(key);
        // Refresh only keys whose attestation was not just extended: a retry after another key failed must not send a
        // transaction for every healthy key again.
        if (checked.juror && checked.juror.attestedUntil <= BigInt(now + deps.validitySec - Math.min(MIN_REFRESH_GAP_SEC, Math.floor(deps.validitySec / 2)))) due.push(key);
      } else if (isSlashable(checked.result.reason)) {
        try {
          const role = checked.role;
          if (role !== undefined && await deps.chain.isActive(key, role) && !reportedFailures.has(key)) {
            await deps.chain.reportAttestationFailure(key);
            reportedFailures.add(key);
          }
        } catch (error) {
          log("error", "attestation_failure_report_failed", { address: key, error: errorText(error) });
        }
      }
      if (checked.juror && checked.role === Role.JUROR) {
        // Read-model write only: a DB failure must never block the on-chain refresh below.
        await deps.store.upsertJuror({
          key: key.toLowerCase() as Address,
          operator: checked.juror.operator.toLowerCase() as Address,
          measurement: checked.juror.measurement.toLowerCase() as Hex,
          class: checked.juror.jurorClass,
          role: checked.juror.role,
          bond: checked.juror.bond.toString(),
          attestedUntil: new Date(Number(checked.juror.attestedUntil) * 1_000),
          uptime30d: 0,
          served: checked.juror.served,
          timeouts: checked.juror.timeouts,
          slashed: "0",
          delisted: checked.juror.delisted,
        }).catch((error: unknown) => log("error", "juror_upsert_failed", { address: key, error: errorText(error) }));
        if (checked.passed && checked.passportDoc) {
          await deps.store.setJurorPassport(key.toLowerCase(), checked.passportDoc.passport, checked.passportDoc.passportSig)
            .catch((error: unknown) => log("error", "juror_passport_write_failed", { address: key, error: errorText(error) }));
        }
      }
    }
    const until = BigInt(now + deps.validitySec);
    const jurors = new Map(checkedRows.flatMap((row) => row.juror ? [[row.result.address, row.juror] as const] : []));
    const reverted = new Set<Address>();
    const deferred = new Set<Address>();
    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE);
      if (deferred.size > 0) {
        // An RPC failure earlier in this pass: do not queue another send (and another timeout) behind it.
        for (const key of batch) deferred.add(key);
        continue;
      }
      const outcome = await refresh(batch, until, jurors);
      for (const key of outcome.reverted) reverted.add(key);
      for (const key of outcome.deferred) deferred.add(key);
    }
    const sent = new Set(due);
    const results: CheckResult[] = [];
    for (const checked of checkedRows) {
      const key = checked.result.address;
      let result = checked.result;
      if (reverted.has(key)) result = { ...result, ok: false, reason: "attestation refresh reverted" };
      else if (deferred.has(key)) result = { ...result, ok: false, reason: "attestation refresh failed" };
      if (result.ok && sent.has(key)) attestedUntil.set(key, Number(until));
      else if (checked.juror) attestedUntil.set(key, Number(checked.juror.attestedUntil));
      results.push(result);
      lastChecks.set(key, result);
    }
    return results;
  }

  return {
    checkAll,
    listChecks: () => [...lastChecks.values()],
    /** The key's on-chain attestedUntil (unix seconds) as of its last check, including a refresh sent in that pass. */
    attestedUntil: (key: Address): number | undefined => attestedUntil.get(key.toLowerCase() as Address),
    registerEndpoint: async (address: Address, role: number, url: string) => {
      const doc = await deps.http.fetchAttestation(url);
      if (doc.address.toLowerCase() !== address.toLowerCase()) throw new Error("attestation address does not match");
      if (doc.role !== roleName(role)) throw new Error("attestation role does not match");
      await deps.store.upsertEndpoint(address, role, url);
      endpoints.set(address.toLowerCase(), { endpoint: { address, role, url }, readAt: deps.clock.nowSeconds() });
    },
  };
}

class EndpointStoreUnavailableError extends Error {
  constructor() { super("endpoint store unavailable"); this.name = "EndpointStoreUnavailableError"; }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown";
}

/**
 * A refresh failure is a revert only when the node returned revert data for the simulated call (viem's
 * ContractFunctionRevertedError with raw data; JurorRegistry reverts only with custom errors). Everything else
 * (timeouts, HTTP and RPC errors, a send or receipt that failed after simulation) is transient.
 */
export function classifyRefreshError(error: unknown): RefreshFailure {
  for (let current: unknown = error, depth = 0; current && depth < 10; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof ContractFunctionRevertedError) {
      if (!current.raw || current.raw === "0x") return { kind: "transient" };
      return { kind: "revert", errorName: current.data?.errorName, args: current.data?.args ?? [] };
    }
  }
  return { kind: "transient" };
}

/** The keys in `batch` that a decoded refreshAttestation revert names. */
function culpritsOf(failure: RefreshFailure, batch: readonly Address[], jurors: ReadonlyMap<Address, JurorRecord>): Address[] {
  if (failure.kind !== "revert") return [];
  if (failure.errorName === "NotEnrolled") {
    const named = String(failure.args[0] ?? "").toLowerCase();
    return batch.filter((key) => key.toLowerCase() === named);
  }
  if (failure.errorName === "MeasurementNotAllowed") {
    const measurement = String(failure.args[0] ?? "").toLowerCase();
    const role = Number(failure.args[1]);
    return batch.filter((key) => {
      const juror = jurors.get(key);
      return juror !== undefined && juror.measurement.toLowerCase() === measurement && juror.role === role;
    });
  }
  return [];
}

/**
 * Only failures that are positive evidence of a non-genuine or misrepresented enclave are reported (5% slash). This
 * is an allow-list: liveness, transport, registry, database and Intel PCS/collateral problems (unreachable endpoints,
 * malformed documents, stale quotes, collateral unavailable or expired, CRL or TCB-info errors, platform TCB status or
 * advisory policy, clock-dependent certificate validity, verifier crashes) and any reason not listed here just let the
 * attestation lapse. Otherwise an outage of Intel PCS, or anyone able to disturb an endpoint's network path, could get
 * every honest juror slashed. A genuine quote of a build outside the role's allowlist ("measurement not allowed",
 * "enrolled measurement no longer allowed") also only lapses: it is an upgrade-ordering or governance problem, not
 * forgery.
 */
const SLASHABLE = new Set([
  // The enclave registered for this key claims a different identity, role or class, or its document claims a
  // measurement that its own verified quote does not prove.
  "attestation address mismatch",
  "attestation role mismatch",
  "juror class mismatch",
  "unexpected measurement",
  // Quote evidence that is forged, altered, debug-mode or bound to other keys or code. These checks need no Intel
  // collateral, or compare the quote with Intel-signed identities that a genuine TDX platform always matches.
  "wrong quote kind",
  "measurement field mismatch",
  "reportData field mismatch",
  "issuedAt field mismatch",
  "unexpected reportData",
  "reportData layout",
  "debug TD",
  "invalid quote tag",
  "invalid mock root signature",
  "malformed mock quote",
  // The quote's PCK chain, checked against the pinned Intel root before any collateral is fetched, then the QE report
  // and quote signatures by the chain's leaf key. Only Intel can issue a chain that passes, so a self-made chain or an
  // altered PCK certificate (for example a bogus FMSPC) is forgery. Certificate validity windows depend on the clock
  // and are deliberately not listed. "dcap: PCK CA" (an intermediate under Intel's root with a name this code does not
  // know) is not listed either: only an Intel-issued chain whose leaf key signed the QE report reaches it, so a new
  // Intel CA name must lapse attestations, not slash every honest enclave.
  "dcap: PCK chain",
  "dcap: PCK untrusted root",
  "dcap: PCK certificate CA",
  "dcap: PCK certificate issuer",
  "dcap: PCK certificate signature",
  "dcap: PCK root signature",
  "dcap: PCK extension",
  "dcap: QE report signature",
  "dcap: QE report data",
  "dcap: quote signature",
  "dcap: QE identity mismatch",
  "dcap: TDX module identity",
]);

export function isSlashable(reason: string | null): boolean {
  return reason !== null && SLASHABLE.has(reason);
}

function roleName(role: number): "JUROR" | "INTAKE" | "CONSENSUS" | undefined {
  if (role === Role.JUROR) return "JUROR";
  if (role === Role.INTAKE) return "INTAKE";
  if (role === Role.CONSENSUS) return "CONSENSUS";
  return undefined;
}
