import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.ts";
import { chainCursors, endpoints, feedQueries, payerResultKeys } from "./schema.ts";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);

/** Registers or updates an enclave endpoint (role: 1 JUROR, 2 INTAKE, 3 CONSENSUS). */
export async function upsertEndpoint(db: Database, addr: string, role: number, url: string) {
  const row = { address: address.parse(addr), role: z.number().int().min(1).max(3).parse(role), url: z.string().url().parse(url) };
  await db
    .insert(endpoints)
    .values({ ...row, updatedAt: new Date() })
    .onConflictDoUpdate({ target: endpoints.address, set: { role: row.role, url: row.url, updatedAt: new Date() } });
}

export async function getEndpoint(db: Database, addr: string) {
  const rows = await db.select().from(endpoints).where(eq(endpoints.address, address.parse(addr))).limit(1);
  return rows[0] ?? null;
}

export async function insertFeedQuery(db: Database, queryId: string, feedId: string, key: string) {
  await db
    .insert(feedQueries)
    .values({ queryId: hex32.parse(queryId), feedId: hex32.parse(feedId), key: hex32.parse(key) })
    .onConflictDoNothing();
}

export async function getFeedQuery(db: Database, queryId: string) {
  const rows = await db.select().from(feedQueries).where(eq(feedQueries.queryId, hex32.parse(queryId))).limit(1);
  return rows[0] ?? null;
}

/** Stores a payer's result key under its commitment. Callers must pass commit = payerCommit(pub); first write wins. */
export async function putPayerResultKey(db: Database, payerCommit: string, pub: string) {
  await db.insert(payerResultKeys).values({ payerCommit: hex32.parse(payerCommit), pub: hex32.parse(pub) }).onConflictDoNothing();
}
export async function getPayerResultKey(db: Database, payerCommit: string): Promise<string | null> {
  const rows = await db.select({ pub: payerResultKeys.pub }).from(payerResultKeys).where(eq(payerResultKeys.payerCommit, hex32.parse(payerCommit))).limit(1);
  return rows[0]?.pub ?? null;
}

export async function getCursor(db: Database, name: string): Promise<bigint | null> {
  const rows = await db.select().from(chainCursors).where(eq(chainCursors.name, name)).limit(1);
  return rows[0] ? BigInt(rows[0].block) : null;
}

export async function setCursor(db: Database, name: string, block: bigint) {
  await db
    .insert(chainCursors)
    .values({ name, block: block.toString() })
    .onConflictDoUpdate({ target: chainCursors.name, set: { block: block.toString() } });
}
