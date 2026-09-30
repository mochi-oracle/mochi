import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { QueryStatus } from "@mochi/core";
import type { OrchestratorDeps } from "../src/ports.ts";
import { Orchestrator } from "../src/pipeline.ts";

const ids = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).padStart(64, "0")}` as Hex);
function fixture(limit = 2) {
  const stored = new Set<Hex>();
  const starts: Array<{ id: Hex; at: number }> = [];
  const pending = new Map<Hex, { resolve(): void; reject(error: Error): void }>();
  let now = 0, head = 1n, cursor: bigint | null = null;
  let opened = [ids[0]!];
  // Block the real advance inside its first chain read, keeping the per-query lock held.
  const deps = {
    chain: {
      dep: { startBlock: "1" }, blockNumber: async () => head,
      getLogs: async () => opened.map(queryId => ({ queryId, blockNumber: head, kind: "opened" })),
      getQuery: async (id: Hex) => {
        if (!stored.has(id)) return { openedAt: 0n, status: QueryStatus.OPEN };
        starts.push({ id, at: now });
        await new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
        return { status: QueryStatus.EXPIRED };
      },
    },
    store: {
      getCursor: async () => cursor, setCursor: async (_: string, value: bigint) => { cursor = value; },
      insertQuery: async (q: { id: Hex }) => { stored.add(q.id); }, queryIds: async () => [...stored],
      updateQueryStatus: async (id: Hex) => { stored.delete(id); },
    },
    config: { maxParallelQueries: limit },
  } as unknown as OrchestratorDeps;
  const orchestrator = new Orchestrator(deps);
  return { orchestrator, starts, pending, stored, open(next: Hex[], at: number) { opened = next; now = at; head++; } };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("a 30-second advance does not delay discovering and starting a query opened one second later", async () => {
  const f = fixture();
  await f.orchestrator.tick();
  expect(f.starts).toEqual([{ id: ids[0]!, at: 0 }]);
  f.open([ids[1]!], 1000);
  await f.orchestrator.tick();
  expect(f.stored.has(ids[1]!)).toBe(true);
  expect(f.starts).toEqual([{ id: ids[0]!, at: 0 }, { id: ids[1]!, at: 1000 }]);
  f.open([], 30000);
  for (const work of f.pending.values()) work.resolve();
  expect(await f.orchestrator.waitForIdle()).toBe(true);
});

test("at most N advances run, duplicate ids and repeated ticks do not start concurrent work", async () => {
  const f = fixture(); f.open(ids, 0);
  await f.orchestrator.tick();
  await f.orchestrator.tick();
  await f.orchestrator.advance(ids[0]!); // direct callers still obey the existing lock
  expect(f.starts.map(s => s.id)).toEqual(ids.slice(0, 2));
  f.pending.get(ids[0]!)!.resolve(); await flush();
  await f.orchestrator.tick();
  expect(f.starts.map(s => s.id)).toEqual(ids.slice(0, 3));
  f.pending.get(ids[1]!)!.resolve(); f.pending.get(ids[2]!)!.resolve();
  await f.orchestrator.waitForIdle();
  await f.orchestrator.tick();
  expect(f.starts.map(s => s.id)).toEqual(ids);
  f.pending.get(ids[3]!)!.resolve(); await f.orchestrator.waitForIdle();
});

test("failed advances release slots and locks so they can be retried", async () => {
  const f = fixture(1); f.open(ids.slice(0, 2), 0);
  await f.orchestrator.tick();
  f.pending.get(ids[0]!)!.reject(new Error("test chain failure"));
  expect(await f.orchestrator.waitForIdle()).toBe(true);
  await f.orchestrator.tick();
  expect(f.starts.map(s => s.id)).toEqual([ids[0]!, ids[0]!]);
  f.pending.get(ids[0]!)!.resolve(); await f.orchestrator.waitForIdle();
  await f.orchestrator.tick();
  expect(f.starts.at(-1)!.id).toBe(ids[1]!);
  f.pending.get(ids[1]!)!.resolve(); await f.orchestrator.waitForIdle();
});

test("shutdown drains in-flight work and prevents new starts", async () => {
  const f = fixture(); await f.orchestrator.tick();
  let settled = false;
  const shutdown = f.orchestrator.shutdown().then(result => { settled = true; return result; });
  await flush(); expect(settled).toBe(false);
  f.open([ids[1]!], 1000); await f.orchestrator.tick();
  expect(f.starts).toHaveLength(1);
  f.pending.get(ids[0]!)!.resolve(); expect(await shutdown).toBe(true);
});

test("shutdown is bounded when an advance stalls", async () => {
  const f = fixture(); await f.orchestrator.tick();
  expect(await f.orchestrator.shutdown(10)).toBe(false);
  f.pending.get(ids[0]!)!.resolve(); expect(await f.orchestrator.waitForIdle()).toBe(true);
});
