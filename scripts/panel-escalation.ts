// Panel escalation launch switch.
//
// Launch deploys PanelEscalation (stable addresses and roles) but leaves it unwired from QueryEscrow: QueryEscrow.panel is
// the zero address and panelReserveBps is 0. With no panel, QueryEscrow.markEscalated reverts, so PanelEscalation.escalate
// reverts atomically before any fee moves, and VERDICT settlement never transfers a reserve share to the zero address.
// The whole protocol fee then follows the existing remainder route (reviewProtocolRecipient, else MochiStaking rewards).
// MochiVerdicts.setPanel stays wired: it only lets PanelEscalation post an outcome for an ESCALATED query, which is
// unreachable while QueryEscrow.panel is zero, and keeping it means switch-on changes a single contract.
//
// Switching on later is one reviewed timelock batch on QueryEscrow: setPanel(panel) + setPanelReserveBps(2500).
//
//   bun scripts/panel-escalation.ts inspect <deployment.json> [--rpc https://...]
//     Read-only: compares the on-chain wiring with the deployment's recorded mode, checks the panel's fixed bindings
//     (MochiVerdicts.panel and PanelEscalation's escrow, verdicts, usdg and randomness) against the deployment, and
//     counts active and drawable evaluators; exits 1 on a mismatch.
//   bun scripts/panel-escalation.ts switch-on <deployment.json> schedule|execute --salt 0x<64 hex> [--rpc https://...]
//     Builds (never sends) the unsigned switch-on batch for scripts/owner-console.ts. Refuses on any binding mismatch
//     and while fewer than six evaluators are drawable (active and past the warm-up): a panel needs three and an appeal
//     three more. Keep the salt for execute.
//   bun scripts/panel-escalation.ts record-on <deployment.json> [--rpc https://...]
//     After the switch-on execute is confirmed: checks the on-chain wiring is on, then records "on" in the file.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, isAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { productionTimelockDelay } from "../deploy/production/chain-policy.ts";

export type PanelEscalationMode = "off" | "on";
export type PanelWiring = { panel: Address; panelReserveBps: number };
type SwitchDeployment = { chainId?: number; rehearsal?: boolean; timelockDelay?: string | number; contracts: { timelock?: Address; queryEscrow: Address; panel: Address; verdicts?: Address; usdg?: Address; randomness?: Address } };
/** What PanelEscalation is bound to on chain: its immutable references and MochiVerdicts' authorised panel. */
export type PanelBindings = { escrow: Address; verdicts: Address; usdg: Address; randomness: Address; verdictsPanel: Address };

/** QueryEscrow's constructor default and the reserve restored by switch-on. */
export const PANEL_RESERVE_BPS_ON = 2_500;
/** A panel needs three drawable evaluators (NotEnoughEvaluators otherwise) and an appeal three more outside it. */
export const MIN_ACTIVE_EVALUATORS = 6;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const PANEL_WIRING_ABI = parseAbi([
  "function panel() view returns (address)",
  "function panelReserveBps() view returns (uint16)",
  "function setPanel(address account)",
  "function setPanelReserveBps(uint16 bps)",
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** `--panel-escalation off|on`. Mainnet and rehearsal deploys must choose explicitly; local fixtures keep the panel on. */
export function parsePanelEscalationOption(value: string | undefined, mainnetMode: boolean): PanelEscalationMode {
  if (value === undefined) {
    if (mainnetMode) throw new Error("--mainnet requires --panel-escalation off|on (launch uses off: there are no panel evaluators yet)");
    return "on";
  }
  if (value !== "off" && value !== "on") throw new Error("--panel-escalation must be off or on");
  return value;
}

/** A recorded deployment mode, or undefined for deployments made before the option existed. */
export function recordedPanelEscalation(deployment: { panelEscalation?: unknown }): PanelEscalationMode | undefined {
  const mode = deployment.panelEscalation;
  if (mode === undefined) return undefined;
  if (mode !== "off" && mode !== "on") throw new Error("deployment panelEscalation must be off or on");
  return mode;
}

/** Problems with observed QueryEscrow wiring; empty when it matches the mode (or, with no mode, is merely consistent). */
export function panelWiringProblems(mode: PanelEscalationMode | undefined, panelContract: Address | undefined, observed: PanelWiring): string[] {
  const problems: string[] = [];
  const unwired = observed.panel.toLowerCase() === ZERO_ADDRESS;
  // Holds in every mode: a reserve without a panel would make every VERDICT settlement transfer to the zero address.
  if (unwired && observed.panelReserveBps !== 0) problems.push(`QueryEscrow.panelReserveBps is ${observed.panelReserveBps} with no panel; VERDICT settlement would revert`);
  if (mode === "off") {
    if (!unwired) problems.push(`QueryEscrow.panel is ${observed.panel}; panel escalation off requires the zero address (if a reviewed switch-on batch executed, run record-on)`);
    if (observed.panelReserveBps !== 0) problems.push(`QueryEscrow.panelReserveBps is ${observed.panelReserveBps}; panel escalation off requires 0`);
  } else if (mode === "on") {
    if (!panelContract || observed.panel.toLowerCase() !== panelContract.toLowerCase()) problems.push(`QueryEscrow.panel is ${observed.panel}; panel escalation on requires PanelEscalation ${panelContract ?? "(missing)"}`);
    if (observed.panelReserveBps === 0) problems.push("QueryEscrow.panelReserveBps is 0; panel escalation on requires a nonzero reserve");
  }
  return problems;
}

export async function readPanelWiring(client: { readContract(args: any): Promise<unknown> }, queryEscrow: Address): Promise<PanelWiring> {
  const [panel, panelReserveBps] = await Promise.all([
    client.readContract({ address: queryEscrow, abi: PANEL_WIRING_ABI, functionName: "panel" }),
    client.readContract({ address: queryEscrow, abi: PANEL_WIRING_ABI, functionName: "panelReserveBps" }),
  ]);
  return { panel: panel as Address, panelReserveBps: Number(panelReserveBps) };
}

export const PANEL_BINDING_ABI = parseAbi([
  "function escrow() view returns (address)",
  "function verdicts() view returns (address)",
  "function usdg() view returns (address)",
  "function randomness() view returns (address)",
  "function panel() view returns (address)",
]);

/** Reads PanelEscalation's immutable escrow, verdicts, usdg and randomness, and MochiVerdicts.panel(). */
export async function readPanelBindings(client: { readContract(args: any): Promise<unknown> }, panel: Address, verdicts: Address): Promise<PanelBindings> {
  const read = (address: Address, functionName: string) => client.readContract({ address, abi: PANEL_BINDING_ABI, functionName }) as Promise<Address>;
  const [escrow, panelVerdicts, usdg, randomness, verdictsPanel] = await Promise.all([
    read(panel, "escrow"), read(panel, "verdicts"), read(panel, "usdg"), read(panel, "randomness"), read(verdicts, "panel"),
  ]);
  return { escrow, verdicts: panelVerdicts, usdg, randomness, verdictsPanel };
}

/**
 * Problems with the panel's fixed wiring against the deployment; empty when it matches. Switching escalation on with
 * any of these wrong would route panel verdicts, fees or randomness through a contract the deployment does not name.
 */
export function panelBindingProblems(contracts: SwitchDeployment["contracts"], observed: PanelBindings): string[] {
  const checks: [what: string, key: string, want: Address | undefined, got: Address][] = [
    ["PanelEscalation.escrow", "queryEscrow", contracts.queryEscrow, observed.escrow],
    ["PanelEscalation.verdicts", "verdicts", contracts.verdicts, observed.verdicts],
    ["PanelEscalation.usdg", "usdg", contracts.usdg, observed.usdg],
    ["PanelEscalation.randomness", "randomness", contracts.randomness, observed.randomness],
    ["MochiVerdicts.panel", "panel", contracts.panel, observed.verdictsPanel],
  ];
  const problems: string[] = [];
  for (const [what, key, want, got] of checks) {
    if (typeof want !== "string" || !ADDRESS.test(want)) problems.push(`deployment.contracts.${key} is missing; cannot check ${what}`);
    else if (want.toLowerCase() !== String(got).toLowerCase()) problems.push(`${what} is ${got}; the deployment's ${key} is ${want}`);
  }
  return problems;
}

/** Why switch-on must not be built, or null: any binding mismatch, or too few drawable evaluators for an appeal. */
export function switchOnRefusal(evaluators: { active: number; drawable: number }, bindingProblems: string[]): string | null {
  if (bindingProblems.length) return `refusing to build switch-on: ${bindingProblems.join("; ")}`;
  if (evaluators.drawable < MIN_ACTIVE_EVALUATORS) {
    return `refusing to build switch-on: ${evaluators.drawable} drawable panel evaluator(s) (${evaluators.active} active), at least ${MIN_ACTIVE_EVALUATORS} are needed to draw a panel and an appeal`;
  }
  return null;
}

const EVALUATOR_ABI = parseAbi([
  "function activeEvaluators() view returns (uint256)",
  "function poolLength() view returns (uint256)",
  "function pool(uint256) view returns (address)",
  "function isDrawable(address) view returns (bool)",
]);

/**
 * PanelEscalation's evaluator pool. `active`: the contract's count of active evaluators (joined with at least minStake,
 * not since deactivated). `drawable`: active evaluators past the warm-up, i.e. eligible for a draw sealed now (only
 * these can fill a panel). `pool`: positions in the pool, which can also hold exits kept while a draw is pending.
 * `limit` caps how many pool positions are read.
 */
export async function countActiveEvaluators(client: { readContract(args: any): Promise<unknown> }, panel: Address, limit = 512): Promise<{ active: number; drawable: number; pool: number }> {
  const read = (functionName: string, args?: readonly unknown[]) => client.readContract({ address: panel, abi: EVALUATOR_ABI, functionName, ...(args ? { args } : {}) });
  const [active, poolLength] = await Promise.all([read("activeEvaluators") as Promise<bigint>, read("poolLength") as Promise<bigint>]);
  const pool = Number(poolLength);
  let drawable = 0;
  for (let i = 0; i < Math.min(pool, limit); i++) {
    const evaluator = await read("pool", [BigInt(i)]) as Address;
    if (await read("isDrawable", [evaluator]) === true) drawable++;
  }
  return { active: Number(active), drawable, pool };
}

/** Unsigned timelock batch that turns panel escalation on; same file shape as scripts/phala-batch.ts output. */
export function buildPanelSwitchOnBatch(deployment: SwitchDeployment, salt: Hex, action: "schedule" | "execute") {
  const { timelock, queryEscrow, panel } = deployment.contracts;
  for (const [name, value] of [["timelock", timelock], ["queryEscrow", queryEscrow], ["panel", panel]] as const) {
    if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === ZERO_ADDRESS) throw new Error(`deployment.contracts.${name} must be a nonzero address`);
  }
  if (!BYTES32.test(salt)) throw new Error("salt must be bytes32");
  if (action !== "schedule" && action !== "execute") throw new Error("action must be schedule or execute");
  const targets: Address[] = [queryEscrow, queryEscrow];
  const values = [0n, 0n];
  const payloads: Hex[] = [
    encodeFunctionData({ abi: PANEL_WIRING_ABI, functionName: "setPanel", args: [panel] }),
    encodeFunctionData({ abi: PANEL_WIRING_ABI, functionName: "setPanelReserveBps", args: [PANEL_RESERVE_BPS_ON] }),
  ];
  const delay = productionTimelockDelay(deployment);
  const predecessor = `0x${"00".repeat(32)}` as Hex;
  const operationId = keccak256(encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
    [targets, values, payloads, predecessor, salt],
  ));
  const calldata = action === "schedule"
    ? encodeFunctionData({ abi: parseAbi(["function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)"]),
        functionName: "scheduleBatch", args: [targets, values, payloads, predecessor, salt, BigInt(delay)] })
    : encodeFunctionData({ abi: parseAbi(["function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt)"]),
        functionName: "executeBatch", args: [targets, values, payloads, predecessor, salt] });
  return { action, phase: "panel-on" as const, to: timelock!, calldata, operationId, callCount: targets.length, delaySeconds: action === "schedule" ? delay : undefined, targets, payloads };
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

async function main(argv: string[]) {
  const [command, deploymentPath] = argv;
  const usage = "usage: bun scripts/panel-escalation.ts inspect|record-on <deployment.json> [--rpc https://...] | switch-on <deployment.json> schedule|execute --salt 0x<64 hex> [--rpc https://...]";
  if (!deploymentPath || !["inspect", "switch-on", "record-on"].includes(command ?? "")) throw new Error(usage);
  const raw = readFileSync(deploymentPath, "utf8");
  const deployment = JSON.parse(raw) as SwitchDeployment & { rpcUrl?: string; panelEscalation?: unknown };
  const escrow = deployment.contracts.queryEscrow;
  if (!escrow || !isAddress(escrow)) throw new Error("deployment.contracts.queryEscrow must be an address");
  // Provider URLs embed API keys: never print the RPC URL.
  const rpcUrl = option(argv, "--rpc") ?? process.env.RPC_URL ?? deployment.rpcUrl;
  if (!rpcUrl) throw new Error(`${command} needs --rpc, RPC_URL or deployment rpcUrl`);
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  if (deployment.chainId !== undefined && await client.getChainId() !== deployment.chainId) throw new Error("RPC chain does not match the deployment chainId");
  const mode = recordedPanelEscalation(deployment);
  const observed = await readPanelWiring(client, escrow);
  const evaluators = await countActiveEvaluators(client, deployment.contracts.panel);
  const verdicts = deployment.contracts.verdicts;
  if (!verdicts || !isAddress(verdicts)) throw new Error("deployment.contracts.verdicts must be an address");
  const bindings = await readPanelBindings(client, deployment.contracts.panel, verdicts);
  const bindingProblems = panelBindingProblems(deployment.contracts, bindings);
  if (command === "switch-on") {
    const action = argv[2];
    if (action !== "schedule" && action !== "execute") throw new Error(usage);
    const salt = option(argv, "--salt");
    if (!salt) throw new Error("--salt 0x<64 hex> is required; reuse the same salt for schedule and execute");
    const refusal = switchOnRefusal(evaluators, bindingProblems);
    if (refusal) throw new Error(refusal);
    console.log(JSON.stringify(buildPanelSwitchOnBatch(deployment, salt as Hex, action), null, 2));
    return;
  }
  if (command === "record-on") {
    const problems = [...panelWiringProblems("on", deployment.contracts.panel, observed), ...bindingProblems];
    if (problems.length) throw new Error(`on-chain wiring is not on; nothing recorded: ${problems.join("; ")}`);
    const updated = { ...JSON.parse(raw), panelEscalation: "on", panelSwitchedOn: { recordedAt: new Date().toISOString(), panel: observed.panel, panelReserveBps: observed.panelReserveBps } };
    writeFileSync(deploymentPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ recorded: "on", observed }, null, 2));
    return;
  }
  const problems = [...panelWiringProblems(mode, deployment.contracts.panel, observed), ...bindingProblems];
  const observedOn = observed.panel.toLowerCase() !== ZERO_ADDRESS;
  console.log(JSON.stringify({
    recordedMode: mode ?? "not recorded",
    observedMode: observedOn ? "on" : "off",
    queryEscrow: escrow, panelContract: deployment.contracts.panel,
    observed, bindings, activeEvaluators: evaluators.active, drawableEvaluators: evaluators.drawable, evaluatorPoolSize: evaluators.pool,
    note: observedOn
      ? "Escalation is live: a HUNG public or disclosure-allowed query can be escalated by its payer."
      : `Escalation is impossible until a reviewed switch-on batch executes; switch-on needs at least ${MIN_ACTIVE_EVALUATORS} active evaluators.`,
    ok: problems.length === 0, problems,
  }, null, 2));
  if (problems.length) process.exit(1);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
