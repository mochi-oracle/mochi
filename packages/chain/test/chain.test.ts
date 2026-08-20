import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createChain, loadDeployment, ROLE_IDS } from "../src/index.ts";

const path = new URL("../../../deployments/local.json", import.meta.url).pathname;
const live = existsSync(path) && process.env.MOCHI_LIVE_CHAIN === "1"; // opt-in: needs anvil + a matching deployment

describe.skipIf(!live)("chain (requires anvil + deployments/local.json)", () => {
  test("reads schemas, quote and roles", async () => {
    const chain = createChain(loadDeployment(path));
    for (const id of [1, 2, 3, 4, 5, 6, 7]) expect(await chain.schemaLatest(id)).toBe(1);
    const q = await chain.quote(3, 7, 30);
    expect(q.jurorFees).toBeGreaterThan(0n);
    expect(q.protocolFee).toBeGreaterThanOrEqual(10_000n);
    expect(ROLE_IDS.FEED_RUNNER).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

test("loadDeployment prefers inline MOCHI_DEPLOYMENT_JSON over the file path", async () => {
  const { loadDeployment } = await import("../src/index.ts");
  const inline = { chainId: 4663, rpcUrl: "https://rpc.mainnet.chain.robinhood.com", startBlock: "1", contracts: { queryEscrow: "0x0000000000000000000000000000000000000001" } };
  const prev = process.env.MOCHI_DEPLOYMENT_JSON;
  process.env.MOCHI_DEPLOYMENT_JSON = JSON.stringify(inline);
  try {
    expect(loadDeployment("/nonexistent.json").chainId).toBe(4663);
    process.env.MOCHI_DEPLOYMENT_JSON = JSON.stringify({ chainId: 1, contracts: {} });
    expect(() => loadDeployment("/nonexistent.json")).toThrow("MOCHI_DEPLOYMENT_JSON");
  } finally {
    if (prev === undefined) delete process.env.MOCHI_DEPLOYMENT_JSON; else process.env.MOCHI_DEPLOYMENT_JSON = prev;
  }
});
