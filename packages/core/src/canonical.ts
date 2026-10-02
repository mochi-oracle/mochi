// Canonical JSON: sorted object keys at every depth, no whitespace.
// For plain JSON values this is byte-identical to the sorted-key JSON of Anonyma's v1 receipt format,
// so receipts verify with Anonyma's verifier.
// Extensions (Mochi-only values): bigint → decimal string; NormalizedValue objects are plain objects.
// Rejected: undefined inside arrays, NaN/Infinity, functions, symbols, non-plain objects (Date, Map, ...).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function toCanonical(value: unknown, path = "$"): Json {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonical: non-finite number at ${path}`);
      return value;
    case "bigint":
      return value.toString(10);
    case "object": {
      if (Array.isArray(value)) {
        return value.map((v, i) => {
          if (v === undefined) throw new TypeError(`canonical: undefined in array at ${path}[${i}]`);
          return toCanonical(v, `${path}[${i}]`);
        });
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonical: non-plain object at ${path}`);
      }
      const entries: [string, Json][] = [];
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue; // matches JSON.stringify dropping undefined properties
        entries.push([key, toCanonical(v, `${path}.${key}`)]);
      }
      // fromEntries defines own properties. Assigning out[key] would treat a "__proto__" key (JSON.parse makes it an
      // own property) as a prototype write and drop it, so two different documents would hash the same.
      return Object.fromEntries(entries);
    }
    default:
      throw new TypeError(`canonical: unsupported ${typeof value} at ${path}`);
  }
}

/** Sorted-key JSON string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
