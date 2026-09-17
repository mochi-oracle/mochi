import { readFile } from "node:fs/promises";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { parseTdxQuote } from "../packages/tee/src/dcap/quote.ts";
import { pemChain } from "../packages/tee/src/dcap/x509.ts";
import { parseTdxReportData } from "../packages/tee/src/tdx-common.ts";
import { quoteVerifierFromEnv, tdxQuoteMeasurement } from "../packages/tee/src/factory.ts";
import type { Quote } from "../packages/tee/src/provider.ts";

async function main() {
  const args = Bun.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) throw new Error("usage: bun scripts/tdx-measurement.ts <quote-file|-> [--now <unix>] [--verify]");
  const verify = args.includes("--verify");
  const nowArg = args.indexOf("--now");
  const now = nowArg === -1 ? undefined : Number(args[nowArg + 1]);
  if (nowArg !== -1 && (!Number.isSafeInteger(now) || now! < 0)) throw new Error("--now must be a non-negative Unix timestamp");

  const raw = source === "-" ? decodeHexInput(await new Response(Bun.stdin.stream()).text()) : new Uint8Array(await readFile(source));
  const parsed = parseTdxQuote(raw);
  const measurement = tdxQuoteMeasurement(raw);
  const chain = pemChain(parsed.pckPem);
  const fmspc = chain[0]?.sgx?.fmspc;
  if (!fmspc) throw new Error("quote PCK certificate has no FMSPC");
  const reportData = parseTdxReportData(parsed.td.reportData);
  const result: Record<string, unknown> = {
    measurement,
    mrtd: bytesToHex(parsed.td.mrTd),
    rtmr: parsed.td.rtmr.map((register) => bytesToHex(register)),
    tdAttributesDebug: (parsed.td.tdAttributes[0]! & 1) !== 0,
    fmspc: bytesToHex(fmspc),
    quoteVersion: parsed.version,
  };

  if (verify) {
    if (!reportData) throw new Error("TD REPORTDATA layout is invalid for Mochi");
    const quote: Quote = {
      kind: "tdx", measurement, reportData: reportData.keyBinding, issuedAt: reportData.issuedAt, raw: bytesToHex(raw),
    };
    const dcap = quoteVerifierFromEnv({ ...process.env, QUOTE_VERIFIER: "dcap" }, undefined, {
      now: now !== undefined ? () => now : () => Math.floor(Date.now() / 1000),
    });
    const outcome = await dcap.verify(quote);
    if (!outcome.ok) throw new Error(`DCAP verification failed: ${outcome.reason ?? "unknown error"}`);
    const claims = outcome as typeof outcome & { tcbStatus?: string; advisoryIds?: string[] };
    result.tcbStatus = claims.tcbStatus;
    result.advisoryIds = claims.advisoryIds;
  }
  console.log(JSON.stringify(result, null, 2));
}

function decodeHexInput(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("stdin must contain a raw quote encoded as hex");
  }
  return hexToBytes(`0x${normalized}` as Hex);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "TDX quote processing failed");
  process.exitCode = 1;
});
