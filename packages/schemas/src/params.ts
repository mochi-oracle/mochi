import { ZERO32, hashCanonical, type NormalizedValue, type SchemaDef } from "@mochi/core";
import { normalizeValue } from "./normalize.ts";

/** Normalizes declared parameters and reports missing required or unknown values. */
export function normalizeParams(
  definition: SchemaDef,
  raw: Record<string, unknown> = {},
):
  | { ok: true; params: Record<string, NormalizedValue | null> }
  | { ok: false; errors: string[] } {
  const allowedNames = new Set(definition.params.map((parameter) => parameter.name));
  const errors: string[] = [];
  for (const name of Object.keys(raw)) {
    if (!allowedNames.has(name)) errors.push(`unknown parameter: ${name}`);
  }

  // Only own properties of the caller's object count (an inherited raw.toString is not a parameter), and the result is
  // built with fromEntries so a parameter name can never be treated as a prototype write.
  const entries: [string, NormalizedValue | null][] = [];
  for (const parameter of definition.params) {
    const normalized = normalizeValue(parameter, Object.hasOwn(raw, parameter.name) ? raw[parameter.name] : undefined);
    if (!normalized.ok) {
      errors.push(`${parameter.name}: ${normalized.error}`);
    } else if (parameter.required && normalized.value === null) {
      errors.push(`${parameter.name} is required`);
    } else {
      entries.push([parameter.name, normalized.value]);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, params: Object.fromEntries(entries) };
}

/** Hashes normalized parameters, using ZERO32 when every parameter is null. */
export function paramsHash(params: Record<string, NormalizedValue | null>) {
  return Object.values(params).every((value) => value === null) ? ZERO32 : hashCanonical(params);
}
