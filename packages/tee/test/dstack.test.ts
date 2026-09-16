import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { bytesToHex } from "viem";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { DstackKeySource, DstackQuoteSource } from "../src/dstack.ts";
import { tdxQuoteMeasurement, teeProviderFromEnv } from "../src/factory.ts";
import { MockTeeProvider, keyBinding } from "../src/provider.ts";
import { TdxTeeProvider, type QuoteSource } from "../src/tdx-provider.ts";

const fixture = new Uint8Array(await readFile(new URL("./fixtures/intel-tdx/tdx_quote", import.meta.url)));
const fixtureReportData = parseTdxQuote(fixture).td.reportData;

function agent(reply: (body: { report_data: string }) => Response) {
  const calls: { url: string; init: RequestInit & { unix?: string }; body: { report_data: string } }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit & { unix?: string }) => {
    const body = JSON.parse(String(init.body)) as { report_data: string };
    calls.push({ url, init, body });
    return reply(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("DstackQuoteSource", () => {
  it("posts raw report data to GetQuote over the socket and returns the quote", async () => {
    const { fetchImpl, calls } = agent(() => Response.json({ quote: bytesToHex(fixture).slice(2), event_log: "[]" }));
    const source = new DstackQuoteSource({ socketPath: "/tmp/test-dstack.sock", fetch: fetchImpl });
    expect(await source.getQuote(fixtureReportData)).toEqual(fixture);
    expect(calls[0]!.url).toBe("http://dstack/GetQuote");
    expect(calls[0]!.init.unix).toBe("/tmp/test-dstack.sock");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.body.report_data).toBe(bytesToHex(fixtureReportData).slice(2));
  });
  it("accepts 0x-prefixed hex", async () => {
    const { fetchImpl } = agent(() => Response.json({ quote: bytesToHex(fixture) }));
    expect(await new DstackQuoteSource({ fetch: fetchImpl }).getQuote(fixtureReportData)).toEqual(fixture);
  });
  it("rejects a quote over different report data (agent hashed/padded it, or replay)", async () => {
    const { fetchImpl } = agent(() => Response.json({ quote: bytesToHex(fixture) }));
    await expect(new DstackQuoteSource({ fetch: fetchImpl }).getQuote(new Uint8Array(64).fill(7))).rejects.toThrow("does not carry the requested report data");
  });
  it("rejects HTTP errors, missing or malformed quotes, and wrong report-data length", async () => {
    const src = (r: Response) => new DstackQuoteSource({ fetch: agent(() => r).fetchImpl });
    await expect(src(new Response("no", { status: 500 })).getQuote(fixtureReportData)).rejects.toThrow("HTTP 500");
    await expect(src(Response.json({})).getQuote(fixtureReportData)).rejects.toThrow("no quote");
    await expect(src(Response.json({ quote: "zz" })).getQuote(fixtureReportData)).rejects.toThrow("no quote");
    await expect(src(Response.json({ quote: "00" })).getQuote(new Uint8Array(32))).rejects.toThrow("64 bytes");
  });
});

describe("DstackKeySource", () => {
  it("posts GetKey requests over the socket and rejects malformed key material", async () => {
    let request: { url: string; init: RequestInit & { unix?: string }; body: { path: string; purpose: string } } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit & { unix?: string }) => {
      request = { url, init, body: JSON.parse(String(init.body)) };
      return Response.json({ key: "ab".repeat(32), signature_chain: ["cd".repeat(32)] });
    }) as unknown as typeof fetch;
    const source = new DstackKeySource({ socketPath: "/tmp/dstack.sock", fetch: fetchImpl });
    expect(await source.getKey("mochi/intake/default/sign", "mochi signing key")).toMatchObject({ key: new Uint8Array(32).fill(0xab), signatureChain: [`0x${"cd".repeat(32)}`] });
    expect(request).toMatchObject({ url: "http://dstack/GetKey", body: { path: "mochi/intake/default/sign", purpose: "mochi signing key" }, init: { method: "POST", unix: "/tmp/dstack.sock" } });
    const bad = new DstackKeySource({ fetch: (async () => Response.json({ key: "01", signature_chain: [] })) as unknown as typeof fetch });
    await expect(bad.getKey("x", "y")).rejects.toThrow("32-byte key");
    const badChain = new DstackKeySource({ fetch: (async () => Response.json({ key: "01".repeat(32), signature_chain: [] })) as unknown as typeof fetch });
    await expect(badChain.getKey("x", "y")).rejects.toThrow("invalid signature_chain");
  });
});

describe("TdxTeeProvider with a quote source", () => {
  it("binds keys + time into REPORTDATA and takes its measurement from the hardware quote", async () => {
    const seen: Uint8Array[] = [];
    const source: QuoteSource = { getQuote: async (rd) => { seen.push(rd); return fixture; } };
    const provider = await TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, quoteSource: source, now: () => 1_790_000_000 });
    const quote = await provider.quote();
    const binding = keyBinding(provider.signer().address, provider.encryptionPublicKey());
    expect(quote).toMatchObject({ kind: "tdx", reportData: binding, raw: bytesToHex(fixture), issuedAt: 1_790_000_000 });
    expect(provider.measurement()).toBe(tdxQuoteMeasurement(fixture));
    expect(bytesToHex(seen.at(-1)!.subarray(0, 32))).toBe(binding);
  });
  it("factory selects dstack mode", async () => {
    const source: QuoteSource = { getQuote: async () => fixture };
    const mockRoot = (await import("viem/accounts")).privateKeyToAccount(`0x${"33".repeat(32)}`);
    const mock = { seed: `0x${"11".repeat(32)}` as const, measurement: `0x${"22".repeat(32)}` as const, mockRoot };
    const tee = await teeProviderFromEnv({ TEE_MODE: "dstack", TEE_KEYS: "ephemeral" }, mock, { quoteSource: source });
    expect(tee.kind).toBe("tdx");
    expect(tee.measurement()).toBe(tdxQuoteMeasurement(fixture));
    expect(await teeProviderFromEnv({}, mock)).toBeInstanceOf(MockTeeProvider);
    await expect(teeProviderFromEnv({ TEE_MODE: "sgx" }, mock)).rejects.toThrow("expected mock, tdx or dstack");
  });

  it("keeps KMS-derived keys stable by role and label, and binds them in REPORTDATA", async () => {
    const root = (await import("viem/accounts")).privateKeyToAccount(`0x${"33".repeat(32)}`);
    const mock = { seed: `0x${"11".repeat(32)}` as const, measurement: `0x${"22".repeat(32)}` as const, mockRoot: root };
    const paths: string[] = [];
    const keySource = new DstackKeySource({ fetch: (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { path: string };
      paths.push(req.path);
      const byte = req.path.includes("large-a") ? "11" : req.path.includes("large-b") ? "22" : "33";
      return Response.json({ key: byte.repeat(32), signature_chain: ["ab".repeat(32)] });
    }) as typeof fetch });
    const requestedReportData: Uint8Array[] = [];
    const quoteSource: QuoteSource = { getQuote: async (reportData) => { requestedReportData.push(reportData); return fixture; } };
    const make = (label: string) => teeProviderFromEnv({ TEE_MODE: "dstack", TEE_KEY_LABEL: label }, mock, { quoteSource, keySource, role: "juror" });
    const first = await make("large-a");
    const again = await make("large-a");
    const other = await make("large-b");
    expect(first.signer().address).toBe(again.signer().address);
    expect(first.encryptionPublicKey()).toBe(again.encryptionPublicKey());
    expect(first.signer().address).not.toBe(other.signer().address);
    expect(first.encryptionPublicKey()).not.toBe(other.encryptionPublicKey());
    expect(paths).toContain("mochi/juror/large-a/sign");
    expect(paths).toContain("mochi/juror/large-a/x25519");
    const q = await first.quote();
    const binding = keyBinding(first.signer().address, first.encryptionPublicKey());
    expect(q.reportData).toBe(binding);
    expect(bytesToHex(requestedReportData.at(-1)!.subarray(0, 32))).toBe(binding);
    expect(q.kmsSignatureChain).toEqual([`0x${"ab".repeat(32)}`]);
    expect(q.kmsEncryptionSignatureChain).toEqual([`0x${"ab".repeat(32)}`]);
  });
});
