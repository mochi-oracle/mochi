import { keccak256, toHex, type Hex } from "viem";
import { ZERO32, hashCanonical, canonicalJson, type SchemaDef } from "@mochi/core";
import { extractionPrompt, PROMPT_TEMPLATE_VERSION } from "./extraction.ts";

/** Hashes the canonical schema definition. */
export const schemaJsonHash = (definition: SchemaDef) => hashCanonical(definition);

/** Hashes the field tolerance table in schema field order. */
export const tolerancesHash = (definition: SchemaDef) =>
  hashCanonical(Object.fromEntries(definition.fields.map((field) => [field.name, field.tolerance])));

/** Hashes the prompt generated with stable placeholder parameter values. */
export function promptHash(definition: SchemaDef): Hex {
  const placeholderParams = Object.fromEntries(
    definition.params.map((parameter) => [
      parameter.name,
      parameter.kind === "enum"
        ? parameter.enumValues?.[0] ?? ""
        : parameter.kind === "bool"
          ? false
          : parameter.kind === "num"
            ? "0"
            : "placeholder",
    ]),
  );
  return keccak256(
    toHex(
      canonicalJson({
        prompt: extractionPrompt(definition, placeholderParams),
        version: PROMPT_TEMPLATE_VERSION,
      }),
    ),
  );
}

/** Returns the shared StockTokenCrosscheck hook hash for dividend and split schemas. */
export const crosscheckHash = (definition: SchemaDef) =>
  definition.id === 1 || definition.id === 2
    ? hashCanonical({ hooks: ["StockTokenCrosscheck"] })
    : ZERO32;

/** Builds the five arguments passed to SchemaRegistry.propose. */
export function registryArgs(definition: SchemaDef) {
  return [
    definition.id,
    schemaJsonHash(definition),
    promptHash(definition),
    tolerancesHash(definition),
    crosscheckHash(definition),
  ] as const;
}
