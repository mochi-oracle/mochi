import { expect, test } from "bun:test";
import { CVM_ENV_NAMES, renderCvmEnv } from "./phala-cvm-env.ts";

// Placeholder values only; the visitor secret just has to meet the 24-character minimum.
const visitor = "v".repeat(24);
const base = `MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN=a\nPHALA_API_KEY=k\nMOCHI_CLAIMS_ACCESS_TOKEN=t\nMOCHI_PRODUCTION_POSTGRES_PASSWORD=p\nMOCHI_VISITOR_KEY_SECRET=${visitor}\n`;
const names = (text: string) => text.trim().split("\n").map((line) => line.slice(0, line.indexOf("=")));

test("standby and production files list the same names in the same order", () => {
  const standby = renderCvmEnv(base);
  const production = renderCvmEnv(base, { format: "mochi-production-runtime-v1", mode: "prepare", nested: { a: [1, 2] } });
  expect(names(standby)).toEqual([...CVM_ENV_NAMES]);
  expect(names(production)).toEqual([...CVM_ENV_NAMES]);
  expect(standby.endsWith("MOCHI_PRODUCTION_CONFIG_JSON=\n")).toBe(true);
  expect(production).toContain('MOCHI_PRODUCTION_CONFIG_JSON={"format":"mochi-production-runtime-v1","mode":"prepare","nested":{"a":[1,2]}}');
});

test("unknown, duplicate or missing base names are refused because they would change the measurement", () => {
  expect(() => renderCvmEnv(base + "EXTRA=1\n")).toThrow("unexpected env names");
  expect(() => renderCvmEnv(base + "PHALA_API_KEY=again\n")).toThrow("duplicate");
  expect(() => renderCvmEnv("PHALA_API_KEY=k\n")).toThrow("must set");
  expect(() => renderCvmEnv(base + "MOCHI_PRODUCTION_CONFIG_JSON={}\n")).toThrow("unexpected env names");
  expect(() => renderCvmEnv(base.replace(visitor, "v".repeat(23)))).toThrow("at least 24");
});
