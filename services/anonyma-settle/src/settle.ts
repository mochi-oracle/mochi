import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hex32, SettlePorts } from "./ports.ts";

export interface Statement {
  period: { start: string; end: string };
  vouchers: Array<{ voucherId: Hex32; queryId: Hex32; tier: number; charged: string; refunded: string; net: string }>;
  totals: { charged: string; refunded: string; net: string };
  byTier: Record<string, { charged: string; refunded: string; net: string }>;
  floatBalance: string;
  recommendedTopUp: string;
}
export interface SettleOptions { targetFloat: bigint; hmacSecret: string }
const ANONYMA_PAY_PATH = 2;
const fromUnits = (x: bigint) => x.toString();
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export function verifySignature(secret: string, body: string, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(hmac(secret, body), "hex");
  const actual = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, actual);
}

export function previousWeek(now: Date): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (end.getUTCDay() + 6) % 7;
  end.setUTCDate(end.getUTCDate() - daysSinceMonday);
  const start = new Date(end.getTime() - 7 * 86400000);
  return { start, end };
}

export function nextSettlement(now: Date, weekday: number, hour: number): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
  let delta = (weekday - next.getUTCDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= now.getTime()) delta = 7;
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

export async function buildStatement(start: Date, end: Date, ports: SettlePorts, targetFloat: bigint): Promise<Statement> {
  if (start.getTime() >= end.getTime()) throw new Error("period start must be before period end");
  const [voucherEvents, opened, refunds, floatBalance] = await Promise.all([
    ports.chain.voucherEvents(start.getTime(), end.getTime()),
    ports.chain.openEvents(start.getTime(), end.getTime()),
    ports.chain.refundEvents(start.getTime(), end.getTime()),
    ports.chain.floatBalance(),
  ]);
  const anonymaQueries = new Set(opened.filter((e) => e.payPath === ANONYMA_PAY_PATH).map((e) => e.queryId));
  const selected = voucherEvents.filter((e) => anonymaQueries.has(e.queryId));
  for (const event of selected) await ports.vouchers.insert({ voucherId: event.voucherId, queryId: event.queryId, tier: event.tier, usdgAmount: fromUnits(event.amount), settled: false });
  const refundByQuery = new Map<string, bigint>();
  for (const refund of refunds) {
    if (anonymaQueries.has(refund.queryId)) refundByQuery.set(refund.queryId, (refundByQuery.get(refund.queryId) ?? 0n) + refund.amount);
  }
  const rows = selected.map((event) => ({ event }));
  const refundedByVoucher = new Map<Hex32, bigint>();
  for (const [queryId, totalRefund] of refundByQuery) {
    const queryRows = rows.filter(({ event }) => event.queryId === queryId).sort((a, b) => a.event.timestamp - b.event.timestamp || a.event.voucherId.localeCompare(b.event.voucherId));
    let left = totalRefund;
    for (const { event } of queryRows) {
      const charged = event.amount;
      const applied = left < charged ? left : charged;
      refundedByVoucher.set(event.voucherId, applied);
      left -= applied;
      if (left === 0n) break;
    }
  }
  let chargedTotal = 0n;
  let refundedTotal = 0n;
  const byTier = new Map<number, { charged: bigint; refunded: bigint }>();
  const vouchers = rows.map(({ event }) => {
    const charged = event.amount;
    const refunded = refundedByVoucher.get(event.voucherId) ?? 0n;
    chargedTotal += charged;
    refundedTotal += refunded;
    const tier = byTier.get(event.tier) ?? { charged: 0n, refunded: 0n };
    tier.charged += charged;
    tier.refunded += refunded;
    byTier.set(event.tier, tier);
    return { voucherId: event.voucherId, queryId: event.queryId, tier: event.tier, charged: fromUnits(charged), refunded: fromUnits(refunded), net: fromUnits(charged - refunded) };
  });
  const byTierObject = Object.fromEntries([...byTier].map(([tier, value]) => [String(tier), { charged: fromUnits(value.charged), refunded: fromUnits(value.refunded), net: fromUnits(value.charged - value.refunded) }]));
  return {
    period: { start: start.toISOString(), end: end.toISOString() }, vouchers,
    totals: { charged: fromUnits(chargedTotal), refunded: fromUnits(refundedTotal), net: fromUnits(chargedTotal - refundedTotal) },
    byTier: byTierObject, floatBalance: fromUnits(floatBalance), recommendedTopUp: fromUnits(targetFloat > floatBalance ? targetFloat - floatBalance : 0n),
  };
}

export async function reconcile(statement: Statement, ledger: Array<{ voucherId: Hex32; usdgEquiv: string }>, ports: SettlePorts): Promise<{ missingOnAnonyma: string[]; missingOnChain: string[]; amountMismatches: Array<{ voucherId: string; chain: string; anonyma: string }>; clean: boolean }> {
  const chainById = new Map(statement.vouchers.map((v) => [v.voucherId, BigInt(v.net)]));
  const ledgerById = new Map(ledger.map((v) => [v.voucherId.toLowerCase(), BigInt(v.usdgEquiv)]));
  const missingOnAnonyma = [...chainById.keys()].filter((id) => !ledgerById.has(id.toLowerCase()));
  const missingOnChain = [...ledgerById.keys()].filter((id) => !chainById.has(id as Hex32));
  const amountMismatches = [...chainById].filter(([id, amount]) => ledgerById.has(id.toLowerCase()) && ledgerById.get(id.toLowerCase()) !== amount).map(([id, amount]) => ({ voucherId: id, chain: amount.toString(), anonyma: ledgerById.get(id.toLowerCase())!.toString() }));
  const clean = missingOnAnonyma.length === 0 && missingOnChain.length === 0 && amountMismatches.length === 0;
  if (clean) await ports.vouchers.markSettled([...chainById.keys()]);
  return { missingOnAnonyma, missingOnChain, amountMismatches, clean };
}

export async function runSettlement(start: Date, end: Date, ports: SettlePorts, options: SettleOptions) {
  const statement = await buildStatement(start, end, ports, options.targetFloat);
  const body = JSON.stringify(statement, null, 2) + "\n";
  await ports.files.writeStatement(end.toISOString().slice(0, 10), body, hmac(options.hmacSecret, body));
  const ledger = await ports.ledger();
  const reconciliation = await reconcile(statement, ledger, ports);
  return { statement, reconciliation };
}
