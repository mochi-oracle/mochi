import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { SchemaId, VerdictStatus, type FieldSpec, type NormalizedValue, type SchemaDef, type SeatInput } from "@mochi/core";
import { runConsensus } from "../src/engine.ts";
import { answer, def, vnum } from "./helpers.ts";

const field: FieldSpec = { name: "exact_num", kind: "num", required: true, tolerance: { kind: "exact" }, description: "" };
const d: SchemaDef = { id: SchemaId.EARNINGS, name: "EARNINGS", version: 1, fields: [field], params: [], derived: [] };
const sizes = fc.constantFrom(3, 5, 7, 9);
const value = fc.integer({ min: -3, max: 3 });
const makeInputs = (values: number[], timeouts: Set<number> = new Set()): SeatInput[] => values.map((v, seat) => timeouts.has(seat)
  ? { seat, juror: "0x0000000000000000000000000000000000000000", jurorClass: 0, timedOut: true }
  : { seat, juror: "0x0000000000000000000000000000000000000000", jurorClass: 0, timedOut: false, answer: answer({ exact_num: vnum(BigInt(v)) }) });

describe("consensus properties", () => {
  test("seat-order invariance", () => {
    fc.assert(fc.property(sizes.chain((n) => fc.tuple(fc.array(value, { minLength: n, maxLength: n }), fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }))), ([values, order]) => {
      const base = runConsensus(d, makeInputs(values));
      const inputs = makeInputs(values);
      const shuffled = runConsensus(d, order.map((index) => inputs[index]!));
      expect(shuffled).toEqual(base);
    }), { numRuns: 500 });
  });

  test("relabeling seats permutes masks and seat lists only", () => {
    fc.assert(fc.property(sizes.chain((n) => fc.tuple(fc.array(value, { minLength: n, maxLength: n }), fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }))), ([values, permutation]) => {
      const original = runConsensus(d, makeInputs(values));
      const relabeledSeats = makeInputs(values).map((seat) => ({ ...seat, seat: permutation[seat.seat]! } as SeatInput));
      const changed = runConsensus(d, relabeledSeats);
      const remapMask = (mask: number) => permutation.reduce((out, newSeat, oldSeat) => ((mask & (1 << oldSeat)) !== 0 ? out | (1 << newSeat) : out), 0);
      expect(changed.status).toBe(original.status);
      expect(changed.n).toBe(original.n);
      expect(changed.k).toBe(original.k);
      expect(changed.agreementBps).toBe(original.agreementBps);
      expect(changed.dissentMask).toBe(remapMask(original.dissentMask));
      expect(changed.timeoutMask).toBe(remapMask(original.timeoutMask));
      expect(changed.agreed).toEqual(original.agreed);
      expect(changed.hungFields).toEqual(original.hungFields);
      expect(changed.fields[0]!.value).toEqual(original.fields[0]!.value);
      expect(changed.fields[0]!.agreeCount).toBe(original.fields[0]!.agreeCount);
      expect(changed.fields[0]!.supportingSeats).toEqual(original.fields[0]!.supportingSeats.map((s) => permutation[s]!).sort((a, b) => a - b));
      const expectedDissent: Record<number, NormalizedValue | null | "INVALID" | "TIMEOUT"> = {};
      for (const [seat, dissent] of Object.entries(original.fields[0]!.dissent)) expectedDissent[permutation[Number(seat)]!] = dissent;
      expect(changed.fields[0]!.dissent).toEqual(expectedDissent);
    }), { numRuns: 500 });
  });

  test("unanimity gives a verdict and 10000 bps", () => {
    fc.assert(fc.property(sizes, value, (n, v) => {
      const result = runConsensus(d, makeInputs(Array.from({ length: n }, () => v)));
      expect(result.status).toBe(VerdictStatus.VERDICT);
      expect(result.agreementBps).toBe(10000);
    }), { numRuns: 500 });
  });

  test("verdict threshold, on-chain agreement check, timeout and dissent invariants", () => {
    fc.assert(fc.property(sizes.chain((n) => fc.tuple(fc.array(value, { minLength: n, maxLength: n }), fc.integer({ min: 0, max: n - Math.floor((n * 3 + 3) / 4) }).chain((count) => fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: count, maxLength: count })))), ([values, timeoutSeats]) => {
      const result = runConsensus(d, makeInputs(values, new Set(timeoutSeats)));
      const fieldResult = result.fields[0]!;
      expect((result.status === VerdictStatus.VERDICT)).toBe(fieldResult.agreeCount >= result.k);
      expect((result.agreementBps * result.n >= result.k * 10000 - (result.n - 1))).toBe(result.status === VerdictStatus.VERDICT);
      if (result.status === VerdictStatus.VERDICT) expect(result.dissentMask & result.timeoutMask).toBe(result.timeoutMask);
      expect(popcount(result.timeoutMask)).toBeLessThanOrEqual(result.n - result.k);
    }), { numRuns: 500 });
  });

  test("expansion by anchor answers never lowers anchor support", () => {
    const nextSize: Record<number, number> = { 3: 5, 5: 7, 7: 9 };
    fc.assert(fc.property(fc.constantFrom(3, 5, 7), fc.array(value, { minLength: 9, maxLength: 9 }), (n, values) => {
      const original = runConsensus(d, makeInputs(values.slice(0, n)));
      const anchorSeat = original.fields[0]!.supportingSeats[0];
      if (anchorSeat === undefined) return;
      const anchorValue = values[anchorSeat]!;
      const expandedValues = [...values.slice(0, n), ...Array.from({ length: nextSize[n]! - n }, () => anchorValue)];
      const expanded = runConsensus(d, makeInputs(expandedValues));
      expect(expanded.fields[0]!.agreeCount).toBeGreaterThanOrEqual(original.fields[0]!.agreeCount);
    }), { numRuns: 500 });
  });
});

function popcount(x: number): number { let c = 0; for (let v = x >>> 0; v !== 0; v &= v - 1) c++; return c; }
