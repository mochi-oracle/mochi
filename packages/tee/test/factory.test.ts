import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { quoteVerifierFromEnv, teeProviderFromEnv, tdxQuoteMeasurement, type TsmPort } from "../src/index.ts";
import type { TdxCollateral } from "../src/dcap/collateral.ts";
import type { Quote } from "../src/provider.ts";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { tdxMeasurement } from "../src/tdx-common.ts";

const fixtureDir = new URL("./fixtures/intel-tdx/", import.meta.url);
const readFixture = async (name: string) => new Uint8Array(await readFile(new URL(name, fixtureDir)));
const readJson = async <T>(name: string) => JSON.parse(await readFile(new URL(name, fixtureDir), "utf8")) as T;
const root = privateKeyToAccount(`0x${"33".repeat(32)}`);
const mock = { seed: `0x${"11".repeat(32)}` as Hex, measurement: `0x${"22".repeat(32)}` as Hex, mockRoot: root };
const fixtureNow = 1_752_919_234;

function pcsFetch(collateral: TdxCollateral): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/tdx/certification/v4/tcb")) {
      return new Response(JSON.stringify({ tcbInfo: JSON.parse(collateral.tcb_info), signature: collateral.tcb_info_signature }), {
        headers: { "TCB-Info-Issuer-Chain": encodeURIComponent(collateral.tcb_info_issuer_chain) },
      });
    }
    if (url.pathname.endsWith("/tdx/certification/v4/qe/identity")) {
      return new Response(JSON.stringify({ enclaveIdentity: JSON.parse(collateral.qe_identity), signature: collateral.qe_identity_signature }), {
        headers: { "SGX-Enclave-Identity-Issuer-Chain": encodeURIComponent(collateral.qe_identity_issuer_chain) },
      });
    }
    if (url.pathname.endsWith("/sgx/certification/v4/pckcrl")) {
      return new Response(hexToBytes(`0x${collateral.pck_crl}`), {
        headers: { "SGX-PCK-CRL-Issuer-Chain": encodeURIComponent(collateral.pck_crl_issuer_chain) },
      });
    }
    return new Response(hexToBytes(`0x${collateral.root_ca_crl}`));
  }) as typeof fetch;
}

function bytesFromSnapshot(snapshot: string, name: string): Uint8Array {
  const found = snapshot.match(new RegExp(`${name}: \\[([\\d,\\s]+)\\]`));
  if (!found) throw new Error(`snapshot is missing ${name}`);
  return Uint8Array.from(found[1]!.split(",").map((value) => value.trim()).filter(Boolean).map(Number));
}

describe("TEE/verifier factories", () => {
  test("defaults to mock provider and verifier", async () => {
    expect(quoteVerifierFromEnv({}, { rootAddress: root.address }).constructor.name).toBe("MockQuoteVerifier");
    expect((await teeProviderFromEnv({}, mock)).kind).toBe("mock");
  });

  test("parses every DCAP setting and completes the PCS/DCAP chain before report data policy rejects the fixture", async () => {
    const collateral = await readJson<TdxCollateral>("tdx_quote_collateral.json");
    const raw = await readFixture("tdx_quote");
    const parsed = parseTdxQuote(raw);
    const measurement = tdxQuoteMeasurement(raw);
    const quote: Quote = {
      kind: "tdx", raw: bytesToHex(raw), measurement,
      reportData: `0x${"00".repeat(32)}`, issuedAt: 0,
    };
    const verifier = quoteVerifierFromEnv({
      QUOTE_VERIFIER: "dcap",
      PCS_BASE_URL: "https://pcs.test",
      PCS_ROOT_CA_CRL_URL: "https://pcs.test/root.crl",
      TDX_ALLOWED_TCB_STATUSES: "UpToDate,SWHardeningNeeded,ConfigurationNeeded,ConfigurationAndSWHardeningNeeded,OutOfDate,OutOfDateConfigurationNeeded",
      TDX_REJECT_ADVISORIES: "INTEL-SA-00000,INTEL-SA-00001",
      TDX_ALLOW_DEBUG: "1",
    }, undefined, { fetch: pcsFetch(collateral), now: () => fixtureNow });
    expect(verifier.constructor.name).toBe("DcapQuoteVerifier");
    expect((await verifier.verify(quote)).reason).toBe("reportData layout");
    expect(parsed.version).toBe(4);
  });

  test("rejects unsupported policy and provider settings", async () => {
    for (const env of [
      { QUOTE_VERIFIER: "nras" }, { QUOTE_VERIFIER: "bad" },
      { QUOTE_VERIFIER: "dcap", TDX_ALLOWED_TCB_STATUSES: "Bogus" },
      { QUOTE_VERIFIER: "dcap", TDX_ALLOWED_TCB_STATUSES: "Revoked" },
      { QUOTE_VERIFIER: "dcap", TDX_ALLOW_DEBUG: "true" },
    ]) expect(() => quoteVerifierFromEnv(env, { rootAddress: root.address })).toThrow();
    expect(() => quoteVerifierFromEnv({})).toThrow(/root address/);
    await expect(teeProviderFromEnv({ TEE_MODE: "sev-snp" }, mock)).rejects.toThrow(/unsupported TEE_MODE/);
    await expect(teeProviderFromEnv({ TEE_MODE: "tdx", TEE_KEYS: "kms" }, mock)).rejects.toThrow(/has no KMS/);
  });

  test("TDX provider measures its first fixture quote and measurement matches the parsed snapshot registers", async () => {
    const raw = await readFixture("tdx_quote");
    const snapshot = await readFile(new URL("verify_quote__could_parse_tdx_quote.snap", fixtureDir), "utf8");
    const snapMrtd = bytesFromSnapshot(snapshot, "mr_td");
    const snapRtmr = [0, 1, 2, 3].map((index) => bytesFromSnapshot(snapshot, `rt_mr${index}`)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    expect(tdxQuoteMeasurement(raw)).toBe(tdxMeasurement({ mrtd: snapMrtd, rtmr: snapRtmr }));

    let generation = 0;
    const tsm: TsmPort = {
      async mkdir() { generation = 0; },
      async rmdir() {},
      async writeFile() { generation += 1; },
      async readFile(path) {
        if (path.endsWith("/provider")) return new TextEncoder().encode("tdx_guest");
        if (path.endsWith("/generation")) return new TextEncoder().encode(String(generation));
        if (path.endsWith("/outblob")) return raw;
        throw new Error("unexpected fake TSM path");
      },
    };
    const provider = await teeProviderFromEnv({ TEE_MODE: "tdx", TSM_ROOT: "/fake/tsm" }, mock, { tsm });
    expect(provider.kind).toBe("tdx");
    expect(provider.measurement()).toBe(tdxQuoteMeasurement(raw));
  });
});
