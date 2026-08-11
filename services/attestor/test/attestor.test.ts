import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JurorAttestationDocSchema, passportHash } from "@mochi/protocol";
import type { AttestationDoc, JurorAttestationDoc } from "@mochi/protocol";
import { MockQuoteVerifier, MockTeeProvider, keyBinding } from "@mochi/tee";
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
      attestedUntil: 1_800_000_000n,
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
    refreshAttestation: async (batch, until) => { refreshes.push({ keys: [...batch], until }); return zero; },
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
  return { deps, store, docs, tees, keys, refreshes, reported };
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
      attestedUntil: 1_800_000_000n, delisted: false, served: 0, timeouts: 0,
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
      role: Role.JUROR, jurorClass: 2, bond: 5n, attestedUntil: 1_800_000_000n,
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
    const attestor = createAttestor(f.deps);
    const first = await attestor.checkAll();
    expect(first.every((r) => !r.ok)).toBe(true);
    expect(f.refreshes).toHaveLength(0);
    // A stale quote is a liveness problem: not refreshed, but never reported for slashing.
    expect(f.reported).toEqual(f.keys.filter((k) => k !== stale));
    await attestor.checkAll();
    expect(f.reported).toHaveLength(4);
    f.docs.set(mismatch, await docFor(f.tees[0]!));
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
