import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gate, type AderynReport, type Baseline } from "./aderyn-gate.ts";

const source: Record<string, string[]> = {
  "src/A.sol": ["contract A {", "    x = oracle.read();", "    x = oracle.read();", "    y = other.call();", "}"],
};
const line = (file: string, n: number) => source[file]?.[n - 1] ?? "";
const report = (lines: number[]): AderynReport => ({
  high_issues: {
    issues: [{ detector_name: "reentrancy-state-change", instances: lines.map((line_no) => ({ contract_path: "src/A.sol", line_no })) }],
  },
});
const baseline = (count?: number): Baseline => ({
  accepted: [
    { detector: "reentrancy-state-change", file: "src/A.sol", line: "x = oracle.read();", ...(count ? { count } : {}), verdict: "fp", reason: "view" },
  ],
});

describe("aderyn gate", () => {
  test("accepts baselined Highs by source text, so line shifts do not matter", () => {
    const result = gate(report([3]), baseline(), line);
    expect(result.unaccepted).toEqual([]);
    expect(result.accepted).toEqual([{ detector: "reentrancy-state-change", file: "src/A.sol", line: 3, source: "x = oracle.read();" }]);
    expect(result.stale).toEqual([]);
  });

  test("fails on a High that is not in the baseline", () => {
    const result = gate(report([2, 4]), baseline(), line);
    expect(result.unaccepted.map((finding) => finding.source)).toEqual(["y = other.call();"]);
  });

  test("count bounds identical lines and unused entries are reported stale", () => {
    expect(gate(report([2, 3]), baseline(), line).unaccepted).toHaveLength(1);
    expect(gate(report([2, 3]), baseline(2), line).unaccepted).toHaveLength(0);
    expect(gate(report([]), baseline(), line).stale).toHaveLength(1);
  });

  test("a different detector on an accepted line is still new", () => {
    const other: AderynReport = {
      high_issues: { issues: [{ detector_name: "storage-array-memory-edit", instances: [{ contract_path: "src/A.sol", line_no: 2 }] }] },
    };
    expect(gate(other, baseline(), line).unaccepted).toHaveLength(1);
  });

  test("the committed baseline is well formed", () => {
    const committed = JSON.parse(readFileSync(new URL("../contracts/aderyn-baseline.json", import.meta.url), "utf8")) as Baseline;
    // Empty when every accepted finding carries an inline aderyn-fp-next-line reason.
    expect(Array.isArray(committed.accepted)).toBe(true);
    for (const entry of committed.accepted) {
      expect(entry.detector).toMatch(/^[a-z-]+$/);
      expect(entry.file).toMatch(/^src\/.+\.sol$/);
      expect(entry.line.trim()).toBe(entry.line);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
