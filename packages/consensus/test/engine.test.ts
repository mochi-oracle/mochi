import { describe, expect, test } from "bun:test";
import { SchemaId, VerdictStatus, type FieldSpec, type SchemaDef } from "@mochi/core";
import { runConsensus, ConsensusInputError } from "../src/engine.ts";
import { answer, def, fields, seats, vbool, vdate, vnum, vstr } from "./helpers.ts";

const valueField = (name: string, kind: FieldSpec["kind"] = "num", tolerance: FieldSpec["tolerance"] = { kind: "exact" }, required = true): FieldSpec => ({ name, kind, tolerance, required, description: "" });
const oneField = (field: FieldSpec): SchemaDef => ({ ...def, fields: [field] });
const nums = (values: bigint[]) => seats(values.map((e8) => ({ exact_num: vnum(e8) })));

describe("runConsensus", () => {
  test("spec example: six EPS 2.11 values beat one 2.10 dissent; revenue is within tolerance", () => {
    const input = seats([
      ...Array.from({ length: 6 }, () => ({ exact_num: vnum(211000000n), relative_num: vnum(100000000n) })),
      { exact_num: vnum(210000000n), relative_num: vnum(100100000n) },
    ]);
    const result = runConsensus(def, input);
    expect(result.status).toBe(VerdictStatus.VERDICT);
    expect(result.agreementBps).toBe(8571);
    expect(result.fields[0]!.value).toEqual(vnum(211000000n));
    expect(result.fields[0]!.supportingSeats).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.dissentMask).toBe(1 << 6);
    expect(result.fields[1]!.agreeCount).toBe(7);
  });

  test("thresholds, unanimity, and dissent", () => {
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 1n])).agreementBps).toBe(10000);
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 2n])).status).toBe(VerdictStatus.HUNG);
    expect(runConsensus(oneField(valueField("exact_num")), nums([5n, 5n, 5n, 5n, 9n])).status).toBe(VerdictStatus.VERDICT);
    expect(runConsensus(oneField(valueField("exact_num")), nums([5n, 5n, 5n, 9n, 9n])).status).toBe(VerdictStatus.HUNG);
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 1n, 1n, 1n, 1n, 2n])).status).toBe(VerdictStatus.VERDICT);
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 1n, 1n, 1n, 2n, 2n])).status).toBe(VerdictStatus.HUNG);
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 1n, 1n, 1n, 1n, 1n, 2n, 2n])).status).toBe(VerdictStatus.VERDICT);
    expect(runConsensus(oneField(valueField("exact_num")), nums([1n, 1n, 1n, 1n, 1n, 1n, 2n, 2n, 2n])).status).toBe(VerdictStatus.HUNG);
  });

  test("relative tolerance boundary is inclusive and one e8 beyond it does not support", () => {
    const d = oneField(valueField("exact_num", "num", { kind: "rel", bps: 10 }));
    const boundary = runConsensus(d, nums([100000000n, 100100000n, 300000000n]));
    expect(boundary.fields[0]!.agreeCount).toBe(2);
    expect(boundary.fields[0]!.supportingSeats).toEqual([0, 1]);
    const oneOver = runConsensus(d, nums([100000000n, 99899999n, 300000000n]));
    expect(oneOver.fields[0]!.supportingSeats).toEqual([0]);
  });

  test("absolute tolerance and median tie-break choose an actual middle juror value", () => {
    const d = oneField(valueField("exact_num", "num", { kind: "abs", e8: 5n }));
    const result = runConsensus(d, nums([0n, 5n, 5n, 5n, 100n]));
    expect(result.fields[0]!.value).toEqual(vnum(5n));
    const tie = runConsensus(oneField(valueField("exact_num")), nums([0n, 10n, 20n]));
    expect(tie.fields[0]!.supportingSeats).toEqual([1]);
  });

  test("optional null loses equal-support tie to a value; all-null optional agrees on null", () => {
    const d = oneField(valueField("as_of", "date", { kind: "exact" }, false));
    const tie = runConsensus(d, seats([{ as_of: null }, { as_of: vdate("2026-01-01") }, { as_of: vdate("2026-01-02") }]));
    expect(tie.fields[0]!.supportingSeats).toEqual([1]);
    const allNull = runConsensus(d, seats([{ as_of: null }, { as_of: null }, { as_of: null }]));
    expect(allNull.status).toBe(VerdictStatus.VERDICT);
    expect(allNull.agreed.as_of).toBeNull();
    expect(allNull.hungFields).toEqual([]);
  });

  test("lexicographic tie-break applies to strings", () => {
    const d = oneField(valueField("text", "str"));
    const result = runConsensus(d, seats(["z", "m", "a"].map((v) => ({ text: vstr(v) }))));
    expect(result.fields[0]!.supportingSeats).toEqual([2]);
  });

  test("missing span, kind mismatch, invalid marker, timeouts, and required nulls are dissent", () => {
    const d = oneField(valueField("exact_num"));
    const badAnswers = [
      answer({}, { noSpan: ["exact_num"] }),
      answer({ exact_num: vstr("wrong kind") }),
      answer({}, { invalid: ["exact_num"] }),
    ];
    for (const bad of badAnswers) {
      const out = runConsensus(d, [0, 1, 2].map((seat) => ({ seat, juror: "0x0000000000000000000000000000000000000000", jurorClass: 0, timedOut: false as const, answer: bad })));
      expect(out.fields[0]!.agreeCount).toBe(0);
    }
    const timedValues: Array<Record<string, import("@mochi/core").NormalizedValue | null> | "timeout"> = ["timeout", { exact_num: vnum(1n) }, { exact_num: vnum(1n) }];
    const timed = runConsensus(d, timedValues.map((x, seat) => x === "timeout"
      ? { seat, juror: "0x0000000000000000000000000000000000000000", jurorClass: 0, timedOut: true as const }
      : { seat, juror: "0x0000000000000000000000000000000000000000", jurorClass: 0, timedOut: false as const, answer: answer(x) }));
    expect(timed.status).toBe(VerdictStatus.HUNG);
    expect(timed.timeoutMask).toBe(1);
    expect(timed.dissentMask).toBe(1);
    const allNull = runConsensus(d, seats([{ exact_num: null }, { exact_num: null }, { exact_num: null }]));
    expect(allNull.fields[0]!.agreeCount).toBe(0);
    expect(allNull.status).toBe(VerdictStatus.HUNG);
  });

  test("validates jury size, exact seat coverage, and answer schema", () => {
    expect(() => runConsensus(def, seats([{}, {}, {}, {}]))).toThrow(ConsensusInputError);
    const three = seats([{}, {}, {}]);
    expect(() => runConsensus(def, [three[0]!, three[0]!, three[2]!])).toThrow(ConsensusInputError);
    expect(() => runConsensus(def, [three[0]!, { ...three[1]!, seat: 3 }, three[2]!])).toThrow(ConsensusInputError);
    const mismatch = { ...three[0]!, answer: answer({}, { schemaVersion: 2 }) };
    expect(() => runConsensus(def, [mismatch, three[1]!, three[2]!])).toThrow(ConsensusInputError);
  });
});
