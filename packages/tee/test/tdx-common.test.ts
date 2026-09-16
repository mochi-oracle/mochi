import { describe, expect, it } from "bun:test";
import { keccak256, concat, type Hex } from "viem";
import { parseTdxReportData, tdxMeasurement, tdxReportData } from "../src/tdx-common.ts";

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
});
