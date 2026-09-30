import { expect, test } from "bun:test";
import { productionTimelockDelay, validateTimelockDelay } from "./chain-policy.ts";

test("all chains default to 60 seconds and accept only whole seconds from 0 to 3600", () => {
  for (const chainId of [4663, 46630, 31337]) {
    expect(productionTimelockDelay({ chainId })).toBe(60);
    for (const timelockDelay of [0, 60, 120, 3600]) expect(productionTimelockDelay({ chainId, timelockDelay })).toBe(timelockDelay);
    for (const timelockDelay of [3601, 86400, -1, 0.5, "", "-1", "1e2", null, true]) {
      expect(() => validateTimelockDelay(timelockDelay)).toThrow("0 to 3600");
    }
  }
});

test("deployment CLI rejects 3601 before RPC or key access on every deployment mode", async () => {
  for (const flags of [[], ["--mainnet"], ["--mainnet", "--rehearsal"]]) {
    const child = Bun.spawn(["bun", "scripts/deploy-local.ts", ...flags, "--timelock-delay", "3601", "--rpc", "http://127.0.0.1:1"],
      { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("0 to 3600");
  }
});
