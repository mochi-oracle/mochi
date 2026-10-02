import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { chainFor } from "@mochi/chain";
import { assertMochiTokenDecimals } from "./token-policy.ts";
import { panelWiringProblems, readPanelWiring, recordedPanelEscalation } from "./panel-escalation.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/verify-ownership.ts <deployment.json>");
const deployment = JSON.parse(readFileSync(path, "utf8")) as {
  chainId: number; rpcUrl: string; startBlock: string; owner?: Address; guardian?: Address; timelock?: Address;
  paused?: boolean; contracts: Record<string, Address>; privacy?: { entrypoint: Address };
  roles?: Record<string, Record<string, Address[]>>;
  tokenSource?: { kind: "external" | "test-deployment"; decimals: number };
  panelEscalation?: "off" | "on";
};
if (deployment.tokenSource && !["external", "test-deployment"].includes(deployment.tokenSource.kind)) throw new Error("deployment tokenSource.kind is unsupported");
const dep = { chainId: deployment.chainId, rpcUrl: deployment.rpcUrl, startBlock: deployment.startBlock, contracts: deployment.contracts };
const publicClient = createPublicClient({ chain: chainFor(dep as unknown as import("@mochi/chain").Deployment), transport: http(deployment.rpcUrl) });
const ZERO = "0x" + "00".repeat(32) as Hex;
const role = (label: string) => keccak256(toHex(label));
const ids: Record<string, Hex> = {
  DEFAULT_ADMIN_ROLE: ZERO,
  GOVERNOR_ROLE: role("mochi.role.GOVERNOR"), GUARDIAN_ROLE: role("mochi.role.GUARDIAN"),
  ATTESTOR_ROLE: role("mochi.role.ATTESTOR"), FEED_RUNNER_ROLE: role("mochi.role.FEED_RUNNER"),
  SLASHER_ROLE: role("mochi.role.SLASHER"), LOCKER_ROLE: role("mochi.role.LOCKER"), ANCHORER_ROLE: role("mochi.role.ANCHORER"),
  OWNER_ROLE: role("OWNER_ROLE"), ASP_POSTMAN_ROLE: role("ASP_POSTMAN"),
  PROPOSER_ROLE: role("PROPOSER_ROLE"), EXECUTOR_ROLE: role("EXECUTOR_ROLE"), CANCELLER_ROLE: role("CANCELLER_ROLE"),
};
const aclAbi = [
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const entries: { name: string; address: Address; roles: string[]; owner?: boolean }[] = [
  { name: "MochiToken", address: deployment.contracts.mochiToken!, roles: [] },
  { name: "Randomness", address: deployment.contracts.randomness!, roles: [] },
  { name: "USDG", address: deployment.contracts.usdg!, roles: [] },
  { name: "ShieldedPayments", address: deployment.contracts.shielded!, roles: [] },
  { name: "DisclosureRegistry", address: deployment.contracts.disclosureRegistry!, roles: [] },
  { name: "QueryEscrow", address: deployment.contracts.queryEscrow!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE", "GUARDIAN_ROLE", "FEED_RUNNER_ROLE"] },
  { name: "JurorRegistry", address: deployment.contracts.jurorRegistry!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE", "ATTESTOR_ROLE", "SLASHER_ROLE"] },
  { name: "SchemaRegistry", address: deployment.contracts.schemaRegistry!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] },
  { name: "MochiStaking", address: deployment.contracts.staking!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE", "LOCKER_ROLE"] },
  { name: "MochiVerdicts", address: deployment.contracts.verdicts!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] },
  { name: "PanelEscalation", address: deployment.contracts.panel!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE", "FEED_RUNNER_ROLE"] },
  { name: "Feeds", address: deployment.contracts.feeds!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] },
  { name: "StockTokenCrosscheck", address: deployment.contracts.stockTokenCrosscheck!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] },
  { name: "ReceiptAnchor", address: deployment.contracts.receiptAnchor!, roles: ["DEFAULT_ADMIN_ROLE", "ANCHORER_ROLE"] },
  { name: "ClassMix", address: deployment.contracts.classMix!, roles: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] },
  { name: "ClerkVoting", address: deployment.contracts.clerkVoting!, roles: ["DEFAULT_ADMIN_ROLE"] },
];
if (deployment.tokenSource?.kind === "external") entries.shift();
if (deployment.timelock ?? deployment.contracts.timelock) entries.push({ name: "MochiTimelock", address: (deployment.timelock ?? deployment.contracts.timelock)!, roles: ["DEFAULT_ADMIN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"] });
if (deployment.privacy?.entrypoint) entries.push({ name: "PrivacyPoolsEntrypoint", address: deployment.privacy.entrypoint, roles: ["DEFAULT_ADMIN_ROLE", "OWNER_ROLE", "ASP_POSTMAN_ROLE"] });
if (deployment.privacy) {
  for (const [name, address] of Object.entries(deployment.privacy)) if (name !== "entrypoint" && name !== "scope" && typeof address === "string" && address.startsWith("0x")) {
    entries.push({ name: `PrivacyPools:${name}`, address: address as Address, roles: [] });
  }
}

const candidates = new Set<Address>();
for (const account of [deployment.owner, deployment.guardian, deployment.timelock, ...(Object.values(deployment.roles ?? {}).flatMap((r) => Object.values(r).flat()))]) if (account) candidates.add(account);
// Deployment metadata deliberately records the deployer address without disclosing its key.
const deployerAddress = (JSON.parse(readFileSync(path, "utf8")) as { deployer?: Address }).deployer;
if (deployerAddress) candidates.add(deployerAddress);
/**
 * Admin-class roles that are normally unheld: MochiStaking's GOVERNOR_ROLE only sweeps dust, and no one holds it until
 * DEFAULT_ADMIN grants it (to the timelock) for a sweep. Any holder other than the timelock still fails, but the timelock
 * is not required to hold it.
 */
const OPTIONAL_TIMELOCK_ROLES = new Set(["MochiStaking:GOVERNOR_ROLE"]);
const rows: string[] = ["Contract | Role | Expected holders | Deployer | Status", "---|---|---|---|---"];
const failures: string[] = [];
const roleMapKey: Record<string, string> = {
  QueryEscrow: "queryEscrow", JurorRegistry: "jurorRegistry", SchemaRegistry: "schemaRegistry", MochiStaking: "staking",
  MochiVerdicts: "verdicts", PanelEscalation: "panel", Feeds: "feeds", StockTokenCrosscheck: "stockTokenCrosscheck",
  ReceiptAnchor: "receiptAnchor", ClassMix: "classMix", ClerkVoting: "clerkVoting", MochiTimelock: "MochiTimelock",
  PrivacyPoolsEntrypoint: "entrypoint",
};
for (const entry of entries) {
  for (const roleName of entry.roles) {
    const roleId = ids[roleName]!;
    const holders: Address[] = [];
    for (const account of candidates) {
      try { if (await publicClient.readContract({ address: entry.address, abi: aclAbi, functionName: "hasRole", args: [roleId, account] })) holders.push(account); } catch { /* contract has no AccessControl surface for this role */ }
    }
    const depHolds = deployerAddress ? holders.includes(deployerAddress) : false;
    const expected = deployment.roles?.[roleMapKey[entry.name] ?? entry.name]?.[roleName] ?? [];
    if (depHolds) failures.push(`${entry.name} ${roleName}: deployer still holds role`);
    if (["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE", "OWNER_ROLE"].includes(roleName)) {
      const allowed = new Set<Address>([deployment.timelock ?? deployment.contracts.timelock!]);
      if (["SchemaRegistry", "ClassMix"].includes(entry.name) && deployment.contracts.clerkVoting) allowed.add(deployment.contracts.clerkVoting);
      for (const holder of holders) if (!allowed.has(holder)) failures.push(`${entry.name} ${roleName}: unexpected holder ${holder}`);
      for (const allowedHolder of (entry.name === "PrivacyPoolsEntrypoint" && roleName === "DEFAULT_ADMIN_ROLE" ? [] : allowed)) {
        try {
          const held = await publicClient.readContract({ address: entry.address, abi: aclAbi, functionName: "hasRole", args: [roleId, allowedHolder] });
          if (!held && allowedHolder === (deployment.timelock ?? deployment.contracts.timelock) && !OPTIONAL_TIMELOCK_ROLES.has(`${entry.name}:${roleName}`)) failures.push(`${entry.name} ${roleName}: timelock does not hold role`);
        } catch { /* non-AccessControl targets are reported with the rest of the table */ }
      }
    }
    const expectedText = expected.join(", ") || (OPTIONAL_TIMELOCK_ROLES.has(`${entry.name}:${roleName}`) ? "none (or only the timelock)" : "—");
    rows.push(`${entry.name} | ${roleName} | ${expectedText} | ${depHolds ? "YES" : "no"} | ${holders.length ? holders.join(", ") : "none found"}`);
  }
  try {
    const owner = await publicClient.readContract({ address: entry.address, abi: aclAbi, functionName: "owner" });
    const ownedByDeployer = !!deployerAddress && owner.toLowerCase() === deployerAddress.toLowerCase();
    rows.push(`${entry.name} | owner() | ${owner} | ${ownedByDeployer ? "YES" : "no"} | ${ownedByDeployer ? "FAIL" : "OK"}`);
    if (ownedByDeployer) failures.push(`${entry.name}: deployer still owns contract`);
  } catch { /* contract has no owner() */ }
}
const externalMochi = deployment.tokenSource?.kind === "external";
if (deployment.tokenSource) {
  try { assertMochiTokenDecimals(deployment.tokenSource.decimals); }
  catch (error) { failures.push(error instanceof Error ? error.message : "deployment MOCHI decimals are invalid"); }
}
if (externalMochi) {
  const tokenAddress = deployment.contracts.mochiToken!;
  const code = await publicClient.getCode({ address: tokenAddress });
  if (!code || code === "0x") failures.push("external MOCHI address has no contract code");
  const tokenAbi = [
    { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  ] as const;
  try {
    const [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "name" }),
      publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "symbol" }),
      publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "decimals" }),
    ]);
    assertMochiTokenDecimals(decimals);
    const metadataOk = !!name.trim() && symbol.toUpperCase() === "MOCHI";
    if (!metadataOk) failures.push(`external MOCHI metadata is unexpected: name=${JSON.stringify(name)}, symbol=${JSON.stringify(symbol)}`);
    rows.push(`MochiToken | external ERC20 metadata | name/symbol MOCHI, 18 decimals | ${JSON.stringify({ name, symbol, decimals })} | ${metadataOk ? "OK" : "FAIL"}`);
  } catch (error) { failures.push(error instanceof Error ? error.message : "external MOCHI does not expose valid ERC20 metadata"); }
  rows.push("MochiToken | external token custody/admin | not asserted | skipped | NOT CHECKED");
} else {
if (deployerAddress) {
  const bal = await publicClient.readContract({ address: deployment.contracts.mochiToken!, abi: aclAbi, functionName: "balanceOf", args: [deployerAddress] });
  rows.push(`MochiToken | deployer MOCHI balance | 0 | ${bal.toString()} | ${bal === 0n ? "OK" : "FAIL"}`);
  if (bal !== 0n) failures.push(`deployer MOCHI balance is ${bal}`);
} else failures.push("deployment JSON must include deployer address for the ownership check");
{
  const metadataAdmin = await publicClient.readContract({
    address: deployment.contracts.mochiToken!,
    abi: [{ type: "function", name: "metadataAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const,
    functionName: "metadataAdmin",
  });
  const timelockAddr = (deployment.timelock ?? deployment.contracts.timelock ?? "").toLowerCase();
  const ok = metadataAdmin.toLowerCase() === timelockAddr || /^0x0{40}$/i.test(metadataAdmin);
  rows.push(`MochiToken | metadataAdmin() | timelock or frozen | ${deployerAddress && metadataAdmin.toLowerCase() === deployerAddress.toLowerCase() ? "YES" : "no"} | ${metadataAdmin} ${ok ? "OK" : "FAIL"}`);
  if (!ok) failures.push(`MochiToken metadataAdmin is ${metadataAdmin}, expected the timelock or address(0)`);
}
}
{
  const mode = recordedPanelEscalation(deployment);
  const wiring = await readPanelWiring(publicClient, deployment.contracts.queryEscrow!);
  const problems = panelWiringProblems(mode, deployment.contracts.panel, wiring);
  const expected = mode === "off" ? "panel 0x0, reserve 0" : mode === "on" ? `panel ${deployment.contracts.panel}, reserve > 0` : "not recorded; consistency only";
  rows.push(`QueryEscrow | panel escalation ${mode ?? "(unrecorded)"} | ${expected} | n/a | panel ${wiring.panel}, reserve ${wiring.panelReserveBps} ${problems.length ? "FAIL" : "OK"}`);
  failures.push(...problems);
}
{
  // The panel's fixed references and MochiVerdicts' authorised panel must be this deployment's contracts in every mode.
  const { panelBindingProblems, readPanelBindings } = await import("./panel-escalation.ts");
  const bindings = await readPanelBindings(publicClient, deployment.contracts.panel!, deployment.contracts.verdicts!);
  const problems = panelBindingProblems(deployment.contracts as never, bindings);
  rows.push(`PanelEscalation | bindings | escrow, verdicts, usdg, randomness; MochiVerdicts.panel | n/a | ${problems.length ? "FAIL" : "OK"}`);
  failures.push(...problems);
}
if (deployment.paused) {
  const paused = await publicClient.readContract({ address: deployment.contracts.queryEscrow!, abi: aclAbi, functionName: "paused" });
  rows.push(`QueryEscrow | paused | true | ${paused} | ${paused ? "OK" : "FAIL"}`);
  if (!paused) failures.push("escrow is not paused despite paused=true in deployment JSON");
}
console.log(rows.join("\n"));
if (failures.length) { console.error("Ownership verification failed:\n" + failures.map((x) => `- ${x}`).join("\n")); process.exit(1); }
console.log("Ownership verification passed.");
