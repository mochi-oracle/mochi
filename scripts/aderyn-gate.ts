#!/usr/bin/env bun
/**
 * CI gate for Aderyn, which reports findings but has no fail-on-severity option. Fails when the JSON report has a
 * High-severity instance that is not accepted in contracts/aderyn-baseline.json. Findings suppressed inline with
 * `// aderyn-fp-next-line(<detector>) <reason>` never reach the report; the baseline is for code that cannot carry an
 * inline annotation yet. A baseline entry matches on detector, file and the trimmed source line, so it survives line
 * shifts but not an edit to the flagged line, and `count` bounds how many identical lines it accepts.
 *
 *   bun scripts/aderyn-gate.ts <report.json> [baseline.json] [project-root]
 *   (defaults: contracts/aderyn-baseline.json, contracts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AderynInstance = { contract_path: string; line_no: number };
export type AderynIssue = { detector_name: string; title?: string; instances: AderynInstance[] };
export type AderynReport = { high_issues: { issues: AderynIssue[] } };
export type BaselineEntry = { detector: string; file: string; line: string; count?: number; verdict: string; reason: string };
export type Baseline = { accepted: BaselineEntry[] };
export type GateFinding = { detector: string; file: string; line: number; source: string };
export type GateResult = { accepted: GateFinding[]; unaccepted: GateFinding[]; stale: BaselineEntry[] };

const keyOf = (detector: string, file: string, source: string) => JSON.stringify([detector, file, source.trim()]);

/** Splits the report's High instances into baseline-accepted and new ones; `sourceLine` reads one source line. */
export function gate(report: AderynReport, baseline: Baseline, sourceLine: (file: string, line: number) => string): GateResult {
  const remaining = new Map<string, number>();
  for (const entry of baseline.accepted) {
    const key = keyOf(entry.detector, entry.file, entry.line);
    remaining.set(key, (remaining.get(key) ?? 0) + (entry.count ?? 1));
  }
  const accepted: GateFinding[] = [];
  const unaccepted: GateFinding[] = [];
  for (const issue of report.high_issues.issues) {
    for (const instance of issue.instances) {
      const finding = {
        detector: issue.detector_name,
        file: instance.contract_path,
        line: instance.line_no,
        source: sourceLine(instance.contract_path, instance.line_no).trim(),
      };
      const key = keyOf(finding.detector, finding.file, finding.source);
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
        accepted.push(finding);
      } else {
        unaccepted.push(finding);
      }
    }
  }
  const stale = baseline.accepted.filter((entry) => (remaining.get(keyOf(entry.detector, entry.file, entry.line)) ?? 0) > 0);
  return { accepted, unaccepted, stale };
}

if (import.meta.main) {
  const [reportPath, baselinePath = "contracts/aderyn-baseline.json", root = "contracts"] = process.argv.slice(2);
  if (!reportPath) {
    console.error("usage: bun scripts/aderyn-gate.ts <report.json> [baseline.json] [project-root]");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as AderynReport;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const files = new Map<string, string[]>();
  const sourceLine = (file: string, line: number) => {
    let lines = files.get(file);
    if (!lines) files.set(file, (lines = readFileSync(join(root, file), "utf8").split("\n")));
    return lines[line - 1] ?? "";
  };
  const result = gate(report, baseline, sourceLine);
  console.log(`Aderyn High: ${result.accepted.length} accepted in ${baselinePath}, ${result.unaccepted.length} new.`);
  for (const entry of result.stale) {
    console.log(`::warning::stale Aderyn baseline entry (${entry.detector} ${entry.file}): ${entry.line}`);
  }
  for (const finding of result.unaccepted) {
    console.log(`::error file=${join(root, finding.file)},line=${finding.line}::Aderyn ${finding.detector}: ${finding.source}`);
  }
  if (result.unaccepted.length > 0) {
    console.log("Fix each new High, or triage it: annotate the line with `// aderyn-fp-next-line(<detector>) <reason>`.");
    process.exit(1);
  }
}
