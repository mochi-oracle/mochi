import { and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.ts";
import { disagreementModel, disclosures, feedSubscriptions, jurors, panelPayloads, queries } from "./schema.ts";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hexBytes = z.string().regex(/^0x([0-9a-f]{2})*$/);

/** Stores a juror's verified model Passport (the attestor verifies the enclave signature first). */
export async function setJurorPassport(db: Database, key: string, passport: unknown, passportSig: string) {
  await db
    .update(jurors)
    .set({ passport: passport as never, passportSig: hexBytes.parse(passportSig) })
    .where(eq(jurors.key, address.parse(key)));
}

export async function getJurorPassports(db: Database, keys: string[]) {
  if (keys.length === 0) return [];
  const rows = await db.select({ key: jurors.key, passport: jurors.passport }).from(jurors);
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  return rows.filter((r) => wanted.has(r.key));
}

export async function setQueryPayer(db: Database, queryId: string, payer: string) {
  await db.update(queries).set({ payer: address.parse(payer.toLowerCase()) }).where(eq(queries.id, hex32.parse(queryId)));
}

export const ModelDisagreementInput = z.object({
  bucket: z.coerce.date(),
  window: z.string().min(1),
  schemaId: z.number().int().positive(),
  field: z.string().min(1),
  modelId: z.string().min(1),
  samples: z.number().int().nonnegative(),
  disagreeCount: z.number().int().nonnegative(),
}).refine((r) => r.disagreeCount <= r.samples, "disagreeCount cannot exceed samples");
export type ModelDisagreementInput = z.infer<typeof ModelDisagreementInput>;

/** Upserts per-model disagreement buckets, merging counts exactly (rate = count / samples). */
export async function recordModelDisagreement(db: Database, rows: ModelDisagreementInput[]) {
  for (const row of z.array(ModelDisagreementInput).parse(rows)) {
    const rate = row.samples === 0 ? "0" : String(row.disagreeCount / row.samples);
    await db
      .insert(disagreementModel)
      .values({ ...row, disagreeRate: rate })
      .onConflictDoUpdate({
        target: [disagreementModel.schemaId, disagreementModel.field, disagreementModel.modelId, disagreementModel.window, disagreementModel.bucket],
        set: {
          samples: sql`${disagreementModel.samples} + excluded.samples`,
          disagreeCount: sql`${disagreementModel.disagreeCount} + excluded.disagree_count`,
          disagreeRate: sql`COALESCE((${disagreementModel.disagreeCount} + excluded.disagree_count)::numeric / NULLIF(${disagreementModel.samples} + excluded.samples, 0), 0)`,
        },
      });
  }
}

export async function modelDisagreementSeries(db: Database, schemaId: number, field: string, window: string) {
  return db
    .select()
    .from(disagreementModel)
    .where(and(eq(disagreementModel.schemaId, schemaId), eq(disagreementModel.field, field), sql`${disagreementModel.window} = ${window}::interval`))
    .orderBy(disagreementModel.bucket);
}

/** Most envelope hashes listDisclosures returns for one verdict and recipient (each is still fetchable by its hash). */
export const DISCLOSURE_LIST_LIMIT = 256;

/**
 * Stores a disclosure envelope (sealed to the recipient; unreadable by the server) under its hash, the keccak256 of
 * `envelope` (its canonical JSON bytes; the caller computes it). Idempotent per envelope. A different envelope for the
 * same verdict and recipient is stored beside it, never rejected: there is no first-come slot to squat, and the
 * recipient tells envelopes apart by opening them and checking the result against the verdict on-chain.
 */
export async function insertDisclosure(db: Database, verdictId: string, recipientKeyHash: string, envelopeHash: string, envelope: Uint8Array) {
  await db
    .insert(disclosures)
    .values({ verdictId: hex32.parse(verdictId), recipientKeyHash: hex32.parse(recipientKeyHash), envelopeHash: hex32.parse(envelopeHash), envelope })
    .onConflictDoNothing();
}

const recipientRows = (verdictId: string, recipientKeyHash: string) =>
  and(eq(disclosures.verdictId, hex32.parse(verdictId)), eq(disclosures.recipientKeyHash, hex32.parse(recipientKeyHash)));

/** The envelope with `envelopeHash`, or (without one) the oldest envelope for the verdict and recipient. */
export async function getDisclosure(db: Database, verdictId: string, recipientKeyHash: string, envelopeHash?: string) {
  const where = envelopeHash === undefined
    ? recipientRows(verdictId, recipientKeyHash)
    : and(recipientRows(verdictId, recipientKeyHash), eq(disclosures.envelopeHash, hex32.parse(envelopeHash)));
  const rows = await db.select().from(disclosures).where(where).orderBy(asc(disclosures.createdAt), asc(disclosures.envelopeHash)).limit(1);
  return rows[0] ?? null;
}

/** Envelope hashes for a verdict and recipient, oldest first, at most `limit`; `total` counts them all. */
export async function listDisclosures(db: Database, verdictId: string, recipientKeyHash: string, limit = DISCLOSURE_LIST_LIMIT) {
  const [rows, counted] = await Promise.all([
    db.select({ envelopeHash: disclosures.envelopeHash, createdAt: disclosures.createdAt }).from(disclosures)
      .where(recipientRows(verdictId, recipientKeyHash)).orderBy(asc(disclosures.createdAt), asc(disclosures.envelopeHash)).limit(limit),
    db.select({ value: count() }).from(disclosures).where(recipientRows(verdictId, recipientKeyHash)),
  ]);
  return { envelopes: rows, total: Number(counted[0]?.value ?? 0) };
}

export async function upsertFeedSubscription(db: Database, feedId: string, consumer: string, until: Date, paid: bigint) {
  const row = { feedId: hex32.parse(feedId), consumer: address.parse(consumer.toLowerCase()), until, paid: paid.toString() };
  await db
    .insert(feedSubscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: [feedSubscriptions.feedId, feedSubscriptions.consumer],
      set: { until: row.until, paid: sql`${feedSubscriptions.paid} + excluded.paid` },
    });
}

export async function activeFeedSubscribers(db: Database, now: Date) {
  const result = await db.execute(sql`SELECT count(DISTINCT consumer)::int AS n FROM feed_subscriptions WHERE until > ${now.toISOString()}::timestamptz`);
  return Number((result as unknown as { n: number }[])[0]?.n ?? 0);
}

export async function insertPanelPayload(db: Database, input: {
  caseId: string; panelIndex: number; evaluator: string; payloadHash: string; payload: Uint8Array; answerJson?: string;
}) {
  await db
    .insert(panelPayloads)
    .values({
      caseId: hex32.parse(input.caseId),
      panelIndex: z.union([z.literal(0), z.literal(1)]).parse(input.panelIndex),
      evaluator: address.parse(input.evaluator.toLowerCase()),
      payloadHash: hex32.parse(input.payloadHash),
      payload: input.payload,
      answerJson: input.answerJson ?? null,
    })
    .onConflictDoNothing();
}

export async function getPanelPayloadByHash(db: Database, caseId: string, payloadHash: string) {
  const rows = await db
    .select()
    .from(panelPayloads)
    .where(and(eq(panelPayloads.caseId, hex32.parse(caseId)), eq(panelPayloads.payloadHash, hex32.parse(payloadHash))))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Kill-criteria numbers (Overview §6): paid VERDICTs in [from, to) excluding FEED-path queries and excluding payers
 * in `internalPayers` (first-party consumers), plus the verdict count including them.
 */
export async function paidVerdictCounts(db: Database, from: Date, to: Date, internalPayers: string[]) {
  const internal = internalPayers.map((a) => a.toLowerCase());
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE q.pay_path <> 3 AND (q.payer IS NULL OR NOT (q.payer = ANY(string_to_array(${internal.join(",")}, ',')))))::int AS external,
      count(*)::int AS total
    FROM verdicts v JOIN queries q ON q.id = v.query_id
    WHERE v.status = 1 AND v.ts >= ${from.toISOString()}::timestamptz AND v.ts < ${to.toISOString()}::timestamptz`);
  const row = (result as unknown as { external: number; total: number }[])[0];
  return { external: Number(row?.external ?? 0), total: Number(row?.total ?? 0) };
}
