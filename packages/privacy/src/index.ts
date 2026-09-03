import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { encodeAbiParameters, encodePacked, keccak256, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

// Constants.SNARK_SCALAR_FIELD (vendor/.../contracts/src/contracts/lib/Constants.sol:5).
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const STATE_ABI = parseAbi(["event LeafInserted(uint256 _index,uint256 _leaf,uint256 _root)", "event Deposited(address indexed _depositor,uint256 _commitment,uint256 _label,uint256 _value,uint256 _precommitmentHash)"]);
export const ENTRY_ABI = parseAbi(["function deposit(address _asset,uint256 _value,uint256 _precommitment) returns (uint256)"]);
export const ERC20_ABI = parseAbi(["function approve(address,uint256) returns (bool)"]);
export type Note = { nullifier: bigint; secret: bigint; label?: bigint; value?: bigint };
export type Deposit = { commitment: bigint; label: bigint; value: bigint; index?: number };
const randomField = () => { let n: bigint; do { n = BigInt(`0x${Buffer.from(randomBytes(32)).toString("hex")}`); } while (n >= SNARK_FIELD); return n; };
// Poseidon arities and input order are CommitmentHasher in circuits/circuits/commitment.circom:24-34.
export const precommitment = (nullifier: bigint, secret: bigint) => poseidon2([nullifier, secret]);
export const commitment = (value: bigint, label: bigint, precommitmentHash: bigint) => poseidon3([value, label, precommitmentHash]);
export const nullifierHash = (nullifier: bigint) => poseidon1([nullifier]);
// State.sol:89 (packed pool, chain id, asset); PrivacyPool.sol:93 (packed scope, incremented nonce).
export function scope(pool: Address, chainId: bigint, asset: Address): bigint { return BigInt(keccak256(encodePacked(["address", "uint256", "address"], [pool, chainId, asset]))) % SNARK_FIELD; }
export function label(poolScope: bigint, nonce: bigint): bigint { return BigInt(keccak256(encodePacked(["uint256", "uint256"], [poolScope, nonce]))) % SNARK_FIELD; }
// PrivacyPool.sol:48 and circuits/circuits/withdraw.circom:24 use keccak256(abi.encode(withdrawal, scope)) % field.
export function context(withdrawal: { processooor: Address; data: Hex }, poolScope: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] }, { type: "uint256" }], [withdrawal, poolScope]))) % SNARK_FIELD;
}
export function generateNote(): Note { return { nullifier: randomField(), secret: randomField() }; }
export function serializeNote(note: Note): string { return JSON.stringify({ ...note, nullifier: String(note.nullifier), secret: String(note.secret), ...(note.label === undefined ? {} : { label: String(note.label) }), ...(note.value === undefined ? {} : { value: String(note.value) }) }); }
export function parseNote(serialized: string): Note { const x = JSON.parse(serialized) as Record<string, unknown>; const note: Note = { nullifier: BigInt(String(x.nullifier)), secret: BigInt(String(x.secret)), ...(x.label === undefined ? {} : { label: BigInt(String(x.label)) }), ...(x.value === undefined ? {} : { value: BigInt(String(x.value)) }) }; if (note.nullifier < 0n || note.nullifier >= SNARK_FIELD || note.secret < 0n || note.secret >= SNARK_FIELD) throw new Error("note scalars outside SNARK field"); return note; }

export async function depositUSDG(chain: { publicClient: PublicClient; walletClient: WalletClient }, entrypoint: Address, usdg: Address, value: bigint, note: Note, pool?: Address): Promise<Deposit> {
  if (!pool) throw new Error("pool address is required to decode its Deposited event");
  const account = chain.walletClient.account; if (!account) throw new Error("wallet account required");
  const ah = await chain.walletClient.writeContract({ address: usdg, abi: ERC20_ABI, functionName: "approve", args: [entrypoint, value], account, chain: null }); await chain.publicClient.waitForTransactionReceipt({ hash: ah });
  const hash = await chain.walletClient.writeContract({ address: entrypoint, abi: ENTRY_ABI, functionName: "deposit", args: [usdg, value, precommitment(note.nullifier, note.secret)], account, chain: null });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  const entries = parseEventLogs({ abi: STATE_ABI, logs: receipt.logs, eventName: "Deposited", strict: false });
  const item = entries.find((x) => x.address.toLowerCase() === pool.toLowerCase()); if (!item) throw new Error("pool Deposited event missing from deposit receipt");
  const result = { commitment: item.args._commitment!, label: item.args._label!, value: item.args._value! };
  if (result.commitment !== commitment(result.value, result.label, precommitment(note.nullifier, note.secret))) throw new Error("deposit event commitment does not match the supplied note");
  note.label = result.label; note.value = result.value; return result;
}
export class StateTreeSync {
  readonly tree = new LeanIMT<bigint>((a,b) => poseidon2([a,b]));
  async rebuild(client: PublicClient, pool: Address, fromBlock: bigint, toBlock?: bigint) { const logs = await client.getLogs({ address: pool, event: STATE_ABI[0], fromBlock, ...(toBlock === undefined ? {} : { toBlock }) }); logs.sort((a,b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : a.logIndex! - b.logIndex!); for (const x of logs) this.tree.insert(x.args._leaf!); return this; }
  get root() { return this.tree.size ? this.tree.root : 0n; }
  assertRoot(onchain: bigint) { if (this.root !== onchain) throw new Error(`state root mismatch: local ${this.root}, chain ${onchain}`); }
}
export class AspTree {
  readonly tree = new LeanIMT<bigint>((a,b) => poseidon2([a,b]));
  add(item: bigint) { if (!this.tree.has(item)) this.tree.insert(item); }
  get root() { return this.tree.size ? this.tree.root : 0n; }
  assertRoot(onchain: bigint) { if (this.root !== onchain) throw new Error(`ASP root mismatch: local ${this.root}, chain ${onchain}`); }
}
export type ProofInput = { note: Note; deposit: Deposit; stateTree: StateTreeSync; aspTree: AspTree; withdrawal: { processooor: Address; data: Hex }; scope: bigint; withdrawnValue: bigint; newNote?: Note; wasmPath?: string; zkeyPath?: string; vkeyPath?: string };
export async function buildWithdrawalProof(args: ProofInput) {
  
  const { note, deposit, stateTree, aspTree, withdrawal, scope: poolScope, withdrawnValue } = args; const newNote = args.newNote ?? generateNote();
  const stateProof = stateTree.tree.generateProof(deposit.index ?? stateTree.tree.indexOf(deposit.commitment)); const aspIndex = aspTree.tree.indexOf(deposit.label); if (aspIndex < 0) throw new Error("deposit label not in ASP"); const aspProof = aspTree.tree.generateProof(aspIndex);
  const base = new URL("../../../contracts/vendor/privacy-pools-core/packages/circuits/", import.meta.url);
  const wasm = args.wasmPath ?? new URL("build/withdraw/withdraw_js/withdraw.wasm", base).pathname, zkey = args.zkeyPath ?? new URL("trusted-setup/final-keys/withdraw.zkey", base).pathname, vkeyPath = args.vkeyPath ?? new URL("trusted-setup/final-keys/withdraw.vkey", base).pathname;
  const pad = (siblings: bigint[]) => [...siblings, ...Array(32-siblings.length).fill(0n)].map(String);
  const input = { withdrawnValue: String(withdrawnValue), stateRoot: String(stateTree.root), stateTreeDepth: String(stateTree.tree.depth), ASPRoot: String(aspTree.root), ASPTreeDepth: String(aspTree.tree.depth), context: String(context(withdrawal,poolScope)), label: String(deposit.label), existingValue: String(deposit.value), existingNullifier: String(note.nullifier), existingSecret: String(note.secret), newNullifier: String(newNote.nullifier), newSecret: String(newNote.secret), stateSiblings: pad(stateProof.siblings), stateIndex: String(Number.isNaN(stateProof.index) ? 0 : stateProof.index), ASPSiblings: pad(aspProof.siblings), ASPIndex: String(Number.isNaN(aspProof.index) ? 0 : aspProof.index) };
  for (const [key,value] of Object.entries(input)) if (value === undefined || (Array.isArray(value) && value.some((v) => v === undefined))) throw new Error(`withdraw witness missing input ${key}`);
  const result = await proveWithNode({ input, wasm, zkey, vkey: vkeyPath }); const seconds = result.seconds;
  if (!result.verified) throw new Error("locally generated withdrawal proof failed verification");
  const proof = { pA: result.proof.pi_a.slice(0,2).map(BigInt), pB: [[BigInt(result.proof.pi_b[0][1]),BigInt(result.proof.pi_b[0][0])],[BigInt(result.proof.pi_b[1][1]),BigInt(result.proof.pi_b[1][0])]], pC: result.proof.pi_c.slice(0,2).map(BigInt), pubSignals: result.publicSignals.map(BigInt) };
  if (proof.pubSignals.length !== 8) throw new Error("withdraw circuit must return 8 public signals"); newNote.label = deposit.label; newNote.value = deposit.value-withdrawnValue; return { proof, newNote, seconds };
}
export function encodeShieldedPayment(withdrawal: { processooor: Address; data: Hex }, proof: { pA: bigint[]; pB: bigint[][]; pC: bigint[]; pubSignals: bigint[] }) {
  const encoded = encodeAbiParameters([{ type:"tuple",components:[{name:"processooor",type:"address"},{name:"data",type:"bytes"}]},{type:"tuple",components:[{name:"pA",type:"uint256[2]"},{name:"pB",type:"uint256[2][2]"},{name:"pC",type:"uint256[2]"},{name:"pubSignals",type:"uint256[8]"}]}],[withdrawal,{pA:proof.pA,pB:proof.pB,pC:proof.pC,pubSignals:proof.pubSignals}] as never);
  return { proof: encoded, nullifier: `0x${proof.pubSignals[1]!.toString(16).padStart(64,"0")}` as Hex };
}
export function openShieldedPaymentFor(adapter: Address, escrow: Address, queryId: Hex, proof: Parameters<typeof encodeShieldedPayment>[1]) { const withdrawal={processooor:adapter,data:encodeAbiParameters([{type:"address"},{type:"bytes32"}],[escrow,queryId])}; return { withdrawal,...encodeShieldedPayment(withdrawal,proof) }; }

/** Runs snarkjs Groth16 proving in a Node.js child process (see node-prover.mjs for why) and returns its JSON result. */
export async function proveWithNode(request: { input: Record<string, unknown>; wasm: string; zkey: string; vkey: string }, timeoutMs = 300_000): Promise<{ proof: any; publicSignals: string[]; verified: boolean; seconds: number }> {
  const { spawn } = await import("node:child_process");
  const script = new URL("./node-prover.mjs", import.meta.url).pathname;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.NODE_BINARY ?? "node", [script], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("proof generation timed out")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString().slice(0, 500); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`cannot start node prover: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // stderr may echo circuit errors; it never contains the private inputs themselves (snarkjs reports constraint names).
      if (code !== 0) return reject(new Error(`node prover exited ${code}: ${err.split("\n")[0] ?? ""}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch { reject(new Error("node prover returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
