import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { ROLE_IDS } from "@mochi/chain";
import { deploymentMinJurorBond, productionTimelockDelay } from "../deploy/production/chain-policy.ts";

export type Deployment = { chainId?: number; rehearsal?: boolean; minJurorBond?: string; timelockDelay?: string | number; contracts: { timelock?: Address; jurorRegistry: Address; queryEscrow: Address; receiptAnchor: Address; panel: Address }; privacy?: { entrypoint: Address } };
type Identity = { address: Address; measurement: Hex; operator: Address };
export type Input = {
  salt: Hex;
  intake: Identity;
  consensus: Identity;
  jurors: Array<Identity & { class: number }>;
  attestor: Address;
  feedRunner: Address;
  orchestrator: Address;
  indexer: Address;
  postman: Address;
};
export function buildPhalaBatch(deployment: Deployment, input: Input, action: "schedule" | "execute", phase: "configure" | "activate" = "configure") {
const timelock = deployment.contracts.timelock;
const entrypoint = deployment.privacy?.entrypoint;
if (!timelock || !entrypoint) throw new Error("deployment must include timelock and privacy.entrypoint");
if (!/^0x[0-9a-fA-F]{64}$/.test(input.salt)) throw new Error("salt must be bytes32");
const required = [2, 2, 2, 1, 2]; // N9, including expansion from N3/N5/N7.
if (input.jurors.length !== 9 || required.some((count, cls) => input.jurors.filter(j => j.class === cls).length !== count)) throw new Error("launch requires nine jurors covering class counts 2/2/2/1/2");
const identities = [input.intake, input.consensus, ...input.jurors];
if (new Set(identities.map(j => j.address.toLowerCase())).size !== identities.length) throw new Error("each enclave must have a unique key");
for (const identity of identities) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(identity.address) || /^0x0{40}$/i.test(identity.address) || !/^0x[0-9a-fA-F]{40}$/.test(identity.operator) || /^0x0{40}$/i.test(identity.operator)) throw new Error("invalid identity address/operator");
  if (!/^0x[0-9a-fA-F]{64}$/.test(identity.measurement) || /^0x0{64}$/i.test(identity.measurement)) throw new Error("invalid enclave measurement");
}
for (const addr of [timelock, entrypoint, ...Object.values(deployment.contracts), input.attestor, input.feedRunner, input.orchestrator, input.indexer, input.postman]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/i.test(addr)) throw new Error("invalid role or contract address");
}
const registry = deployment.contracts.jurorRegistry;
const escrow = deployment.contracts.queryEscrow;
const anchor = deployment.contracts.receiptAnchor;
const abi = parseAbi([
  "function setUnbondedJuror(address key,address operator)",
  "function setMeasurement(bytes32 measurement,uint8 role,bool allowed)",
  "function registerServiceKey(address key,address operator,bytes32 measurement,uint8 role)",
  "function grantRole(bytes32 role,address account)",
  "function unpause()",
]);
const targets: Address[] = [];
const values: bigint[] = [];
const payloads: Hex[] = [];
function add(target: Address, signature: string, args: readonly unknown[]) {
  const fn = abi.find((item) => item.type === "function" && item.name === signature);
  if (!fn) throw new Error(`missing batch function ${signature}`);
  targets.push(target); values.push(0n);
  payloads.push(encodeFunctionData({ abi: [fn], functionName: signature as never, args: args as never }));
}
if (phase === "configure") {
const jurorMeasurements = new Set<string>();
for (const seat of input.jurors) jurorMeasurements.add(seat.measurement.toLowerCase());
for (const measurement of jurorMeasurements) add(registry, "setMeasurement", [measurement, 1, true]);
add(registry, "setMeasurement", [input.intake.measurement, 2, true]);
add(registry, "setMeasurement", [input.consensus.measurement, 3, true]);
for (const seat of input.jurors) {
  if (deploymentMinJurorBond(deployment) === 0n) add(registry, "setUnbondedJuror", [seat.address, seat.operator]);
  if (!Number.isInteger(seat.class) || seat.class < 0 || seat.class > 4) throw new Error("juror class must be 0..4");
}
add(registry, "registerServiceKey", [input.intake.address, input.intake.operator, input.intake.measurement, 2]);
add(registry, "registerServiceKey", [input.consensus.address, input.consensus.operator, input.consensus.measurement, 3]);
add(registry, "grantRole", [ROLE_IDS.ATTESTOR, input.attestor]);
add(escrow, "grantRole", [ROLE_IDS.FEED_RUNNER, input.feedRunner]);
add(escrow, "grantRole", [ROLE_IDS.FEED_RUNNER, input.orchestrator]);
add(anchor, "grantRole", [ROLE_IDS.ANCHORER, input.indexer]);
add(deployment.contracts.panel, "grantRole", [ROLE_IDS.FEED_RUNNER, input.feedRunner]);
add(deployment.contracts.panel, "grantRole", [ROLE_IDS.FEED_RUNNER, input.orchestrator]);
add(entrypoint, "grantRole", [keccak256(toHex("ASP_POSTMAN")), input.postman]);
} else {
add(escrow, "unpause", []);
}
// Schedule with the reviewed deployment delay on mainnet and rehearsal (0–3600 seconds).
const delay = productionTimelockDelay(deployment);
const predecessor = `0x${"00".repeat(32)}` as Hex;
const operationId = keccak256(encodeAbiParameters(
  [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
  [targets, values, payloads, predecessor, input.salt],
));
const calldata = action === "schedule"
  ? encodeFunctionData({ abi: parseAbi(["function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)"]),
      functionName: "scheduleBatch", args: [targets, values, payloads, predecessor, input.salt, BigInt(delay)] })
  : encodeFunctionData({ abi: parseAbi(["function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt)"]),
      functionName: "executeBatch", args: [targets, values, payloads, predecessor, input.salt] });
return { action, phase, to: timelock, calldata, operationId, callCount: targets.length, delaySeconds: action === "schedule" ? delay : undefined, targets, payloads };
}

if (import.meta.main) {
  const [deploymentPath, inputPath, action = "schedule", phase = "configure"] = Bun.argv.slice(2);
  if (!deploymentPath || !inputPath || !["schedule", "execute"].includes(action) || !["configure", "activate"].includes(phase)) throw new Error("usage: bun scripts/phala-batch.ts <deployment.json> <identities.json> [schedule|execute] [configure|activate]");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as Input;
  const batch = buildPhalaBatch(deployment, input, action as "schedule" | "execute", phase as "configure" | "activate");
  if (phase === "activate") {
    const { createChain } = await import("@mochi/chain");
    const chain = createChain(deployment);
    if (await chain.publicClient.getChainId() !== deployment.chainId) throw new Error("deployment/RPC chain mismatch");
    for (const [identity, role] of [[input.intake, 2], [input.consensus, 3], ...input.jurors.map(j => [j, 1])] as Array<[Identity, number]>) {
      const registered = await chain.getJuror(identity.address);
      if (!await chain.isActive(identity.address, role) || registered.measurement.toLowerCase() !== identity.measurement.toLowerCase() || registered.operator.toLowerCase() !== identity.operator.toLowerCase()) throw new Error(`enclave is not enrolled and active with the reviewed identity: ${identity.address}`);
      if (role === 1 && registered.jurorClass !== input.jurors.find(j => j.address === identity.address)!.class) throw new Error("juror class mismatch");
      // A juror joins its class's selection pool at the attestor's first refresh that leaves it active, not at enrollment.
      if (role === 1 && !await chain.publicClient.readContract({ address: deployment.contracts.jurorRegistry, abi: parseAbi(["function inPool(address) view returns (bool)"]), functionName: "inPool", args: [identity.address] })) {
        throw new Error(`juror is active but not yet in its selection pool (the attestor's next refresh adds it): ${identity.address}`);
      }
    }
  }
  console.log(JSON.stringify(batch, null, 2));
}
