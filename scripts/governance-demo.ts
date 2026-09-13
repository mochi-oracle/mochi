// Exercises both governance paths on a live network. Deploy with short delays first, e.g.
//   bun scripts/deploy-local.ts --rpc <rpc> --key-file <key> --voting-period 120 --execution-delay 60 --timelock-delay 60
// 1. Clerk vote (staked $MOCHI): stake → propose SET_CLASS_MIX with the current mix (behavior-neutral) → vote → queue →
//    execute. Checks that queue before endTime and execute before eta both revert.
// 2. Timelock: grant MochiTimelock GOVERNOR on StockTokenCrosscheck → schedule setToken(TSLA, current token) →
//    early execute reverts → execute after minDelay.
// Usage: MOCHI_DEPLOYMENT=deployments/testnet.json MOCHI_KEY_FILE=~/.config/mochi/testnet-deployer.json \
//          bun scripts/governance-demo.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { encodeFunctionData, parseEventLogs, type Abi, type Address, type Hex } from "viem";
import { toBytes32String, ZERO32 } from "@mochi/core";
import * as A from "@mochi/chain";
import { createChain, loadDeployment, ROLE_IDS } from "@mochi/chain";

const keyFile = process.env.MOCHI_KEY_FILE?.replace(/^~/, homedir());
if (!keyFile) throw new Error("MOCHI_KEY_FILE required");
const privateKey = (JSON.parse(readFileSync(keyFile, "utf8")) as { privateKey: Hex }).privateKey;
const dep = loadDeployment();
const chain = createChain(dep, { privateKey });
const pub = chain.publicClient;
const me = chain.account!.address;
const C = dep.contracts;

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
async function send(address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  const { request } = await pub.simulateContract({ account: chain.account!, address, abi, functionName, args } as never);
  const hash = await chain.walletClient!.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
async function reverts(address: Address, abi: Abi, functionName: string, args: unknown[], pattern: RegExp) {
  try {
    await pub.simulateContract({ account: chain.account!, address, abi, functionName, args } as never);
    return false;
  } catch (e) {
    return pattern.test(String(e));
  }
}
async function waitForChainTime(target: bigint, label: string) {
  for (;;) {
    const ts = (await pub.getBlock()).timestamp;
    if (ts >= target) return;
    process.stdout.write(`  … waiting ${target - ts}s for ${label}\r`);
    await new Promise((r) => setTimeout(r, Math.min(10_000, Number(target - ts) * 1000 + 1000)));
  }
}

async function clerkVote() {
  console.log("1. Clerk vote: stake $MOCHI → propose SET_CLASS_MIX → vote → queue → execute");
  const V = A.ClerkVotingAbi as Abi;
  const threshold = await read<bigint>(C.clerkVoting!, V, "proposalThreshold");
  const staked = await read<bigint>(C.staking, A.MochiStakingAbi as Abi, "stakeOf", [me]).catch(() => 0n);
  if (staked < threshold) {
    const amount = threshold + 50_000n * 10n ** 18n - staked;
    await send(C.mochiToken, A.MochiTokenAbi as Abi, "approve", [C.staking, amount]);
    const stakeReceipt = await send(C.staking, A.MochiStakingAbi as Abi, "stake", [amount]);
    // Votes count stake as of one second before `propose` (checkpointed snapshot), so let the stake age first.
    const stakedAt = (await pub.getBlock({ blockNumber: stakeReceipt.blockNumber })).timestamp;
    await waitForChainTime(stakedAt + 2n, "the stake to reach the voting snapshot");
  }
  ok(true, `staked ≥ proposal threshold (${threshold / 10n ** 18n} MOCHI)`);
  const mix = await read<readonly number[]>(C.classMix!, A.ClassMixAbi as Abi, "mix");
  const input = {
    kind: 2, schemaId: 0, version: 0, schemaJsonHash: ZERO32, promptHash: ZERO32, tolerancesHash: ZERO32, crosscheckHash: ZERO32,
    classMix: [...mix],
  };
  const r = await send(C.clerkVoting!, V, "propose", [input]);
  const [created] = parseEventLogs({ abi: V, logs: r.logs, eventName: "ProposalCreated" }) as unknown as { args: { proposalId: bigint; endTime: bigint } }[];
  const id = created!.args.proposalId;
  ok(true, `proposal #${id} created (SET_CLASS_MIX, current mix [${mix.join(",")}])`);
  await send(C.clerkVoting!, V, "castVote", [id, true]);
  ok(true, "voted FOR with the full stake (stake locked until voting ends)");
  ok(await reverts(C.clerkVoting!, V, "queue", [id], /VotingNotEnded/), "queue before endTime reverts");
  await waitForChainTime(created!.args.endTime, "voting to end");
  await send(C.clerkVoting!, V, "queue", [id]);
  const p = await read<{ eta: bigint; queued: boolean }>(C.clerkVoting!, V, "getProposal", [id]);
  ok(p.queued, `queued; executable at eta ${new Date(Number(p.eta) * 1000).toISOString()}`);
  ok(await reverts(C.clerkVoting!, V, "execute", [id], /TimelockNotElapsed/), "execute before eta reverts TimelockNotElapsed");
  await waitForChainTime(p.eta, "the execution delay");
  const er = await send(C.clerkVoting!, V, "execute", [id]);
  ok(parseEventLogs({ abi: V, logs: er.logs, eventName: "ProposalExecuted" }).length === 1, "executed: ClerkVoting applied the class mix via its GOVERNOR role");
  const after = await read<readonly number[]>(C.classMix!, A.ClassMixAbi as Abi, "mix");
  ok(after.join() === mix.join(), "ClassMix reads back the voted mix");
}

async function timelock() {
  console.log("2. Timelock: schedule → early execute reverts → execute after minDelay");
  const T = A.MochiTimelockAbi as Abi;
  const X = A.StockTokenCrosscheckAbi as Abi;
  if (!(await read<boolean>(C.stockTokenCrosscheck, X, "hasRole", [ROLE_IDS.GOVERNOR, C.timelock!]))) {
    await send(C.stockTokenCrosscheck, X, "grantRole", [ROLE_IDS.GOVERNOR, C.timelock!]);
  }
  ok(true, "MochiTimelock holds GOVERNOR on StockTokenCrosscheck");
  const key = toBytes32String("TSLA");
  const token = await read<Address>(C.stockTokenCrosscheck, X, "tokenOf", [key]);
  const data = encodeFunctionData({ abi: X, functionName: "setToken", args: [key, token] });
  const salt = toBytes32String(`demo-${Date.now()}`);
  const delay = await read<bigint>(C.timelock!, T, "getMinDelay");
  const args = [C.stockTokenCrosscheck, 0n, data, ZERO32, salt];
  await send(C.timelock!, T, "schedule", [...args, delay]);
  const opId = await read<Hex>(C.timelock!, T, "hashOperation", args);
  ok(true, `scheduled setToken(TSLA, ${token.slice(0, 10)}…) with minDelay ${delay}s`);
  ok(await reverts(C.timelock!, T, "execute", args, /TimelockUnexpectedOperationState|0x5ead8eb5/), "execute before the delay reverts");
  const readyAt = await read<bigint>(C.timelock!, T, "getTimestamp", [opId]);
  await waitForChainTime(readyAt, "the timelock delay");
  const r = await send(C.timelock!, T, "execute", args);
  ok(parseEventLogs({ abi: T, logs: r.logs, eventName: "CallExecuted" }).length === 1, "timelock executed the call");
  ok(await read<boolean>(C.timelock!, T, "isOperationDone", [opId]), "operation marked done");
}

await Promise.all([clerkVote(), timelock()]);
console.log("\nGOVERNANCE DEMO PASSED: clerk vote and timelock both executed on-chain.");
