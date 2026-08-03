import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { FieldSpec, NormalizedValue } from "@mochi/core";
import { normalizeValue } from "../src/normalize.ts";

interface NormalizationCase {
  spec: FieldSpec;
  raw: unknown;
  expected: NormalizedValue | null;
}

/** Creates a basic field spec for direct normalization tests. */
function spec(kind: FieldSpec["kind"], extra: Partial<FieldSpec> = {}): FieldSpec {
  return {
    name: "value",
    kind,
    required: false,
    tolerance: { kind: "exact" },
    description: "Test value.",
    ...extra,
  };
}

/** Wraps a fixed point test result in the normalized value representation. */
function numberValue(e8: bigint): NormalizedValue {
  return { t: "num", e8 };
}

/** Wraps a canonical date test result in the normalized value representation. */
function dateValue(value: string): NormalizedValue {
  return { t: "date", v: value };
}

/** Wraps a canonical string test result in the normalized value representation. */
function stringValue(value: string): NormalizedValue {
  return { t: "str", v: value };
}

const numberCases: Array<[unknown, bigint]> = [
  ["$2.11", 211000000n],
  ["(0.05)", -5000000n],
  ["35.08 billion", 3508000000000000000n],
  ["$35,082 million", 3508200000000000000n],
  ["1.5e-3", 150000n],
  ["0.123456785", 12345679n],
  ["1e21", 10n ** 29n],
  ["-1.25", -125000000n],
  ["−2.5", -250000000n],
  ["1,234.5", 123450000000n],
  ["1_000", 100000000000n],
  ["2 thousand", 200000000000n],
  ["3k", 300000000000n],
  ["4m", 400000000000000n],
  ["5mm", 500000000000000n],
  ["6mn", 600000000000000n],
  ["7 million", 700000000000000n],
  ["8bn", 800000000000000000n],
  ["9b", 900000000000000000n],
  ["10 billion", 1000000000000000000n],
  ["11tn", 1100000000000000000000n],
  ["12t", 1200000000000000000000n],
  ["13 trillion", 1300000000000000000000n],
  ["1.234567894", 123456789n],
  ["0.000000005", 1n],
  ["0.000000004", 0n],
  ["USD 12.34", 1234000000n],
  ["€3", 300000000n],
  ["25", 2500000000n],
  [".5", 50000000n],
  ["5.", 500000000n],
  ["(1,000)", -100000000000n],
  ["1.2 million", 120000000000000n],
  ["1e-7", 10n],
  ["1.5e21", 150000000000000000000000000000n],
  ["-$0.12", -12000000n],
  ["($0.12)", -12000000n],
  ["$(0.12)", -12000000n],
  ["(USD 1.5) million", -150000000000000n],
  ["USD -3.2", -320000000n],
  ["0.12 USD", 12000000n],
  ["1 EUR", 100000000n],
  ["1 CAD", 100000000n],
  ["1 AUD", 100000000n],
  ["1 234.5", 123450000000n],
  ["1 234.5", 123450000000n],
  ["14", 1400000000n],
  ["15", 1500000000n],
  ["16", 1600000000n],
  ["17", 1700000000n],
  ["18", 1800000000n],
  ["19", 1900000000n],
  ["20", 2000000000n],
  ["21", 2100000000n],
  ["22", 2200000000n],
  ["23", 2300000000n],
  ["24", 2400000000n],
  ["25.25", 2525000000n],
  ["26", 2600000000n],
  ["27", 2700000000n],
  ["28", 2800000000n],
  ["29", 2900000000n],
  ["30", 3000000000n],
  ["31", 3100000000n],
  ["32", 3200000000n],
  ["33", 3300000000n],
  ["34", 3400000000n],
  ["35", 3500000000n],
  ["36", 3600000000n],
  ["37", 3700000000n],
];

const dateCases: Array<[string, string]> = [
  ["2028-02-29", "2028-02-29"],
  ["2027-02-28", "2027-02-28"],
  ["2028/2/9", "2028-02-09"],
  ["02/29/2028", "2028-02-29"],
  ["February 29, 2028", "2028-02-29"],
  ["Feb 9, 2026", "2026-02-09"],
  ["9 February 2026", "2026-02-09"],
  ["9 Feb 2026", "2026-02-09"],
  ["2026-02-09T23:00:00Z", "2026-02-09"],
  ["2026-02-09T00:00:00-05:00", "2026-02-09"],
  ["Sept. 30, 2026", "2026-09-30"],
  ["Sep. 30, 2026", "2026-09-30"],
  ["Jan. 5 2027", "2027-01-05"],
  ["30 Sept. 2026", "2026-09-30"],
  ["September 30th, 2026", "2026-09-30"],
  ["1st October 2026", "2026-10-01"],
  ["March 2nd 2027", "2027-03-02"],
  ["23rd September 2026", "2026-09-23"],
  ["Tuesday, September 30, 2026", "2026-09-30"],
];

const periodCases: Array<[string, string]> = [
  ["Q3 2026", "2026Q3"],
  ["3Q26", "2026Q3"],
  ["Q3 FY2026", "2026Q3"],
  ["third quarter of fiscal 2026", "2026Q3"],
  ["fiscal Q3 2026", "2026Q3"],
  ["FY2026", "FY2026"],
  ["fiscal year 2026", "FY2026"],
  ["full year 2026", "FY2026"],
  ["H1 2026", "2026H1"],
  ["first half 2026", "2026H1"],
  ["second half 26", "2026H2"],
  ["Q3 fiscal 2026", "2026Q3"],
  ["Q3 fiscal year 2026", "2026Q3"],
  ["fourth quarter 2026", "2026Q4"],
  ["fourth quarter fiscal 2026", "2026Q4"],
  ["fourth quarter of fiscal year 2026", "2026Q4"],
  ["FY2026 Q3", "2026Q3"],
  ["FY26 Q3", "2026Q3"],
  ["FY 2026 Q3", "2026Q3"],
  ["3Q FY2026", "2026Q3"],
  ["fiscal 2026", "FY2026"],
];

const nameCases: Array<[string, string]> = [
  ["Deloitte & Touche LLP", "deloitte and touche"],
  ["Bank N.A.", "bank"],
  ["Foo S.A.", "foo"],
  ["Acme Co.", "acme"],
  ["J.P. Morgan Chase & Co.", "jp morgan chase and"],
  ["Example, Inc.", "example"],
];

const cases: NormalizationCase[] = [
  ...numberCases.map(([raw, e8]) => ({ spec: spec("num"), raw, expected: numberValue(e8) })),
  ...dateCases.map(([raw, value]) => ({ spec: spec("date"), raw, expected: dateValue(value) })),
  ...periodCases.map(([raw, value]) => ({
    spec: spec("str", { strMode: "period" }),
    raw,
    expected: stringValue(value),
  })),
  ...nameCases.map(([raw, value]) => ({
    spec: spec("str", { strMode: "name" }),
    raw,
    expected: stringValue(value),
  })),
];

describe("normalizeValue", () => {
  it("normalizes the full table of numbers, dates, periods, and names", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    for (const testCase of cases) {
      const result = normalizeValue(testCase.spec, testCase.raw);
      expect(result).toEqual({ ok: true, value: testCase.expected });
    }
  });

  it("rejects malformed values", () => {
    for (const raw of ["12%", "1-2", "one hundred", "1 2", "$4.5 USD EUR"]) {
      expect(normalizeValue(spec("num"), raw).ok).toBe(false);
    }
    expect(normalizeValue(spec("date"), "Feb 29, 2027").ok).toBe(false);
    expect(normalizeValue(spec("str", { strMode: "period" }), "next quarter").ok).toBe(false);
    expect(normalizeValue(spec("ts"), "2026-01-01T12:00:00").ok).toBe(false);
    expect(normalizeValue(spec("int"), "1.2").ok).toBe(false);
  });

  it("normalizes timestamps, integers, currencies, tickers, identifiers, and text", () => {
    expect(normalizeValue(spec("ts"), "2026-01-01T00:00:00-05:00")).toEqual({
      ok: true,
      value: { t: "ts", v: 1767243600 },
    });
    expect(normalizeValue(spec("ts"), "1700000000")).toEqual({
      ok: true,
      value: { t: "ts", v: 1700000000 },
    });
    expect(normalizeValue(spec("int"), "1,234")).toEqual({ ok: true, value: { t: "int", v: 1234n } });

    const currencies: Array<[string, string]> = [
      ["$", "USD"], ["US$", "USD"], ["usd", "USD"], ["dollars", "USD"],
      ["€", "EUR"], ["euro", "EUR"], ["euros", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["yen", "JPY"],
    ];
    for (const [raw, value] of currencies) {
      expect(normalizeValue(spec("str", { strMode: "currency" }), raw)).toEqual({
        ok: true,
        value: stringValue(value),
      });
    }
    expect(normalizeValue(spec("str", { strMode: "ticker" }), "NASDAQ: nvda")).toEqual({
      ok: true,
      value: stringValue("NVDA"),
    });
    expect(normalizeValue(spec("str", { strMode: "id" }), " ab-12 ")).toEqual({
      ok: true,
      value: stringValue("AB-12"),
    });
    expect(normalizeValue(spec("str", { strMode: "text" }), " Hi  there ")).toEqual({
      ok: true,
      value: stringValue("Hi there"),
    });
  });

  it("normalizes enums, booleans, and null-like values", () => {
    const enumValues = ["CASH", "SPECIAL", "STOCK", "RETURN_OF_CAPITAL"];
    const enumCases: Array<[string, string]> = [
      ["regular", "CASH"], ["ordinary", "CASH"], ["quarterly", "CASH"],
      ["cash dividend", "CASH"], ["special cash", "SPECIAL"],
      ["special dividend", "SPECIAL"], ["stock dividend", "STOCK"], ["ROC", "RETURN_OF_CAPITAL"],
    ];
    for (const [raw, value] of enumCases) {
      expect(normalizeValue(spec("enum", { enumValues }), raw)).toEqual({
        ok: true,
        value: { t: "enum", v: value },
      });
    }

    const booleanCases: Array<[unknown, boolean]> = [
      [true, true], [false, false], ["yes", true], ["no", false], ["y", true],
      ["n", false], ["true", true], ["false", false], [1, true], [0, false],
    ];
    for (const [raw, value] of booleanCases) {
      expect(normalizeValue(spec("bool"), raw)).toEqual({ ok: true, value: { t: "bool", v: value } });
    }

    const nullLikeValues = [
      null,
      undefined,
      "",
      " n/A ",
      "NA",
      "none",
      "null",
      "not stated",
      "not available",
      "not disclosed",
      "-",
      "—",
    ];
    for (const raw of nullLikeValues) {
      expect(normalizeValue(spec("str"), raw)).toEqual({ ok: true, value: null });
    }
  });

  it("keeps string normalization idempotent", () => {
    const examples: Record<NonNullable<FieldSpec["strMode"]>, string> = {
      ticker: "nasdaq:nvda",
      currency: "usd",
      name: "Deloitte & Touche LLP",
      id: "ab 12",
      period: "Q3 2026",
      text: "hello  world",
    };
    for (const mode of Object.keys(examples) as Array<NonNullable<FieldSpec["strMode"]>>) {
      const stringSpec = spec("str", { strMode: mode });
      const first = normalizeValue(stringSpec, examples[mode]);
      expect(first.ok).toBe(true);
      if (first.ok && first.value?.t === "str") {
        expect(normalizeValue(stringSpec, first.value.v)).toEqual(first);
      }
    }
  });

  it("preserves random fixed point values with grouping and currency symbols", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), (e8) => {
        const absolute = e8 < 0n ? -e8 : e8;
        const whole = String(absolute / 100000000n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        const fraction = String(absolute % 100000000n).padStart(8, "0");
        const raw = `$${e8 < 0n ? "-" : ""}${whole}.${fraction}`;
        expect(normalizeValue(spec("num"), raw)).toEqual({ ok: true, value: numberValue(e8) });
      }),
    );
  });
});
