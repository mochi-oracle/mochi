import { JurorClass, SchemaId, type FieldSpec, type NormalizedValue, type SchemaDef, type SeatInput, type SpanRef } from "@mochi/core";

export const fields: readonly FieldSpec[] = [
  { name: "exact_num", kind: "num", required: true, tolerance: { kind: "exact" }, description: "" },
  { name: "relative_num", kind: "num", required: true, tolerance: { kind: "rel", bps: 10 }, description: "" },
  { name: "text", kind: "str", required: true, tolerance: { kind: "exact" }, description: "" },
  { name: "as_of", kind: "date", required: false, tolerance: { kind: "exact" }, description: "" },
  { name: "active", kind: "bool", required: false, tolerance: { kind: "exact" }, description: "" },
];
export const def: SchemaDef = { id: SchemaId.EARNINGS, name: "EARNINGS", version: 1, fields, params: [], derived: [] };
export const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
export const hexByte = (n: number) => `0x${n.toString(16).padStart(2, "0")}${"00".repeat(31)}` as const;
export const vnum = (e8: bigint): NormalizedValue => ({ t: "num", e8 });
export const vstr = (v: string): NormalizedValue => ({ t: "str", v });
export const vdate = (v: string): NormalizedValue => ({ t: "date", v });
export const vbool = (v: boolean): NormalizedValue => ({ t: "bool", v });

export function answer(overrides: Record<string, NormalizedValue | null> = {}, options: { invalid?: string[]; noSpan?: string[]; schemaVersion?: number } = {}) {
  const defaults: Record<string, NormalizedValue | null> = {
    exact_num: vnum(100n), relative_num: vnum(200n), text: vstr("same"), as_of: vdate("2026-01-01"), active: vbool(true),
  };
  Object.assign(defaults, overrides);
  const noSpan = new Set(options.noSpan ?? []);
  const spans: SpanRef[] = fields.filter((f) => defaults[f.name] !== null && !noSpan.has(f.name)).map((f, i) => ({ field: f.name, start: i, end: i + 1, hash: hexByte(i + 1) }));
  return { schemaId: def.id, schemaVersion: options.schemaVersion ?? def.version, fields: defaults, invalid: options.invalid ?? [], spans, confidence: {} };
}

export function seats(values: Array<Record<string, NormalizedValue | null> | "timeout">, opts: { jurorClass?: JurorClass } = {}): SeatInput[] {
  return values.map((value, seat) => value === "timeout"
    ? { seat, juror: zeroAddress, jurorClass: opts.jurorClass ?? JurorClass.LARGE_A, timedOut: true }
    : { seat, juror: zeroAddress, jurorClass: opts.jurorClass ?? JurorClass.LARGE_A, timedOut: false, answer: answer(value) });
}
