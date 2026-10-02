import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { diskBytes, FileSealedStore, MockTeeProvider, SealedStoreFullError, seal, type SealedStoreRetention } from "../src/index.ts";

const provider = new MockTeeProvider({ seed: `0x${"22".repeat(32)}` as Hex, measurement: `0x${"ab".repeat(32)}` as Hex, mockRoot: privateKeyToAccount(`0x${"11".repeat(32)}`) });
const HOUR = 3_600_000, DAY = 24 * HOUR, BLOCK = 4096;
const dirs: string[] = [];
const stores: FileSealedStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function store(retention: Partial<SealedStoreRetention> = {}, Store: typeof FileSealedStore = FileSealedStore) {
  const dir = await mkdtemp(join(tmpdir(), "mochi-sealed-life-")); dirs.push(dir);
  const clock = { now: Date.now() };
  const created = new Store(dir, provider, { ttlSec: 3 * 3600, sweepIntervalMs: 0, now: () => clock.now, ...retention });
  stores.push(created);
  return { s: created, dir, clock };
}
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const entryName = (key: string) => sha256(toHex(new TextEncoder().encode(key)));

describe("sealed store lifecycle", () => {
  test("retained entries expire retainedTtlSec after their last retain; retaining again restarts the clock", async () => {
    const { s, clock } = await store({ retainedTtlSec: 14 * 86_400 });
    await s.put("prov:dispatched", bytes(10));
    await s.put("prov:escalated", bytes(10));
    await s.retain("prov:dispatched");
    await s.retain("prov:escalated");
    clock.now += 10 * DAY;
    await s.retain("prov:escalated"); // a panel dispatch ten days later
    clock.now += 4 * DAY + 60_000;
    expect(await s.sweep()).toBe(1);
    expect(await s.has("prov:dispatched")).toBe(false);
    expect(await s.has("prov:escalated")).toBe(true);
    clock.now += 10 * DAY;
    expect(await s.sweep()).toBe(1);
    expect(await s.has("prov:escalated")).toBe(false);
    expect(await s.usage()).toEqual({ unretainedBytes: 0, retainedBytes: 0, pendingBytes: 0 });
  });

  test("retaining a missing or expired entry writes no marker", async () => {
    const { s, dir, clock } = await store({ retainedTtlSec: 86_400 });
    await s.retain("prov:never-written");
    await s.put("prov:late", bytes(10));
    clock.now += 3 * HOUR + 60_000;
    await s.sweep();
    await s.retain("prov:late");
    expect(await readdir(dir)).toEqual([]);
  });

  test("free writes fill only the unretained pool; they cannot crowd out retention", async () => {
    const { s, clock } = await store({ maxUnretainedBytes: 3 * BLOCK, maxRetainedBytes: 4 * BLOCK, maxBytes: 7 * BLOCK, retainedTtlSec: 86_400 });
    for (let i = 0; i < 3; i++) expect(await s.putIfAbsent(`prov:${i}`, bytes(100))).toBe(true);
    const error = await s.putIfAbsent("prov:spam", bytes(100)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealedStoreFullError);
    expect((error as SealedStoreFullError).pool).toBe("unretained");
    await s.retain("prov:0"); // a paid dispatch: moves to the retained pool, freeing upload room
    expect(await s.usage()).toMatchObject({ unretainedBytes: 2 * BLOCK, retainedBytes: 2 * BLOCK });
    expect(await s.putIfAbsent("prov:3", bytes(100))).toBe(true);
    // The upload TTL frees the unretained pool; the retained entry stays.
    clock.now += 3 * HOUR + 60_000;
    expect(await s.putIfAbsent("prov:4", bytes(100))).toBe(true);
    expect(await s.has("prov:0")).toBe(true);
    expect(await s.has("prov:1")).toBe(false);
  });

  test("a full retained pool refuses retain; the entry keeps its upload lifetime", async () => {
    const { s, clock } = await store({ maxRetainedBytes: 2 * BLOCK, retainedTtlSec: 86_400 });
    await s.put("prov:a", bytes(100));
    await s.put("prov:b", bytes(100));
    await s.retain("prov:a");
    const error = await s.retain("prov:b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealedStoreFullError);
    expect((error as SealedStoreFullError).pool).toBe("retained");
    await s.retain("prov:a"); // refreshing an entry that is already retained needs no room
    clock.now += 3 * HOUR + 60_000;
    expect(await s.sweep()).toBe(1);
    expect(await s.has("prov:a")).toBe(true);
    expect(await s.has("prov:b")).toBe(false);
  });

  test("concurrent writers cannot overshoot a cap", async () => {
    const { s } = await store({ maxUnretainedBytes: 5 * BLOCK });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => s.putIfAbsent(`prov:${i}`, bytes(100))));
    expect(results.filter((r) => r.status === "fulfilled" && r.value)).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof SealedStoreFullError)).toHaveLength(15);
    expect((await s.usage()).unretainedBytes).toBe(5 * BLOCK);
  });

  test("disk use is counted in whole blocks per file and released by delete", async () => {
    const { s, dir } = await store({ retainedTtlSec: 86_400 });
    await s.put("prov:small", bytes(1));
    await s.put("prov:large", bytes(3 * BLOCK));
    await s.retain("prov:large");
    const sizes = await Promise.all((await readdir(dir)).filter((n) => n.endsWith(".bin")).map(async (n) => (await stat(join(dir, n))).size));
    expect(sizes.map(diskBytes).sort((a, b) => a - b)).toEqual([BLOCK, 4 * BLOCK]);
    expect(await s.usage()).toEqual({ unretainedBytes: BLOCK, retainedBytes: 4 * BLOCK + BLOCK, pendingBytes: 0 });
    await s.sweep(); // the recount agrees with the running total
    expect(await s.usage()).toEqual({ unretainedBytes: BLOCK, retainedBytes: 5 * BLOCK, pendingBytes: 0 });
    await s.delete("prov:large");
    await s.delete("prov:small");
    expect(await s.usage()).toEqual({ unretainedBytes: 0, retainedBytes: 0, pendingBytes: 0 });
  });
});

describe("sealed store format", () => {
  test("stores the ciphertext once (value + 64 bytes), not as hex inside JSON", async () => {
    const { s, dir } = await store();
    await s.put("prov:doc", bytes(100_000));
    const [name] = await readdir(dir);
    expect(name).toBe(`${entryName("prov:doc")}.bin`);
    expect((await stat(join(dir, name!))).size).toBe(100_000 + 4 + 32 + 12 + 16);
    expect([...(await s.get("prov:doc"))!].every((b) => b === 7)).toBe(true);
  });

  test("entries written in the earlier JSON format are read, confirmed, counted, replaced and swept", async () => {
    const { s, dir, clock } = await store();
    const legacy = (key: string, value: Uint8Array) => writeFile(join(dir, `${entryName(key)}.json`), JSON.stringify(seal(provider.encryptionPublicKey(), value, new TextEncoder().encode(key))));
    await legacy("prov:old", bytes(5, 1));
    await legacy("prov:older", bytes(5, 2));
    expect([...(await s.get("prov:old"))!]).toEqual([1, 1, 1, 1, 1]);
    expect(await s.putIfAbsent("prov:old", bytes(5, 9))).toBe(false);
    await s.sweep();
    expect((await s.usage()).unretainedBytes).toBe(2 * BLOCK);
    await s.put("prov:old", bytes(5, 3));
    expect((await readdir(dir)).sort()).toEqual([`${entryName("prov:old")}.bin`, `${entryName("prov:older")}.json`].sort());
    expect([...(await s.get("prov:old"))!]).toEqual([3, 3, 3, 3, 3]);
    clock.now += 3 * HOUR + 60_000;
    expect(await s.sweep()).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  test("putIfAbsent flushes the directory after linking a new entry, and only then", async () => {
    let syncs = 0;
    class Counting extends FileSealedStore { protected override async syncDirectory() { syncs++; await super.syncDirectory(); } }
    const { s } = await store({}, Counting);
    expect(await s.putIfAbsent("prov:x", bytes(10))).toBe(true);
    expect(syncs).toBe(1);
    expect(await s.putIfAbsent("prov:x", bytes(10))).toBe(false);
    expect(syncs).toBe(1);
  });
});
