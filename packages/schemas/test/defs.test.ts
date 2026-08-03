import { expect, it } from "bun:test";
import { SchemaId } from "@mochi/core";
import { SCHEMAS, getSchema, resolveSchema } from "../src/defs.ts";
import { crosscheckHash, promptHash, schemaJsonHash, tolerancesHash } from "../src/hashes.ts";

it("defines all version-one fields with descriptions and required sets", () => {
  const requiredFields = [
    "ticker,ex_date,amount_per_share,currency,dividend_type",
    "ticker,ratio_num,ratio_den,effective_date",
    "ticker,period,eps_gaap_diluted,revenue,currency",
    "issuer,asset_symbol,as_of,reported_supply,reported_reserves,signature_present",
    "fund_id,as_of,nav_per_share",
    "payee_id,payer_id,amount,currency,due_date,invoice_number",
    "answer",
  ];

  expect(Object.keys(SCHEMAS)).toHaveLength(7);
  for (let id = 1; id <= 7; id++) {
    const definition = getSchema(id as SchemaId);
    expect(definition.version).toBe(1);
    expect(definition.fields.every((field) => field.description && field.kind && field.tolerance)).toBe(true);
    expect(definition.fields.filter((field) => field.required).map((field) => field.name).join(",")).toBe(
      requiredFields[id - 1]!,
    );
  }
});

it("resolves FREEFORM_FACT answer kinds and validates required parameters", () => {
  expect(resolveSchema(SchemaId.FREEFORM_FACT, { answer_type: "BOOL", question: "q" }).fields[0]?.kind).toBe(
    "bool",
  );
  expect(resolveSchema(SchemaId.FREEFORM_FACT, { answer_type: "NUMBER", question: "q" }).fields[0]?.kind).toBe(
    "num",
  );
  expect(resolveSchema(SchemaId.FREEFORM_FACT, { answer_type: "STRING", question: "q" }).fields[0]?.kind).toBe(
    "str",
  );
  expect(() => resolveSchema(SchemaId.FREEFORM_FACT)).toThrow();
  expect(() => resolveSchema(SchemaId.FREEFORM_FACT, { answer_type: "BOOL" })).toThrow();
});

it("produces stable schema hashes that differ across schemas", () => {
  for (let id = 1; id <= 7; id++) {
    const definition = getSchema(id as SchemaId);
    expect(schemaJsonHash(definition)).toBe(schemaJsonHash(definition));
    expect(tolerancesHash(definition)).toBe(tolerancesHash(definition));
    expect(promptHash(definition)).toBe(promptHash(definition));
  }
  expect(schemaJsonHash(getSchema(SchemaId.SPLIT))).not.toBe(schemaJsonHash(getSchema(SchemaId.NAV)));
  expect(crosscheckHash(getSchema(SchemaId.SPLIT))).not.toBe(crosscheckHash(getSchema(SchemaId.NAV)));
});
