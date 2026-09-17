// Verifies a fresh TDX quote from a remote probe (deploy/phala/quote-probe.compose.yml) against Intel's live collateral.
// A throwaway key binding + current time go into REPORTDATA, so the quote must be freshly produced by that hardware.
// Usage: bun scripts/tdx-probe-check.ts <probe base URL> [--allow <status,status>] [--register-intake deployments/x.json]
//        (--register-intake also needs MOCHI_KEY_FILE: governor key; it allow-lists the measurement for INTAKE keys)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x25519 } from "@noble/curves/ed25519.js";
import { Role } from "@mochi/core";
import {
  DcapQuoteVerifier, PcsCollateralSource, keyBinding, parseTdxQuote, tdxQuoteMeasurement, tdxReportData, verifyTdxQuote,
  type Quote, type TcbStatus,
} from "@mochi/tee";
import * as A from "@mochi/chain";

const args = process.argv.slice(2);
const base = args[0]?.replace(/\/$/, "");
if (!base?.startsWith("http")) throw new Error("usage: bun scripts/tdx-probe-check.ts <probe base URL> [--allow s1,s2] [--register-intake dep.json]");
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const allowed = (opt("--allow") ?? "UpToDate").split(",") as TcbStatus[];

const address = privateKeyToAccount(bytesToHex(randomBytes(32))).address;
const encPub = bytesToHex(x25519.getPublicKey(randomBytes(32)));
const binding = keyBinding(address, encPub);
const issuedAt = Math.floor(Date.now() / 1000);
const reportData = tdxReportData(binding, issuedAt);

const response = await fetch(`${base}/quote?report_data=${bytesToHex(reportData).slice(2)}`, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`probe HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
const body = (await response.json()) as { quote: string };
const raw = hexToBytes((body.quote.startsWith("0x") ? body.quote : `0x${body.quote}`) as Hex);
const parsed = parseTdxQuote(raw);
const hex = (b: Uint8Array) => bytesToHex(b);

const collateral = new PcsCollateralSource();
const pck = (await import("@mochi/tee")).pemChain(parsed.pckPem);
const fmspc = bytesToHex(pck[0]!.sgx!.fmspc).slice(2).toUpperCase();
const ca = pck[1]!.subjectCN.includes("Processor") ? "processor" : "platform";
const dcap = verifyTdxQuote(raw, await collateral.get(fmspc, ca), issuedAt + 5);
const measurement = tdxQuoteMeasurement(raw);
console.log(JSON.stringify({
  quoteVersion: parsed.version, bytes: raw.length, fmspc, ca,
  intelTcbStatus: dcap.status, advisoryIds: dcap.advisoryIds,
  debugTd: (parsed.td.tdAttributes[0]! & 1) !== 0,
  reportDataMatches: hex(parsed.td.reportData) === hex(reportData),
  measurement, mrtd: hex(parsed.td.mrTd), rtmr: parsed.td.rtmr.map(hex),
}, null, 2));

const quote: Quote = { kind: "tdx", measurement, reportData: binding, raw: hex(raw), issuedAt };
const verdict = await new DcapQuoteVerifier({ collateral, policy: { allowedStatuses: allowed } }).verify(quote, { reportData: binding, maxAgeSec: 300 });
console.log(`Mochi policy (${allowed.join(",")}): ${verdict.ok ? "ACCEPTED" : `REJECTED — ${verdict.reason}`}`);

const depPath = opt("--register-intake");
if (depPath && verdict.ok) {
  const keyFile = process.env.MOCHI_KEY_FILE?.replace(/^~/, homedir());
  if (!keyFile) throw new Error("MOCHI_KEY_FILE required to register");
  const pk = (JSON.parse(readFileSync(keyFile, "utf8")) as { privateKey: Hex }).privateKey;
  const chain = A.createChain(A.loadDeployment(depPath), { privateKey: pk });
  const hash = await chain.walletClient!.writeContract({ account: chain.account!, chain: chain.publicClient.chain, address: chain.dep.contracts.jurorRegistry, abi: A.JurorRegistryAbi as Abi, functionName: "setMeasurement", args: [measurement, Role.INTAKE, true] } as never);
  const r = await chain.publicClient.waitForTransactionReceipt({ hash });
  console.log(`registered measurement for INTAKE on chain ${chain.dep.chainId}: tx ${hash} (${r.status})`);
}
