import { expect, it } from "bun:test";
import { keccak256, type Hex } from "viem";
import { SchemaId, type NormalizedValue } from "@mochi/core";
import { getSchema } from "../src/defs.ts";
import { buildPayload, decodePayload } from "../src/payload.ts";

/** Builds a normalized date fixture. */
function date(value: string): NormalizedValue {
  return { t: "date", v: value };
}

/** Builds a normalized numeric fixture. */
function number(e8: bigint): NormalizedValue {
  return { t: "num", e8 };
}

/** Builds a normalized string fixture. */
function string(value: string): NormalizedValue {
  return { t: "str", v: value };
}

/** Builds a normalized integer fixture. */
function integer(value: bigint): NormalizedValue {
  return { t: "int", v: value };
}

/** Builds a normalized boolean fixture. */
function boolean(value: boolean): NormalizedValue {
  return { t: "bool", v: value };
}

/** Builds a normalized enum fixture. */
function enumeration(value: string): NormalizedValue {
  return { t: "enum", v: value };
}

const context = { openedAt: 1700000000n };
const fixtures: Record<
  number,
  { agreed: Record<string, NormalizedValue | null>; params: Record<string, NormalizedValue | null> }
> = {
  1: {
    agreed: {
      ticker: string("NVDA"),
      ex_date: date("2026-01-02"),
      record_date: null,
      pay_date: null,
      amount_per_share: number(211000000n),
      currency: string("USD"),
      dividend_type: enumeration("CASH"),
      issuer: null,
    },
    params: { multiplier_token: boolean(true) },
  },
  2: {
    agreed: {
      ticker: string("NVDA"),
      ratio_num: integer(2n),
      ratio_den: integer(1n),
      effective_date: date("2026-01-02"),
    },
    params: {},
  },
  3: {
    agreed: {
      ticker: string("NVDA"),
      period: string("2026Q3"),
      eps_gaap_diluted: number(100000000n),
      eps_non_gaap_diluted: null,
      revenue: number(500n),
      currency: string("USD"),
      release_ts: null,
    },
    params: {
      consensus_eps: number(90000000n),
      consensus_revenue: number(500n),
      consensus_eps_basis: null,
    },
  },
  4: {
    agreed: {
      issuer: string("issuer inc"),
      asset_symbol: string("USDC"),
      as_of: date("2026-01-02"),
      reported_supply: number(100n),
      reported_reserves: number(100n),
      custodian: null,
      auditor: null,
      attestation_type: null,
      signature_present: boolean(true),
    },
    params: {},
  },
  5: {
    agreed: {
      fund_id: string("FUND1"),
      as_of: date("2026-01-02"),
      nav_per_share: number(100n),
      total_assets: null,
      total_liabilities: null,
      shares_outstanding: null,
    },
    params: {},
  },
  6: {
    agreed: {
      payee_id: string("payee"),
      payer_id: string("payer"),
      amount: number(100n),
      currency: string("USD"),
      due_date: date("2026-01-02"),
      invoice_number: string("INV1"),
    },
    params: {},
  },
  7: {
    agreed: { answer: boolean(true) },
    params: { question: string("Is it true?"), answer_type: enumeration("BOOL") },
  },
};

it("builds and decodes every schema payload", () => {
  for (let id = 1; id <= 7; id++) {
    const fixture = fixtures[id]!;
    const result = buildPayload(getSchema(id as SchemaId), fixture.agreed, fixture.params, context);
    expect(result.payloadHash).toBe(keccak256(result.payload));
    const decoded = decodePayload(id as SchemaId, result.payload);
    expect(decoded.subjectKey).toBe(result.subjectKey);
    expect(decoded.asOf).toBe(result.asOf);
    expect(decoded.body).toBeDefined();
  }
});

it("uses the absent integer sentinel, openedAt fallback, and derived beat values", () => {
  const nav = buildPayload(getSchema(SchemaId.NAV), fixtures[5]!.agreed, {}, context);
  const decodedNav = decodePayload(SchemaId.NAV, nav.payload);
  expect(decodedNav.body.totalAssetsE8).toBe(-(2n ** 255n));

  const earningsFixture = fixtures[3]!;
  const earnings = buildPayload(
    getSchema(SchemaId.EARNINGS),
    earningsFixture.agreed,
    earningsFixture.params,
    context,
  );
  expect(earnings.asOf).toBe(context.openedAt);
  expect(earnings.derived).toEqual({ beat_eps: 1, beat_revenue: 0 });

  const noConsensus = buildPayload(getSchema(SchemaId.EARNINGS), earningsFixture.agreed, {}, context);
  expect(noConsensus.derived).toEqual({ beat_eps: 2, beat_revenue: 2 });
});

it("matches the hand-assembled SPLIT payload vector", () => {
  const result = buildPayload(getSchema(SchemaId.SPLIT), fixtures[2]!.agreed, {}, context);
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  const tickerWord = "4e564441" + "0".repeat(56);
  const effectiveDate = BigInt(Date.parse("2026-01-02T00:00:00Z") / 1000);
  const expectedBody = (`0x${[
    tickerWord,
    word(effectiveDate),
    word(2n),
    word(1n),
  ].join("")}`) as Hex;
  const expectedPayload = (`0x${[
    tickerWord,
    word(effectiveDate),
    word(96n),
    word(128n),
    tickerWord,
    word(effectiveDate),
    word(2n),
    word(1n),
  ].join("")}`) as Hex;

  expect(result.body).toBe(expectedBody);
  expect(result.payload).toBe(expectedPayload);
});

it("throws when required agreed data is missing", () => {
  expect(() => buildPayload(getSchema(SchemaId.SPLIT), {}, {}, context)).toThrow();
});
