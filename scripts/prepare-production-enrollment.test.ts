import { expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareProductionEnrollment } from "./prepare-production-enrollment.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const measurement = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const operator = addr(100);
const deployment = { chainId: 4663, tokenSource: { kind: "external" }, contracts: { mochiToken: addr(101), jurorRegistry: addr(102) } };

async function fixture(chainId = 4663) {
  const classes = [0, 0, 1, 1, 2, 2, 3, 4, 4];
  const accounts = classes.map((_, i) => privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex));
  const identities = { jurors: accounts.map((account, i) => ({ address: account.address, operator, class: classes[i], measurement: measurement(i + 1) })) };
  const proofs = await Promise.all(accounts.map(async (account, i) => {
    const digest = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }],
      ["mochi.enroll.v1", BigInt(chainId), deployment.contracts.jurorRegistry, operator, account.address, measurement(i + 1), classes[i]!],
    ));
    return { chainId, registry: deployment.contracts.jurorRegistry, operator, key: account.address, measurement: measurement(i + 1), jurorClass: classes[i], digest, signature: await account.signMessage({ message: { raw: digest } }) };
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

const CALLS = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function enrollJuror(address key,bytes32 measurement,uint8 jurorClass,uint256 bond,bytes keySig)"]);

test("uses the bond recorded at deployment for the approval and every seat", async () => {
  const { identities, response } = await fixture();
  const bond = 1_000n * 10n ** 18n;
  const result = await prepareProductionEnrollment({ deployment: { ...deployment, minJurorBond: bond.toString() }, identities, operator, response });
  expect(result.totalBond).toBe((bond * 9n).toString());
  expect(decodeFunctionData({ abi: CALLS, data: result.transactions[0]!.data }).args).toEqual([deployment.contracts.jurorRegistry, bond * 9n]);
  for (const tx of result.transactions.slice(1)) expect(decodeFunctionData({ abi: CALLS, data: tx.data }).args[3]).toBe(bond);
  await expect(prepareProductionEnrollment({ deployment: { ...deployment, minJurorBond: "-1" }, identities, operator, response })).rejects.toThrow("minJurorBond");
});

test("a testnet rehearsal enrolls with chain-bound proofs that can never validate on mainnet, and the reverse", async () => {
  const rehearsal = { ...deployment, chainId: 46630, rehearsal: true };
  const testnet = await fixture(46630);
  const result = await prepareProductionEnrollment({ deployment: rehearsal, identities: testnet.identities, operator, response: testnet.response });
  expect(result.chainId).toBe(46630);
  await expect(prepareProductionEnrollment({ deployment, identities: testnet.identities, operator, response: testnet.response })).rejects.toThrow("invalid enrollment proof");
  const mainnet = await fixture(4663);
  await expect(prepareProductionEnrollment({ deployment: rehearsal, identities: mainnet.identities, operator, response: mainnet.response })).rejects.toThrow("invalid enrollment proof");
  const forged = structuredClone(mainnet.response); for (const proof of forged.proofs) (proof as any).chainId = 46630;
  await expect(prepareProductionEnrollment({ deployment: rehearsal, identities: mainnet.identities, operator, response: forged })).rejects.toThrow("digest mismatch");
  await expect(prepareProductionEnrollment({ deployment: { ...deployment, chainId: 46630 }, identities: testnet.identities, operator, response: testnet.response })).rejects.toThrow("explicit testnet rehearsal");
  await expect(prepareProductionEnrollment({ deployment: { ...deployment, rehearsal: true }, identities: mainnet.identities, operator, response: mainnet.response })).rejects.toThrow("explicit testnet rehearsal");
});


test("team-operated enrollment has nine zero-bond calls and no token approval", async () => {
  const { identities, response } = await fixture();
  const result = await prepareProductionEnrollment({ deployment: { ...deployment, minJurorBond: "0" }, identities, operator, response });
  expect(result.totalBond).toBe("0");
  expect(result.transactions).toHaveLength(9);
  for (const tx of result.transactions) {
    expect(tx.to).toBe(deployment.contracts.jurorRegistry);
    const call = decodeFunctionData({ abi: CALLS, data: tx.data });
    expect(call.functionName).toBe("enrollJuror");
    expect(call.args[3]).toBe(0n);
  }
});
