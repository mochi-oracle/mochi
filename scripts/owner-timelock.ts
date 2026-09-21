import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbiItem, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "@mochi/chain";

type Deployment = { chainId: number; rpcUrl: string; startBlock: string; owner?: Address; contracts: Record<string, Address>; rehearsal?: boolean };
const [action, deploymentPath, ...rest] = process.argv.slice(2);
if (!action || !deploymentPath || !["schedule", "execute", "unpause", "set-measurement", "grant-role"].includes(action)) {
  throw new Error("usage: bun scripts/owner-timelock.ts schedule|execute|unpause|set-measurement|grant-role <deployment.json> ... [--key-file path]");
}
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
const args = [...rest];
let keyFile: string | undefined;
const keyIndex = args.indexOf("--key-file");
if (keyIndex >= 0) { keyFile = args[keyIndex + 1]; args.splice(keyIndex, 2); if (!keyFile) throw new Error("--key-file requires a path"); }
let requestedSalt: Hex | undefined;
const saltIndex = args.indexOf("--salt");
if (saltIndex >= 0) { requestedSalt = args[saltIndex + 1] as Hex | undefined; args.splice(saltIndex, 2); if (!requestedSalt) throw new Error("--salt requires bytes32"); }
if (keyFile && (deployment.chainId !== 46630 || !deployment.rehearsal)) throw new Error("--key-file is restricted to a chain 46630 rehearsal deployment");
const targetTimelock = deployment.contracts.timelock;
if (!targetTimelock) throw new Error("deployment has no contracts.timelock");
const chain = chainFor(deployment as unknown as import("@mochi/chain").Deployment);
const pub = createPublicClient({ chain, transport: http(deployment.rpcUrl) });
const scheduleAbi = [{ type: "function", name: "schedule", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "predecessor", type: "bytes32" }, { name: "salt", type: "bytes32" }, { name: "delay", type: "uint256" }], outputs: [] }] as const;
const executeAbi = [{ type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "predecessor", type: "bytes32" }, { name: "salt", type: "bytes32" }], outputs: [] }] as const;
const delayAbi = [{ type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
function parseValue(raw: string, type: string): unknown {
  if (type === "bool") { if (raw === "true") return true; if (raw === "false") return false; throw new Error(`invalid bool: ${raw}`); }
  if (type === "address") return raw as Address;
  if (/^u?int/.test(type)) return BigInt(raw);
  if (type.endsWith("[]") || type.startsWith("(") || type === "tuple") return JSON.parse(raw);
  if (type === "bytes" || /^bytes\d+$/.test(type)) return raw as Hex;
  return raw;
}
let target: Address;
let signature: string;
let fnArgs: unknown[];
if (action === "unpause") { target = deployment.contracts.queryEscrow!; signature = "unpause()"; fnArgs = []; }
else if (action === "set-measurement") {
  if (args.length < 3) throw new Error("set-measurement requires <measurement-bytes32> <role-number> <allowed-bool>");
  target = deployment.contracts.jurorRegistry!; signature = "setMeasurement(bytes32,uint8,bool)"; fnArgs = [args[0], Number(args[1]), parseValue(args[2]!, "bool")];
} else if (action === "grant-role") {
  if (args.length < 3) throw new Error("grant-role requires <contract-address> <role-bytes32> <account>");
  target = args[0] as Address; signature = "grantRole(bytes32,address)"; fnArgs = [args[1], args[2]];
} else {
  if (args.length < 2) throw new Error(`${action} requires <target-address> <function signature> [args…]`);
  target = args[0] as Address; signature = args[1]!;
  fnArgs = args.slice(2);
}
const item = parseAbiItem(`function ${signature}`) as Extract<Abi[number], { type: "function" }>;
const inputParams = item.inputs;
if (inputParams.length !== fnArgs.length) throw new Error(`${signature} expects ${inputParams.length} arguments, got ${fnArgs.length}`);
if (action === "schedule" || action === "execute") fnArgs = fnArgs.map((v, i) => parseValue(String(v), inputParams[i]!.type));
const data = encodeFunctionData({ abi: [item], functionName: item.name, args: fnArgs as never });
const predecessor = "0x" + "00".repeat(32) as Hex;
const salt = requestedSalt ?? keccak256(toHex(`${target.toLowerCase()}:${data.toLowerCase()}`));
const delay = await pub.readContract({ address: targetTimelock, abi: delayAbi, functionName: "getMinDelay" });
const operationId = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }],
  [target, 0n, data, predecessor, salt],
));
const callData = action === "execute"
  ? encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [target, 0n, data, predecessor, salt] })
  : encodeFunctionData({ abi: scheduleAbi, functionName: "schedule", args: [target, 0n, data, predecessor, salt, delay] });
console.log(JSON.stringify({ action: action === "execute" ? "execute" : "schedule", timelock: targetTimelock, target, value: "0", function: signature, args: fnArgs.map(String), calldata: callData, predecessor, salt, delay: delay.toString(), operationId }, null, 2));
if (keyFile) {
  const path = keyFile.replace(/^~/, homedir());
  const privateKey = (JSON.parse(readFileSync(path, "utf8")) as { privateKey: Hex }).privateKey;
  const account = privateKeyToAccount(privateKey);
  if (deployment.owner && account.address.toLowerCase() !== deployment.owner.toLowerCase()) throw new Error("--key-file account does not match deployment owner");
  const wallet = createWalletClient({ chain, transport: http(deployment.rpcUrl), account });
  const hash = await wallet.sendTransaction({ to: targetTimelock, data: callData });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${action} transaction reverted`);
  console.log(`sent ${hash}`);
}
