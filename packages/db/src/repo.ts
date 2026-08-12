import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { JurorClass, PayPath, ProvenanceKind, QueryStatus, Role, SchemaId, VerdictStatus } from "@mochi/core";
import type { Database } from "./client.ts";
import { anonymaVouchers, anchors, crosschecks, disagreement, escalations, feeds, jurorAnswers, jurors, privateResults, queries, receipts, verdictPublic, verdicts } from "./schema.ts";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const int = (min = 0, max = 2_147_483_647) => z.number().int().min(min).max(max);
const enumValue = (values: object) => z.number().int().refine((value) => Object.values(values).some((candidate) => candidate === value), "Invalid enum value");
const json = z.unknown();
export class PrivacyViolation extends Error { constructor(message = "Private verdict content cannot be stored in verdict_public") { super(message); this.name = "PrivacyViolation"; } }
const schemaId = enumValue(SchemaId), jurorClass = enumValue(JurorClass);

export const QueryInput = z.object({ id: hex32, ts: z.coerce.date(), docCommit: hex32, schemaId, schemaVersion: int(1), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]), round: int(0, 255), isPublic: z.boolean(), payPath: enumValue(PayPath), payerCommit: hex32, paramsHash: hex32, provenanceKind: enumValue(ProvenanceKind), originId: hex32, tokensK: int(), status: enumValue(QueryStatus) });
export type QueryInput = z.infer<typeof QueryInput>;
export async function insertQuery(db: Database, input: QueryInput) { const v = QueryInput.parse(input); await db.insert(queries).values(v); }
export async function updateQueryStatus(db: Database, id: string, status: number) { const i = hex32.parse(id), s = enumValue(QueryStatus).parse(status); await db.update(queries).set({ status: s }).where(eq(queries.id, i)); }

export const JurorAnswerInput = z.object({ queryId: hex32, round: int(0, 255), seat: int(0, 8), juror: address, class: jurorClass, answerHash: hex32, spansRoot: hex32, quoteHash: hex32, sig: z.instanceof(Uint8Array), timedOut: z.boolean(), ts: z.coerce.date() });
export type JurorAnswerInput = z.infer<typeof JurorAnswerInput>;
export async function insertJurorAnswer(db: Database, input: JurorAnswerInput) { await db.insert(jurorAnswers).values(JurorAnswerInput.parse(input)); }

export const VerdictInput = z.object({ id: hex32, ts: z.coerce.date(), queryId: hex32, round: int(0, 255), status: enumValue(VerdictStatus), agreementBps: int(0, 10000), dissentMask: z.bigint().nonnegative(), timeoutMask: z.bigint().nonnegative(), evidenceRoot: hex32, attestationRoot: hex32, answerHash: hex32, payloadHash: hex32, isPublic: z.boolean(), escalated: z.boolean(), tx: hex32 });
export type VerdictInput = z.infer<typeof VerdictInput>;
export const VerdictPublicInput = z.object({ verdictId: hex32, answer: json, payload: z.instanceof(Uint8Array), dissent: json, fieldAgreement: json });
export type VerdictPublicInput = z.infer<typeof VerdictPublicInput>;
export async function insertVerdict(db: Database, verdict: VerdictInput, publicPart?: Omit<VerdictPublicInput, "verdictId">) {
  const v = VerdictInput.parse(verdict);
  if (publicPart && !v.isPublic) throw new PrivacyViolation();
  const part = publicPart ? VerdictPublicInput.parse({ ...publicPart, verdictId: v.id }) : undefined;
  await db.transaction(async (tx) => {
    // Idempotent: the orchestrator and the indexer may both insert the same verdict (same id and on-chain ts).
    await tx.insert(verdicts).values(v).onConflictDoNothing();
    if (v.isPublic && part) await tx.insert(verdictPublic).values(part).onConflictDoNothing();
  });
}

export async function storePrivateResult(db: Database, verdictId: string, ciphertext: Uint8Array, ttlSeconds = 7 * 24 * 3600) {
  const id = hex32.parse(verdictId), bytes = z.instanceof(Uint8Array).parse(ciphertext), ttl = int(1, 31_536_000).parse(ttlSeconds);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await db.insert(privateResults).values({ verdictId: id, ciphertext: bytes, expiresAt }).onConflictDoUpdate({ target: privateResults.verdictId, set: { ciphertext: bytes, expiresAt } });
}
export async function getPrivateResult(db: Database, verdictId: string) { return (await db.select().from(privateResults).where(eq(privateResults.verdictId, hex32.parse(verdictId))).limit(1))[0] ?? null; }
export async function purgeExpiredPrivateResults(db: Database, now: Date) { const expiry = z.coerce.date().parse(now); const deleted = await db.delete(privateResults).where(sql`${privateResults.expiresAt} <= ${sql.param(expiry, privateResults.expiresAt)}`).returning({ verdictId: privateResults.verdictId }); return deleted.length; }

export async function upsertFeed(db: Database, feedId: string, key: string, verdictId: string, asOf: Date) {
  const f = z.string().min(1).parse(feedId), k = z.string().min(1).parse(key), v = hex32.parse(verdictId), a = z.coerce.date().parse(asOf);
  await db.insert(feeds).values({ feedId: f, key: k, verdictId: v, asOf: a, updatedAt: new Date() }).onConflictDoUpdate({ target: [feeds.feedId, feeds.key], set: { verdictId: v, asOf: a, updatedAt: new Date() }, setWhere: sql`${feeds.asOf} <= excluded.as_of` });
}

export const DisagreementInput = z.object({ bucket: z.coerce.date(), window: z.string().min(1), schemaId, field: z.string().min(1), class: jurorClass, disagreeRate: z.number().min(0).max(1), samples: int(), disagreeCount: int() }).refine((row) => row.disagreeCount <= row.samples, "disagreeCount cannot exceed samples");
export type DisagreementInput = z.infer<typeof DisagreementInput>;
export async function recordDisagreement(db: Database, rows: DisagreementInput[]) {
  const parsed = z.array(DisagreementInput).parse(rows);
  for (const row of parsed) {
    await db.insert(disagreement).values({ ...row, disagreeRate: `${row.disagreeRate}`, window: `${row.window}` }).onConflictDoUpdate({ target: [disagreement.schemaId, disagreement.field, disagreement.class, disagreement.window, disagreement.bucket], set: {
      samples: sql`${disagreement.samples} + excluded.samples`, disagreeCount: sql`${disagreement.disagreeCount} + excluded.disagree_count`,
      disagreeRate: sql`COALESCE((${disagreement.disagreeCount} + excluded.disagree_count)::numeric / NULLIF(${disagreement.samples} + excluded.samples, 0), 0)`,
    } });
  }
}

export const CrosscheckInput = z.object({ feedId: z.string().min(1), key: z.string().min(1), verdictId: hex32, ok: z.boolean(), detail: json, ts: z.coerce.date() });
export async function insertCrosscheck(db: Database, input: z.infer<typeof CrosscheckInput>) { await db.insert(crosschecks).values(CrosscheckInput.parse(input)); }
export const EscalationInput = z.object({ queryId: hex32, round: int(0, 255), panel: z.array(address), outcome: json, appealed: z.boolean(), ts: z.coerce.date() });
export async function insertEscalation(db: Database, input: z.infer<typeof EscalationInput>) { await db.insert(escalations).values(EscalationInput.parse(input)); }
export const JurorInput = z.object({ key: address, operator: address, measurement: hex32, class: jurorClass, role: enumValue(Role), bond: z.string().regex(/^\d+$/), attestedUntil: z.coerce.date(), uptime30d: int(), served: int(), timeouts: int(), slashed: z.string().regex(/^\d+$/), delisted: z.boolean() });
export async function upsertJuror(db: Database, input: z.infer<typeof JurorInput>) { const v = JurorInput.parse(input); await db.insert(jurors).values(v).onConflictDoUpdate({ target: jurors.key, set: v }); }
export const ReceiptInput = z.object({ verdictId: hex32, keyId: z.string().min(1), sig: z.instanceof(Uint8Array), payload: json, anchorRoot: hex32.nullable(), anchorIndex: int().nullable() });
export async function insertReceipt(db: Database, input: z.infer<typeof ReceiptInput>) { await db.insert(receipts).values(ReceiptInput.parse(input)); }
export const AnchorInput = z.object({ root: hex32, ts: z.coerce.date(), count: int(), tx: hex32 });
export async function insertAnchor(db: Database, input: z.infer<typeof AnchorInput>) { await db.insert(anchors).values(AnchorInput.parse(input)); }
export const VoucherInput = z.object({ voucherId: hex32, queryId: hex32, tier: int(0, 32767), usdgAmount: z.string().regex(/^\d+$/), settled: z.boolean() });
/** Idempotent: the gateway (at relay time) and the indexer (from AnonymaVoucherUsed) may both record a voucher. */
export async function insertAnonymaVoucher(db: Database, input: z.infer<typeof VoucherInput>) { await db.insert(anonymaVouchers).values(VoucherInput.parse(input)).onConflictDoNothing(); }
export async function markVouchersSettled(db: Database, ids: string[]) { const parsed = z.array(hex32).parse(ids); if (parsed.length) await db.update(anonymaVouchers).set({ settled: true }).where(inArray(anonymaVouchers.voucherId, parsed)); }

export async function getVerdict(db: Database, id: string) {
  const [row] = await db.select({ verdict: verdicts, publicPart: verdictPublic }).from(verdicts).leftJoin(verdictPublic, eq(verdictPublic.verdictId, verdicts.id)).where(eq(verdicts.id, hex32.parse(id))).orderBy(asc(verdicts.ts)).limit(1);
  return row ?? null;
}
export async function listFeeds(db: Database, feedId: string) { return db.select().from(feeds).where(eq(feeds.feedId, z.string().min(1).parse(feedId))).orderBy(asc(feeds.key)); }
export async function disagreementSeries(db: Database, schemaIdValue: number, field: string, window: string) {
  return db.select().from(disagreement).where(and(eq(disagreement.schemaId, schemaId.parse(schemaIdValue)), eq(disagreement.field, z.string().min(1).parse(field)), eq(disagreement.window, `${z.string().min(1).parse(window)}`))).orderBy(asc(disagreement.bucket));
}
