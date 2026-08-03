import { expect, it } from "bun:test";
import { SchemaId } from "@mochi/core";
import { getSchema } from "../src/defs.ts";
import { extractionPrompt } from "../src/extraction.ts";
import { locateSpan, normalizeAnswer } from "../src/normalize.ts";
import { keccak256, toHex } from "viem";

it("fills all fields, reports invalid values, locates spans, and clamps confidence", () => {
  const definition = getSchema(SchemaId.SPLIT);
  const answer = normalizeAnswer(
    definition,
    {
      fields: {
        ticker: "NASDAQ:NVDA",
        ratio_num: "two",
        ratio_den: 1,
        effective_date: "2026-01-02",
        unknown: "ignored",
      },
      evidence: {
        ticker: "NASDAQ:NVDA",
        ratio_den: "ratio is 1",
        effective_date: "Jan 2, 2026",
      },
      confidence: { ticker: 2, ratio_num: -1 },
    },
    "NASDAQ:NVDA split ratio is 1 effective Jan 2, 2026",
  );

  expect(Object.keys(answer.fields)).toEqual(definition.fields.map((field) => field.name));
  expect(answer.invalid).toEqual(["ratio_num"]);
  expect(answer.fields.ratio_num).toBeNull();
  expect(answer.spans.map((span) => span.field)).toEqual(["ticker", "ratio_den", "effective_date"]);
  expect(answer.spans[0]).toEqual({
    field: "ticker",
    start: 0,
    end: 11,
    hash: keccak256(toHex("NASDAQ:NVDA")),
  });
  expect(answer.confidence).toEqual({ ticker: 1, ratio_num: 0, ratio_den: 0, effective_date: 0 });
});

it("locates whitespace-insensitive and case-insensitive quotations", () => {
  expect(locateSpan("First\n  SECOND thing", "First SECOND")).toEqual({ start: 0, end: 14 });
  expect(locateSpan("The Issuer Name", "issuer   name")).toEqual({ start: 4, end: 15 });
  expect(locateSpan("abc", "x")).toBeNull();
});

it("describes the extraction output object in the system prompt", () => {
  const prompt = extractionPrompt(getSchema(SchemaId.SPLIT)).system;
  expect(prompt).toContain("fields");
  expect(prompt).toContain("evidence");
  expect(prompt).toContain("confidence");
});
