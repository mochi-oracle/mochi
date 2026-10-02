import { expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import {
  buildPanelSwitchOnBatch, countActiveEvaluators, MIN_ACTIVE_EVALUATORS, PANEL_RESERVE_BPS_ON, PANEL_WIRING_ABI, panelBindingProblems, panelWiringProblems,
  parsePanelEscalationOption, readPanelBindings, readPanelWiring, recordedPanelEscalation, switchOnRefusal, ZERO_ADDRESS, type PanelBindings,
} from "./panel-escalation.ts";
import { loadDeployment, loadSteps } from "./owner-console.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const salt = `0x${"7a".repeat(32)}` as Hex;
const deployment = loadDeployment({ chainId: 4663, owner: a(200), rpcUrl: "https://rpc.example", timelockDelay: "60", contracts: { timelock: a(101), jurorRegistry: a(102), queryEscrow: a(103), receiptAnchor: a(104), panel: a(106), mochiToken: a(107), usdg: a(108) }, privacy: { entrypoint: a(105) } });
const switchDeployment = deployment as unknown as Parameters<typeof buildPanelSwitchOnBatch>[0];
const TIMELOCK_ABI = parseAbi([
  "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt)",
]);

test("--panel-escalation is explicit on mainnet, defaults on for local fixtures, and rejects other values", () => {
  expect(() => parsePanelEscalationOption(undefined, true)).toThrow("--mainnet requires --panel-escalation off|on");
  expect(parsePanelEscalationOption("off", true)).toBe("off");
  expect(parsePanelEscalationOption("on", true)).toBe("on");
  expect(parsePanelEscalationOption(undefined, false)).toBe("on");
  expect(parsePanelEscalationOption("off", false)).toBe("off");
  for (const value of ["", "OFF", "false", "0", "disabled"]) expect(() => parsePanelEscalationOption(value, true)).toThrow("must be off or on");
  expect(recordedPanelEscalation({})).toBeUndefined();
  expect(recordedPanelEscalation({ panelEscalation: "off" })).toBe("off");
  expect(() => recordedPanelEscalation({ panelEscalation: true })).toThrow("must be off or on");
});

test("wiring check: off needs no panel and no reserve; on needs the deployed panel and a reserve", () => {
  const panel = a(106);
  expect(panelWiringProblems("off", panel, { panel: ZERO_ADDRESS, panelReserveBps: 0 })).toEqual([]);
  expect(panelWiringProblems("off", panel, { panel, panelReserveBps: 0 }).join()).toContain("requires the zero address");
  expect(panelWiringProblems("off", panel, { panel: ZERO_ADDRESS, panelReserveBps: 2500 }).join()).toContain("VERDICT settlement would revert");
  expect(panelWiringProblems("on", panel, { panel, panelReserveBps: 2500 })).toEqual([]);
  expect(panelWiringProblems("on", panel, { panel: ZERO_ADDRESS, panelReserveBps: 0 }).join()).toContain("requires PanelEscalation");
  expect(panelWiringProblems("on", panel, { panel, panelReserveBps: 0 }).join()).toContain("nonzero reserve");
  // Unrecorded (older) deployments are only checked for the settlement-blocking combination.
  expect(panelWiringProblems(undefined, panel, { panel, panelReserveBps: 2500 })).toEqual([]);
  expect(panelWiringProblems(undefined, panel, { panel: ZERO_ADDRESS, panelReserveBps: 0 })).toEqual([]);
  expect(panelWiringProblems(undefined, panel, { panel: ZERO_ADDRESS, panelReserveBps: 1 })).toHaveLength(1);
});

test("readPanelWiring reads QueryEscrow.panel and panelReserveBps", async () => {
  const calls: string[] = [];
  const client = { async readContract(args: { address: Address; functionName: string }) { calls.push(`${args.address}.${args.functionName}`); return args.functionName === "panel" ? ZERO_ADDRESS : 0; } };
  expect(await readPanelWiring(client, a(103))).toEqual({ panel: ZERO_ADDRESS, panelReserveBps: 0 });
  expect(calls.sort()).toEqual([`${a(103)}.panel`, `${a(103)}.panelReserveBps`]);
});

test("switch-on batch is setPanel(panel) + setPanelReserveBps(2500) on QueryEscrow through the timelock", () => {
  const schedule = buildPanelSwitchOnBatch(switchDeployment, salt, "schedule");
  expect(schedule.to).toBe(a(101));
  expect(schedule.phase).toBe("panel-on");
  expect(schedule.callCount).toBe(2);
  expect(schedule.delaySeconds).toBe(60);
  expect(schedule.targets).toEqual([a(103), a(103)]);
  const inner = schedule.payloads.map((data) => decodeFunctionData({ abi: PANEL_WIRING_ABI, data }));
  expect(inner.map((c) => [c.functionName, ...(c.args ?? [])])).toEqual([["setPanel", a(106)], ["setPanelReserveBps", PANEL_RESERVE_BPS_ON]]);
  const outer = decodeFunctionData({ abi: TIMELOCK_ABI, data: schedule.calldata });
  expect(outer.functionName).toBe("scheduleBatch");
  expect(outer.args).toEqual([[a(103), a(103)], [0n, 0n], schedule.payloads, `0x${"00".repeat(32)}`, salt, 60n]);
  expect(schedule.operationId).toBe(keccak256(encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
    [schedule.targets, [0n, 0n], schedule.payloads, `0x${"00".repeat(32)}`, salt],
  )));
  const execute = buildPanelSwitchOnBatch(switchDeployment, salt, "execute");
  expect(execute.operationId).toBe(schedule.operationId);
  expect(execute.delaySeconds).toBeUndefined();
  expect(decodeFunctionData({ abi: TIMELOCK_ABI, data: execute.calldata }).functionName).toBe("executeBatch");
});

test("switch-on batch refuses a bad salt, missing contracts and an out-of-policy delay", () => {
  expect(() => buildPanelSwitchOnBatch(switchDeployment, "0x1234" as Hex, "schedule")).toThrow("salt must be bytes32");
  expect(() => buildPanelSwitchOnBatch({ ...switchDeployment, contracts: { ...switchDeployment.contracts, panel: ZERO_ADDRESS } }, salt, "schedule")).toThrow("contracts.panel");
  expect(() => buildPanelSwitchOnBatch({ ...switchDeployment, contracts: { ...switchDeployment.contracts, timelock: undefined } }, salt, "schedule")).toThrow("contracts.timelock");
  expect(() => buildPanelSwitchOnBatch({ ...switchDeployment, timelockDelay: "3601" }, salt, "schedule")).toThrow("0 to 3600");
});

test("owner console loads and explains the switch-on batch for review", () => {
  const [schedule] = loadSteps(deployment, buildPanelSwitchOnBatch(switchDeployment, salt, "schedule"), "panel-on-schedule.json", "p1");
  expect(schedule!.kind).toBe("timelock-schedule");
  expect(schedule!.title).toBe("Schedule governance operation (panel-on): 2 call(s)");
  expect(schedule!.details).toEqual([
    `queryEscrow.setPanel(${a(106)} (panel))`,
    "queryEscrow.setPanelReserveBps(2500)",
    "Waiting period after scheduling: 60 seconds",
  ]);
  const [execute] = loadSteps(deployment, buildPanelSwitchOnBatch(switchDeployment, salt, "execute"), "panel-on-execute.json", "p2");
  expect(execute!.kind).toBe("timelock-execute");
  expect(execute!.operationId).toBe(schedule!.operationId);
});

test("evaluator counts come from PanelEscalation's pool: active count, and drawable (past the warm-up) per position", async () => {
  const pool = [a(1), a(2), a(3), a(4)];
  const drawable: Record<string, boolean> = { [a(1)]: true, [a(2)]: false, [a(3)]: true, [a(4)]: false };
  const calls: string[] = [];
  const client = { async readContract(args: { address: Address; functionName: string; args?: readonly unknown[] }) {
    calls.push(args.functionName);
    expect(args.address).toBe(a(106));
    if (args.functionName === "activeEvaluators") return 3n;
    if (args.functionName === "poolLength") return BigInt(pool.length);
    if (args.functionName === "pool") { const i = Number(args.args![0]); if (i >= pool.length) throw new Error("out of range"); return pool[i]; }
    if (args.functionName === "isDrawable") return drawable[args.args![0] as string];
    throw new Error(`unexpected ${args.functionName}`);
  } };
  expect(await countActiveEvaluators(client, a(106))).toEqual({ active: 3, drawable: 2, pool: 4 });
  // The scan is capped; the active count still comes from the contract.
  expect(await countActiveEvaluators(client, a(106), 1)).toEqual({ active: 3, drawable: 1, pool: 4 });
  expect(calls).not.toContain("evaluators");
  // A panel needs three drawable evaluators and an appeal three more outside it.
  expect(MIN_ACTIVE_EVALUATORS).toBe(6);
});

describeBindings();

function describeBindings() {
  // Deployment above: queryEscrow a(103), panel a(106), usdg a(108); add verdicts and randomness.
  const contracts = { ...switchDeployment.contracts, verdicts: a(110), randomness: a(111) };
  const good: PanelBindings = { escrow: a(103), verdicts: a(110), usdg: a(108), randomness: a(111), verdictsPanel: a(106) };

  test("readPanelBindings reads PanelEscalation's escrow, verdicts, usdg, randomness and MochiVerdicts.panel", async () => {
    const calls: string[] = [];
    const values: Record<string, Address> = {
      [`${a(106)}.escrow`]: a(103), [`${a(106)}.verdicts`]: a(110), [`${a(106)}.usdg`]: a(108), [`${a(106)}.randomness`]: a(111), [`${a(110)}.panel`]: a(106),
    };
    const client = { async readContract(args: { address: Address; functionName: string }) { const key = `${args.address}.${args.functionName}`; calls.push(key); return values[key]; } };
    expect(await readPanelBindings(client, a(106), a(110))).toEqual(good);
    expect(calls.sort()).toEqual(Object.keys(values).sort());
  });

  test("binding check: every fixed reference must be the deployment's contract, compared case-insensitively", () => {
    expect(panelBindingProblems(contracts, good)).toEqual([]);
    expect(panelBindingProblems(contracts, { ...good, escrow: a(103).toUpperCase().replace("0X", "0x") as Address })).toEqual([]);
    const cases: [Partial<PanelBindings>, string][] = [
      [{ escrow: a(199) }, `PanelEscalation.escrow is ${a(199)}; the deployment's queryEscrow is ${a(103)}`],
      [{ verdicts: a(199) }, `PanelEscalation.verdicts is ${a(199)}; the deployment's verdicts is ${a(110)}`],
      [{ usdg: a(199) }, `PanelEscalation.usdg is ${a(199)}; the deployment's usdg is ${a(108)}`],
      [{ randomness: a(199) }, `PanelEscalation.randomness is ${a(199)}; the deployment's randomness is ${a(111)}`],
      [{ verdictsPanel: ZERO_ADDRESS }, `MochiVerdicts.panel is ${ZERO_ADDRESS}; the deployment's panel is ${a(106)}`],
    ];
    for (const [change, message] of cases) expect(panelBindingProblems(contracts, { ...good, ...change })).toEqual([message]);
    expect(panelBindingProblems({ ...contracts, randomness: undefined }, good)).toEqual(["deployment.contracts.randomness is missing; cannot check PanelEscalation.randomness"]);
  });

  test("switch-on is refused on any binding mismatch and below six drawable evaluators", () => {
    expect(switchOnRefusal({ active: 6, drawable: 6 }, [])).toBeNull();
    expect(switchOnRefusal({ active: 9, drawable: 5 }, [])).toContain("5 drawable panel evaluator(s) (9 active), at least 6");
    expect(switchOnRefusal({ active: 3, drawable: 3 }, [])).toContain("at least 6");
    const mismatch = panelBindingProblems(contracts, { ...good, verdictsPanel: a(199) });
    expect(switchOnRefusal({ active: 20, drawable: 20 }, mismatch)).toBe(`refusing to build switch-on: ${mismatch[0]}`);
  });
}
