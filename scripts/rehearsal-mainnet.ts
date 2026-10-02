/**
 * Testnet (46630) dress rehearsal of the exact mainnet deploy path, end to end:
 * deploy paused -> handover -> verify-ownership -> deployer and guardian cannot unpause -> owner unpauses through
 * the timelock -> guardian pauses -> owner renames the token through the timelock -> verify-ownership again.
 *
 *   bun scripts/rehearsal-mainnet.ts --usdg <MockUSDG on 46630> [--delay 60]
 *
 * Throwaway owner/guardian keys are created in a private temp directory (0700/0600), funded with 0.0003 ETH each
 * from ~/.config/mochi/testnet-deployer.json, and deleted at the end. No key is ever printed.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.chain.robinhood.com/rpc";
const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const usdg = arg("--usdg") as Address | undefined;
if (!usdg) throw new Error("--usdg <MockUSDG address> required");
const delay = Number(arg("--delay") ?? 60);
const out = "deployments/testnet-rehearsal.json";
const logDir = "deployments/logs";
mkdirSync(logDir, { recursive: true });

const chain = { id: 46630, name: "rhc-testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const deployerKeyFile = join(homedir(), ".config/mochi/testnet-deployer.json");
const deployer = privateKeyToAccount((JSON.parse(readFileSync(deployerKeyFile, "utf8")) as { privateKey: Hex }).privateKey);
const tmp = mkdtempSync(join(tmpdir(), "mochi-rehearsal-"));
chmodSync(tmp, 0o700);

function newKey(name: string): { file: string; address: Address } {
  const pk = generatePrivateKey();
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, JSON.stringify({ privateKey: pk }), { mode: 0o600 });
  return { file, address: privateKeyToAccount(pk).address };
}
function run(label: string, cmd: string[], expectFail = false): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  const text = r.stdout.toString() + r.stderr.toString();
  writeFileSync(join(logDir, `rehearsal-${label}.log`), text);
  const ok = r.exitCode === 0;
  if (ok === expectFail) throw new Error(`${label}: ${expectFail ? "expected failure but succeeded" : "failed"}\n${text.slice(-3000)}`);
  console.log(`  ✓ ${label}${expectFail ? " (reverted as expected)" : ""}`);
  return text;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escrowAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const tokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const before = await pub.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address} balance ${formatEther(before)} ETH`);
try {
  const owner = newKey("owner");
  const guardian = newKey("guardian");
  const wallet = createWalletClient({ chain, transport: http(RPC), account: deployer });
  for (const k of [owner, guardian]) {
    const hash = await wallet.sendTransaction({ to: k.address, value: parseEther("0.0003") });
    await pub.waitForTransactionReceipt({ hash });
  }
  console.log(`  ✓ funded rehearsal owner ${owner.address} and guardian ${guardian.address}`);

  run("deploy", ["bun", "scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--rpc", RPC, "--key-file", deployerKeyFile,
    "--owner", owner.address, "--guardian", guardian.address, "--usdg", usdg, "--shielded", "privacy-pools", "--randomness", "drand",
    "--timelock-delay", String(delay), "--panel-escalation", "off", "--out", out, "--yes"]);
  run("verify", ["bun", "scripts/verify-ownership.ts", out]);
  const dep = JSON.parse(readFileSync(out, "utf8")) as { contracts: Record<string, Address> };
  const escrow = dep.contracts.queryEscrow!;
  const token = dep.contracts.mochiToken!;
  if (!(await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "paused" }))) throw new Error("escrow not paused after deploy");
  console.log("  ✓ escrow launched paused");

  for (const [who, account] of [["deployer", deployer], ["guardian", privateKeyToAccount((JSON.parse(readFileSync(guardian.file, "utf8")) as { privateKey: Hex }).privateKey)]] as const) {
    try {
      await pub.simulateContract({ address: escrow, abi: escrowAbi, functionName: "unpause", account });
      throw new Error(`${who} could unpause`);
    } catch (e) {
      if ((e as Error).message.endsWith("could unpause")) throw e;
      console.log(`  ✓ ${who} cannot unpause (reverts)`);
    }
  }

  run("schedule-unpause", ["bun", "scripts/owner-timelock.ts", "unpause", out, "--key-file", owner.file]);
  await sleep((delay + 5) * 1000);
  run("execute-unpause", ["bun", "scripts/owner-timelock.ts", "execute", out, escrow, "unpause()", "--key-file", owner.file]);
  if (await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "paused" })) throw new Error("still paused after timelocked unpause");
  console.log("  ✓ owner unpaused through the timelock");

  const gWallet = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount((JSON.parse(readFileSync(guardian.file, "utf8")) as { privateKey: Hex }).privateKey) });
  const ph = await gWallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "pause" });
  await pub.waitForTransactionReceipt({ hash: ph });
  if (!(await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "paused" }))) throw new Error("guardian pause failed");
  console.log("  ✓ guardian paused instantly");

  run("schedule-rename", ["bun", "scripts/owner-timelock.ts", "schedule", out, token, "setMetadata(string,string)", "Mochi Rehearsal", "MOCHIR", "--key-file", owner.file]);
  await sleep((delay + 5) * 1000);
  run("execute-rename", ["bun", "scripts/owner-timelock.ts", "execute", out, token, "setMetadata(string,string)", "Mochi Rehearsal", "MOCHIR", "--key-file", owner.file]);
  const [n, s] = await Promise.all([
    pub.readContract({ address: token, abi: tokenAbi, functionName: "name" }),
    pub.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
  ]);
  if (n !== "Mochi Rehearsal" || s !== "MOCHIR") throw new Error(`rename did not land: ${n}/${s}`);
  console.log("  ✓ owner renamed the token through the timelock (Mochi Rehearsal / MOCHIR)");

  run("verify-final", ["bun", "scripts/verify-ownership.ts", out]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  const after = await pub.getBalance({ address: deployer.address });
  console.log(`temporary keys deleted; deployer spent ${formatEther(before - after)} ETH`);
}
console.log("REHEARSAL PASSED");
