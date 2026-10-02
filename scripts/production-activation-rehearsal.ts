/**
 * Bounded local-only rehearsal of the mainnet-style deploy, configuration timelock,
 * and activation timelock. Uses a fresh Anvil on a free loopback high port (its listener
 * PID and chain id are checked before anything is sent) and mnemonic-derived
 * development keys only. No caller environment configuration is inherited by deploy-local.
 *
 * Run: bun scripts/production-activation-rehearsal.ts
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, type Address, type Hex } from "viem";
import * as A from "@mochi/chain";
import { buildPhalaBatch, type Input } from "./phala-batch.ts";
import { buildPanelSwitchOnBatch, panelWiringProblems, readPanelWiring } from "./panel-escalation.ts";
import { ROLE_IDS } from "@mochi/chain";
import { startAnvil } from "./launch-ops/anvil-harness.ts";

const ROOT = resolve(import.meta.dir, "..");
const MNEMONIC = "test test test test test test test test test test test junk";
const FIXTURE_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const accountAt = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });
const delay = 60n;
const unexpectedStateSelector = keccak256(toHex("TimelockUnexpectedOperationState(bytes32,bytes32)")).slice(0, 10);
const accessAbi = parseAbi([
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function grantRole(bytes32 role,address account)",
  "function paused() view returns (bool)",
]);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };

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

async function main() {
  // Our own anvil: free high port, listener PID and chain id 46630 verified before anything is sent.
  const anvil = await startAnvil(46630, ["--mnemonic", MNEMONIC, "--accounts", "20"]);
  const { rpc, port } = anvil;
  const temp = await mkdtemp(join(tmpdir(), "mochi-activation-rehearsal-"));
  try {
    const owner = accountAt(1);
    const guardian = owner; // User-selected shared administrative and emergency control.
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
      "--shielded", "privacy-pools", "--randomness", "drand", "--panel-escalation", "off", "--yes"], { cwd: ROOT, env });
    const deployed = await collect(deploy);
    assert(deployed.code === 0, `deploy-local rehearsal failed (exit ${deployed.code}):\n${deployed.output}`);
    const deployment = JSON.parse(await Bun.file(deploymentPath).text()) as { chainId: number; paused: boolean; minJurorBond: string; timelockDelay: string; panelEscalation?: string; contracts: Record<string, Address>; privacy?: { entrypoint: Address } };
    assert(deployment.chainId === 46630 && deployment.paused === true, "deployment metadata must describe paused chainId 46630 rehearsal");
    const { contracts } = deployment;
    assert(deployment.timelockDelay === "60", "new deployments must record the default 60-second delay");
    assert(await publicClient.readContract({ address: contracts.timelock!, abi: parseAbi(["function getMinDelay() view returns (uint256)"]), functionName: "getMinDelay" }) === delay, "deployed timelock must honour the default delay");
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" }), "QueryEscrow must start paused");
    // Launch keeps PanelEscalation deployed but unwired: no panel and no reserve share.
    const panelWiring = await readPanelWiring(publicClient, contracts.queryEscrow!);
    assert(deployment.panelEscalation === "off" && panelWiringProblems("off", contracts.panel, panelWiring).length === 0, "rehearsal must deploy with panel escalation off (QueryEscrow.panel 0x0, panelReserveBps 0)");

    // A rehearsal may stand in an external token, but deploy-local must refuse one with no contract code; no request leaves loopback.
    const productionGuard = start("bun", ["scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--rpc", rpc, "--key-file", keyPath, "--out", join(temp, "refused.json"), "--owner", owner.address,
      "--guardian", guardian.address, "--usdg", contracts.usdg!, "--mochi-token", guardian.address, "--shielded", "privacy-pools", "--randomness", "drand", "--panel-escalation", "off", "--yes"], { cwd: ROOT, env });
    const guardResult = await collect(productionGuard);
    assert(guardResult.code !== 0 && guardResult.output.includes("--mochi-token has no contract code"), "rehearsal mode must refuse an external MOCHI address without contract code");

    // The same mnemonic-derived fixture holds owner and guardian roles. Build the exact
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
    const deploymentForBatch = { timelockDelay: deployment.timelockDelay, minJurorBond: deployment.minJurorBond, contracts: { timelock: contracts.timelock!, jurorRegistry: contracts.jurorRegistry!,
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
    // Check the closed activation gate before enrolling our local zero-bond fixtures.
    const identitiesPath = join(temp, "identities.json");
    await writeFile(identitiesPath, JSON.stringify(input));
    const activationGate = start("bun", ["scripts/phala-batch.ts", deploymentPath, identitiesPath, "schedule", "activate"], { cwd: ROOT, env });
    const gateResult = await collect(activationGate);
    assert(gateResult.code !== 0 && gateResult.output.includes("enclave is not enrolled and active with the reviewed identity"), "activation CLI must block scheduling until all reviewed service and juror identities are enrolled and active");
    assert(deployment.minJurorBond === "0", "new team-operated deployment must default to zero bond");
    for (let i = 0; i < input.jurors.length; i++) {
      const seat = input.jurors[i]!;
      const digest = await publicClient.readContract({ address: contracts.jurorRegistry!, abi: A.JurorRegistryAbi, functionName: "enrollmentDigest", args: [seat.operator, seat.address, seat.measurement, seat.class] });
      const proof = await accountAt(jurorIndexes[i]!).signMessage({ message: { raw: digest } });
      const tx = await wallet(accountAt(jurorIndexes[i]! + 1)).writeContract({ address: contracts.jurorRegistry!, abi: A.JurorRegistryAbi, functionName: "enrollJuror", args: [seat.address, seat.measurement, seat.class, 0n, proof], chain: null });
      assert((await publicClient.waitForTransactionReceipt({ hash: tx })).status === "success", "zero-bond enrollment failed");
    }
    const until = (await publicClient.getBlock()).timestamp + 14n * delay;
    const refresh = await wallet(accountAt(18)).writeContract({ address: contracts.jurorRegistry!, abi: A.JurorRegistryAbi, functionName: "refreshAttestation", args: [[input.intake.address, input.consensus.address, ...input.jurors.map(j => j.address)], until], chain: null });
    assert((await publicClient.waitForTransactionReceipt({ hash: refresh })).status === "success", "fixture attestation failed");
    const readyGate = await collect(start("bun", ["scripts/phala-batch.ts", deploymentPath, identitiesPath, "schedule", "activate"], { cwd: ROOT, env }));
    assert(readyGate.code === 0, "activation CLI must accept approved zero-bond jurors after attestation");
    let directUnpauseRefused = false;
    try { await publicClient.simulateContract({ account: owner.address, address: contracts.queryEscrow!, abi: A.QueryEscrowAbi, functionName: "unpause" }); }
    catch { directUnpauseRefused = true; }
    assert(directUnpauseRefused, "shared owner/guardian must not bypass the reopening delay");
    const activation = buildPhalaBatch(deploymentForBatch, input, "schedule", "activate");
    await schedule(activation);
    const activationExecute = buildPhalaBatch(deploymentForBatch, input, "execute", "activate");
    await expectTimelockNotReady(activationExecute);
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_increaseTime", params: [Number(delay)] });
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_mine", params: [] });
    await execute(activationExecute);
    assert(!(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" })), "activation must unpause QueryEscrow after full delay");
    // Verify shared custody still pauses immediately, without gaining direct unpause authority.
    const guardianPauseHash = await guardianWallet.writeContract({ address: contracts.queryEscrow!, abi: parseAbi(["function pause()"]), functionName: "pause", chain: null });
    const guardianPauseReceipt = await publicClient.waitForTransactionReceipt({ hash: guardianPauseHash });
    assert(guardianPauseReceipt.status === "success", "guardian pause transaction failed after activation");
    assert(await publicClient.readContract({ address: contracts.queryEscrow!, abi: accessAbi, functionName: "paused" }), "guardian must retain pause authority after activation");

    // The generated switch-on batch, run through the deployed timelock, wires the panel back on after its own delay.
    const panelSalt = `0x${"5e".repeat(32)}` as Hex;
    const panelOnSchedule = buildPanelSwitchOnBatch(deploymentForBatch as never, panelSalt, "schedule");
    const panelOnExecute = buildPanelSwitchOnBatch(deploymentForBatch as never, panelSalt, "execute");
    await schedule(panelOnSchedule as never);
    await expectTimelockNotReady(panelOnExecute as never);
    assert(panelWiringProblems("off", contracts.panel, await readPanelWiring(publicClient, contracts.queryEscrow!)).length === 0, "panel must stay off until the switch-on delay passes");
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_increaseTime", params: [Number(delay)] });
    await (publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "evm_mine", params: [] });
    await execute(panelOnExecute as never);
    assert(panelWiringProblems("on", contracts.panel, await readPanelWiring(publicClient, contracts.queryEscrow!)).length === 0, "switch-on batch must wire PanelEscalation with the 2500 bps reserve");

    console.log(JSON.stringify({
      result: "passed", rpc, chainId: 46630, deploymentMode: "mainnet rehearsal", deployer: deployer.address,
      owner: owner.address, guardian: guardian.address, mochiSource: "test-deployment (local fixture only)",
      usdg: "MockUSDG", initialPaused: true, configure: { callCount: configureSchedule.callCount, earlyExecutionReverted: true, earlyRevert: "TimelockUnexpectedOperationState", executedAfterSeconds: "60", pausedAfterConfigure: true, attestorRoleAssigned: true, feedRunnerRoleAssigned: true },
      activation: { callCount: activation.callCount, earlyExecutionReverted: true, earlyRevert: "TimelockUnexpectedOperationState", executedAfterSeconds: "60", unpausedAfterExecution: true, guardianPauseAfterActivation: true },
      panelEscalation: { deployedOff: true, switchOnCallCount: panelOnSchedule.callCount, earlyExecutionReverted: true, onAfterDelay: true },
      jurorFixture: "nine locally approved and attested zero-bond jurors; activation CLI refused before enrollment and passed afterward; no payment or real service health claimed",
      limitation: "this local run deploys the test token; the external-token path is exercised by a testnet dress rehearsal (chain 46630, --mochi-token stand-in) and on mainnet",
    }, null, 2));
  } finally {
    await anvil.stop();
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
