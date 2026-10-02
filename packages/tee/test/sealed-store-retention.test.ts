import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileSealedStore, MockTeeProvider, SealedStoreFullError } from "../src/index.ts";

const provider = new MockTeeProvider({ seed: `0x${"22".repeat(32)}` as Hex, measurement: `0x${"ab".repeat(32)}` as Hex, mockRoot: privateKeyToAccount(`0x${"11".repeat(32)}`) });
const dirs: string[] = [];
const stores: FileSealedStore[] = [];
const HOUR = 3_600_000;
async function store(options: { ttlSec?: number; maxBytes?: number; retainOnRead?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mochi-sealed-ttl-")); dirs.push(dir);
  const clock = { now: Date.now() };
  const created = new FileSealedStore(dir, provider, { ttlSec: options.ttlSec ?? 86_400, maxBytes: options.maxBytes, retainOnRead: options.retainOnRead, sweepIntervalMs: 0, now: () => clock.now });
  stores.push(created);
  return { store: created, dir, clock };
}
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sealed store retention", () => {
  test("purges uploads that no query opened after the TTL and keeps retained ones", async () => {
    const { store: s, dir, clock } = await store({ ttlSec: 3600 });
    await s.put("doc:unopened", new Uint8Array([1, 2, 3]));
    await s.put("doc:opened", new Uint8Array([4, 5, 6]));
    await s.retain("doc:opened");
    clock.now += HOUR / 2;
    expect(await s.sweep()).toBe(0);
    expect(await s.has("doc:unopened")).toBe(true);
    clock.now += HOUR;
    expect(await s.sweep()).toBe(1);
    expect(await s.get("doc:unopened")).toBeUndefined();
    expect([...(await s.get("doc:opened"))!]).toEqual([4, 5, 6]);
    expect((await readdir(dir)).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
  });

  test("a successful read retains the entry when retainOnRead is set; has() does not", async () => {
    const { store: s, clock } = await store({ ttlSec: 60, retainOnRead: true });
    await s.put("doc:dispatched", new Uint8Array([7]));
    await s.put("doc:probed", new Uint8Array([8]));
    expect(await s.has("doc:probed")).toBe(true);
    expect(await s.get("doc:dispatched")).toBeDefined();
    clock.now += 61_000;
    expect(await s.sweep()).toBe(1);
    expect(await s.has("doc:dispatched")).toBe(true);
    expect(await s.has("doc:probed")).toBe(false);
  });

  test("refuses writes past the byte cap instead of filling the disk, and frees space as entries expire", async () => {
    const { store: s, clock } = await store({ ttlSec: 60, maxBytes: 3 * 4096 });
    const doc = new Uint8Array(600).fill(9);
    let stored = 0;
    for (let i = 0; i < 20; i++) {
      try { await s.put(`doc:${i}`, doc); stored++; }
      catch (error) { expect(error).toBeInstanceOf(SealedStoreFullError); }
    }
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(20);
    await expect(s.put("doc:overflow", doc)).rejects.toBeInstanceOf(SealedStoreFullError);
    clock.now += 61_000;
    await s.put("doc:after-expiry", doc);
    expect(await s.has("doc:after-expiry")).toBe(true);
    expect(await s.has("doc:0")).toBe(false);
  });

  test("overwriting the same key does not double count, delete removes the marker, and orphan markers are swept", async () => {
    const { store: s, dir } = await store({ ttlSec: 60, maxBytes: 2 * 4096 });
    for (let i = 0; i < 10; i++) await s.put("doc:same", new Uint8Array(400).fill(i));
    await s.retain("doc:same");
    await s.delete("doc:same");
    expect(await readdir(dir)).toHaveLength(0);
    await s.put("doc:other", new Uint8Array([1]));
    await s.retain("doc:other");
    const [entry] = (await readdir(dir)).filter((name) => name.endsWith(".bin"));
    await rm(join(dir, entry!));
    await s.sweep();
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("without a retention policy nothing expires (consensus and juror state)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mochi-sealed-plain-")); dirs.push(dir);
    const plain = new FileSealedStore(dir, provider);
    await plain.put("consensus:q", new Uint8Array([1]));
    expect(await plain.sweep()).toBe(0);
    await plain.retain("consensus:q");
    expect(await readdir(dir)).toHaveLength(1);
    expect(await plain.has("consensus:q")).toBe(true);
  });

  test("rejects invalid retention settings", () => {
    expect(() => new FileSealedStore("/nonexistent", provider, { ttlSec: 0, sweepIntervalMs: 0 })).toThrow();
    expect(() => new FileSealedStore("/nonexistent", provider, { ttlSec: 10, maxBytes: -1, sweepIntervalMs: 0 })).toThrow();
  });
});
