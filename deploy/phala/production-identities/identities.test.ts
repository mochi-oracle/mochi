import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DstackKeySource, keyBinding, parseTdxQuote, teeProviderFromEnv, tdxQuoteMeasurement, type QuoteSource, type QuoteVerifier, type TeeProvider } from "@mochi/tee";
import { createProductionIdentityReadiness, PRODUCTION_IDENTITY_SPECS, PRODUCTION_RECEIPT_SIGNING_SPEC } from "./identities.ts";

const fixture = new Uint8Array(await readFile(new URL("../../../packages/tee/test/fixtures/intel-tdx/tdx_quote", import.meta.url)));
const measurement = tdxQuoteMeasurement(fixture);
const mock = { seed: `0x${"11".repeat(32)}` as const, measurement, mockRoot: privateKeyToAccount(`0x${"22".repeat(32)}`) };
const now = () => 1_800_000_000;

function makeDeps() {
  const keyCalls: string[] = [];
  const materialByPath = new Map<string, number>();
  const keySource = new DstackKeySource({ fetch: (async (_url: string, init: RequestInit) => {
    const { path } = JSON.parse(String(init.body)) as { path: string };
    keyCalls.push(path);
    const index = materialByPath.get(path) ?? materialByPath.size + 1;
    materialByPath.set(path, index);
    return Response.json({ key: `0x${"00".repeat(31)}${index.toString(16).padStart(2, "0")}`, signature_chain: [`0x${"ab".repeat(32)}`] });
  }) as typeof fetch });
  const quoteSource: QuoteSource = { getQuote: async (reportData) => {
    const raw = fixture.slice();
    // TDX v4 report_data begins at byte 568; the provider and quote parser validate the signed structure.
    raw.set(reportData, 568);
    return raw;
  } };
  const quoteVerifier: QuoteVerifier = {
    async verify(quote, expected) {
      const parsed = parseTdxQuote(Buffer.from(quote.raw.slice(2), "hex"));
      const binding = bytesToHex(parsed.td.reportData.slice(0, 32));
      if (expected?.reportData?.toLowerCase() !== binding.toLowerCase()) return { ok: false, reason: "report data mismatch" };
      if (expected?.measurement?.toLowerCase() !== quote.measurement.toLowerCase()) return { ok: false, reason: "measurement mismatch" };
      if (expected?.maxAgeSec !== 300) return { ok: false, reason: "freshness policy missing" };
      return { ok: true, measurement: quote.measurement, reportData: binding };
    },
  };
  const create = () => createProductionIdentityReadiness({
    env: { TEE_MODE: "dstack", TEE_KEYS: "kms", QUOTE_VERIFIER: "dcap", TEE_KEY_LABEL: "operator-override-is-ignored" },
    mock, quoteVerifier, now, keySource,
    providerFactory: (spec) => teeProviderFromEnv(
      { TEE_MODE: "dstack", TEE_KEYS: "kms", TEE_KEY_LABEL: spec.label }, mock,
      { role: spec.role, quoteSource, keySource },
    ),
  });
  return { create, keyCalls, keySource };
}

test("production fleet uses 11 unique KMS labels and remains stable across service recreation", async () => {
  const { create, keyCalls } = makeDeps();
  const first = await (await create()).read();
  const second = await (await create()).read();
  expect(PRODUCTION_IDENTITY_SPECS).toHaveLength(11);
  expect(first.identities).toHaveLength(11);
  expect(new Set(first.identities.map(({ address }) => address.toLowerCase())).size).toBe(11);
  expect(new Set(first.identities.map(({ encryptionPublicKey }) => encryptionPublicKey.toLowerCase())).size).toBe(11);
  expect(second.identities.map(({ address, encryptionPublicKey }) => [address, encryptionPublicKey]))
    .toEqual(first.identities.map(({ address, encryptionPublicKey }) => [address, encryptionPublicKey]));
  expect(first.identities.every(({ quote, verification }) => quote.kind === "tdx" && verification.ok)).toBe(true);
  expect(first.identities.every(({ address, encryptionPublicKey, keyBinding: binding, quote }) =>
    binding === keyBinding(address, encryptionPublicKey) && quote.reportData === binding)).toBe(true);
  expect(first.identities[2]).toMatchObject({ jurorClass: 0, jurorSeat: 0 });
  expect(first.identities.at(-1)).toMatchObject({ jurorClass: 4, jurorSeat: 1 });
  expect(first.serviceSigners.map(({ name }) => name)).toEqual(["attestor", "indexer", "orchestrator", "feed-runner", "postman"]);
  expect(new Set(first.serviceSigners.map(({ address }) => address.toLowerCase())).size).toBe(5);
  expect(first.receiptSigner.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  expect(second.receiptSigner.publicKey).toBe(first.receiptSigner.publicKey);
  expect(keyCalls).toContain("mochi/intake/production-intake/sign");
  expect(keyCalls).toContain("mochi/consensus/production-consensus/x25519");
  expect(keyCalls).toContain("mochi/juror/production-juror-class-4-seat-1/sign");
  expect(keyCalls).toContain("mochi/service/production-service-attestor/sign");
  expect(keyCalls).toContain(PRODUCTION_RECEIPT_SIGNING_SPEC.path);
  expect(keyCalls.some((path) => path.includes("operator-override-is-ignored"))).toBe(false);
});

test("the quote check follows the runtime config's TCB policy, not the parent process's environment", async () => {
  const { keySource } = makeDeps();
  const base = { mock, keySource, providerFactory: async () => { throw new Error("verifier accepted"); } };
  // The parent environment's setting is invalid (Revoked); without an explicit policy it is what the verifier reads.
  const env = { TEE_MODE: "dstack", TEE_KEYS: "kms", QUOTE_VERIFIER: "dcap", TDX_ALLOWED_TCB_STATUSES: "UpToDate,Revoked" };
  await expect(createProductionIdentityReadiness({ ...base, env })).rejects.toThrow("must not include Revoked");
  // The runtime config's list replaces it.
  await expect(createProductionIdentityReadiness({ ...base, env, allowedTcbStatuses: ["UpToDate", "OutOfDate"] })).rejects.toThrow("verifier accepted");
});

test("production fleet refuses ephemeral or unverifiable configuration", async () => {
  const { create } = makeDeps();
  const options = {
    env: { TEE_MODE: "dstack", TEE_KEYS: "ephemeral", QUOTE_VERIFIER: "dcap" }, mock,
    quoteVerifier: { verify: async () => ({ ok: true }) } as QuoteVerifier,
  };
  await expect(createProductionIdentityReadiness(options)).rejects.toThrow("TEE_KEYS=kms");
  await expect(createProductionIdentityReadiness({ ...options, env: { TEE_MODE: "dstack", TEE_KEYS: "kms" } }))
    .rejects.toThrow("QUOTE_VERIFIER=dcap");
});

test("production fleet rejects reuse in either public-key column", async () => {
  const verify: QuoteVerifier = { verify: async (quote) => ({ ok: true, measurement: quote.measurement, reportData: quote.reportData }) };
  for (const duplicate of ["signer", "encryption"] as const) {
    const accounts = Array.from({ length: 11 }, (_, index) => privateKeyToAccount(`0x${(index + 1).toString(16).padStart(64, "0")}`));
    const providers: TeeProvider[] = [];
    const providerFactory = async (spec: typeof PRODUCTION_IDENTITY_SPECS[number]) => {
      const index = PRODUCTION_IDENTITY_SPECS.indexOf(spec);
      const signer = accounts[duplicate === "signer" && index > 0 ? 0 : index]!;
      const encryptionPublicKey = `0x${(duplicate === "encryption" && index > 0 ? 1 : index + 1).toString(16).padStart(64, "0")}` as const;
      const provider: TeeProvider = {
        kind: "tdx",
        measurement: () => measurement,
        signer: () => signer,
        encryptionPublicKey: () => encryptionPublicKey,
        decryptEnvelope: () => { throw new Error("not used"); },
        quote: async () => {
          const reportData = keyBinding(signer.address, encryptionPublicKey);
          return { kind: "tdx", measurement, reportData, raw: "0x01", issuedAt: now() };
        },
      };
      providers.push(provider);
      return provider;
    };
    const keySource = new DstackKeySource({ fetch: (async () => Response.json({ key: `0x${"01".repeat(32)}`, signature_chain: [`0x${"ab".repeat(32)}`] })) as unknown as typeof fetch });
    await expect(createProductionIdentityReadiness({
      env: { TEE_MODE: "dstack", TEE_KEYS: "kms", QUOTE_VERIFIER: "dcap" }, mock, quoteVerifier: verify, providerFactory, keySource,
    })).rejects.toThrow("production identity KMS keys are not distinct");
    expect(providers).toHaveLength(11);
  }
});
