// Registers real Robinhood Chain Stock Tokens with StockTokenCrosscheck and proves the cross-check reads them.
// For each token: read its multiplier schedule, setToken(ticker, token) if needed (governor), then eth_call
// check() with a SPLIT payload and simulate recordBaseline(). Reverts/garbage from the token would show up as
// TOKEN_READ_FAILED; a token with no schedule answers NO_PENDING_CHANGE.
// Usage: MOCHI_DEPLOYMENT=deployments/testnet.json MOCHI_KEY_FILE=~/.config/mochi/testnet-deployer.json \
//          bun scripts/register-stock-tokens.ts TSLA=0x... AMD=0x...
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { encodeAbiParameters, hexToString, type Address, type Hex } from "viem";
import { SchemaId, toBytes32String } from "@mochi/core";
import { createChain, loadDeployment, StockTokenCrosscheckAbi } from "@mochi/chain";

const multiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const keyFile = process.env.MOCHI_KEY_FILE?.replace(/^~/, homedir());
if (!keyFile) throw new Error("MOCHI_KEY_FILE required (governor key)");
const privateKey = (JSON.parse(readFileSync(keyFile, "utf8")) as { privateKey: Hex }).privateKey;
const dep = loadDeployment();
const chain = createChain(dep, { privateKey });
const pub = chain.publicClient;
const crosscheck = dep.contracts.stockTokenCrosscheck;

const pairs = process.argv.slice(2).map((a) => {
  const [ticker, token] = a.split("=");
  if (!ticker || !token?.startsWith("0x")) throw new Error(`bad arg ${a}; expected TICKER=0xAddress`);
  return { ticker: ticker.toUpperCase(), token: token as Address };
});

const splitPayload = (key: Hex, effectiveDate: bigint) => {
  const body = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "bytes32" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }] }],
    [[key, effectiveDate, 2, 1]],
  );
  return encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [key, effectiveDate, body]);
};
const reason = (r: Hex) => hexToString(r, { size: 32 }).replace(/\0+$/, "");

for (const { ticker, token } of pairs) {
  const key = toBytes32String(ticker);
  const read = <T>(functionName: (typeof multiplierAbi)[number]["name"]) =>
    pub.readContract({ address: token, abi: multiplierAbi, functionName }) as Promise<T>;
  const [symbol, ui, next, at] = await Promise.all([read<string>("symbol"), read<bigint>("uiMultiplier"), read<bigint>("newUIMultiplier"), read<bigint>("effectiveAt")]);
  if (symbol.toUpperCase() !== ticker) throw new Error(`${token} symbol is ${symbol}, not ${ticker}`);
  const current = await pub.readContract({ address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "tokenOf", args: [key] });
  if (current.toLowerCase() !== token.toLowerCase()) {
    const hash = await chain.walletClient!.writeContract({ account: chain.account!, chain: pub.chain, address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "setToken", args: [key, token] });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`setToken ${ticker} reverted`);
  }
  const effectiveDate = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const [ok, why] = await pub.readContract({ address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "check", args: [key, key, SchemaId.SPLIT, splitPayload(key, effectiveDate)] });
  let baseline: string;
  try {
    await pub.simulateContract({ account: chain.account!, address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "recordBaseline", args: [key] });
    baseline = "recordable (change pending)";
  } catch (e) {
    baseline = /NoPendingChange/.test(String(e)) ? "NoPendingChange (nothing scheduled)" : `unexpected: ${String(e).split("\n")[0]}`;
  }
  console.log(`${ticker.padEnd(5)} ${token}  ui=${ui} new=${next} effectiveAt=${at}  check(SPLIT 2:1)=${ok}/${reason(why)}  recordBaseline=${baseline}`);
  if (reason(why) === "TOKEN_READ_FAILED") throw new Error(`${ticker}: crosscheck could not read the token`);
}
