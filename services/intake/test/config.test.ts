import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

test("intake requires an explicit QUOTE_VERIFIER: no configuration defaults to mock quote verification", () => {
  for (const QUOTE_VERIFIER of [undefined, "", "MOCK", "nras"]) {
    expect(() => loadConfig({ QUOTE_VERIFIER })).toThrow("QUOTE_VERIFIER must be set explicitly");
  }
  expect(() => loadConfig({ QUOTE_VERIFIER: "dcap" })).not.toThrow();
  expect(() => loadConfig({ QUOTE_VERIFIER: "mock" })).not.toThrow();
});
