import { expect, test } from "bun:test";
import { retryDelayMs, startAttestationChecks } from "../src/scheduler.ts";

test("attestor checks at startup, backs off failed checks exponentially, and resumes 600-second refresh without overlap", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let calls = 0;
  let finish: (passing: boolean) => void = () => {};
  startAttestationChecks(() => { calls++; return new Promise<boolean>((resolve) => { finish = resolve; }); }, 600_000,
    (callback, delay) => { scheduled.push({ callback, delay }); }, () => 0.999_999);
  expect(calls).toBe(1);
  expect(scheduled).toHaveLength(0); // No timer can start another check while this one runs.
  const delays: number[] = [];
  for (let failure = 0; failure < 7; failure++) {
    finish(false);
    await Promise.resolve();
    const next = scheduled.shift()!;
    delays.push(next.delay);
    next.callback();
  }
  expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
  finish(true);
  await Promise.resolve();
  expect(scheduled.shift()!.delay).toBe(600_000);
  scheduled.length = 0;
  startAttestationChecks(async () => false, 600_000, (callback, delay) => { scheduled.push({ callback, delay }); }, () => 0);
  await Promise.resolve(); await Promise.resolve();
  // The first retry is the 15 s base step, jittered down to half at minimum.
  expect(scheduled[0]!.delay).toBe(7_500);
});

test("retry delays are jittered between half and all of the exponential step", () => {
  for (const failures of [1, 2, 3, 6, 50]) {
    const ceiling = Math.min(600_000, 15_000 * 2 ** (failures - 1));
    expect(retryDelayMs(failures, 600_000, () => 0)).toBe(ceiling / 2);
    expect(retryDelayMs(failures, 600_000, () => 0.5)).toBe(Math.round(ceiling * 0.75));
    expect(retryDelayMs(failures, 600_000, () => 0.999_999)).toBeLessThanOrEqual(ceiling);
  }
});
