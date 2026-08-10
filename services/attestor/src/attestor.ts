import { keyBinding } from "@mochi/tee";
import type { Quote } from "@mochi/tee";
import { Role } from "@mochi/core";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { JurorAttestationDocSchema, passportHash } from "@mochi/protocol";
import type { JurorAttestationDoc } from "@mochi/protocol";
import { log } from "./log.ts";
import type { AttestorDeps } from "./ports.ts";
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

export function createAttestor(deps: AttestorDeps) {
  const keys = new Set<Address>();
  const reportedFailures = new Set<Address>();
  const lastChecks = new Map<Address, CheckResult>();
  let initialized = false;

  async function indexEnrollments(): Promise<void> {
    const head = await deps.chain.blockNumber();
    const saved = await deps.store.getCursor(CURSOR_NAME);
    const previousCursor = saved ?? deps.startBlock - 1n;
    if (head < deps.startBlock) {
      initialized = true;
      return;
    }
    // The DB cursor tracks progress, but keys are not persisted by the shared store API.
    // Rebuild the in-memory set on process start, then use the cursor incrementally.
    const replayTo = initialized ? deps.startBlock - 1n : (previousCursor < head ? previousCursor : head);
    let scan = deps.startBlock;
    while (scan <= replayTo) {
      const end = scan + LOG_SCAN_BLOCKS - 1n < replayTo ? scan + LOG_SCAN_BLOCKS - 1n : replayTo;
      await addEnrollments(scan, end);
      scan = end + 1n;
    }
    let cursor = previousCursor < deps.startBlock - 1n || previousCursor > head ? deps.startBlock - 1n : previousCursor;
    while (cursor < head) {
      const from = cursor + 1n;
      const end = from + LOG_SCAN_BLOCKS - 1n < head ? from + LOG_SCAN_BLOCKS - 1n : head;
      await addEnrollments(from, end);
      await deps.store.setCursor(CURSOR_NAME, end);
      cursor = end;
    }
    initialized = true;
  }

  async function addEnrollments(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const enrolled = await deps.chain.getEnrolled(fromBlock, toBlock);
    for (const row of enrolled) keys.add(row.key.toLowerCase() as Address);
  }

  async function checkOne(key: Address): Promise<{ result: CheckResult; passed: boolean; role?: number; juror?: Awaited<ReturnType<typeof deps.chain.getJuror>>; passportDoc?: JurorAttestationDoc }> {
    const checkedAt = deps.clock.nowDate().toISOString();
    const endpoint = await deps.store.getEndpoint(key);
    if (!endpoint) return { result: { address: key, ok: false, reason: "endpoint not registered", checkedAt }, passed: false };

    let doc;
    try {
      doc = await deps.http.fetchAttestation(endpoint.url);
    } catch (error) {
      // Network and HTTP transport failures are availability issues, never slashable verification failures.
      if (error instanceof EndpointUnavailableError) {
        return { result: { address: key, ok: false, reason: "endpoint unreachable", checkedAt }, passed: false };
      }
      return { result: { address: key, ok: false, reason: "invalid attestation document", checkedAt }, passed: false };
    }

    let juror;
    try {
      juror = await deps.chain.getJuror(key);
    } catch {
      return { result: { address: key, ok: false, reason: "registry read failed", checkedAt }, passed: false };
    }
    let reason: string | undefined;
    if (doc.address.toLowerCase() !== key.toLowerCase()) reason = "attestation address mismatch";
    else if (doc.role !== roleName(endpoint.role) || doc.role !== roleName(juror.role)) reason = "attestation role mismatch";
    else if (doc.measurement.toLowerCase() !== juror.measurement.toLowerCase()) reason = "measurement mismatch";
    else if (juror.role === Role.JUROR && doc.jurorClass !== juror.jurorClass) reason = "juror class mismatch";
    else {
      const verified = await deps.quoteVerifier.verify(doc.quote as Quote, {
        measurement: juror.measurement,
        reportData: keyBinding(key, doc.encryptionPubKey as Hex),
        maxAgeSec: deps.maxQuoteAgeSec,
      });
      if (!verified.ok) reason = verified.reason ?? "quote verification failed";
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
    return {
      result: { address: key, ok: !reason, reason: reason ?? null, checkedAt },
      passed: !reason,
      role: juror.role,
      juror,
      passportDoc,
    };
  }

  async function checkAll(): Promise<CheckResult[]> {
    await indexEnrollments();
    const checkedRows: Awaited<ReturnType<typeof checkOne>>[] = [];
    for (const key of keys) checkedRows.push(await checkOne(key));
    const largeALineages = new Set(checkedRows
      .filter((row) => row.passed && row.juror?.jurorClass === 0 && row.passportDoc)
      .map((row) => row.passportDoc!.passport.lineage.toLowerCase()));
    for (const row of checkedRows) {
      if (row.passed && row.juror?.jurorClass === 4 && row.passportDoc && largeALineages.has(row.passportDoc.passport.lineage.toLowerCase())) {
        row.passed = false;
        row.result = { ...row.result, ok: false, reason: "dissenter_lineage_not_distinct" };
      }
    }
    const passing: Address[] = [];
    const results: CheckResult[] = [];
    for (const checked of checkedRows) {
      const key = checked.result.address;
      results.push(checked.result);
      lastChecks.set(key, checked.result);
      if (checked.passed) {
        passing.push(key);
        reportedFailures.delete(key);
      } else if (isSlashable(checked.result.reason)) {
        try {
          const role = checked.role;
          if (role !== undefined && await deps.chain.isActive(key, role) && !reportedFailures.has(key)) {
            await deps.chain.reportAttestationFailure(key);
            reportedFailures.add(key);
          }
        } catch (error) {
          log("error", "attestation_failure_report_failed", { address: key, error: error instanceof Error ? error.message : "unknown" });
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
        }).catch((error: unknown) => log("error", "juror_upsert_failed", { address: key, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
        if (checked.passed && checked.passportDoc) {
          await deps.store.setJurorPassport(key.toLowerCase(), checked.passportDoc.passport, checked.passportDoc.passportSig)
            .catch((error: unknown) => log("error", "juror_passport_write_failed", { address: key, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
        }
      }
    }
    const until = BigInt(deps.clock.nowSeconds() + deps.validitySec);
    for (let i = 0; i < passing.length; i += BATCH_SIZE) {
      await deps.chain.refreshAttestation(passing.slice(i, i + BATCH_SIZE), until);
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
    },
  };
}

/**
 * Only failures that are evidence of a non-genuine or misrepresented enclave are reported (5% slash). Liveness and
 * transport problems (unreachable, malformed document, stale quote, registry read errors) just let the attestation
 * lapse — otherwise anyone able to disturb an endpoint's network path could get an honest juror slashed.
 */
const NON_SLASHABLE = new Set([
  "endpoint unreachable",
  "endpoint not registered",
  "registry read failed",
  "invalid attestation document",
  "quote expired or issued in the future",
  "passport missing or invalid",
  "passport signature mismatch",
  "passport juror mismatch",
  "passport class mismatch",
  "passport tee mismatch",
  "dissenter_lineage_excluded",
  "dissenter_lineage_not_distinct",
]);

export function isSlashable(reason: string | null): boolean {
  return reason !== null && !NON_SLASHABLE.has(reason);
}

function roleName(role: number): "JUROR" | "INTAKE" | "CONSENSUS" | undefined {
  if (role === Role.JUROR) return "JUROR";
  if (role === Role.INTAKE) return "INTAKE";
  if (role === Role.CONSENSUS) return "CONSENSUS";
  return undefined;
}
