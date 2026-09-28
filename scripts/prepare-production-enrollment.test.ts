import { expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareProductionEnrollment } from "./prepare-production-enrollment.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const measurement = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const operator = addr(100);
const deployment = { chainId: 4663, tokenSource: { kind: "external" }, contracts: { mochiToken: addr(101), jurorRegistry: addr(102) } };

async function fixture() {
  const classes = [0, 0, 1, 1, 2, 2, 3, 4, 4];
  const accounts = classes.map((_, i) => privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex));
  const identities = { jurors: accounts.map((account, i) => ({ address: account.address, operator, class: classes[i], measurement: measurement(i + 1) })) };
  const proofs = await Promise.all(accounts.map(async (account, i) => {
    const digest = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }],
      ["mochi.enroll.v1", 4663n, deployment.contracts.jurorRegistry, operator, account.address, measurement(i + 1), classes[i]!],
    ));
    return { chainId: 4663, registry: deployment.contracts.jurorRegistry, operator, key: account.address, measurement: measurement(i + 1), jurorClass: classes[i], digest, signature: await account.signMessage({ message: { raw: digest } }) };
  }));
  return { identities, response: { proofs } };
}

test("creates exact unsigned approve and nine signed-proof enrollment calls", async () => {
  const { identities, response } = await fixture();
  const result = await prepareProductionEnrollment({ deployment, identities, operator, response });
  expect(result.transactions).toHaveLength(10);
  expect(result.transactions[0]!.to).toBe(deployment.contracts.mochiToken);
  expect(result.transactions.slice(1).every((tx) => tx.to === deployment.contracts.jurorRegistry && tx.value === "0")).toBe(true);
  expect(result.totalBond).toBe((225_000n * 10n ** 18n).toString());
});

test("rejects mismatched operator, class, proof signature, and duplicate keys", async () => {
  const { identities, response } = await fixture();
  await expect(prepareProductionEnrollment({ deployment, identities, operator: addr(999), response })).rejects.toThrow("invalid enrollment proof");
  const wrongClass = structuredClone(response); (wrongClass.proofs[0] as any).jurorClass = 1;
  await expect(prepareProductionEnrollment({ deployment, identities, operator, response: wrongClass })).rejects.toThrow("invalid enrollment proof");
  const badSignature = structuredClone(response); (badSignature.proofs[0] as any).signature = `0x${"00".repeat(65)}`;
  await expect(prepareProductionEnrollment({ deployment, identities, operator, response: badSignature })).rejects.toThrow();
  const duplicate = structuredClone(response); duplicate.proofs[1]!.key = duplicate.proofs[0]!.key;
  await expect(prepareProductionEnrollment({ deployment, identities, operator, response: duplicate })).rejects.toThrow("unique");
});
