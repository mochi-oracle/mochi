import { describe, expect, it } from "bun:test";
import { keccak256, concat, type Hex } from "viem";
import { dstackConfigMeasurement, parseTdxReportData, tdxMeasurement, tdxReportData } from "../src/tdx-common.ts";

describe("tdx-common", () => {
  const binding = `0x${"ab".repeat(32)}` as Hex;
  it("round-trips report data and rejects bad padding/length", () => {
    const rd = tdxReportData(binding, 1_790_000_000);
    expect(rd.length).toBe(64);
    expect(parseTdxReportData(rd)).toEqual({ keyBinding: binding, issuedAt: 1_790_000_000 });
    const bad = rd.slice(); bad[63] = 1;
    expect(parseTdxReportData(bad)).toBeUndefined();
    expect(parseTdxReportData(rd.subarray(0, 63))).toBeUndefined();
    expect(() => tdxReportData("0x01", 1)).toThrow();
    expect(() => tdxReportData(binding, -1)).toThrow();
  });
  it("measurement is keccak of the five 48-byte registers in order", () => {
    const r = (b: number) => new Uint8Array(48).fill(b);
    const regs = { mrtd: r(1), rtmr: [r(2), r(3), r(4), r(5)] as const };
    expect(tdxMeasurement(regs)).toBe(keccak256(concat([r(1), r(2), r(3), r(4), r(5)])));
    expect(tdxMeasurement({ ...regs, rtmr: [r(2), r(3), r(4), r(6)] })).not.toBe(tdxMeasurement(regs));
    expect(() => tdxMeasurement({ mrtd: new Uint8Array(47), rtmr: regs.rtmr })).toThrow();
  });
  it("dstack config profile pins app identity but excludes RTMR3", () => {
    const r = (b: number) => new Uint8Array(48).fill(b);
    const config = new Uint8Array(48); config[0] = 1; config.fill(0x9a, 1, 33);
    const regs = { mrtd: r(1), rtmr: [r(2), r(3), r(4), r(5)] as const, mrConfigId: config };
    const original = dstackConfigMeasurement(regs);
    expect(dstackConfigMeasurement({ ...regs, rtmr: [r(2), r(3), r(4), r(6)] })).toBe(original);
    expect(dstackConfigMeasurement({ ...regs, mrtd: r(7) })).not.toBe(original);
    for (const i of [0, 1, 2]) {
      const changed = regs.rtmr.map((register, index) => index === i ? r(register[0]! ^ 0xff) : register) as unknown as typeof regs.rtmr;
      expect(dstackConfigMeasurement({ ...regs, rtmr: changed })).not.toBe(original);
    }
    const changedConfig = config.slice(); changedConfig[1] = changedConfig[1]! ^ 1;
    expect(dstackConfigMeasurement({ ...regs, mrConfigId: changedConfig })).not.toBe(original);
  });
  it("rejects malformed and unknown dstack config identities", () => {
    const r = (b: number) => new Uint8Array(48).fill(b);
    const config = new Uint8Array(48); config[0] = 2; config.fill(1, 1, 33);
    const regs = { mrtd: r(1), rtmr: [r(2), r(3), r(4), r(5)] as const, mrConfigId: config };
    const invalid = [new Uint8Array(47), new Uint8Array(48), (() => { const x = config.slice(); x[0] = 4; return x; })(), (() => { const x = config.slice(); x[0] = 0; return x; })(), (() => { const x = config.slice(); x.fill(0, 1, 33); return x; })(), (() => { const x = config.slice(); x[47] = 1; return x; })()];
    for (const mrConfigId of invalid) expect(() => dstackConfigMeasurement({ ...regs, mrConfigId })).toThrow();
    for (const version of [1, 2, 3]) {
      const known = config.slice(); known[0] = version;
      expect(() => dstackConfigMeasurement({ ...regs, mrConfigId: known })).not.toThrow();
    }
  });
});
