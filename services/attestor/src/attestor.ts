import { keyBinding } from "@mochi/tee";
import type { Quote } from "@mochi/tee";
import { Role } from "@mochi/core";
import { recoverMessageAddress, type Address, type Hex } from "viem";
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

export function createAttestor(deps: AttestorDeps) {
  const keys = new Set<Address>();
  const reportedFailures = new Set<Address>();
  const lastChecks = new Map<Address, CheckResult>();
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
    let endpoint: Endpoint | null;
    try {
      endpoint = await endpointFor(key);
    } catch {
      // A database outage is an availability problem of this service, never evidence about the enclave.
      return failed("endpoint store unavailable");
    }
    if (!endpoint) return failed("endpoint not registered");

    let doc;
    try {
      doc = await deps.http.fetchAttestation(endpoint.url);
    } catch (error) {
      // Network and HTTP transport failures are availability issues, never slashable verification failures.
      if (error instanceof EndpointUnavailableError) return failed("endpoint unreachable");
      return failed("invalid attestation document");
    }

    let juror: JurorRecord;
    try {
      juror = await deps.chain.getJuror(key);
    } catch {
      return failed("registry read failed");
    }
    let reason: string | undefined;
    // The quote must prove the measurement the document claims. That is the key's enrolled measurement or, after an
    // upgrade, another measurement governance allows for the same role: the registry keeps the measurement a key was
    // enrolled with, while the same KMS-derived key now runs the new build. A measurement outside the role's allowlist
    // is still a slashable mismatch.
    let expectedMeasurement: Hex = juror.measurement;
    if (doc.address.toLowerCase() !== key.toLowerCase()) reason = "attestation address mismatch";
    else if (doc.role !== roleName(endpoint.role) || doc.role !== roleName(juror.role)) reason = "attestation role mismatch";
    else if (juror.role === Role.JUROR && doc.jurorClass !== juror.jurorClass) reason = "juror class mismatch";
    else if (doc.measurement.toLowerCase() !== juror.measurement.toLowerCase()) {
      try {
        if (await allowed(doc.measurement as Hex, juror.role)) expectedMeasurement = doc.measurement as Hex;
        else reason = "measurement mismatch";
      } catch {
        reason = "registry read failed";
      }
    }
    if (!reason) {
      try {
        const verified = await deps.quoteVerifier.verify(doc.quote as Quote, {
          measurement: expectedMeasurement,
          reportData: keyBinding(key, doc.encryptionPubKey as Hex),
          maxAgeSec: deps.maxQuoteAgeSec,
        });
        if (!verified.ok) reason = verified.reason ?? "quote verification failed";
      } catch {
        // A verifier crash (collateral service, parser bug) says nothing about the enclave.
        reason = "quote verifier unavailable";
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
   * Send refreshes for the keys that need one. A batch that reverts is split until the failing key is isolated, so
   * one bad key cannot hold back the others. Returns the keys whose refresh failed.
   */
  async function refresh(batch: Address[], until: bigint): Promise<Address[]> {
    if (batch.length === 0) return [];
    try {
      await deps.chain.refreshAttestation(batch, until);
      return [];
    } catch (error) {
      if (batch.length === 1) {
        log("error", "attestation_refresh_failed", { address: batch[0], error: errorText(error) });
        return batch;
      }
      const middle = Math.ceil(batch.length / 2);
      return [...await refresh(batch.slice(0, middle), until), ...await refresh(batch.slice(middle), until)];
    }
  }

  async function checkAll(): Promise<CheckResult[]> {
    await indexEnrollments();
    const allowed = allowlist();
    const checkedRows: Checked[] = [];
    for (const key of keys) {
      try {
        checkedRows.push(await checkOne(key, allowed));
      } catch (error) {
        // Isolate unexpected failures to this key; never slashable.
        log("error", "attestation_check_crashed", { address: key, error: errorText(error) });
        checkedRows.push({ result: { address: key, ok: false, reason: "check failed", checkedAt: deps.clock.nowDate().toISOString() }, passed: false });
      }
    }
    const largeALineages = new Set(checkedRows
      .filter((row) => row.passed && row.juror?.jurorClass === 0 && row.passportDoc)
      .map((row) => row.passportDoc!.passport.lineage.toLowerCase()));
    for (const row of checkedRows) {
      if (row.passed && row.juror?.jurorClass === 4 && row.passportDoc && largeALineages.has(row.passportDoc.passport.lineage.toLowerCase())) {
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
    const failedRefresh = new Set<Address>();
    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      for (const key of await refresh(due.slice(i, i + BATCH_SIZE), until)) failedRefresh.add(key);
    }
    const results: CheckResult[] = [];
    for (const checked of checkedRows) {
      const result = failedRefresh.has(checked.result.address)
        ? { ...checked.result, ok: false, reason: "attestation refresh failed" }
        : checked.result;
      results.push(result);
      lastChecks.set(result.address, result);
    }
    return results;
  }

  return {
    checkAll,
    listChecks: () => [...lastChecks.values()],
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
 * Only failures that are positive evidence of a non-genuine or misrepresented enclave are reported (5% slash). This
 * is an allow-list: liveness, transport, registry, database and Intel PCS/collateral problems (unreachable endpoints,
 * malformed documents, stale quotes, collateral unavailable or expired, CRL or TCB-info errors, platform TCB status or
 * advisory policy, clock-dependent certificate validity, verifier crashes) and any reason not listed here just let the
 * attestation lapse. Otherwise an outage of Intel PCS, or anyone able to disturb an endpoint's network path, could get
 * every honest juror slashed.
 */
const SLASHABLE = new Set([
  // The enclave registered for this key claims a different identity, role, class, or a measurement outside the
  // allowlist for its role.
  "attestation address mismatch",
  "attestation role mismatch",
  "measurement mismatch",
  "juror class mismatch",
  // Quote evidence that is forged, altered, debug-mode or bound to other keys or code. These checks need no Intel
  // collateral, or compare the quote with Intel-signed identities that a genuine TDX platform always matches.
  "wrong quote kind",
  "measurement field mismatch",
  "reportData field mismatch",
  "issuedAt field mismatch",
  "unexpected measurement",
  "unexpected reportData",
  "reportData layout",
  "debug TD",
  "invalid quote tag",
  "invalid mock root signature",
  "malformed mock quote",
  // The quote's PCK chain, checked against the pinned Intel root before any collateral is fetched. Only Intel can
  // issue a chain that passes, so a self-made chain or an altered PCK certificate (for example a bogus FMSPC) is
  // forgery. Certificate validity windows depend on the clock and are deliberately not listed.
  "dcap: PCK chain",
  "dcap: PCK untrusted root",
  "dcap: PCK certificate CA",
  "dcap: PCK certificate issuer",
  "dcap: PCK certificate signature",
  "dcap: PCK root signature",
  "dcap: PCK extension",
  "dcap: PCK CA",
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
