import { readFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, recoverMessageAddress,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentMinJurorBond, productionChainId } from "../deploy/production/chain-policy.ts";

const MOCHI_ABI = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const REGISTRY_ABI = parseAbi(["function enrollJuror(address key,bytes32 measurement,uint8 jurorClass,uint256 bond,bytes keySig)"]);
const ROSTER: readonly [number, number][] = [[0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 4], [8, 4]];
type Proof = { chainId: number; registry: Address; operator: Address; key: Address; measurement: Hex; jurorClass: number; digest: Hex; signature: Hex };

export async function prepareProductionEnrollment(options: {
  deployment: any; identities: any; operator: string; response: unknown;
}): Promise<{ chainId: 4663 | 46630; operator: Address; token: Address; registry: Address; totalBond: string; transactions: Array<{ to: Address; data: Hex; value: "0"; purpose: string }> }> {
  const chainId = productionChainId(options.deployment);
  const BOND = deploymentMinJurorBond(options.deployment);
  const operator = address(options.operator, "--operator");
  const token = address(options.deployment.contracts?.mochiToken, "MOCHI token");
  const registry = address(options.deployment.contracts?.jurorRegistry, "juror registry");
  const items = (options.response as { proofs?: unknown })?.proofs;
  if (!Array.isArray(items) || items.length !== 9) throw new Error("enrollment response must contain exactly nine proofs");
  const configured = options.identities?.jurors;
  if (!Array.isArray(configured) || configured.length !== 9) throw new Error("identity input must contain exactly nine jurors");
  const keys = new Set<string>();
  const transactions: Array<{ to: Address; data: Hex; value: "0"; purpose: string }> = [];
  transactions.push({ to: token, data: encodeFunctionData({ abi: MOCHI_ABI, functionName: "approve", args: [registry, BOND * 9n] }), value: "0", purpose: `approve exactly nine minimum juror bonds (${BOND * 9n} MOCHI wei)` });
  for (let i = 0; i < 9; i += 1) {
    const proof = items[i] as Proof;
    const [expectedIndex, jurorClass] = ROSTER[i]!;
    const configuredJuror = configured[expectedIndex];
    if (!proof || proof.chainId !== chainId || proof.registry?.toLowerCase() !== registry.toLowerCase()
      || proof.operator?.toLowerCase() !== operator.toLowerCase() || proof.jurorClass !== jurorClass
      || !/^0x[0-9a-fA-F]{64}$/.test(proof.measurement) || !/^0x[0-9a-fA-F]{64}$/.test(proof.digest)
      || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)) throw new Error(`invalid enrollment proof at seat ${i}`);
    const key = address(proof.key, `proof ${i} key`);
    if (keys.has(key.toLowerCase())) throw new Error("enrollment juror keys must be unique");
    keys.add(key.toLowerCase());
    if (configuredJuror?.address?.toLowerCase() !== key.toLowerCase() || configuredJuror?.operator?.toLowerCase() !== operator.toLowerCase()
      || configuredJuror?.class !== jurorClass || configuredJuror?.measurement?.toLowerCase() !== proof.measurement.toLowerCase()) throw new Error(`enrollment proof does not match configured juror seat ${i}`);
    const expectedDigest = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }],
      ["mochi.enroll.v1", BigInt(chainId), registry, operator, key, proof.measurement, jurorClass],
    ));
    if (proof.digest.toLowerCase() !== expectedDigest.toLowerCase()) throw new Error(`enrollment digest mismatch at seat ${i}`);
    const recovered = await recoverMessageAddress({ message: { raw: proof.digest }, signature: proof.signature });
    if (recovered.toLowerCase() !== key.toLowerCase()) throw new Error(`enrollment signature does not match juror key at seat ${i}`);
    transactions.push({ to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "enrollJuror", args: [key, proof.measurement, jurorClass, BOND, proof.signature] }), value: "0", purpose: `enroll juror seat ${i}` });
  }
  return { chainId, operator, token, registry, totalBond: (BOND * 9n).toString(), transactions };
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${field} must be a nonzero address`);
  return value as Address;
}

async function main() {
  const args = new Map<string, string>();
  const allowed = ["--deployment", "--identities", "--operator", "--proofs", "--out"];
  for (let i = 0; i < process.argv.slice(2).length; i += 1) {
    const argv = process.argv.slice(2); const key = argv[i]!;
    if (!allowed.includes(key) || args.has(key) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new Error("usage: bun scripts/prepare-production-enrollment.ts --deployment <json> --identities <json> --operator 0x... --proofs <GET response json> [--out <new json file>]");
    args.set(key, argv[++i]!);
  }
  for (const key of allowed.slice(0, 4)) if (!args.has(key)) throw new Error(`missing required argument ${key}`);
  const [deployment, identities, response] = await Promise.all(["--deployment", "--identities", "--proofs"].map(async (key) => JSON.parse(await readFile(resolve(args.get(key)!), "utf8"))));
  const result = await prepareProductionEnrollment({ deployment, identities, operator: args.get("--operator")!, response });
  const serialized = `${JSON.stringify({ status: "unsigned", ...result }, null, 2)}\n`;
  if (args.has("--out")) { const file = await open(resolve(args.get("--out")!), "wx", 0o600); try { await file.writeFile(serialized); } finally { await file.close(); } }
  else process.stdout.write(serialized);
}
if (import.meta.main) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "enrollment preparation failed"}\n`); process.exitCode = 1; });
