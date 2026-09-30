import { expect, test } from "bun:test";
import { startAttestationChecks } from "../src/scheduler.ts";

test("attestor checks at startup, retries startup failures in 15 seconds, and resumes 600-second refresh without overlap", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let calls = 0;
  let finish: (passing: boolean) => void = () => {};
  startAttestationChecks(() => { calls++; return new Promise<boolean>((resolve) => { finish = resolve; }); }, 600_000,
    (callback, delay) => { scheduled.push({ callback, delay }); });
  expect(calls).toBe(1);
  expect(scheduled).toHaveLength(0); // No timer can start another check while this one runs.
  finish(false);
  await Promise.resolve();
  expect(scheduled[0]!.delay).toBe(15_000);
  scheduled.shift()!.callback();
  expect(calls).toBe(2);
  finish(true);
  await Promise.resolve();
  expect(scheduled[0]!.delay).toBe(600_000);
});
