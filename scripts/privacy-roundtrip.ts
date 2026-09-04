// Real Privacy Pools round trip against a deployment made with `--shielded privacy-pools` (anvil):
// deposit USDG → approve-all ASP root → REAL Groth16 withdrawal proof (vendored circuit + trusted-setup keys) →
// PrivacyPoolShieldedPayments.spend as the escrow → escrow receives exactly the amount. Then: replay rejected, a proof
// bound to another query rejected, and the change note spent in a second withdrawal.
// Usage: anvil --host 127.0.0.1 --hardfork prague --port 18999 & bun scripts/deploy-local.ts --rpc http://127.0.0.1:18999 \
//          --out /tmp/pp.json --shielded privacy-pools && bun scripts/privacy-roundtrip.ts /tmp/pp.json
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as A from "@mochi/chain";
import {
  AspTree, StateTreeSync, buildWithdrawalProof, depositUSDG, generateNote, openShieldedPaymentFor,
} from "@mochi/privacy";
import { POSTMAN_ABI, PLACEHOLDER_ASP_CID } from "@mochi/privacy/postman";
import { DEV_KEYS } from "./deploy-local.ts";

const dep = JSON.parse(readFileSync(process.argv[2] ?? "deployments/local.json", "utf8")) as A.Deployment & {
  privacy: { entrypoint: Address; pool: Address; adapter: Address; scope: string };
};
if (dep.chainId !== 31337) throw new Error("anvil only (impersonates the escrow)");
const chain = A.chainFor(dep);
const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
const admin = createWalletClient({ chain, transport: http(dep.rpcUrl), account: privateKeyToAccount(DEV_KEYS.deployer) });
const payerKey = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const; // anvil #5
const payer = createWalletClient({ chain, transport: http(dep.rpcUrl), account: privateKeyToAccount(payerKey) });
const P = dep.privacy, C = dep.contracts, scope = BigInt(P.scope);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);
const adapterAbi = parseAbi(["function spend(bytes32 nullifier,uint256 amount,address recipient,bytes32 context,bytes proof)"]);
const ok = (c: unknown, m: string) => { if (!c) throw new Error(`ASSERTION FAILED: ${m}`); console.log(`  ✓ ${m}`); };
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });

async function approveAll(): Promise<AspTree> {
  const logs = await pub.getLogs({ address: P.pool, event: parseAbi(["event Deposited(address indexed _depositor,uint256 _commitment,uint256 _label,uint256 _value,uint256 _precommitmentHash)"])[0], fromBlock: 0n });
  const asp = new AspTree();
  for (const l of logs) asp.add(l.args._label!);
  await wait(await admin.writeContract({ address: P.entrypoint, abi: POSTMAN_ABI, functionName: "updateRoot", args: [asp.root, PLACEHOLDER_ASP_CID] }));
  return asp;
}
async function spendAsEscrow(nullifier: Hex, amount: bigint, queryId: Hex, proof: Hex) {
  await pub.request({ method: "anvil_impersonateAccount" as never, params: [C.queryEscrow] as never });
  await pub.request({ method: "anvil_setBalance" as never, params: [C.queryEscrow, toHex(10n ** 18n)] as never });
  const escrow = createWalletClient({ chain, transport: http(dep.rpcUrl), account: C.queryEscrow });
  const { request } = await pub.simulateContract({ account: C.queryEscrow, address: P.adapter, abi: adapterAbi, functionName: "spend", args: [nullifier, amount, C.queryEscrow, queryId, proof] });
  return wait(await escrow.writeContract(request));
}

console.log("1. Payer deposits 5 USDG into the pool");
await wait(await admin.writeContract({ address: C.usdg, abi: erc20, functionName: "mint", args: [payer.account.address, 10_000_000n] }));
const note = generateNote();
const deposit = await depositUSDG({ publicClient: pub as never, walletClient: payer as never }, P.entrypoint, C.usdg, 5_000_000n, note, P.pool);
ok(deposit.value > 0n, `deposit commitment ${deposit.commitment.toString().slice(0, 12)}… value ${deposit.value}`);

console.log("2. ASP postman approves every deposit (no identity checks)");
let asp = await approveAll();
const latest = await pub.readContract({ address: P.entrypoint, abi: POSTMAN_ABI, functionName: "latestRoot" });
ok(latest === asp.root, "on-chain ASP root equals the local LeanIMT root");

console.log("3. Real Groth16 withdrawal proof bound to (adapter, escrow, queryId)");
const queryId = keccak256(toHex("roundtrip-query-1"));
const amount = 1_300_000n;
const state = await new StateTreeSync().rebuild(pub as never, P.pool, 0n);
const onchainState = await pub.readContract({ address: P.pool, abi: parseAbi(["function currentRoot() view returns (uint256)"]), functionName: "currentRoot" });
ok(state.root === onchainState, "local state tree root equals the pool's currentRoot");
const bound = (qid: Hex) => ({ processooor: P.adapter, data: openShieldedPaymentFor(P.adapter, C.queryEscrow, qid, { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n], pubSignals: Array(8).fill(0n) }).withdrawal.data });
const { proof, newNote, seconds } = await buildWithdrawalProof({ note, deposit, stateTree: state, aspTree: asp, withdrawal: bound(queryId), scope, withdrawnValue: amount });
ok(true, `proof generated and verified locally in ${seconds.toFixed(1)} s`);
const pay = openShieldedPaymentFor(P.adapter, C.queryEscrow, queryId, proof);

console.log("4. Escrow spends through the adapter → the real pool verifies the proof on-chain");
const before = await pub.readContract({ address: C.usdg, abi: erc20, functionName: "balanceOf", args: [C.queryEscrow] });
const rcpt = await spendAsEscrow(pay.nullifier, amount, queryId, pay.proof);
const after = await pub.readContract({ address: C.usdg, abi: erc20, functionName: "balanceOf", args: [C.queryEscrow] });
ok(rcpt.status === "success" && after - before === amount, `escrow received exactly ${amount} (gas ${rcpt.gasUsed})`);

console.log("5. Negative checks");
let replay = false; try { await spendAsEscrow(pay.nullifier, amount, queryId, pay.proof); } catch { replay = true; }
ok(replay, "replaying the same proof is rejected (nullifier spent)");
let rebound = false; try { await spendAsEscrow(pay.nullifier, amount, keccak256(toHex("another-query")), pay.proof); } catch { rebound = true; }
ok(rebound, "the proof cannot pay for a different query");

console.log("6. Change note (the unspent remainder) is spendable");
const state2 = await new StateTreeSync().rebuild(pub as never, P.pool, 0n);
asp = await approveAll();
const changeLeaf = state2.tree.leaves[state2.tree.size - 1]!;
const change = { commitment: changeLeaf, label: newNote.label!, value: newNote.value!, index: state2.tree.size - 1 };
const qid2 = keccak256(toHex("roundtrip-query-2"));
const second = await buildWithdrawalProof({ note: newNote, deposit: change, stateTree: state2, aspTree: asp, withdrawal: bound(qid2), scope, withdrawnValue: 700_000n });
const pay2 = openShieldedPaymentFor(P.adapter, C.queryEscrow, qid2, second.proof);
const r2 = await spendAsEscrow(pay2.nullifier, 700_000n, qid2, pay2.proof);
ok(r2.status === "success", `change note spent (${change.value} → paid 700000, proof ${second.seconds.toFixed(1)} s)`);
console.log("\nPRIVACY ROUND TRIP PASSED: real proofs verified on-chain by the audited Privacy Pools contracts.");
