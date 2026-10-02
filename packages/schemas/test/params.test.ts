import { expect, it } from "bun:test";
import { SchemaId, ZERO32, hashCanonical, type SchemaDef } from "@mochi/core";
import { getSchema } from "../src/defs.ts";
import { normalizeParams, paramsHash } from "../src/params.ts";

const def = (names: string[]): SchemaDef => ({
  ...getSchema(SchemaId.FREEFORM_FACT),
  params: names.map((name) => ({ name, kind: "str" as const, required: true, description: name })),
});

it("reads only the caller's own properties", () => {
  const inherited = Object.create({ question: "inherited?" }) as Record<string, unknown>;
  expect(normalizeParams(def(["question"]), inherited)).toEqual({ ok: false, errors: ["question is required"] });
  expect(normalizeParams(def(["toString"]), {})).toEqual({ ok: false, errors: ["toString is required"] });
});

it("keeps every declared parameter as an own key, whatever its name", () => {
  const result = normalizeParams(def(["__proto__", "constructor"]), JSON.parse('{"__proto__":"a","constructor":"b"}'));
  if (!result.ok) throw new Error(result.errors.join("; "));
  expect(Object.keys(result.params).sort()).toEqual(["__proto__", "constructor"]);
  expect(Object.getPrototypeOf(result.params)).toBe(Object.prototype);
  expect(paramsHash(result.params)).not.toBe(ZERO32);
  expect(paramsHash(result.params)).toBe(hashCanonical(result.params));
});

it("still rejects unknown parameters", () => {
  expect(normalizeParams(def(["question"]), JSON.parse('{"question":"q","__proto__":"x"}'))).toEqual({
    ok: false,
    errors: ["unknown parameter: __proto__"],
  });
});
