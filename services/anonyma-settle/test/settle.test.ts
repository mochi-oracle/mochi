import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createAnonymaSettleApp } from "../src/app.ts";
import { nextSettlement, previousWeek, reconcile, runSettlement, type Statement } from "../src/settle.ts";
import type { Hex32, SettlePorts, VoucherEvent } from "../src/ports.ts";

const id = (n: string) => `0x${n.repeat(64)}` as Hex32;
function fakePorts(overrides: Partial<SettlePorts> = {}) {
  const inserted: Array<{ voucherId: Hex32; queryId: Hex32; tier: number; usdgAmount: string; settled: false }> = [];
  const settled: string[][] = [];
  const written = new Map<string, string>();
  const events: VoucherEvent[] = [
    { voucherId: id("1"), queryId: id("a"), tier: 1, amount: 100n, timestamp: 10 },
    { voucherId: id("2"), queryId: id("a"), tier: 2, amount: 200n, timestamp: 20 },
    { voucherId: id("3"), queryId: id("b"), tier: 1, amount: 300n, timestamp: 30 },
  ];
  const base: SettlePorts = {
    chain: {
      async voucherEvents(start, end) { return events.filter((e) => e.timestamp >= start && e.timestamp < end); },
      async openEvents(start, end) { return [{ queryId: id("a"), payPath: 2, timestamp: 0 }, { queryId: id("b"), payPath: 1, timestamp: 0 }].filter((e) => e.timestamp >= start && e.timestamp < end); },
      async refundEvents(start, end) { return [{ queryId: id("a"), amount: 150n, timestamp: 25 }].filter((e) => e.timestamp >= start && e.timestamp < end); },
      async floatBalance() { return 700n; },
    },
    vouchers: {
      async insert(v) { if (!inserted.some((x) => x.voucherId === v.voucherId)) inserted.push(v); },
      async markSettled(ids) { settled.push(ids); },
    },
    async ledger() { return []; },
    clock: { now: () => new Date("2026-09-23T12:00:00Z") },
    files: {
      async writeStatement(end, body, sig) { written.set(`${end}.json`, body); written.set(`${end}.sig`, sig); },
      async readStatement(name) { return written.get(name) ?? written.get(`${name}.json`) ?? null; },
    },
  };
  return { ports: { ...base, ...overrides }, inserted, settled, written };
}

describe("Anonyma settlement", () => {
  test("indexes Anonyma vouchers and nets query refunds against vouchers in order", async () => {
    const f = fakePorts();
    const statement = await (await import("../src/settle.ts")).buildStatement(new Date(0), new Date(100), f.ports, 1000n);
    expect(f.inserted.map((v) => v.voucherId)).toEqual([id("1"), id("2")]);
    expect(statement.vouchers.map((v) => [v.charged, v.refunded, v.net])).toEqual([["100", "100", "0"], ["200", "50", "150"]]);
    expect(statement.totals).toEqual({ charged: "300", refunded: "150", net: "150" });
    expect(statement.byTier).toEqual({ "1": { charged: "100", refunded: "100", net: "0" }, "2": { charged: "200", refunded: "50", net: "150" } });
  });

  test("reports all reconciliation discrepancy classes and settles only when clean", async () => {
    const f = fakePorts();
    const statement: Statement = { period: { start: "", end: "" }, vouchers: [{ voucherId: id("1"), queryId: id("a"), tier: 0, charged: "50", refunded: "10", net: "40" }], totals: { charged: "50", refunded: "10", net: "40" }, byTier: {}, floatBalance: "0", recommendedTopUp: "0" };
    const dirty = await reconcile(statement, [{ voucherId: id("1"), usdgEquiv: "39" }, { voucherId: id("2"), usdgEquiv: "4" }], f.ports);
    expect(dirty.missingOnAnonyma).toEqual([]);
    const absent = await reconcile(statement, [], f.ports);
    expect(absent.missingOnAnonyma).toEqual([id("1")]);
    expect(f.settled).toHaveLength(0);
    expect(dirty.missingOnChain).toEqual([id("2")]);
    expect(dirty.amountMismatches).toEqual([{ voucherId: id("1"), chain: "40", anonyma: "39" }]);
    expect(f.settled).toHaveLength(0);
    const clean = await reconcile(statement, [{ voucherId: id("1"), usdgEquiv: "40" }], f.ports);
    expect(clean.clean).toBe(true);
    expect(f.settled).toEqual([[id("1")]]);
  });

  test("writes an HMAC-SHA256 sibling signature and recommends the float shortfall", async () => {
    const f = fakePorts();
    const result = await runSettlement(new Date(0), new Date(100), f.ports, { targetFloat: 1000n, hmacSecret: "test-secret" });
    expect(result.statement.floatBalance).toBe("700");
    expect(result.statement.recommendedTopUp).toBe("300");
    const body = f.written.get("1970-01-01.json")!;
    expect(f.written.get("1970-01-01.sig")).toBe(createHmac("sha256", "test-secret").update(body).digest("hex"));
  });

  test("serves authenticated statement/settle routes and validates bodies", async () => {
    const f = fakePorts();
    const { app } = createAnonymaSettleApp({ ports: f.ports, adminToken: "admin", hmacSecret: "secret", targetFloat: 1000n });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/v1/anonyma/settle", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect((await app.request("/v1/anonyma/statements/2026-09-21", { headers: { authorization: "Bearer admin" } })).status).toBe(200);
    expect((await app.request("/v1/anonyma/settle", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: "{\"periodStart\":\"oops\"}" })).status).toBe(400);
  });

  test("calculates previous-week periods and next UTC schedule boundaries", () => {
    expect(previousWeek(new Date("2026-09-23T12:30:00Z"))).toEqual({ start: new Date("2026-09-14T00:00:00.000Z"), end: new Date("2026-09-21T00:00:00.000Z") });
    expect(nextSettlement(new Date("2026-09-21T00:00:00Z"), 1, 0)).toEqual(new Date("2026-09-28T00:00:00.000Z"));
    expect(nextSettlement(new Date("2026-09-20T23:59:59Z"), 1, 0)).toEqual(new Date("2026-09-21T00:00:00.000Z"));
  });
});
