import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

test("juror requires an explicit QUOTE_VERIFIER: no configuration defaults to mock quote verification", () => {
  for (const QUOTE_VERIFIER of [undefined, "", "MOCK", "nras"]) {
    expect(() => loadConfig({ QUOTE_VERIFIER })).toThrow("QUOTE_VERIFIER must be set explicitly");
  }
  expect(loadConfig({ QUOTE_VERIFIER: "dcap" }).QUOTE_VERIFIER).toBe("dcap");
  expect(loadConfig({ QUOTE_VERIFIER: "mock" }).QUOTE_VERIFIER).toBe("mock");
});

test("a phala-aci juror requires an attested os: or compose: pin for the ACI gateway", () => {
  const aci = { QUOTE_VERIFIER: "dcap", RUNNER: "phala-aci", MODEL_PROVIDER: "phala-aci", PHALA_AI_API_KEY: "test-key", PHALA_ACI_MODEL: "vendor/model" };
  for (const PHALA_ACI_ALLOWED_WORKLOADS of [undefined, "", "workload-id", "model:vendor/model", "workload:abc,model:vendor/model", "os:not-hex"]) {
    expect(() => loadConfig({ ...aci, PHALA_ACI_ALLOWED_WORKLOADS })).toThrow("must include an attested os: or compose: pin");
  }
  expect(loadConfig({ ...aci, PHALA_ACI_ALLOWED_WORKLOADS: `os:${"ab".repeat(32)}` }).MODEL_PROVIDER).toBe("phala-aci");
  expect(loadConfig({ ...aci, PHALA_ACI_ALLOWED_WORKLOADS: `compose:${"cd".repeat(32)},model:vendor/model` }).MODEL_PROVIDER).toBe("phala-aci");
});
