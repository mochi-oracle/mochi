import { describe, expect, test } from "bun:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, getAddress, type Address, type Hex } from "viem";
import type { JurorAttestationDoc } from "@mochi/protocol";
import { DcapQuoteVerifier, PcsCollateralSource, keyBinding, tdxQuoteMeasurement, tdxReportData } from "@mochi/tee";
import { JurorRegistryAbi } from "@mochi/chain";
import { FIXTURE_NOW, bogusFmspcQuote, readFixtureJson, selfSignedChainQuote } from "../../../packages/tee/test/forge-quote.ts";
import { readFile } from "node:fs/promises";
import { bytesToHex } from "viem";
import { Role } from "@mochi/core";
import { createAttestorApp } from "../src/app.ts";
import { classifyRefreshError, createAttestor, isSlashable } from "../src/attestor.ts";
import { docFor, measurement, provider, readyFixture, root, signedQuote, teeRoot } from "./fixture.ts";

describe("attestor", () => {
  test("refreshes passing keys and writes current juror chain fields", async () => {
    const f = await readyFixture({ count: 2 });
    const attestor = createAttestor(f.deps);
    const result = await attestor.checkAll();
    expect(result.every((r) => r.ok)).toBe(true);
    expect(f.refreshes).toEqual([{ keys: f.keys, until: 1_700_001_200n }]);
    expect(f.reported).toHaveLength(0);
    expect(f.store.cursor).toBe(100n);
    expect(f.store.jurors.map((j) => [j.bond, j.served, j.timeouts])).toEqual([["25000", 9, 1], ["25000", 9, 1]]);
    expect(f.store.passports.map((p) => p.key)).toEqual(f.keys);
  });

  test("rejects invalid Passport claims without refresh or slash report", async () => {
    const f = await readyFixture({ count: 5, classes: [2, 2, 2, 4, 2] });
    const [badSig, wrongClass, wrongTee, excluded, missing] = f.keys as [Address, Address, Address, Address, Address];
    const signatureDoc = f.docs.get(badSig)! as JurorAttestationDoc;
    f.docs.set(badSig, { ...signatureDoc, passportSig: `0x${"01"}` } as JurorAttestationDoc);
    f.docs.set(wrongClass, await docFor(f.tees[1]!, {}, 2, { jurorClass: 3 }));
    f.docs.set(wrongTee, await docFor(f.tees[2]!, {}, 2, { tee: "tdx" }));
    f.docs.set(excluded, await docFor(f.tees[3]!, {}, 4, { lineage: "QwEn" }));
    const validDoc = f.docs.get(missing)! as JurorAttestationDoc;
    const { passport: _passport, passportSig: _passportSig, ...withoutPassport } = validDoc;
    f.docs.set(missing, withoutPassport);
    const result = await createAttestor(f.deps).checkAll();
    expect(result.map((row) => row.reason)).toEqual([
      "passport signature mismatch", "passport class mismatch", "passport tee mismatch", "dissenter_lineage_excluded", "passport missing or invalid",
    ]);
    expect(f.refreshes).toHaveLength(0);
    expect(f.reported).toHaveLength(0);
    expect(f.store.passports).toHaveLength(0);
    expect(result.every((row) => !isSlashable(row.reason))).toBe(true);
  });

  test("requires DISSENTER lineage to differ from LARGE_A seen in the same pass", async () => {
    const f = await readyFixture({ count: 2, classes: [0, 4] });
    const dissenterKey = f.keys[1]!;
    f.docs.set(dissenterKey, await docFor(f.tees[1]!, {}, 4, { lineage: "MISTRAL" }));
    const result = await createAttestor(f.deps).checkAll();
    expect(result.map((row) => row.reason)).toEqual([null, "dissenter_lineage_not_distinct"]);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([f.keys[0]!]);
    expect(f.reported).toHaveLength(0);
  });

  test("Passport DB write failures do not block refresh, and non-juror roles need no Passport", async () => {
    const f = await readyFixture();
    f.store.setJurorPassport = async () => { throw new Error("db unavailable"); };
    const jurorResult = await createAttestor(f.deps).checkAll();
    expect(jurorResult[0]?.ok).toBe(true);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([f.keys[0]!]);

    const g = await readyFixture();
    const key = g.keys[0]!;
    g.deps.chain.getJuror = async () => ({
      operator: root.address, measurement, role: Role.INTAKE, jurorClass: 0, bond: 0n,
      attestedUntil: 0n, delisted: false, served: 0, timeouts: 0,
    });
    g.store.endpoints.set(key, { address: key, role: Role.INTAKE, url: "http://intake.test" });
    const jurorDoc = g.docs.get(key)! as JurorAttestationDoc;
    g.deps.http.fetchAttestation = async () => ({
      role: "INTAKE", address: jurorDoc.address, encryptionPubKey: jurorDoc.encryptionPubKey,
      measurement: jurorDoc.measurement, quote: jurorDoc.quote,
    });
    const nonJurorResult = await createAttestor(g.deps).checkAll();
    expect(nonJurorResult[0]?.ok).toBe(true);
    expect(g.refreshes.flatMap((batch) => batch.keys)).toEqual([key]);
    expect(g.store.passports).toHaveLength(0);
  });

  test("rejects wrong measurement, reportData, stale quote, role and class; reports once until recovery", async () => {
    const f = await readyFixture({ count: 5 });
    const [mismatch, report, stale, role, klass] = f.keys as [Address, Address, Address, Address, Address];
    f.deps.chain.getJuror = async (key) => ({
      operator: root.address,
      measurement: key === mismatch ? `0x${"33".repeat(32)}` as Hex : measurement,
      role: Role.JUROR, jurorClass: 2, bond: 5n, attestedUntil: 0n,
      delisted: false, served: 1, timeouts: 0,
    });
    const reportDoc = f.docs.get(report)!;
    const other = await docFor(provider(99));
    f.docs.set(report, { ...reportDoc, quote: other.quote });
    const staleDoc = f.docs.get(stale)!;
    const old = await signedQuote(teeRoot(), staleDoc.measurement as Hex, keyBinding(staleDoc.address as Address, staleDoc.encryptionPubKey as Hex), 1_600_000_000);
    f.docs.set(stale, { ...staleDoc, quote: old });
    f.docs.set(role, { ...f.docs.get(role)!, role: "INTAKE" });
    f.docs.set(klass, { ...f.docs.get(klass)!, jurorClass: 1 });
    // Only the mismatching key's enrolled measurement is on the allowlist, so its genuine 0x22… quote is not an upgrade.
    f.deps.chain.measurementAllowed = async (m) => m === `0x${"33".repeat(32)}`;
    const attestor = createAttestor(f.deps);
    const first = await attestor.checkAll();
    expect(first.every((r) => !r.ok)).toBe(true);
    expect(first.map((row) => row.reason)).toEqual([
      "measurement not allowed", "unexpected reportData", "quote expired or issued in the future", "attestation role mismatch", "juror class mismatch",
    ]);
    expect(f.refreshes).toHaveLength(0);
    // A stale quote is a liveness problem and a genuine quote of a build outside the allowlist an upgrade-ordering
    // problem: neither is refreshed, and neither is reported for slashing.
    expect(f.reported).toEqual(f.keys.filter((k) => k !== stale && k !== mismatch));
    await attestor.checkAll();
    expect(f.reported).toHaveLength(3);
    f.docs.set(mismatch, await docFor(f.tees[0]!));
    f.deps.chain.measurementAllowed = async (m) => m === measurement;
    const getJuror = f.deps.chain.getJuror;
    f.deps.chain.getJuror = async (key) => ({ ...await getJuror(key), measurement });
    const recovered = await attestor.checkAll();
    expect(recovered[0]?.ok).toBe(true);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toContain(mismatch);
  });

  test("does not report unreachable endpoints and batches refreshes at 50", async () => {
    const f = await readyFixture({ count: 51 });
    f.deps.http.fetchAttestation = async (url: string) => {
      const key = f.keys[Number(url.split("-").at(-1)?.split(".")[0]) - 1]!;
      if (key === f.keys[50]!) throw new Error("offline");
      return f.docs.get(key)!;
    };
    const result = await createAttestor(f.deps).checkAll();
    expect(result.filter((r) => r.ok)).toHaveLength(50);
    expect(f.refreshes.map((batch) => batch.keys.length)).toEqual([50]);
    expect(f.reported).toHaveLength(0);
  });

  test("protects endpoint registration and rejects address mismatch", async () => {
    const f = await readyFixture();
    const originalFetch = f.deps.http.fetchAttestation;
    f.deps.http.fetchAttestation = async (url) => url === "http://new.test" ? f.docs.get(f.keys[0]!)! : originalFetch(url);
    const { app } = createAttestorApp(f.deps);
    const unauth = await app.request("/v1/endpoints", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: f.keys[0], role: "JUROR", url: "http://new.test" }) });
    expect(unauth.status).toBe(401);
    const mismatch = await app.request("/v1/endpoints", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ address: root.address, role: "JUROR", url: "http://new.test" }) });
    expect(mismatch.status).toBe(400);
    const good = await app.request("/v1/endpoints", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ address: f.keys[0], role: "JUROR", url: "http://new.test" }) });
    expect(good.status).toBe(201);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

test("liveness failures are never slashable; verification failures are", () => {
  expect(isSlashable("endpoint unreachable")).toBe(false);
  expect(isSlashable("invalid attestation document")).toBe(false);
  expect(isSlashable("quote expired or issued in the future")).toBe(false);
  expect(isSlashable("measurement not allowed")).toBe(false);
  expect(isSlashable("enrolled measurement no longer allowed")).toBe(false);
  expect(isSlashable("unexpected measurement")).toBe(true);
  expect(isSlashable("invalid mock root signature")).toBe(true);
  expect(isSlashable("attestation refresh failed")).toBe(false);
  expect(isSlashable("attestation refresh reverted")).toBe(false);
  expect(isSlashable(null)).toBe(false);
});

describe("infrastructure failures never slash", () => {
  test("Intel PCS outage: DCAP collateral unavailable for every key reports nobody and refreshes nobody", async () => {
    const raw = new Uint8Array(await readFile(new URL("../../../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url)));
    const f = await readyFixture({ count: 3 });
    const tdxMeasurementValue = tdxQuoteMeasurement(raw);
    f.deps.chain.getJuror = async () => ({ operator: root.address, measurement: tdxMeasurementValue, role: Role.JUROR, jurorClass: 2, bond: 5n, attestedUntil: 0n, delisted: false, served: 0, timeouts: 0 });
    for (const key of f.keys) {
      const doc = f.docs.get(key)! as JurorAttestationDoc;
      f.docs.set(key, { ...doc, measurement: tdxMeasurementValue, quote: { kind: "tdx", raw: bytesToHex(raw), measurement: tdxMeasurementValue, reportData: keyBinding(key, doc.encryptionPubKey as Hex), issuedAt: 1_700_000_000 } } as never);
    }
    let pcsCalls = 0;
    f.deps.quoteVerifier = new DcapQuoteVerifier({ collateral: new PcsCollateralSource({ fetch: (async () => { pcsCalls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch }) });
    const result = await createAttestor(f.deps).checkAll();
    expect(pcsCalls).toBeGreaterThan(0);
    expect(result.map((row) => row.reason)).toEqual(["dcap: collateral unavailable", "dcap: collateral unavailable", "dcap: collateral unavailable"]);
    expect(f.reported).toHaveLength(0);
    expect(f.refreshes).toHaveLength(0);
  });

  test("a verifier that throws, or any collateral/TCB/policy reason, is not slashable; forged evidence still is", async () => {
    const f = await readyFixture({ count: 2 });
    f.deps.quoteVerifier = { verify: async () => { throw new Error("PCS HTTP 503"); } };
    const crashed = await createAttestor(f.deps).checkAll();
    expect(crashed.every((row) => row.reason === "quote verifier unavailable")).toBe(true);
    expect(f.reported).toHaveLength(0);
    let reason = "dcap: quote signature";
    f.deps.quoteVerifier = { verify: async () => ({ ok: false, reason }) };
    await createAttestor(f.deps).checkAll();
    expect(f.reported).toEqual(f.keys);
    for (reason of ["dcap: collateral unavailable", "dcap: collateral malformed", "dcap: TCB validity", "dcap: QE validity", "dcap: root CRL", "dcap: PCK CRL",
      "dcap: certificate validity", "dcap: untrusted root", "dcap: PCK certificate validity", "dcap: PCK revoked", "dcap: TCB not supported", "dcap: unknown TCB status", "tcb status OutOfDate",
      "rejected advisory", "dcap: collateral source required", "dcap: PCS HTTP 503", "quote verifier unavailable", "quote verification failed"]) {
      expect(isSlashable(reason)).toBe(false);
      const g = await readyFixture({ count: 1 });
      g.deps.quoteVerifier = { verify: async () => ({ ok: false, reason }) };
      await createAttestor(g.deps).checkAll();
      expect(g.reported).toHaveLength(0);
    }
  });
});

describe("forged PCK chains are slashed before any collateral is fetched", () => {
  async function forgedFixture(forge: (reportData: Uint8Array) => Promise<Uint8Array>) {
    const f = await readyFixture({ count: 1 });
    const key = f.keys[0]!;
    const doc = f.docs.get(key)! as JurorAttestationDoc;
    const binding = keyBinding(key, doc.encryptionPubKey as Hex);
    const raw = await forge(tdxReportData(binding, FIXTURE_NOW - 5));
    const tdMeasurement = tdxQuoteMeasurement(raw);
    f.deps.chain.getJuror = async () => ({ operator: root.address, measurement: tdMeasurement, role: Role.JUROR, jurorClass: 2, bond: 5n, attestedUntil: 0n, delisted: false, served: 0, timeouts: 0 });
    f.deps.chain.measurementAllowed = async (m) => m === tdMeasurement;
    f.docs.set(key, { ...doc, measurement: tdMeasurement, quote: { kind: "tdx", raw: bytesToHex(raw), measurement: tdMeasurement, reportData: binding, issuedAt: FIXTURE_NOW - 5 } } as never);
    const collateralCalls: string[] = [];
    const collateral = await readFixtureJson("tdx_quote_collateral.json");
    f.deps.quoteVerifier = new DcapQuoteVerifier({ now: () => FIXTURE_NOW, collateral: { get: async (fmspc, ca) => { collateralCalls.push(`${fmspc}:${ca}`); return collateral; } } });
    return { ...f, collateralCalls };
  }

  test("a self-made chain carrying the real FMSPC is reported as an untrusted root and slashed", async () => {
    const f = await forgedFixture((reportData) => selfSignedChainQuote({ reportData }));
    const [result] = await createAttestor(f.deps).checkAll();
    expect(result?.reason).toBe("dcap: PCK untrusted root");
    expect(isSlashable(result!.reason)).toBe(true);
    expect(f.reported).toEqual(f.keys);
    expect(f.refreshes).toHaveLength(0);
    expect(f.collateralCalls).toEqual([]);
  });

  test("a bogus FMSPC is reported as a certificate signature failure and slashed, without contacting PCS", async () => {
    for (const resign of [false, true]) {
      const f = await forgedFixture((reportData) => bogusFmspcQuote({ resign, reportData }));
      const [result] = await createAttestor(f.deps).checkAll();
      expect(result?.reason).toBe("dcap: PCK certificate signature");
      expect(f.reported).toEqual(f.keys);
      expect(f.collateralCalls).toEqual([]);
    }
    // Against a real PCS source the bogus FMSPC is never requested either.
    const f = await forgedFixture((reportData) => bogusFmspcQuote({ reportData }));
    let pcsCalls = 0;
    f.deps.quoteVerifier = new DcapQuoteVerifier({ now: () => FIXTURE_NOW, collateral: new PcsCollateralSource({ fetch: (async () => { pcsCalls++; return new Response("", { status: 404 }); }) as unknown as typeof fetch }) });
    await createAttestor(f.deps).checkAll();
    expect(pcsCalls).toBe(0);
    expect(f.reported).toEqual(f.keys);
  });

  test("a genuine chain outside its validity window (a clock problem) is not slashed", () => {
    expect(isSlashable("dcap: PCK certificate validity")).toBe(false);
    for (const reason of ["dcap: PCK chain", "dcap: PCK untrusted root", "dcap: PCK certificate signature", "dcap: PCK certificate issuer", "dcap: PCK certificate CA"]) {
      expect(isSlashable(reason)).toBe(true);
    }
  });

  test("an Intel CA name the verifier does not know lapses instead of slashing; a missing PCK extension is still slashed", async () => {
    expect(isSlashable("dcap: PCK CA")).toBe(false);
    expect(isSlashable("dcap: PCK extension")).toBe(true);
    const f = await readyFixture({ count: 1 });
    f.deps.quoteVerifier = { verify: async () => ({ ok: false, reason: "dcap: PCK CA" }) };
    const [result] = await createAttestor(f.deps).checkAll();
    expect(result?.reason).toBe("dcap: PCK CA");
    expect(f.reported).toEqual([]);
  });
});

describe("database outages are isolated", () => {
  test("a Postgres error for one key affects only that key; cached endpoints ride through a full outage", async () => {
    const f = await readyFixture({ count: 3 });
    const [first, broken, third] = f.keys as [Address, Address, Address];
    let now = 1_700_000_000;
    f.deps.clock = { nowSeconds: () => now, nowDate: () => new Date(now * 1_000) };
    const getEndpoint = f.store.getEndpoint.bind(f.store);
    let outage = false;
    let endpointReads = 0;
    f.store.getEndpoint = async (address: string) => {
      endpointReads++;
      if (outage || address.toLowerCase() === broken) throw new Error("connection terminated unexpectedly");
      return getEndpoint(address);
    };
    f.store.setCursor = async () => { throw new Error("connection terminated unexpectedly"); };
    const attestor = createAttestor(f.deps);
    const results = await attestor.checkAll();
    expect(results.map((row) => [row.address, row.reason])).toEqual([[first, null], [broken, "endpoint store unavailable"], [third, null]]);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([first, third]);
    expect(f.reported).toHaveLength(0);
    expect(isSlashable("endpoint store unavailable")).toBe(false);

    // Within the cache period the store is not read again.
    const readsBefore = endpointReads;
    now += 60;
    await attestor.checkAll();
    expect(endpointReads - readsBefore).toBe(1); // only the key that has never been read successfully

    // Postgres fully down past the cache period: the last known endpoints are still used and refreshed.
    outage = true;
    now += 900;
    const during = await attestor.checkAll();
    expect(during.map((row) => row.reason)).toEqual([null, "endpoint store unavailable", null]);
    expect(f.refreshes.at(-1)!.keys).toEqual([first, third]);
    expect(f.reported).toHaveLength(0);
  });

  test("an unexpected crash while checking one key does not abort the pass", async () => {
    const f = await readyFixture({ count: 2 });
    const getJuror = f.deps.chain.getJuror;
    f.deps.chain.measurementAllowed = async () => { throw new Error("rpc"); };
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual(["registry read failed", "registry read failed"]);
    f.deps.chain.measurementAllowed = async () => true;
    f.deps.chain.getJuror = async (key) => { if (key === f.keys[0]) return null as never; return getJuror(key); };
    const crashed = await createAttestor(f.deps).checkAll();
    expect(crashed.map((row) => row.reason)).toEqual(["check failed", null]);
    expect(f.reported).toHaveLength(0);
  });
});

describe("upgrades: allowlisted measurements re-attest; any other genuine build lapses, never slashes", () => {
  const upgraded = `0x${"44".repeat(32)}` as Hex;
  const rogue = `0x${"55".repeat(32)}` as Hex;
  const intakeOnly = `0x${"66".repeat(32)}` as Hex;

  test("a genuine quote at a measurement the registry allows for the role is refreshed; any other build only lapses", async () => {
    const f = await readyFixture({ count: 4 });
    const [upgradedKey, rogueKey, wrongRoleKey, retiredKey] = f.keys as [Address, Address, Address, Address];
    // The registry still records the enrollment measurement (0x22…). Governance allowed the new build for jurors
    // before the rebuild, plus an intake-only build; the key that keeps running an old build enrolled under a
    // measurement governance later removed cannot be refreshed but is not slashed.
    const retired = `0x${"77".repeat(32)}` as Hex;
    const allow = new Map([[`${measurement}:${Role.JUROR}`, true], [`${upgraded}:${Role.JUROR}`, true], [`${intakeOnly}:${Role.INTAKE}`, true]]);
    f.deps.chain.measurementAllowed = async (m, role) => allow.get(`${m.toLowerCase()}:${role}`) ?? false;
    const getJuror = f.deps.chain.getJuror;
    f.deps.chain.getJuror = async (key) => ({ ...await getJuror(key), measurement: key === retiredKey ? retired : measurement });
    f.docs.set(upgradedKey, await docFor(provider(1, upgraded)));
    f.docs.set(rogueKey, await docFor(provider(2, rogue)));
    f.docs.set(wrongRoleKey, await docFor(provider(3, intakeOnly)));
    f.docs.set(retiredKey, await docFor(provider(4, retired)));
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual([null, "measurement not allowed", "measurement not allowed", "enrolled measurement no longer allowed"]);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([upgradedKey]);
    expect(f.reported).toEqual([]);
  });

  test("governance removing M_NEW lapses every key running it, whatever measurement it was enrolled with", async () => {
    const f = await readyFixture({ count: 2 });
    const [enrolledOld, enrolledNew] = f.keys as [Address, Address];
    const getJuror = f.deps.chain.getJuror;
    f.deps.chain.getJuror = async (key) => ({ ...await getJuror(key), measurement: key === enrolledNew ? upgraded : measurement });
    // Both keys run M_NEW (0x44…); one was enrolled at M_OLD (0x22…) and one at M_NEW.
    f.docs.set(enrolledOld, await docFor(provider(1, upgraded)));
    f.docs.set(enrolledNew, await docFor(provider(2, upgraded)));
    const allowed = new Set([measurement, upgraded]);
    f.deps.chain.measurementAllowed = async (m) => allowed.has(m.toLowerCase() as Hex);
    const attestor = createAttestor(f.deps);
    expect((await attestor.checkAll()).map((row) => row.reason)).toEqual([null, null]);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([enrolledOld, enrolledNew]);

    allowed.delete(upgraded);
    const removed = await attestor.checkAll();
    expect(removed.map((row) => row.reason)).toEqual(["measurement not allowed", "enrolled measurement no longer allowed"]);
    expect(removed.every((row) => !isSlashable(row.reason))).toBe(true);
    expect(f.reported).toEqual([]);
    expect(f.refreshes).toHaveLength(1);
  });

  test("deploying M_NEW before it is allowlisted lapses every key without a report, and the allowlist update recovers them", async () => {
    const f = await readyFixture({ count: 3 });
    for (const [index, key] of f.keys.entries()) f.docs.set(key, await docFor(provider(index + 1, upgraded)));
    const allowed = new Set([measurement]);
    f.deps.chain.measurementAllowed = async (m) => allowed.has(m.toLowerCase() as Hex);
    const attestor = createAttestor(f.deps);
    expect((await attestor.checkAll()).map((row) => row.reason)).toEqual(Array(3).fill("measurement not allowed"));
    expect(f.reported).toEqual([]);
    expect(f.refreshes).toHaveLength(0);
    allowed.add(upgraded);
    expect((await attestor.checkAll()).every((row) => row.ok)).toBe(true);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual(f.keys);
  });

  test("the allowlist is consulted with the verified quote's measurement, never the document's unverified claim", async () => {
    const f = await readyFixture({ count: 2 });
    const [claimsRogue, staleQuote] = f.keys as [Address, Address];
    const consulted: Hex[] = [];
    f.deps.chain.measurementAllowed = async (m) => { consulted.push(m.toLowerCase() as Hex); return m.toLowerCase() === measurement; };
    // The document names a build outside the allowlist, but its quote cannot be verified (stale): before any
    // verification nothing is known about the enclave, so this lapses and is not reported.
    const doc = f.docs.get(staleQuote)! as JurorAttestationDoc;
    const old = await signedQuote(teeRoot(), rogue, keyBinding(staleQuote, doc.encryptionPubKey as Hex), 1_600_000_000);
    f.docs.set(staleQuote, { ...doc, measurement: rogue, quote: old });
    // A verified quote at the enrolled build whose document claims another build misrepresents the enclave.
    f.docs.set(claimsRogue, { ...(f.docs.get(claimsRogue) as JurorAttestationDoc), measurement: rogue });
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual(["unexpected measurement", "quote expired or issued in the future"]);
    expect(consulted).not.toContain(rogue);
    expect(f.reported).toEqual([claimsRogue]);
  });

  test("the quote must still prove the upgraded measurement it claims", async () => {
    const f = await readyFixture({ count: 1 });
    f.deps.chain.measurementAllowed = async () => true;
    const key = f.keys[0]!;
    const genuine = await docFor(provider(1, upgraded));
    // The document claims the allowlisted build, but its quote was produced by the old one.
    f.docs.set(key, { ...genuine, quote: (f.docs.get(key) as JurorAttestationDoc).quote });
    const [result] = await createAttestor(f.deps).checkAll();
    expect(result?.reason).toBe("unexpected measurement");
    expect(f.reported).toEqual([key]);
  });
});

describe("refresh transactions are batched, spaced and isolated", () => {
  test("a failing key does not make the attestor re-send refreshes for healthy keys on every retry", async () => {
    const f = await readyFixture({ count: 3 });
    let now = 1_700_000_000;
    f.deps.clock = { nowSeconds: () => now, nowDate: () => new Date(now * 1_000) };
    const offline = f.keys[2]!;
    const fetchAttestation = f.deps.http.fetchAttestation;
    f.deps.http.fetchAttestation = async (url) => { const doc = await fetchAttestation(url); if (doc.address === offline) throw new Error("offline"); return doc; };
    const attestor = createAttestor(f.deps);
    await attestor.checkAll();
    expect(f.refreshes).toEqual([{ keys: [f.keys[0]!, f.keys[1]!], until: BigInt(now + 1_200) }]);
    for (const step of [15, 30, 60, 120]) {
      now += step;
      await attestor.checkAll();
    }
    expect(f.refreshes).toHaveLength(1);
    now = 1_700_000_000 + 600;
    await attestor.checkAll();
    expect(f.refreshes).toHaveLength(2);
    expect(f.refreshes[1]!.until).toBe(BigInt(now + 1_200));
  });

  test("a NotEnrolled revert drops the key it names and resends the rest at once", async () => {
    const f = await readyFixture({ count: 5 });
    const bad = f.keys[3]!;
    const refresh = f.deps.chain.refreshAttestation;
    const attempts: Address[][] = [];
    f.deps.chain.refreshAttestation = async (batch, until) => {
      attempts.push([...batch]);
      if (batch.includes(bad)) throw simulatedRevert("NotEnrolled", [bad]);
      return refresh(batch, until);
    };
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual([null, null, null, "attestation refresh reverted", null]);
    expect(attempts).toEqual([f.keys, f.keys.filter((key) => key !== bad)]);
    expect(f.reported).toEqual([]);
  });

  test("a MeasurementNotAllowed revert drops the keys enrolled at that measurement", async () => {
    const f = await readyFixture({ count: 4 });
    const removed = `0x${"88".repeat(32)}` as Hex;
    const [, second, , fourth] = f.keys as [Address, Address, Address, Address];
    const getJuror = f.deps.chain.getJuror;
    f.deps.chain.getJuror = async (key) => ({ ...await getJuror(key), measurement: key === second || key === fourth ? removed : measurement });
    // The allowlist read raced with the removal: the pass saw the measurement as allowed, the simulation does not.
    f.deps.chain.measurementAllowed = async () => true;
    for (const key of [second, fourth]) {
      const doc = f.docs.get(key)! as JurorAttestationDoc;
      f.docs.set(key, await docFor(provider(f.keys.indexOf(key) + 1, removed), {}, doc.jurorClass));
    }
    const refresh = f.deps.chain.refreshAttestation;
    let attempts = 0;
    f.deps.chain.refreshAttestation = async (batch, until) => {
      attempts++;
      if (batch.includes(second) || batch.includes(fourth)) throw simulatedRevert("MeasurementNotAllowed", [removed, Role.JUROR]);
      return refresh(batch, until);
    };
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual([null, "attestation refresh reverted", null, "attestation refresh reverted"]);
    expect(attempts).toBe(2);
  });

  test("a revert that names no key still splits the batch until the failing key is isolated", async () => {
    const f = await readyFixture({ count: 5 });
    const bad = f.keys[3]!;
    const refresh = f.deps.chain.refreshAttestation;
    f.deps.chain.refreshAttestation = async (batch, until) => {
      if (batch.includes(bad)) throw simulatedRevert("BondTooLow", [1n, 2n]);
      return refresh(batch, until);
    };
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual([null, null, null, "attestation refresh reverted", null]);
    expect(f.refreshes.flatMap((batch) => batch.keys).sort()).toEqual(f.keys.filter((key) => key !== bad).sort());
  });

  test("an RPC timeout is retried as a whole batch later: no split, no further sends, no duplicate once it landed", async () => {
    const f = await readyFixture({ count: 60 });
    let now = 1_700_000_000;
    f.deps.clock = { nowSeconds: () => now, nowDate: () => new Date(now * 1_000) };
    const refresh = f.deps.chain.refreshAttestation;
    const attempts: number[] = [];
    let stalled = true;
    f.deps.chain.refreshAttestation = async (batch, until) => {
      attempts.push(batch.length);
      if (stalled) {
        // The transaction was broadcast and mined, but the receipt wait timed out.
        await refresh(batch, until);
        throw new Error("Timed out while waiting for transaction with hash 0xabc to be confirmed.");
      }
      return refresh(batch, until);
    };
    const attestor = createAttestor(f.deps);
    const first = await attestor.checkAll();
    // One send for the first batch of 50; the second batch waits for the next pass instead of queueing another timeout.
    expect(attempts).toEqual([50]);
    expect(first.filter((row) => row.reason === "attestation refresh failed")).toHaveLength(60);
    expect(f.reported).toEqual([]);
    stalled = false;
    now += 15;
    const retry = await attestor.checkAll();
    // The first 50 already landed, so the retry reads their new attestedUntil and sends only the other 10.
    expect(attempts).toEqual([50, 10]);
    expect(retry.every((row) => row.ok)).toBe(true);
  });

  test("viem errors are classified: a simulated custom-error revert is a revert, transport failures are transient", async () => {
    const key = `0x${"ab".repeat(20)}` as Address;
    const revertData = encodeErrorResult({ abi: JurorRegistryAbi, errorName: "NotEnrolled", args: [key] });
    const simulate = (request: () => Promise<unknown>) => createPublicClient({ transport: custom({ request }, { retryCount: 0 }) }).simulateContract({
      account: key, address: key, abi: JurorRegistryAbi, functionName: "refreshAttestation", args: [[key], 1n],
    });
    const caught = async (request: () => Promise<unknown>) => { try { await simulate(request); } catch (error) { return error; } throw new Error("no error"); };
    const reverted = classifyRefreshError(await caught(async () => { throw Object.assign(new Error("execution reverted"), { code: 3, data: revertData }); }));
    expect(reverted).toEqual({ kind: "revert", errorName: "NotEnrolled", args: [getAddress(key)] });
    expect(classifyRefreshError(await caught(async () => { throw new Error("fetch failed"); }))).toEqual({ kind: "transient" });
    expect(classifyRefreshError(await caught(async () => { throw Object.assign(new Error("header not found"), { code: -32603 }); }))).toEqual({ kind: "transient" });
    expect(classifyRefreshError(new Error("refreshAttestation reverted: 0xabc"))).toEqual({ kind: "transient" });
  });
});

function simulatedRevert(errorName: "NotEnrolled" | "MeasurementNotAllowed" | "BondTooLow", args: readonly unknown[]) {
  const data = encodeErrorResult({ abi: JurorRegistryAbi, errorName, args } as never);
  const reverted = new ContractFunctionRevertedError({ abi: JurorRegistryAbi, data, functionName: "refreshAttestation" });
  return new ContractFunctionExecutionError(reverted, { abi: JurorRegistryAbi, functionName: "refreshAttestation", args: [] });
}
