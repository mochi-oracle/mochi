import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { createAttestor } from "../src/attestor.ts";
import { AttestationSchedule, RETRY_CEILING_IN_VALIDITY_MS, RETRY_FLOOR_MS, retryCapMs, retryDelayMs, startAttestationChecks } from "../src/scheduler.ts";
import { readyFixture } from "./fixture.ts";

const INTERVAL = 600_000;
const T0 = 1_700_000_000;

describe("retry bounds", () => {
  test("delays are jittered between half and all of the exponential step, capped", () => {
    for (const failures of [1, 2, 3, 6, 50]) {
      const ceiling = Math.min(INTERVAL, 15_000 * 2 ** (failures - 1));
      expect(retryDelayMs(failures, INTERVAL, () => 0)).toBe(ceiling / 2);
      expect(retryDelayMs(failures, INTERVAL, () => 0.5)).toBe(Math.round(ceiling * 0.75));
      expect(retryDelayMs(failures, INTERVAL, () => 0.999_999)).toBeLessThanOrEqual(ceiling);
    }
    expect(retryDelayMs(10, 40_000, () => 0.999_999)).toBe(40_000);
  });

  test("the cap is a quarter of the remaining validity, between 15 s and 120 s, and the interval once expired", () => {
    expect(retryCapMs(INTERVAL, 1_200_000)).toBe(RETRY_CEILING_IN_VALIDITY_MS);
    expect(retryCapMs(INTERVAL, 400_000)).toBe(100_000);
    expect(retryCapMs(INTERVAL, 30_000)).toBe(RETRY_FLOOR_MS);
    expect(retryCapMs(INTERVAL, 1)).toBe(RETRY_FLOOR_MS);
    expect(retryCapMs(INTERVAL, undefined)).toBe(RETRY_CEILING_IN_VALIDITY_MS);
    expect(retryCapMs(INTERVAL, 0)).toBe(INTERVAL);
    expect(retryCapMs(INTERVAL, -5_000)).toBe(INTERVAL);
    // Never longer than a short configured interval.
    expect(retryCapMs(10_000, 1_200_000)).toBe(10_000);
  });

  test("keys back off independently, and a failed pass counts against the keys that were due", () => {
    const plan = new AttestationSchedule(INTERVAL, () => 0.999_999);
    const now = T0 * 1_000;
    // A permanently failing key, lapsed long ago, has backed off to the full interval.
    for (let i = 0; i < 8; i++) plan.record([{ key: "0xdead", ok: false, attestedUntilSec: 0 }], now);
    expect(plan.isDue("0xdead", now + INTERVAL - 1)).toBe(false);
    // A healthy key's first failure is retried after at most 15 s.
    plan.record([{ key: "0xbeef", ok: true, attestedUntilSec: T0 + 1_200 }], now);
    plan.record([{ key: "0xbeef", ok: false, attestedUntilSec: T0 + 1_200 }], now);
    expect(plan.nextRunAt(now)).toBeLessThanOrEqual(now + 15_000);
    expect(plan.isDue("0xBEEF", now + 15_000)).toBe(true);
    expect(plan.isDue("0xdead", now + 15_000)).toBe(false);
    expect(plan.isDue("0xnew", now)).toBe(true);
    plan.recordPassFailure(now + 15_000);
    expect(plan.isDue("0xbeef", now + 15_000)).toBe(false);
    expect(plan.nextRunAt(now + 15_000)).toBeLessThanOrEqual(now + 15_000 + 30_000);
  });

  test("a pass that throws is retried with backoff, and passes never overlap", async () => {
    const scheduled: number[] = [];
    let calls = 0;
    let finish: (value: never[]) => void = () => {};
    const loop = startAttestationChecks(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, INTERVAL,
      { schedule: (_callback, delay) => { scheduled.push(delay); }, random: () => 0, now: () => T0 * 1_000 });
    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(0); // No timer can start another pass while this one runs.
    finish([]);
    await loop.idle();
    expect(scheduled).toEqual([INTERVAL]); // No keys yet: look for enrollments again after one interval.
    const failing = startAttestationChecks(async () => { throw new Error("rpc down"); }, INTERVAL,
      { schedule: (_callback, delay) => { scheduled.push(delay); }, random: () => 0, now: () => T0 * 1_000 });
    await failing.idle();
    expect(scheduled.at(-1)).toBe(7_500);
  });
});

/** Drives startAttestationChecks and the real attestor on a fake clock. */
async function simulation(options: {
  count: number;
  /** Is the key's endpoint reachable at `t` (seconds since T0)? */
  reachable: (index: number, t: number) => boolean;
  attestedUntil?: (index: number) => bigint;
  random?: () => number;
}) {
  const f = await readyFixture({ count: options.count });
  let nowMs = T0 * 1_000;
  const t = () => nowMs / 1_000 - T0;
  f.deps.clock = { nowSeconds: () => Math.floor(nowMs / 1_000), nowDate: () => new Date(nowMs) };
  for (const [index, key] of f.keys.entries()) {
    const juror = f.fakeJurors.get(key)!;
    f.fakeJurors.set(key, { ...juror, attestedUntil: options.attestedUntil?.(index) ?? 0n });
  }
  const checks = new Map<Address, number[]>();
  const fetchAttestation = f.deps.http.fetchAttestation;
  f.deps.http.fetchAttestation = async (url) => {
    const index = Number(url.split("-").at(-1)?.split(".")[0]) - 1;
    const key = f.keys[index]!;
    checks.set(key, [...checks.get(key) ?? [], t()]);
    if (!options.reachable(index, t())) throw new Error("offline");
    return fetchAttestation(url);
  };
  const lapses: { key: Address; at: number; until: bigint }[] = [];
  const refreshedAt = new Map<Address, number[]>();
  const refresh = f.deps.chain.refreshAttestation;
  f.deps.chain.refreshAttestation = async (batch, until) => {
    for (const key of batch) {
      const previous = f.fakeJurors.get(key)!.attestedUntil;
      if (previous > 0n && previous < BigInt(Math.floor(nowMs / 1_000))) lapses.push({ key, at: t(), until: previous });
      refreshedAt.set(key, [...refreshedAt.get(key) ?? [], t()]);
    }
    return refresh(batch, until);
  };
  const attestor = createAttestor(f.deps);
  const queue: { at: number; callback: () => void }[] = [];
  const loop = startAttestationChecks(async (isDue) => {
    const results = await attestor.checkAll(isDue);
    return results.map((row) => ({ key: row.address, ok: row.ok, attestedUntilSec: attestor.attestedUntil(row.address) }));
  }, INTERVAL, {
    schedule: (callback, delay) => { queue.push({ at: nowMs + delay, callback }); },
    random: options.random ?? (() => 0.999_999),
    now: () => nowMs,
  });
  await loop.idle();
  return {
    f, checks, lapses, refreshedAt,
    async runUntil(seconds: number) {
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > (T0 + seconds) * 1_000) break;
        queue.shift();
        nowMs = next.at;
        next.callback();
        await loop.idle();
      }
      nowMs = (T0 + seconds) * 1_000;
    },
    /** Keys whose on-chain attestation has run out at the current fake time. */
    expired() {
      return f.keys.filter((key) => f.fakeJurors.get(key)!.attestedUntil < BigInt(Math.floor(nowMs / 1_000)));
    },
  };
}

describe("per-key retries keep healthy keys attested", () => {
  test("a failure that clears 470 s after the 600 s check is retried and refreshed before the 1200 s expiry", async () => {
    for (const random of [() => 0.999_999, () => 0.5, () => 0]) {
      // The key is refreshed at startup (until T0 + 1200); its endpoint is down from 600 s to 1070 s.
      const sim = await simulation({ count: 1, reachable: (_index, t) => t < 600 || t >= 1_070, random });
      await sim.runUntil(1_800);
      const key = sim.f.keys[0]!;
      const refreshes = sim.refreshedAt.get(key)!;
      expect(refreshes[0]).toBe(0);
      const recovered = refreshes.find((at) => at >= 600)!;
      expect(recovered).toBeGreaterThanOrEqual(1_070);
      expect(recovered).toBeLessThan(1_200);
      expect(sim.lapses).toEqual([]);
      expect(sim.expired()).toEqual([]);
      // Retries tighten as the expiry approaches: none waits longer than 120 s, or a quarter of what is left.
      const attempts = sim.checks.get(key)!.filter((at) => at >= 600 && at <= recovered);
      for (let i = 1; i < attempts.length; i++) {
        const gap = attempts[i]! - attempts[i - 1]!;
        expect(gap).toBeLessThanOrEqual(Math.max(15, Math.min(120, (1_200 - attempts[i - 1]!) / 4)) + 0.001);
      }
    }
  });

  test("a permanently failing key does not slow the retries of a healthy key with a short blip", async () => {
    // Key 0 is healthy except for a 40 s blip at 600 s; key 1 (an exited enclave) never answers.
    const sim = await simulation({ count: 2, reachable: (index, t) => index === 0 && !(t >= 600 && t < 640) });
    await sim.runUntil(3_600);
    const [healthy, dead] = sim.f.keys as [Address, Address];
    const healthyChecks = sim.checks.get(healthy)!;
    // The blip is noticed at 600 s and retried after 15 s, 30 s: the failing key's long backoff is not shared.
    expect(healthyChecks.filter((at) => at >= 600 && at <= 660)).toEqual([600, 615, 645]);
    expect(sim.refreshedAt.get(healthy)).toContain(645);
    expect(sim.lapses).toEqual([]);
    expect(sim.expired()).toEqual([dead]);
    // The dead key backs off on its own, to the full interval since it has nothing left to protect.
    const deadChecks = sim.checks.get(dead)!;
    expect(deadChecks.at(-1)! - deadChecks.at(-2)!).toBe(600);
    expect(sim.refreshedAt.get(dead)).toBeUndefined();
  });

  test("after a CVM restart, keys whose endpoints warm up for 450 s of their remaining 500 s are refreshed before expiry", async () => {
    // The previous attestor refreshed everything 700 s before the restart, so 500 s of validity remain. Jurors answer
    // only after their ACI warm-up; key 3 belongs to an exited enclave that never comes back.
    for (const random of [() => 0.999_999, () => 0.5, () => 0]) {
      const sim = await simulation({
        count: 4,
        attestedUntil: () => BigInt(T0 + 500),
        reachable: (index, t) => index !== 3 && t >= 450,
        random,
      });
      await sim.runUntil(2_400);
      const live = sim.f.keys.slice(0, 3);
      for (const key of live) {
        const first = sim.refreshedAt.get(key)![0]!;
        expect(first).toBeGreaterThanOrEqual(450);
        expect(first).toBeLessThan(500);
      }
      expect(sim.lapses).toEqual([]);
      expect(sim.expired()).toEqual([sim.f.keys[3]!]);
    }
  });
});
