// TDX TCB level evaluation vectors, checked against Intel's QVL (confidential-computing.tee.dcap.qvl,
// Src/AttestationLibrary/src/Verifiers/Checks/EvaluateTcb.cpp tdxEvaluateTCB, TcbLevelCheck.cpp checkTcbLevel and
// TDRelaunchCheck.cpp checkForRelaunch). The TCB info is the real Intel-signed fixture body (FMSPC B0C06F000000):
//   level 1 UpToDate:  SGX 2,2,2,2,3,1,0,5,0… PCESVN 11, TDX 5,0,2,0…
//   level 2 OutOfDate: SGX 2,2,2,2,3,1,0,5,0… PCESVN 5,  TDX 5,0,2,0… (with advisories)
//   TDX_01: ISVSVN 4 UpToDate, ISVSVN 2 OutOfDate;  TDX_03: ISVSVN 3 UpToDate.
import { describe, expect, test } from "bun:test";
import { DcapError, checkForRelaunch, evaluateTdxQuoteTcb, evaluateTdxTcb, verifyTdxQuote, type TdxTcbInput } from "../src/dcap/verify.ts";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { pemChain } from "../src/dcap/x509.ts";
import type { TdxCollateral } from "../src/dcap/collateral.ts";
import { FIXTURE_NOW, readFixture, readFixtureJson } from "./forge-quote.ts";

const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
const tcbInfo = JSON.parse(collateral.tcb_info) as Record<string, unknown>;
const raw = await readFixture("tdx_quote");
const quote = parseTdxQuote(raw);
const pck = pemChain(quote.pckPem)[0]!.sgx!.tcb;
const upToDateQe = { status: "UpToDate", advisoryIds: [] };
const fixtureInput: TdxTcbInput = { sgxTcbComponents: pck.compSvn, pceSvn: pck.pceSvn, qe: upToDateQe };

const svn = (...bytes: number[]) => { const out = new Uint8Array(16); out.set(bytes); return out; };
const evaluate = (teeTcbSvn: Uint8Array, input: Partial<TdxTcbInput> = {}, tcb = tcbInfo) => {
  try { return evaluateTdxTcb(tcb, { ...fixtureInput, ...input }, teeTcbSvn); } catch (error) { return error instanceof DcapError ? error.code : String(error); }
};
/** A copy of the fixture TCB info with every platform level's status replaced (bodies need no signature here). */
const withPlatformStatus = (status: string) => ({
  ...tcbInfo,
  tcbLevels: (tcbInfo.tcbLevels as Record<string, unknown>[]).map((level) => ({ ...level, tcbStatus: status })),
});

describe("TDX TCB levels follow Intel QVL tdxEvaluateTCB", () => {
  test("the real fixture quote (TEE_TCB_SVN 6,1,3: module 1.x) still evaluates UpToDate, alone and through full DCAP", () => {
    expect([...quote.td.teeTcbSvn.slice(0, 3)]).toEqual([6, 1, 3]);
    expect(pck.pceSvn).toBe(11);
    expect(evaluate(quote.td.teeTcbSvn)).toEqual({ status: "UpToDate", advisoryIds: [] });
    expect(verifyTdxQuote(raw, collateral, FIXTURE_NOW)).toMatchObject({ status: "UpToDate", advisoryIds: [] });
  });

  test("with a module major version above 0, TEE_TCB_SVN bytes 0-1 are rated by the module identity, not the platform level", () => {
    // Module 1.3: the platform level's TDX component 0 (5) is skipped; TDX_01 rates minor SVN 3 OutOfDate.
    expect(evaluate(svn(3, 1, 3))).toEqual({ status: "OutOfDate", advisoryIds: [] });
    // After a module major-version change (3.3), the genuine quote matches level 1 from index 2 and TDX_03 rates it.
    expect(evaluate(svn(3, 3, 3))).toEqual({ status: "UpToDate", advisoryIds: [] });
    expect(evaluate(svn(2, 3, 3))).toBe("TDX module TCB not supported");
    // Components from index 2 still count.
    expect(evaluate(svn(6, 1, 1))).toBe("TCB not supported");
    // A module major version without an identity in the TCB info is not supported.
    expect(evaluate(svn(6, 2, 3))).toBe("TDX module identity not supported");
  });

  test("with module major version 0, every TDX component is compared and no module status is added", () => {
    expect(evaluate(svn(5, 0, 2))).toEqual({ status: "UpToDate", advisoryIds: [] });
    expect(evaluate(svn(4, 0, 2))).toBe("TCB not supported");
    expect(evaluate(svn(5, 0, 1))).toBe("TCB not supported");
  });

  test("SGX components and PCESVN select the platform level; the QE status and advisories converge in", () => {
    // PCESVN 7 only reaches level 2, which carries its own advisories.
    const level2 = evaluate(quote.td.teeTcbSvn, { pceSvn: 7 }) as { status: string; advisoryIds: string[] };
    expect(level2.status).toBe("OutOfDate");
    expect(level2.advisoryIds).toContain("INTEL-SA-00837");
    expect(evaluate(quote.td.teeTcbSvn, { pceSvn: 4 })).toBe("TCB not supported");
    expect(evaluate(quote.td.teeTcbSvn, { sgxTcbComponents: [3, 3, 2, 2, 4, 1, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0] })).toBe("TCB not supported");
    expect(evaluate(quote.td.teeTcbSvn, { qe: { status: "OutOfDate", advisoryIds: ["INTEL-SA-00001"] } }))
      .toEqual({ status: "OutOfDate", advisoryIds: ["INTEL-SA-00001"] });
    // A ConfigurationNeeded QE does not change the platform status (Intel converges only OutOfDate and Revoked).
    expect(evaluate(quote.td.teeTcbSvn, { qe: { status: "ConfigurationNeeded", advisoryIds: [] } })).toEqual({ status: "UpToDate", advisoryIds: [] });
    expect(evaluate(svn(3, 1, 3), {}, withPlatformStatus("ConfigurationNeeded"))).toEqual({ status: "OutOfDateConfigurationNeeded", advisoryIds: [] });
  });

  test("status values outside Intel's lists for each kind of level fail", () => {
    const moduleSwHardening = {
      ...tcbInfo,
      tdxModuleIdentities: [{ ...(tcbInfo.tdxModuleIdentities as Record<string, unknown>[])[1], tcbLevels: [{ tcb: { isvsvn: 0 }, tcbStatus: "SWHardeningNeeded" }] }],
    };
    expect(evaluate(quote.td.teeTcbSvn, {}, moduleSwHardening)).toBe("unknown TCB status");
    expect(evaluate(quote.td.teeTcbSvn, {}, withPlatformStatus("TDRelaunchAdvised"))).toBe("unknown TCB status");
  });
});

describe("TD 1.5 bodies also rate TEE_TCB_SVN2 (Intel checkTcbLevel 4.1.2.5.1.20)", () => {
  const evaluateTd15 = (launch: Uint8Array, current: Uint8Array, bodyType = 3, tcb = tcbInfo) => {
    try { return evaluateTdxQuoteTcb(tcb, fixtureInput, { teeTcbSvn: launch, teeTcbSvn2: current }, bodyType); } catch (error) { return error instanceof DcapError ? error.code : String(error); }
  };

  test("a TD launched under an out-of-date module that now runs a current one is advised to relaunch", () => {
    expect(evaluateTd15(svn(3, 1, 3), svn(6, 1, 3))).toEqual({ status: "TDRelaunchAdvised", advisoryIds: [] });
    expect(evaluateTd15(svn(3, 1, 3), svn(3, 3, 3))).toEqual({ status: "TDRelaunchAdvised", advisoryIds: [] });
    expect(evaluateTd15(svn(3, 1, 3), svn(6, 1, 3), 3, withPlatformStatus("ConfigurationNeeded")))
      .toEqual({ status: "TDRelaunchAdvisedConfigurationNeeded", advisoryIds: [] });
    // The launch status stands otherwise, and an unsupported current SVN fails like Intel's.
    expect(evaluateTd15(svn(6, 1, 3), svn(3, 1, 3))).toEqual({ status: "UpToDate", advisoryIds: [] });
    expect(evaluateTd15(svn(3, 1, 3), svn(2, 1, 3))).toEqual({ status: "OutOfDate", advisoryIds: [] });
    expect(evaluateTd15(svn(6, 1, 3), svn(6, 2, 3))).toBe("TDX module identity not supported");
    // TD 1.0 bodies (v4, or v5 body type 2) have no TEE_TCB_SVN2.
    expect(evaluateTd15(svn(3, 1, 3), svn(6, 1, 3), 2)).toEqual({ status: "OutOfDate", advisoryIds: [] });
  });

  test("checkForRelaunch follows Intel's table", () => {
    const relaunchable = ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"];
    const expected: Record<string, string> = {
      UpToDate: "TDRelaunchAdvised", SWHardeningNeeded: "TDRelaunchAdvised",
      ConfigurationNeeded: "TDRelaunchAdvisedConfigurationNeeded", ConfigurationAndSWHardeningNeeded: "TDRelaunchAdvisedConfigurationNeeded",
    };
    for (const current of relaunchable) {
      expect(checkForRelaunch("OutOfDate", current)).toBe(expected[current]!);
      expect(checkForRelaunch("OutOfDateConfigurationNeeded", current)).toBe("TDRelaunchAdvisedConfigurationNeeded");
    }
    for (const current of ["OutOfDate", "OutOfDateConfigurationNeeded", "Revoked"]) expect(checkForRelaunch("OutOfDate", current)).toBe("OutOfDate");
    for (const launch of ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "Revoked"]) expect(checkForRelaunch(launch, "UpToDate")).toBe(launch);
  });
});
