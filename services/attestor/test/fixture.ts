// Shared fakes for the attestor tests: mock enclaves, an in-memory store and a registry that records refreshes.
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JurorAttestationDocSchema, passportHash } from "@mochi/protocol";
import type { AttestationDoc, JurorAttestationDoc } from "@mochi/protocol";
import { MockQuoteVerifier, MockTeeProvider } from "@mochi/tee";
import { Role } from "@mochi/core";
import type { AttestorDeps, ChainPort, Endpoint, Store } from "../src/ports.ts";

export const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const measurement = `0x${"22".repeat(32)}` as Hex;
export const zero = `0x${"00".repeat(32)}` as Hex;

export function provider(seedNum: number, m = measurement) {
  return new MockTeeProvider({ seed: toHex(new Uint8Array([seedNum])), measurement: m, mockRoot: root });
}

export async function docFor(tee: MockTeeProvider, overrides: Partial<JurorAttestationDoc> = {}, jurorClass = 2, passportOverrides: Record<string, unknown> = {}): Promise<JurorAttestationDoc> {
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

export class FakeStore implements Store {
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

export async function fixture(options: { count?: number; docs?: Map<string, JurorAttestationDoc | AttestationDoc>; unavailable?: Set<string>; block?: bigint; classes?: number[] } = {}) {
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

export async function readyFixture(opts: Parameters<typeof fixture>[0] = {}) {
  return fixture(opts);
}

export function teeRoot() { return root; }

export async function signedQuote(mockRoot: typeof root, m: Hex, reportData: Hex, issuedAt: number) {
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

