// Quotes from a dstack guest agent (Phala Cloud and other dstack CVMs). Containers there get TDX quotes from the agent
// over a Unix socket instead of configfs-tsm. Uses the agent's frozen v0 `GetQuote` RPC (POST, JSON
// `{ "report_data": "<hex>" }` → `{ "quote": "<hex>", "event_log": "…" }`), served since dstack 0.3.
import { existsSync } from "node:fs";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { parseTdxQuote } from "./dcap/quote.ts";
import { TDX_REPORT_DATA_BYTES } from "./tdx-common.ts";
import { TsmError, type QuoteSource } from "./tdx-provider.ts";

/** Socket paths the dstack SDK probes, legacy first. */
export const DSTACK_SOCKET_PATHS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock", "/run/dstack/dstack.sock"];

export class DstackQuoteSource implements QuoteSource {
  private readonly socketPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { socketPath?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.socketPath = opts.socketPath ?? DSTACK_SOCKET_PATHS.find((p) => existsSync(p)) ?? DSTACK_SOCKET_PATHS[0]!;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async getQuote(reportData: Uint8Array): Promise<Uint8Array> {
    if (reportData.length !== TDX_REPORT_DATA_BYTES) throw new TsmError("report data must be 64 bytes");
    const response = await this.fetchImpl("http://dstack/GetQuote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report_data: bytesToHex(reportData).slice(2) }),
      signal: AbortSignal.timeout(this.timeoutMs),
      unix: this.socketPath,
    } as RequestInit);
    if (!response.ok) throw new TsmError(`dstack GetQuote HTTP ${response.status}`);
    const body = (await response.json()) as { quote?: unknown };
    if (typeof body.quote !== "string" || !/^(0x)?([0-9a-fA-F]{2})+$/.test(body.quote)) throw new TsmError("dstack GetQuote: no quote");
    const quote = hexToBytes((body.quote.startsWith("0x") ? body.quote : `0x${body.quote}`) as Hex);
    // The agent may hash or pad report data depending on version; accept only a quote over exactly our 64 bytes.
    const inQuote = parseTdxQuote(quote).td.reportData;
    if (inQuote.length !== reportData.length || inQuote.some((b, i) => b !== reportData[i])) {
      throw new TsmError("dstack quote does not carry the requested report data");
    }
    return quote;
  }
}

/** Stable private key material derived by the dstack guest KMS. */
export class DstackKeySource {
  private readonly socketPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(opts: { socketPath?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.socketPath = opts.socketPath ?? DSTACK_SOCKET_PATHS.find((p) => existsSync(p)) ?? DSTACK_SOCKET_PATHS[0]!;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async getKey(path: string, purpose: string): Promise<{ key: Uint8Array; signatureChain: Hex[] }> {
    const response = await this.fetchImpl("http://dstack/GetKey", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, purpose }), signal: AbortSignal.timeout(this.timeoutMs), unix: this.socketPath,
    } as RequestInit);
    if (!response.ok) throw new TsmError(`dstack GetKey HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new TsmError("dstack GetKey returned invalid JSON"); }
    if (!body || typeof body !== "object") throw new TsmError("dstack GetKey returned an invalid response");
    const record = body as { key?: unknown; signature_chain?: unknown };
    if (typeof record.key !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(record.key)) throw new TsmError("dstack GetKey must return a 32-byte key");
    if (!Array.isArray(record.signature_chain) || record.signature_chain.length === 0 || record.signature_chain.some((item) => typeof item !== "string" || !/^(0x)?([0-9a-fA-F]{2})+$/.test(item))) {
      throw new TsmError("dstack GetKey returned an invalid signature_chain");
    }
    const keyHex = record.key.startsWith("0x") ? record.key : `0x${record.key}`;
    return {
      key: hexToBytes(keyHex as Hex),
      signatureChain: record.signature_chain.map((item) => (item.startsWith("0x") ? item : `0x${item}`) as Hex),
    };
  }

  /** HKDF-SHA256 with empty salt and a domain-separated fixed info string. */
  async derive(path: string, purpose: string, info: string): Promise<{ key: Hex; signatureChain: Hex[] }> {
    const material = await this.getKey(path, purpose);
    const derived = hkdf(sha256, material.key, new Uint8Array(32), new TextEncoder().encode(info), 32);
    return { key: bytesToHex(derived), signatureChain: material.signatureChain };
  }
}
