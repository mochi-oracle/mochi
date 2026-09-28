/**
 * Bounded local-only rehearsal of the mainnet-style deploy, configuration timelock,
 * and activation timelock. Uses a fresh Anvil loopback port and mnemonic-derived
 * development keys only. No caller environment configuration is inherited by deploy-local.
 *
 * Run: bun scripts/production-activation-rehearsal.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import { buildPhalaBatch, type Input } from "./phala-batch.ts";
import { ROLE_IDS } from "@mochi/chain";

const ROOT = resolve(import.meta.dir, "..");
const MNEMONIC = "test test test test test test test test test test test junk";
const FIXTURE_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const accountAt = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const delay = 86_400n;
const unexpectedStateSelector = keccak256(toHex("TimelockUnexpectedOperationState(bytes32,bytes32)")).slice(0, 10);
const accessAbi = parseAbi([
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function grantRole(bytes32 role,address account)",
  "function paused() view returns (bool)",
]);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((ok, fail) => server.close((err) => err ? fail(err) : ok()));
  return port;
}

function start(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
}

async function collect(proc: ChildProcess, timeoutMs = 180_000): Promise<{ code: number; output: string }> {
  let output = "";
  proc.stdout?.on("data", (x) => output += String(x));
  proc.stderr?.on("data", (x) => output += String(x));
  const code = await new Promise<number>((resolveCode, reject) => {
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`child process exceeded ${timeoutMs}ms bound`)); }, timeoutMs);
    proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    proc.once("exit", (value) => { clearTimeout(timer); resolveCode(value ?? 1); });
  });
  return { code, output };
}

async function waitForRpc(url: string, proc: ChildProcess) {
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Anvil exited before becoming ready (exit ${proc.exitCode})`);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok && Number.parseInt((await response.json() as { result: string }).result, 16) === 46630) return;
    } catch { /* wait for startup */ }
    await sleep(125);
  }
  throw new Error("Anvil did not become ready on its loopback port");
}

async function main() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const temp = await mkdtemp(join(tmpdir(), "mochi-activation-rehearsal-"));
  const anvil = start("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "46630", "--mnemonic", MNEMONIC, "--accounts", "20"], { cwd: ROOT, env: { PATH: process.env.PATH } });
  try {
    await waitForRpc(rpc, anvil);
    const owner = accountAt(1);
    const guardian = accountAt(2);
    const deployer = accountAt(0);
    const publicClient = createPublicClient({ transport: http(rpc) });
    const wallet = (account: ReturnType<typeof accountAt>) => createWalletClient({ account, transport: http(rpc) });
    const ownerWallet = wallet(owner);
    const guardianWallet = wallet(guardian);
    const deployerWallet = wallet(deployer);
    const usdgHash = await deployerWallet.deployContract({ abi: A.MockUSDGAbi, bytecode: A.MockUSDGBytecode, chain: null });
    const usdgReceipt = await publicClient.waitForTransactionReceipt({ hash: usdgHash });
    assert(usdgReceipt.contractAddress, "local MockUSDG deployment failed");
    const deploymentPath = join(temp, "deployment.json");
    const keyPath = join(temp, "fixture-deployer-key.json");
    await writeFile(keyPath, JSON.stringify({ privateKey: FIXTURE_DEPLOYER_KEY }), { mode: 0o600 });
    const env = { PATH: process.env.PATH };
    const deploy = start("bun", ["scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--rpc", rpc, "--key-file", keyPath, "--out", deploymentPath,
      "--owner", owner.address, "--guardian", guardian.address, "--usdg", usdgReceipt.contractAddress!,
      "--shielded", "privacy-pools", "--randomness", "drand", "--timelock-delay", "86400", "--yes"], { cwd: ROOT, env });
    const deployed = await collect(deploy);
    assert(deployed.code === 0, `deploy-local rehearsal failed (exit ${deployed.code}):\n${deployed.output}`);
    const deployment = JSON.parse(await Bun.file(deploymentPath).text()) as { chainId: number; paused: boolean; contracts: Record<string, Address>; privacy?: { entrypoint: Address } };
    assert(deployment.chainId === 46630 && deployment.paused === true, "deployment metadata must describe paused chainId 46630 rehearsal");
    const { contracts } = deployment;
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" }), "QueryEscrow must start paused");

    // Prove deploy-local refuses an external token in rehearsal mode; no request leaves loopback.
    const productionGuard = start("bun", ["scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--rpc", rpc, "--owner", owner.address,
      "--guardian", guardian.address, "--usdg", contracts.usdg!, "--mochi-token", contracts.mochiToken!, "--shielded", "privacy-pools", "--randomness", "drand", "--yes"], { cwd: ROOT, env });
    const guardResult = await collect(productionGuard);
    assert(guardResult.code !== 0 && guardResult.output.includes("--mochi-token is accepted only for production mainnet"), "rehearsal mode must refuse an external MOCHI address");

    // The owner and guardian are distinct mnemonic-derived fixtures. Build the exact
    // nine-juror 2/2/2/1/2 payload with deterministic nonzero test identities.
    const identity = (index: number, cls?: number) => ({ address: accountAt(index).address, operator: accountAt(index + 1).address,
      measurement: (`0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`) as Hex, ...(cls === undefined ? {} : { class: cls }) });
    const jurorIndexes = [4, 5, 6, 7, 8, 9, 10, 11, 12];
    const classes = [0, 0, 1, 1, 2, 2, 3, 4, 4];
    const input: Input = {
      salt: keccak256(toHex(`activation-rehearsal-${port}`)),
      intake: identity(14), consensus: identity(16),
      jurors: jurorIndexes.map((n, i) => identity(n, classes[i])) as Input["jurors"],
      attestor: accountAt(18).address, feedRunner: accountAt(19).address, orchestrator: accountAt(0).address,
      indexer: accountAt(18).address, postman: accountAt(19).address,
    };
    assert(deployment.privacy?.entrypoint, "mainnet rehearsal deployment must include its real privacy entrypoint");
    const deploymentForBatch = { contracts: { timelock: contracts.timelock!, jurorRegistry: contracts.jurorRegistry!,
      queryEscrow: contracts.queryEscrow!, receiptAnchor: contracts.receiptAnchor!, panel: contracts.panel! }, privacy: deployment.privacy };
    const configureSchedule = buildPhalaBatch(deploymentForBatch, input, "schedule", "configure");
    const configureExecute = buildPhalaBatch(deploymentForBatch, input, "execute", "configure");
    const schedule = async (batch: typeof configureSchedule) => {
      const hash = await ownerWallet.sendTransaction({ to: batch.to, data: batch.calldata, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash }); assert(receipt.status === "success", `${batch.phase} schedule failed`);
    };
    const execute = async (batch: typeof configureExecute) => {
      const hash = await ownerWallet.sendTransaction({ to: batch.to, data: batch.calldata, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash }); assert(receipt.status === "success", `${batch.phase} execution failed`);
    };
    const expectTimelockNotReady = async (batch: typeof configureExecute) => {
      let failure = "";
      try { await publicClient.call({ account: owner.address, to: batch.to, data: batch.calldata }); }
      catch (error) { failure = String(error); }
      assert(failure.includes(unexpectedStateSelector), `${batch.phase} early execution did not return TimelockUnexpectedOperationState: ${failure || "call succeeded"}`);
    };
    await schedule(configureSchedule);
    await expectTimelockNotReady(configureExecute);
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_increaseTime", params: [Number(delay)] });
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_mine", params: [] });
    await execute(configureExecute);
    assert(await publicClient.readContract({ address: contracts.jurorRegistry!, abi: accessAbi, functionName: "hasRole", args: [ROLE_IDS.ATTESTOR, input.attestor] }), "attestor role assignment missing after configure batch");
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "hasRole", args: [ROLE_IDS.FEED_RUNNER, input.feedRunner] }), "feed runner role assignment missing after configure batch");
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" }), "configure must keep QueryEscrow paused");

    // The activation CLI requires all service/juror enrollment and identity checks.
    // We intentionally do not manufacture payments, bonds, or successful service enrollment.
    const identitiesPath = join(temp, "identities.json");
    await writeFile(identitiesPath, JSON.stringify(input));
    const activationGate = start("bun", ["scripts/phala-batch.ts", deploymentPath, identitiesPath, "schedule", "activate"], { cwd: ROOT, env });
    const gateResult = await collect(activationGate);
    assert(gateResult.code !== 0 && gateResult.output.includes("enclave is not enrolled and active with the reviewed identity"), "activation CLI must block scheduling until all reviewed service and juror identities are enrolled and active");
    const activation = buildPhalaBatch(deploymentForBatch, input, "schedule", "activate");
    await schedule(activation);
    const activationExecute = buildPhalaBatch(deploymentForBatch, input, "execute", "activate");
    await expectTimelockNotReady(activationExecute);
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_increaseTime", params: [Number(delay)] });
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_mine", params: [] });
    await execute(activationExecute);
    assert(!(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" })), "activation must unpause QueryEscrow after full delay");
    // Verify guardian retains the independent pause role after unpause.
    const guardianPauseHash = await guardianWallet.writeContract({ address: contracts.queryEscrow!, abi: parseAbi(["function pause()"]), functionName: "pause", chain: null });
    const guardianPauseReceipt = await publicClient.waitForTransactionReceipt({ hash: guardianPauseHash });
    assert(guardianPauseReceipt.status === "success", "guardian pause transaction failed after activation");
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" }), "guardian must retain pause authority after activation");

    console.log(JSON.stringify({
      result: "passed", rpc, chainId: 46630, deploymentMode: "mainnet rehearsal", deployer: deployer.address,
      owner: owner.address, guardian: guardian.address, mochiSource: "test-deployment (external token prohibited by rehearsal policy)",
      usdg: "MockUSDG", initialPaused: true, configure: { callCount: configureSchedule.callCount, earlyExecutionReverted: true, earlyRevert: "TimelockUnexpectedOperationState", executedAfterSeconds: "86400", pausedAfterConfigure: true, attestorRoleAssigned: true, feedRunnerRoleAssigned: true },
      activation: { callCount: activation.callCount, earlyExecutionReverted: true, earlyRevert: "TimelockUnexpectedOperationState", executedAfterSeconds: "86400", unpausedAfterExecution: true, guardianPauseAfterActivation: true },
      jurorFixture: "nine identities, class counts 2/2/2/1/2; activation CLI correctly blocked because no operator enrollment was performed; no bonds, payment, or service health claimed",
      limitation: "external MOCHI on chainId 4663 cannot be reached with MockUSDG: mainnet rejects MockUSDG outside rehearsal, while rehearsal is chainId 46630 only and rejects --mochi-token",
    }, null, 2));
  } finally {
    anvil.kill("SIGTERM");
    if (anvil.exitCode === null) {
      await Promise.race([new Promise<void>((resolveExit) => anvil.once("exit", () => resolveExit())), sleep(3_000)]);
      if (anvil.exitCode === null) anvil.kill("SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
