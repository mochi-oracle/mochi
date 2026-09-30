import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { createChain, ROLE_IDS, type Deployment as ChainDeployment } from "@mochi/chain";
import { buildPhalaBatch, type Deployment as BatchDeployment, type Input as IdentityInput } from "./phala-batch.ts";
import { deploymentMinJurorBond, isProductionRehearsal, productionChainRule, productionTimelockDelay, REHEARSAL_CHAIN_ID } from "../deploy/production/chain-policy.ts";

const SPEC_MIN_JUROR_BOND_MOCHI = 25_000;
const expectedChain = (deployment: ProductionDeployment): number | undefined => productionChainRule(deployment);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;
const ROLES = ["owner", "guardian", "tokenRecipient", "feeTreasury", "attestor", "feedRunner", "orchestrator", "indexer", "postman"] as const;
const REQUIRED_ROLES = ["owner", "guardian", "attestor", "feedRunner", "orchestrator", "indexer", "postman"] as const;
type Role = typeof ROLES[number];
export type ReleaseInput = {
  chainId: number;
  rpcUrl?: string;
  mochiToken?: string | null;
  usdg?: string | null;
  roles: Partial<Record<Role, string | null>>;
  timelockDelaySeconds: number;
  jurorCount: number;
  jurorClassCounts: number[];
  minimumJurorBondMochi: number;
  /** Explicit reviewed approval for a per-juror bond below the 25,000 MOCHI spec default. */
  bondBelowSpecApproved?: boolean;
  initialFeedBudgetUsdg?: number | null;
  deploymentFile?: string | null;
  identitiesFile?: string | null;
  salt?: string | null;
};
export type ProductionDeployment = BatchDeployment & {
  chainId: number; rpcUrl?: string; owner?: Address; guardian?: Address; paused?: boolean; rehearsal?: boolean; minJurorBond?: string;
  tokenSource?: { kind: string; decimals?: number };
  contracts: BatchDeployment["contracts"] & Record<string, Address> & { mochiToken?: Address; usdg?: Address; jurorRegistry: Address; queryEscrow: Address; panel: Address; receiptAnchor: Address; timelock?: Address };
};
export interface ReadOnlyReader {
  chainId(): Promise<number>;
  code(address: Address): Promise<Hex | undefined>;
  decimals(address: Address): Promise<number>;
  hasRole(contract: Address, role: Hex, account: Address): Promise<boolean>;
  nativeBalance(account: Address): Promise<bigint>;
  jurorInfo(key: Address): Promise<{ operator: Address; measurement: Hex; role: number; jurorClass: number; bond: bigint }>;
  isActive(key: Address, role: number): Promise<boolean>;
  feedBudget(escrow: Address): Promise<bigint>;
  paused(escrow: Address): Promise<boolean>;
}
export interface TimelockStatusReader {
  chainId(): Promise<number>;
  blockTimestamp(): Promise<bigint>;
  operationTimestamp(timelock: Address, operationId: Hex): Promise<bigint>;
}

export type TimelockOperationObservation = {
  phase: "configure" | "activate";
  operationId: Hex;
  status: "unscheduled" | "pending" | "ready" | "done" | "read-failed";
  chainId: number | null;
  blockTimestamp: string | null;
  scheduledTimestamp: string | null;
  nextAction: string;
  detail: string;
};

/** Observe OpenZeppelin TimelockController timestamps. This reports chain state only. */
export async function readTimelockOperationStatus(
  deployment: ProductionDeployment,
  batches: { configure: { operationId: Hex }; activation: { operationId: Hex } },
  reader: TimelockStatusReader,
): Promise<TimelockOperationObservation[]> {
  const timelock = deployment.contracts.timelock;
  const phases = [
    ["configure", batches.configure.operationId],
    ["activate", batches.activation.operationId],
  ] as const;
  let actualChainId: number;
  try { actualChainId = await reader.chainId(); }
  catch {
    return phases.map(([phase, operationId]) => ({ phase, operationId, status: "read-failed", chainId: null, blockTimestamp: null, scheduledTimestamp: null, nextAction: "Retry the public read-only chain ID check; do not infer readiness from unavailable data.", detail: "RPC chain ID read failed; provider details suppressed" }));
  }
  if (actualChainId !== expectedChain(deployment) || actualChainId !== deployment.chainId) {
    return phases.map(([phase, operationId]) => ({ phase, operationId, status: "read-failed", chainId: actualChainId, blockTimestamp: null, scheduledTimestamp: null, nextAction: "Use the Robinhood Chain mainnet RPC (chain ID 4663) matching the deployment and repeat the read-only check.", detail: `RPC chain ID=${actualChainId}; deployment=${deployment.chainId}; expected=4663` }));
  }
  let now: bigint;
  try { now = await reader.blockTimestamp(); }
  catch {
    return phases.map(([phase, operationId]) => ({ phase, operationId, status: "read-failed", chainId: actualChainId, blockTimestamp: null, scheduledTimestamp: null, nextAction: "Retry the public read-only timelock status check; do not infer readiness from unavailable data.", detail: "block timestamp read failed; provider details suppressed" }));
  }
  return Promise.all(phases.map(async ([phase, operationId]): Promise<TimelockOperationObservation> => {
    if (!timelock) return { phase, operationId, status: "read-failed", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: null, nextAction: "Supply the deployed timelock address and rerun the public read-only status check.", detail: "deployment has no timelock address" };
    let timestamp: bigint;
    try { timestamp = await reader.operationTimestamp(timelock, operationId); }
    catch { return { phase, operationId, status: "read-failed", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: null, nextAction: "Retry the public read-only timelock status check; do not infer readiness from unavailable data.", detail: "operation timestamp read failed; provider details suppressed" }; }
    if (timestamp === 0n) return { phase, operationId, status: "unscheduled", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: null, nextAction: phase === "configure" ? "After deployment and identity review, have the approved control wallet schedule the configure batch." : "After configure execution, enrollment, service checks, and activation readiness review, have the approved control wallet schedule the separate activation batch.", detail: "timelock operation is not scheduled" };
    if (timestamp === 1n) return { phase, operationId, status: "done", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: null, nextAction: phase === "configure" ? "Proceed to enrollment and verify identities, funding, and service readiness while QueryEscrow remains paused." : "The activation operation is done; review release evidence and the bounded paid smoke-test gate before offering paid access.", detail: "timelock operation is done" };
    if (timestamp > now) return { phase, operationId, status: "pending", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: timestamp.toString(), nextAction: `Wait until Unix timestamp ${timestamp.toString()} (the full timelock delay), then repeat readiness checks before approved-multisig execution.`, detail: `operation is pending until ${timestamp.toString()}` };
    return { phase, operationId, status: "ready", chainId: actualChainId, blockTimestamp: now.toString(), scheduledTimestamp: timestamp.toString(), nextAction: "The timelock delay has elapsed; repeat all phase prerequisites and off-chain readiness checks, then have the approved control wallet execute this operation.", detail: `operation is ready by timestamp (scheduled=${timestamp.toString()}, current=${now.toString()})` };
  }));
}

function address(value: unknown, field: string, missing: string[], errors: string[]): void {
  if (value == null || value === "") { missing.push(field); return; }
  if (typeof value !== "string" || !ADDRESS.test(value) || ZERO.test(value)) errors.push(`${field} must be a valid nonzero EVM address`);
}
const roleHash = (label: string) => keccak256(toHex(label));
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);
const accessAbi = parseAbi(["function hasRole(bytes32,address) view returns (bool)"]);
const pauseAbi = parseAbi(["function paused() view returns (bool)"]);
function safeRpcOrigin(raw: string): string {
  try { return new URL(raw).origin; } catch { return "invalid-rpc-url"; }
}
function validateRpcUrl(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = new URL(raw);
    return [
      ...(parsed.protocol === "https:" ? [] : ["rpcUrl must use HTTPS"]),
      ...(parsed.username || parsed.password ? ["rpcUrl must not contain username or password credentials"] : []),
    ];
  } catch { return ["rpcUrl must be a valid HTTPS URL"]; }
}

export async function runReadOnlyPreflight(deployment: ProductionDeployment, input: ReleaseInput, reader: ReadOnlyReader, identities?: IdentityInput) {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  async function check(id: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
    try { const result = await fn(); checks.push({ id, ...result }); }
    catch { checks.push({ id, ok: false, detail: "read failed; provider details suppressed" }); }
  }
  await check("chain-id", async () => { const actual = await reader.chainId(); return { ok: actual === expectedChain(deployment) && actual === deployment.chainId, detail: `RPC=${actual}; deployment=${deployment.chainId}; expected=4663` }; });
  await check("paused", async () => { const paused = await reader.paused(deployment.contracts.queryEscrow); return { ok: paused, detail: `QueryEscrow.paused=${paused}; expected=true before activation` }; });
  const contractEntries = Object.entries(deployment.contracts).filter(([, a]) => typeof a === "string" && ADDRESS.test(a) && !ZERO.test(a)) as [string, Address][];
  if (deployment.privacy?.entrypoint) contractEntries.push(["privacy.entrypoint", deployment.privacy.entrypoint]);
  const checkedAddresses = new Set(contractEntries.map(([, a]) => a.toLowerCase()));
  const externalToken = input.mochiToken ?? deployment.contracts.mochiToken;
  const usdToken = input.usdg ?? deployment.contracts.usdg;
  if (externalToken && !checkedAddresses.has(externalToken.toLowerCase())) contractEntries.push(["mochiToken", externalToken as Address]);
  if (usdToken && !checkedAddresses.has(usdToken.toLowerCase())) contractEntries.push(["usdg", usdToken as Address]);
  for (const [name, contract] of contractEntries) await check(`code:${name}`, async () => {
    const code = await reader.code(contract); return { ok: Boolean(code && code !== "0x"), detail: code && code !== "0x" ? "contract code present" : "no contract code" };
  });
  const token = externalToken;
  const usdg = usdToken;
  if (token) await check("mochi-decimals", async () => { const d = await reader.decimals(token as Address); return { ok: d === 18, detail: `decimals=${d}; expected=18` }; });
  else checks.push({ id: "mochi-decimals", ok: false, detail: "external MOCHI CA is not supplied" });
  if (usdg) await check("usdg-decimals", async () => { const d = await reader.decimals(usdg as Address); return { ok: d === 6, detail: `decimals=${d}; expected=6` }; });

  const r = {
    ...input.roles,
    owner: input.roles.owner ?? deployment.owner ?? null,
    guardian: input.roles.guardian ?? deployment.guardian ?? null,
    attestor: input.roles.attestor ?? identities?.attestor ?? null,
    feedRunner: input.roles.feedRunner ?? identities?.feedRunner ?? null,
    orchestrator: input.roles.orchestrator ?? identities?.orchestrator ?? null,
    indexer: input.roles.indexer ?? identities?.indexer ?? null,
    postman: input.roles.postman ?? identities?.postman ?? null,
  };
  const timelock = deployment.contracts.timelock;
  const assignments: Array<[string, Address | undefined, Hex, string | null | undefined]> = [
    ["owner-proposer", timelock, roleHash("PROPOSER_ROLE"), r.owner],
    ["owner-executor", timelock, roleHash("EXECUTOR_ROLE"), r.owner],
    ["guardian-pause", deployment.contracts.queryEscrow, ROLE_IDS.GUARDIAN, r.guardian],
    ["attestor", deployment.contracts.jurorRegistry, ROLE_IDS.ATTESTOR, r.attestor],
    ["feed-runner-escrow", deployment.contracts.queryEscrow, ROLE_IDS.FEED_RUNNER, r.feedRunner],
    ["feed-runner-panel", deployment.contracts.panel, ROLE_IDS.FEED_RUNNER, r.feedRunner],
    ["orchestrator-escrow", deployment.contracts.queryEscrow, ROLE_IDS.FEED_RUNNER, r.orchestrator],
    ["orchestrator-panel", deployment.contracts.panel, ROLE_IDS.FEED_RUNNER, r.orchestrator],
    ["indexer-anchorer", deployment.contracts.receiptAnchor, ROLE_IDS.ANCHORER, r.indexer],
    ["postman", deployment.privacy?.entrypoint, roleHash("ASP_POSTMAN"), r.postman],
  ];
  for (const [id, contract, role, account] of assignments) {
    if (!account) { checks.push({ id: `role:${id}`, ok: false, detail: "required role address is missing" }); continue; }
    if (!contract) { checks.push({ id: `role:${id}`, ok: false, detail: "deployment has no target contract for this role" }); continue; }
    await check(`role:${id}`, async () => { const held = await reader.hasRole(contract, role, account as Address); return { ok: held, detail: held ? "role is held" : "required role is not held" }; });
  }
  if (identities) {
    const expected: Array<[string, { address: Address; operator: Address; measurement: Hex; class?: number }, number]> = [
      ["intake", identities.intake, 2], ["consensus", identities.consensus, 3],
      ...identities.jurors.map((j) => [`juror:${j.address.toLowerCase()}`, j, 1] as [string, typeof j, number]),
    ];
    for (const [id, identity, role] of expected) await check(`enrollment:${id}`, async () => {
      const [j, active] = await Promise.all([reader.jurorInfo(identity.address), reader.isActive(identity.address, role)]);
      const matching = j.operator.toLowerCase() === identity.operator.toLowerCase() && j.measurement.toLowerCase() === identity.measurement.toLowerCase() && j.role === role && (role !== 1 || (j.jurorClass === identity.class && j.bond >= BigInt(Math.ceil(input.minimumJurorBondMochi)) * 10n ** 18n));
      return { ok: matching && active, detail: `identity=${matching ? "matches" : "mismatch"}; active=${active}; role=${j.role}; bond=${j.bond}` };
    });
  } else checks.push({ id: "enrollment:identities", ok: false, detail: "reviewed identity file is required to check active enrollment and per-juror bonds" });
  if (deployment.contracts.queryEscrow && input.initialFeedBudgetUsdg != null) await check("feed-budget", async () => {
    const budget = await reader.feedBudget(deployment.contracts.queryEscrow);
    const minimum = BigInt(Math.ceil(input.initialFeedBudgetUsdg! * 1_000_000));
    return { ok: budget >= minimum, detail: `QueryEscrow.feedBudget=${budget}; configured minimum=${minimum}` };
  });
  const gasAccounts = [...new Set([r.owner, r.guardian, r.attestor, r.feedRunner, r.orchestrator, r.indexer, r.postman].filter((x): x is string => Boolean(x)))];
  for (const account of gasAccounts) if (ADDRESS.test(account)) await check(`gas:${account.toLowerCase()}`, async () => {
    const bal = await reader.nativeBalance(account as Address); return { ok: bal > 0n, detail: `native balance=${bal}; must be funded for required operations` };
  });
  return { checked: checks.length, passed: checks.filter((x) => x.ok).length, failed: checks.filter((x) => !x.ok).length, checks, checksPassed: checks.length > 0 && checks.every((x) => x.ok), status: "read-only-checks-only" as const };
}

export function buildProductionRelease(input: ReleaseInput, options: { deployment?: ProductionDeployment; identities?: IdentityInput; preflight?: Awaited<ReturnType<typeof runReadOnlyPreflight>>; timelockOperations?: TimelockOperationObservation[] } = {}) {
  const deployment = options.deployment;
  const identities = options.identities;
  const roles = {
    ...input.roles,
    owner: input.roles.owner ?? deployment?.owner ?? null,
    guardian: input.roles.guardian ?? deployment?.guardian ?? null,
    attestor: input.roles.attestor ?? identities?.attestor ?? null,
    feedRunner: input.roles.feedRunner ?? identities?.feedRunner ?? null,
    orchestrator: input.roles.orchestrator ?? identities?.orchestrator ?? null,
    indexer: input.roles.indexer ?? identities?.indexer ?? null,
    postman: input.roles.postman ?? identities?.postman ?? null,
  };
  const missing: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const rehearsalPlan = input.chainId === REHEARSAL_CHAIN_ID && isProductionRehearsal(deployment);
  if (input.chainId !== 4663 && !rehearsalPlan) errors.push("chainId must be Robinhood Chain mainnet 4663 (46630 only with an explicit rehearsal deployment file)");
  if (rehearsalPlan) warnings.push("REHEARSAL on Robinhood Chain testnet 46630: nothing in this plan applies to mainnet");
  errors.push(...validateRpcUrl(input.rpcUrl ?? deployment?.rpcUrl));
  address(input.mochiToken, "mochiToken (team-created external MOCHI CA)", missing, errors);
  address(input.usdg, "usdg", missing, errors);
  for (const role of ROLES) address(roles[role], `roles.${role}`, REQUIRED_ROLES.includes(role as typeof REQUIRED_ROLES[number]) ? missing : [], errors);
  const a = (key: Role) => roles[key]?.toLowerCase();
  for (const role of ["attestor", "feedRunner", "orchestrator", "indexer", "postman"] as Role[]) if (a(role) && a(role) === a("owner")) errors.push(`roles.${role} must be distinct from roles.owner`);
  let expectedDelay = 86400;
  if (rehearsalPlan) { try { expectedDelay = productionTimelockDelay(deployment); } catch (error) { errors.push(error instanceof Error ? error.message : "invalid rehearsal timelock delay"); } }
  if (input.timelockDelaySeconds !== expectedDelay) errors.push(rehearsalPlan ? `timelockDelaySeconds must be ${expectedDelay} to match the rehearsal deployment` : "timelockDelaySeconds must be 86400 to match the existing production batch builder");
  if (input.jurorCount !== 9 || JSON.stringify(input.jurorClassCounts) !== JSON.stringify([2, 2, 2, 1, 2])) errors.push("launch requires nine jurors with class counts 2/2/2/1/2");
  if (!Number.isSafeInteger(input.minimumJurorBondMochi) || input.minimumJurorBondMochi < 0) errors.push("minimumJurorBondMochi must be a nonnegative whole number of MOCHI");
  else if (input.minimumJurorBondMochi === 0) warnings.push("Team-operated launch: zero MOCHI bonds; each juror key/operator must be approved through governance. This is not customer insurance.");
  else if (input.minimumJurorBondMochi < SPEC_MIN_JUROR_BOND_MOCHI && input.bondBelowSpecApproved !== true) errors.push("minimumJurorBondMochi must be at least 25000 per juror unless bondBelowSpecApproved=true records a reviewed decision");
  else if (input.minimumJurorBondMochi < SPEC_MIN_JUROR_BOND_MOCHI) warnings.push(`per-juror bond ${input.minimumJurorBondMochi} MOCHI is below the 25000 spec default (approved)`);
  if (input.initialFeedBudgetUsdg == null) missing.push("initialFeedBudgetUsdg (reviewed USDG feed budget)");
  else if (!Number.isFinite(input.initialFeedBudgetUsdg) || input.initialFeedBudgetUsdg <= 0) errors.push("initialFeedBudgetUsdg must be positive when supplied");
  if (input.salt != null && !/^0x[0-9a-fA-F]{64}$/.test(input.salt)) errors.push("salt must be bytes32");

  let batches: Record<string, unknown> | undefined;
  if (deployment) {
    if (expectedChain(deployment) === undefined || deployment.chainId !== input.chainId) errors.push("deployment.chainId must be 4663 (or 46630 for an explicit rehearsal) and match the input chainId");
    try { if (Number.isSafeInteger(input.minimumJurorBondMochi) && input.minimumJurorBondMochi >= 0 && deploymentMinJurorBond(deployment) !== BigInt(input.minimumJurorBondMochi) * 10n ** 18n) errors.push("deployment.minJurorBond does not match minimumJurorBondMochi"); }
    catch (error) { errors.push(error instanceof Error ? error.message : "invalid deployment.minJurorBond"); }
    if (deployment.contracts.mochiToken && input.mochiToken && deployment.contracts.mochiToken.toLowerCase() !== input.mochiToken.toLowerCase()) errors.push("input mochiToken does not match deployment contracts.mochiToken");
    if (deployment.contracts.usdg && input.usdg && deployment.contracts.usdg.toLowerCase() !== input.usdg.toLowerCase()) errors.push("input usdg does not match deployment contracts.usdg");
    if (deployment.owner && input.roles.owner && deployment.owner.toLowerCase() !== input.roles.owner.toLowerCase()) errors.push("input roles.owner does not match deployment owner");
    if (deployment.guardian && input.roles.guardian && deployment.guardian.toLowerCase() !== input.roles.guardian.toLowerCase()) errors.push("input roles.guardian does not match deployment guardian");
    if (input.mochiToken && deployment.tokenSource?.kind !== "external") errors.push("a supplied production CA requires deployment.tokenSource.kind=external");
  }
  if (deployment && identities) {
    const salt = (input.salt ?? identities.salt) as Hex | undefined;
    if (!salt) errors.push("supply salt in release input or identities file to build review payloads");
    else {
      const identityRoles: Array<[string, string | null | undefined]> = [["attestor", identities.attestor], ["feedRunner", identities.feedRunner], ["orchestrator", identities.orchestrator], ["indexer", identities.indexer], ["postman", identities.postman]];
      for (const [role, value] of identityRoles) if (value && input.roles[role as Role] && value.toLowerCase() !== input.roles[role as Role]!.toLowerCase()) errors.push(`identities.${role} does not match roles.${role}`);
      try {
        const full = { ...identities, salt } as IdentityInput;
        batches = {
          configure: buildPhalaBatch(deployment, full, "schedule", "configure"),
          configurationExecution: buildPhalaBatch(deployment, full, "execute", "configure"),
          activation: buildPhalaBatch(deployment, full, "schedule", "activate"),
          activationExecute: buildPhalaBatch(deployment, full, "execute", "activate"),
        };
      } catch (e) { errors.push(`cannot build offline batch payloads: ${(e as Error).message}`); }
    }
  } else if ((input.deploymentFile && !deployment) || (input.identitiesFile && !identities)) {
    errors.push("configured deploymentFile/identitiesFile must be readable before creating a release plan");
  }
  if (errors.length) throw new Error(`Invalid production release input:\n- ${errors.join("\n- ")}`);

  const blockers = [
    ...missing.map((item) => `Provide and independently verify ${item}.`),
    ...(!deployment ? ["No deployment file was supplied: deploy paused using scripts/deploy-local.ts --mainnet with --mochi-token and the team-created external CA."] : []),
    ...(!identities ? ["No reviewed identities file was supplied: provide nine jurors (class counts 2/2/2/1/2), intake and consensus keys, operator addresses, measurements, current TDX evidence, key binding and proof of possession."] : []),
    ...(!options.preflight ? ["Run public read-only checks for external token code and 18 decimals, deployment contract code, chain ID, roles and funding."] : []),
    ...(!options.preflight?.checks.some((x) => x.id === "paused" && x.ok) ? ["Verify on chain that QueryEscrow is paused before configuration; deployment JSON is metadata only."] : []),
    "Complete and record production service health, confidential execution, persistent signing, encrypted secrets, capacity, cost cap and smoke-test evidence.",
    ...(options.preflight?.checks.filter((x) => !x.ok).map((x) => `Read-only preflight failed ${x.id}: ${x.detail}`) ?? []),
  ];
  const preflightPassed = Boolean(options.preflight?.checksPassed);
  const identitiesComplete = Boolean(identities && batches);
  const caAddressAndDecimalsChecked = Boolean(input.mochiToken && deployment?.contracts.mochiToken && input.mochiToken.toLowerCase() === deployment.contracts.mochiToken.toLowerCase() && deployment.tokenSource?.kind === "external" && options.preflight?.checks.some((x) => x.id === "chain-id" && x.ok) && options.preflight.checks.some((x) => x.id === "mochi-decimals" && x.ok) && options.preflight.checks.some((x) => x.id === "code:mochiToken" && x.ok));
  return {
    format: "mochi-production-release-plan-v2",
    generatedAt: new Date().toISOString(),
    mode: "offline-review-only",
    network: rehearsalPlan ? "REHEARSAL (chain 46630) - not mainnet" : "Robinhood Chain mainnet (4663)",
    warnings,
    target: { chainId: input.chainId, rpcOrigin: safeRpcOrigin(input.rpcUrl ?? deployment?.rpcUrl ?? "https://rpc.mainnet.chain.robinhood.com"), externalMochiToken: input.mochiToken ?? null, usdg: input.usdg ?? null },
    roles,
    economics: { jurorCount: 9, classCounts: [2, 2, 2, 1, 2], minimumBondPerJurorMochi: input.minimumJurorBondMochi, minimumTotalJurorBondsMochi: input.minimumJurorBondMochi * 9, initialFeedBudgetUsdg: input.initialFeedBudgetUsdg ?? null },
    timelockDelaySeconds: input.timelockDelaySeconds,
    deployment: deployment ? { chainId: deployment.chainId, pausedMetadata: deployment.paused ?? null, pausedOnChain: options.preflight?.checks.find((x) => x.id === "paused")?.ok ?? null, contracts: deployment.contracts } : null,
    preflight: options.preflight ?? { status: "not-run", note: "Supply --check-rpc to perform public read-only checks; no keys or writes are used." },
    status: blockers.length ? "blocked-on-operational-inputs" : "review-required",
    blockers,
    timelockOperations: options.timelockOperations ?? { status: "not-checked", note: "Supply --check-timelock to observe timelock operation timestamps; these observations do not establish readiness." },
    reviewPayloads: batches ? {
      configuration: { status: "built-offline-not-scheduled", ...(options.timelockOperations?.find((x) => x.phase === "configure") ? { timelockObservation: options.timelockOperations.find((x) => x.phase === "configure") } : {}), ...batches.configure as object },
      activation: { status: "built-offline-not-ready-to-schedule", ...(options.timelockOperations?.find((x) => x.phase === "activate") ? { timelockObservation: options.timelockOperations.find((x) => x.phase === "activate") } : {}), readiness: { caAddressAndDecimalsChecked, readOnlyChainChecksPassed: preflightPassed, offchainServiceChecksRequired: true, readyToSchedule: false }, ...batches.activation as object },
      configurationExecution: { status: "review-only-do-not-submit", ...batches.configurationExecution as object },
      activationExecution: { status: "review-only-do-not-submit", ...batches.activationExecute as object },
    } : { configuration: null, configurationExecution: null, activation: null, activationExecution: null },
    phases: [
      { id: "validate", order: 1, action: "Read-only verify RPC chain, deployment, token metadata, roles and configured funding." },
      { id: deployment ? "deploy-already-present" : "deploy-paused", order: 2, action: deployment ? "Review supplied deployment and confirm QueryEscrow is paused on chain." : "Deploy production contracts paused and hand governance to timelock controlled by the reviewed control wallet.", ...(deployment ? {} : { commandTemplate: "bun scripts/deploy-local.ts --mainnet --rpc <HTTPS_RPC> --key-file <PROTECTED_DEPLOYER_KEY_FILE> --owner <CONTROL_WALLET> --guardian <CONTROL_WALLET> --min-juror-bond 0 --usdg <USDG_CA> --mochi-token <TEAM_MOCHI_CA> --shielded privacy-pools --randomness drand --out deployments/mainnet.json" }), requires: ["phase validate complete"] },
      { id: "configure", order: 3, action: batches ? "Review the generated configuration schedule payload; it is not submitted." : "Build configuration payload from deployment and identity files.", payload: batches ? "reviewPayloads.configuration" : undefined, requires: ["deployment and identities reviewed"], then: "execute through approved control wallet only after the full 86,400-second delay", irreversible: true },
      { id: "enroll-and-verify", order: 4, action: "Enroll jurors from operator wallets, attest service keys, fund required bonds and feed budget; verify live service readiness while paused." },
      { id: "activate", order: 5, action: batches ? "Review separate activation payload after configuration, enrollment and readiness checks." : "Build a separate activation payload only when deployment and identities are supplied.", payload: batches ? "reviewPayloads.activation" : undefined, requires: ["phase enroll-and-verify complete"], readiness: { readyToSchedule: false, reason: !input.mochiToken ? "external MOCHI CA is missing" : "chain and off-chain activation checks must be completed" }, then: "schedule through approved control wallet, wait full delay, repeat checks and obtain release approval", irreversible: true },
      { id: "paid-smoke-and-release", order: 6, action: "Run bounded, spend-capped paid smoke reviews and publish paid access only after evidence review.", irreversible: true },
    ],
    safety: { transactionsSent: false, keysRead: false, tokenCreated: false, servicesProvisioned: false, mainnetExecutionEnabled: false, note: "Payloads are unsigned review data only. This planner never submits transactions or invokes a wallet." },
  };
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(resolve(path), "utf8")) as T; }
async function main() {
  const argv = process.argv.slice(2);
  const inputPath = argv[0];
  if (!inputPath || argv.some((x) => ["--execute", "--yes"].includes(x))) throw new Error("usage: bun scripts/production-release.ts <public-release-input.json> [--check-rpc] [--check-timelock] [--out <plan.json>]; execution flags are unsupported");
  const allowed = new Set([inputPath, "--check-rpc", "--check-timelock", "--out"]);
  for (let i = 1; i < argv.length; i++) { if (argv[i] === "--out") { if (!argv[i + 1]) throw new Error("--out requires a path"); allowed.add(argv[++i]!); } else if (!allowed.has(argv[i]!)) throw new Error(`unknown argument: ${argv[i]}`); }
  const input = readJson<ReleaseInput>(inputPath);
  const deployment = input.deploymentFile ? readJson<ProductionDeployment>(input.deploymentFile) : undefined;
  const identities = input.identitiesFile ? readJson<IdentityInput>(input.identitiesFile) : undefined;
  // Run all pure input/deployment/identity validation before opening the RPC transport.
  buildProductionRelease(input, { deployment, identities });
  let preflight: Awaited<ReturnType<typeof runReadOnlyPreflight>> | undefined;
  let timelockOperations: TimelockOperationObservation[] | undefined;
  if (argv.includes("--check-rpc") || argv.includes("--check-timelock")) {
    if (!deployment) throw new Error("--check-rpc requires deploymentFile");
    const rpcUrl = input.rpcUrl ?? deployment.rpcUrl;
    if (!rpcUrl) throw new Error("--check-rpc requires rpcUrl in release input or deployment");
    const rpcUrlErrors = validateRpcUrl(rpcUrl);
    if (rpcUrlErrors.length) throw new Error(rpcUrlErrors.join("\n"));
    const transport = http(rpcUrl);
    const client = createPublicClient({ transport });
    const chain = createChain({ ...deployment, rpcUrl } as unknown as ChainDeployment, { transport });
    const escrowBudgetAbi = parseAbi(["function feedBudget() view returns (uint256)"]);
    const reader: ReadOnlyReader = {
      chainId: () => client.getChainId(),
      code: (address) => client.getCode({ address }),
      decimals: (address) => client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      hasRole: (contract, role, account) => client.readContract({ address: contract, abi: accessAbi, functionName: "hasRole", args: [role, account] }),
      nativeBalance: (account) => client.getBalance({ address: account }),
      jurorInfo: (key) => chain.getJuror(key),
      isActive: (key, role) => chain.isActive(key, role),
      feedBudget: (escrow) => client.readContract({ address: escrow, abi: escrowBudgetAbi, functionName: "feedBudget" }),
      paused: (escrow) => client.readContract({ address: escrow, abi: pauseAbi, functionName: "paused" }),
    };
    const batchInput = deployment && identities ? (() => {
      const salt = (input.salt ?? identities.salt) as Hex | undefined;
      if (!salt) return undefined;
      const full = { ...identities, salt } as IdentityInput;
      return { configure: buildPhalaBatch(deployment, full, "schedule", "configure"), activation: buildPhalaBatch(deployment, full, "schedule", "activate") };
    })() : undefined;
    if (argv.includes("--check-rpc")) preflight = await runReadOnlyPreflight(deployment, input, reader, identities);
    if (argv.includes("--check-timelock")) {
      if (!batchInput) throw new Error("--check-timelock requires deploymentFile, identitiesFile, and a valid salt");
      const timestampAbi = parseAbi(["function getTimestamp(bytes32 id) view returns (uint256)"]);
      timelockOperations = await readTimelockOperationStatus(deployment, batchInput, {
        chainId: () => client.getChainId(),
        blockTimestamp: async () => BigInt((await client.getBlock({ blockTag: "latest" })).timestamp),
        operationTimestamp: (timelock, operationId) => client.readContract({ address: timelock, abi: timestampAbi, functionName: "getTimestamp", args: [operationId] }),
      });
    }
  }
  const plan = buildProductionRelease(input, { deployment, identities, preflight, timelockOperations });
  const output = JSON.stringify(plan, null, 2) + "\n";
  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0) writeFileSync(resolve(argv[outIndex + 1]!), output, { mode: 0o600 });
  else process.stdout.write(output);
}
if (import.meta.main) main();
