import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JurorAttestationDocSchema, passportHash } from "@mochi/protocol";
import type { AttestationDoc, JurorAttestationDoc } from "@mochi/protocol";
import { DcapQuoteVerifier, MockQuoteVerifier, MockTeeProvider, PcsCollateralSource, keyBinding, tdxQuoteMeasurement, tdxReportData } from "@mochi/tee";
import { FIXTURE_NOW, bogusFmspcQuote, readFixtureJson, selfSignedChainQuote } from "../../../packages/tee/test/forge-quote.ts";
import { readFile } from "node:fs/promises";
import { bytesToHex } from "viem";
import { Role } from "@mochi/core";
import { createAttestorApp } from "../src/app.ts";
import { createAttestor, isSlashable } from "../src/attestor.ts";
import type { AttestorDeps, ChainPort, Endpoint, Store } from "../src/ports.ts";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const measurement = `0x${"22".repeat(32)}` as Hex;
const zero = `0x${"00".repeat(32)}` as Hex;

function provider(seedNum: number, m = measurement) {
  return new MockTeeProvider({ seed: toHex(new Uint8Array([seedNum])), measurement: m, mockRoot: root });
}

async function docFor(tee: MockTeeProvider, overrides: Partial<JurorAttestationDoc> = {}, jurorClass = 2, passportOverrides: Record<string, unknown> = {}): Promise<JurorAttestationDoc> {
  const base = {
    role: "JUROR",
    address: tee.signer().address.toLowerCase() as Address,
    encryptionPubKey: tee.encryptionPublicKey(),
    measurement: tee.measurement(),
    jurorClass,
    quote: await tee.quote(),
    ...overrides,
  } as const;
  const passport = {
    v: 1,
    juror: base.address,
    jurorClass,
    modelId: "test/model",
    lineage: "mistral",
    weightsSha256: `0x${"ab".repeat(32)}`,
    openWeights: true,
    provider: "test-provider",
    zdr: true,
    tee: base.quote.kind,
    ...passportOverrides,
  };
  const passportSig = await tee.signer().signMessage({ message: { raw: passportHash(passport as never) } });
  return JurorAttestationDocSchema.parse({ ...base, passport, passportSig });
}

class FakeStore implements Store {
  cursor: bigint | null = null;
  endpoints = new Map<string, Endpoint>();
  jurors: Parameters<Store["upsertJuror"]>[0][] = [];
  passports: { key: string; passport: unknown; passportSig: string }[] = [];
  async getCursor() { return this.cursor; }
  async setCursor(_name: string, block: bigint) { this.cursor = block; }
  async getEndpoint(address: string) { return this.endpoints.get(address.toLowerCase()) ?? null; }
  async upsertEndpoint(address: string, role: number, url: string) {
    this.endpoints.set(address.toLowerCase(), { address, role, url });
  }
  async upsertJuror(row: Parameters<Store["upsertJuror"]>[0]) { this.jurors.push(row); }
  async setJurorPassport(key: string, passport: JurorAttestationDoc["passport"], passportSig: string) { this.passports.push({ key, passport, passportSig }); }
}

async function fixture(options: { count?: number; docs?: Map<string, JurorAttestationDoc | AttestationDoc>; unavailable?: Set<string>; block?: bigint; classes?: number[] } = {}) {
  const store = new FakeStore();
  const docs = options.docs ?? new Map<string, AttestationDoc>();
  const unavailable = options.unavailable ?? new Set<string>();
  const tees: MockTeeProvider[] = [];
  const keys: Address[] = [];
  const refreshes: { keys: Address[]; until: bigint }[] = [];
  const reported: Address[] = [];
  const fakeJurors = new Map<Address, Awaited<ReturnType<ChainPort["getJuror"]>>>();
  for (let i = 1; i <= (options.count ?? 1); i++) {
    const tee = provider(i);
    const key = tee.signer().address.toLowerCase() as Address;
    tees.push(tee); keys.push(key);
    fakeJurors.set(key, {
      operator: root.address,
      measurement,
      role: Role.JUROR,
      jurorClass: options.classes?.[i - 1] ?? 2,
      bond: 25_000n,
      attestedUntil: 0n,
      delisted: false,
      served: 9,
      timeouts: 1,
    });
    if (!docs.has(key)) docs.set(key, await docFor(tee, {}, options.classes?.[i - 1] ?? 2));
    store.endpoints.set(key, { address: key, role: Role.JUROR, url: `http://node-${i}.test` });
  }
  const chain: ChainPort = {
    blockNumber: async () => options.block ?? 100n,
    getEnrolled: async () => keys.map((key) => ({ key })),
    getJuror: async (key) => {
      const juror = fakeJurors.get(key);
      if (!juror) throw new Error("missing juror");
      return juror;
    },
    isActive: async () => true,
    measurementAllowed: async (m) => m.toLowerCase() === measurement.toLowerCase(),
    refreshAttestation: async (batch, until) => {
      refreshes.push({ keys: [...batch], until });
      for (const key of batch) { const juror = fakeJurors.get(key); if (juror) fakeJurors.set(key, { ...juror, attestedUntil: until }); }
      return zero;
    },
    reportAttestationFailure: async (key) => { reported.push(key); return zero; },
  };
  const http = {
    fetchAttestation: async (url: string) => {
      const key = keys[Number(url.split("-").at(-1)?.split(".")[0]) - 1];
      if (!key) throw new Error("unknown fake endpoint");
      if (key && unavailable.has(key)) throw new Error("offline");
      const value = docs.get(key);
      if (!value) throw new Error("missing doc");
      return value;
    },
  };
  const deps: AttestorDeps = {
    chain, http, store, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
    clock: { nowSeconds: () => 1_700_000_000, nowDate: () => new Date("2023-11-14T22:13:20.000Z") },
    startBlock: 10n, validitySec: 1_200, maxQuoteAgeSec: 900, adminToken: "secret", dissenterExcludedLineages: ["llama", "qwen"],
  };
  return { deps, store, docs, tees, keys, refreshes, reported, fakeJurors };
}

async function readyFixture(opts: Parameters<typeof fixture>[0] = {}) {
  return fixture(opts);
}

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
    // Only the mismatching key's enrolled measurement is on the allowlist, so its document's 0x22… is not an upgrade.
    f.deps.chain.measurementAllowed = async (m) => m === `0x${"33".repeat(32)}`;
    const attestor = createAttestor(f.deps);
    const first = await attestor.checkAll();
    expect(first.every((r) => !r.ok)).toBe(true);
    expect(f.refreshes).toHaveLength(0);
    // A stale quote is a liveness problem: not refreshed, but never reported for slashing.
    expect(f.reported).toEqual(f.keys.filter((k) => k !== stale));
    await attestor.checkAll();
    expect(f.reported).toHaveLength(4);
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

function teeRoot() { return root; }

async function signedQuote(mockRoot: typeof root, m: Hex, reportData: Hex, issuedAt: number) {
  const signedHash = keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
    ["MOCHI_MOCK_QUOTE_V1", m, reportData, BigInt(issuedAt)],
  ));
  const rootSig = await mockRoot.signMessage({ message: { raw: signedHash } });
  const raw = encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
    ["MOCHI_MOCK_QUOTE_V1", m, reportData, BigInt(issuedAt), rootSig],
  );
  return { kind: "mock" as const, measurement: m, reportData, raw, issuedAt };
}

test("liveness failures are never slashable; verification failures are", () => {
  expect(isSlashable("endpoint unreachable")).toBe(false);
  expect(isSlashable("invalid attestation document")).toBe(false);
  expect(isSlashable("quote expired or issued in the future")).toBe(false);
  expect(isSlashable("measurement mismatch")).toBe(true);
  expect(isSlashable("invalid mock root signature")).toBe(true);
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

describe("upgrades: allowlisted measurements re-attest instead of slashing", () => {
  const upgraded = `0x${"44".repeat(32)}` as Hex;
  const rogue = `0x${"55".repeat(32)}` as Hex;
  const intakeOnly = `0x${"66".repeat(32)}` as Hex;

  test("a genuine quote at a measurement the registry allows for the role is refreshed, not slashed", async () => {
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
    expect(results.map((row) => row.reason)).toEqual([null, "measurement mismatch", "measurement mismatch", "enrolled measurement no longer allowed"]);
    expect(f.refreshes.flatMap((batch) => batch.keys)).toEqual([upgradedKey]);
    expect(f.reported).toEqual([rogueKey, wrongRoleKey]);
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

  test("a reverting batch is split so one key cannot block the others", async () => {
    const f = await readyFixture({ count: 5 });
    const bad = f.keys[3]!;
    const refresh = f.deps.chain.refreshAttestation;
    f.deps.chain.refreshAttestation = async (batch, until) => {
      if (batch.includes(bad)) throw new Error("execution reverted: NotEnrolled");
      return refresh(batch, until);
    };
    const results = await createAttestor(f.deps).checkAll();
    expect(results.map((row) => row.reason)).toEqual([null, null, null, "attestation refresh failed", null]);
    expect(f.refreshes.flatMap((batch) => batch.keys).sort()).toEqual(f.keys.filter((key) => key !== bad).sort());
    expect(isSlashable("attestation refresh failed")).toBe(false);
  });
});
