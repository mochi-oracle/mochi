import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileSealedStore, MemorySealedStore, MockTeeProvider, SealedStoreFullError, type SealedStore } from "../src/index.ts";

const SEED = `0x${"22".repeat(32)}` as Hex, MEASUREMENT = `0x${"ab".repeat(32)}` as Hex, ROOT = `0x${"11".repeat(32)}` as Hex;
const provider = new MockTeeProvider({ seed: SEED, measurement: MEASUREMENT, mockRoot: privateKeyToAccount(ROOT) });
const dirs: string[] = [];
const stores: FileSealedStore[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), "mochi-sealed-first-")); dirs.push(dir); return dir; }
function fileStore(dir: string, retention?: ConstructorParameters<typeof FileSealedStore>[2]) {
  const created = new FileSealedStore(dir, provider, retention);
  stores.push(created);
  return created;
}
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const bytes = (value: Uint8Array | undefined) => value === undefined ? undefined : [...value];

describe("putIfAbsent: atomic first write wins", () => {
  test("memory and file stores keep the first value and report whether they wrote", async () => {
    const dir = await directory();
    for (const store of [new MemorySealedStore(), fileStore(dir)] as SealedStore[]) {
      expect(await store.putIfAbsent!("prov:a", new Uint8Array([1, 2, 3]))).toBe(true);
      expect(await store.putIfAbsent!("prov:a", new Uint8Array([9, 9, 9]))).toBe(false);
      expect(bytes(await store.get("prov:a"))).toEqual([1, 2, 3]);
      expect(await store.putIfAbsent!("prov:b", new Uint8Array([4]))).toBe(true);
      expect(bytes(await store.get("prov:b"))).toEqual([4]);
    }
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith(".bin"))).toHaveLength(2);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // The entry on disk is ciphertext bound to the key, like put().
    for (const name of names) expect(await readFile(join(dir, name), "utf8")).not.toContain("prov:a");
  });

  test("concurrent writers through separate store instances: exactly one wins and its value is kept", async () => {
    const dir = await directory();
    const [a, b] = [fileStore(dir), fileStore(dir)];
    for (let round = 0; round < 5; round++) {
      const key = `prov:race-${round}`;
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).putIfAbsent(key, new Uint8Array([round, i]))));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect(bytes(await a.get(key))).toEqual([round, winner]);
      expect(bytes(await b.get(key))).toEqual([round, winner]);
    }
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("concurrent writers in separate processes: exactly one wins", async () => {
    const dir = await directory();
    const root = resolve(import.meta.dir, "../../..");
    const startAt = Date.now() + 1500;
    const script = [
      `import { FileSealedStore, MockTeeProvider } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};`,
      `import { privateKeyToAccount } from "viem/accounts";`,
      `const provider = new MockTeeProvider({ seed: ${JSON.stringify(SEED)}, measurement: ${JSON.stringify(MEASUREMENT)}, mockRoot: privateKeyToAccount(${JSON.stringify(ROOT)}) });`,
      `const store = new FileSealedStore(process.env.DIR, provider);`,
      `await Bun.sleep(Math.max(0, ${startAt} - Date.now()));`,
      `console.log(JSON.stringify(await store.putIfAbsent("prov:cross-process", new Uint8Array([Number(process.env.ID)]))));`,
    ].join("\n");
    const children = Array.from({ length: 6 }, (_, id) => Bun.spawn([process.execPath, "-e", script], { cwd: root, env: { ...process.env, DIR: dir, ID: String(id) }, stdout: "pipe", stderr: "pipe" }));
    const outputs = await Promise.all(children.map(async (child) => { await child.exited; return (await new Response(child.stdout).text()).trim(); }));
    expect(outputs.every((output) => output === "true" || output === "false")).toBe(true);
    expect(outputs.filter((output) => output === "true")).toHaveLength(1);
    expect(bytes(await fileStore(dir).get("prov:cross-process"))).toEqual([outputs.indexOf("true")]);
  });

  test("retention: capacity bounds new entries, an existing entry is still confirmed, stale staging files are swept", async () => {
    const dir = await directory();
    const clock = { now: Date.now() };
    // Disk use is counted in whole 4 KiB blocks: room for one small entry.
    const store = fileStore(dir, { ttlSec: 3600, maxBytes: 6000, sweepIntervalMs: 0, now: () => clock.now });
    expect(await store.putIfAbsent("prov:first", new Uint8Array(200))).toBe(true);
    await expect(store.putIfAbsent("prov:second", new Uint8Array(1000))).rejects.toBeInstanceOf(SealedStoreFullError);
    expect(await store.has("prov:second")).toBe(false);
    expect(await store.putIfAbsent("prov:first", new Uint8Array(1000))).toBe(false);
    // A staging file left by a crash is removed once it is older than the TTL; a fresh one is left alone.
    const name = (await readdir(dir)).find((entry) => entry.endsWith(".bin"))!;
    const stale = join(dir, `.${name.slice(0, -4)}.0123456789abcdef.tmp`), fresh = join(dir, `.${name.slice(0, -4)}.fedcba9876543210.tmp`);
    await writeFile(stale, "partial"); await writeFile(fresh, "partial");
    const old = new Date(clock.now - 2 * 3_600_000);
    await utimes(stale, old, old);
    await store.sweep();
    const left = await readdir(dir);
    expect(left).not.toContain(stale.slice(dir.length + 1));
    expect(left).toContain(fresh.slice(dir.length + 1));
    expect(bytes(await store.get("prov:first"))).toEqual(Array(200).fill(0));
  });
});
