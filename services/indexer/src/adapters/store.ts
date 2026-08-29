import { and, eq, isNull, sql } from "drizzle-orm";
import {
  anchors,
  chainCursors,
  createDb,
  crosschecks,
  disagreement,
  escalations,
  getCursor,
  insertAnonymaVoucher,
  insertCrosscheck,
  insertEscalation,
  jurors,
  queries,
  receipts,
  setCursor,
  updateQueryStatus,
  upsertFeed,
  getJurorPassports,
  purgeExpiredPrivateResults,
  recordModelDisagreement,
  setQueryPayer,
  upsertFeedSubscription,
  upsertJuror,
  verdictPublic,
  verdicts,
} from "@mochi/db";
import { QueryStatus, VerdictStatus } from "@mochi/core";
import { merkleProof, receiptLeaf } from "@mochi/receipts";
import type { Hex } from "viem";
import type {
  ChainEvent,
  ChainVerdict,
  DisagreementWrite,
  PublicVerdictPart,
  ReceiptRow,
  StorePort,
} from "../ports.ts";

type Data = Record<string, unknown>;

/** Treat an untrusted event value as a record when it has object shape. */
function asRecord(value: unknown): Data | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Data
    : undefined;
}

/** Read a required string event field. */
function stringField(value: unknown): string {
  return String(value ?? "");
}

/** Insert an event's crosscheck record at most once. */
async function insertCrosscheckOnce(
  db: ReturnType<typeof createDb>["db"],
  input: Parameters<typeof insertCrosscheck>[1],
): Promise<void> {
  const eventId = String((input.detail as Data).event_id);
  const existing = await db.select()
    .from(crosschecks)
    .where(sql`${crosschecks.detail}->>'event_id' = ${eventId}`)
    .limit(1);
  if (existing.length === 0) await insertCrosscheck(db, input);
}

/** Persist event-derived read models and their status transitions. */
async function applyEventToDatabase(
  db: ReturnType<typeof createDb>["db"],
  event: ChainEvent,
): Promise<void> {
  const args = event.args;
  const query = asRecord(args.query);
  const verdictId = stringField(args.verdictId).toLowerCase();
  const eventId = `${event.transactionHash}:${event.logIndex}`;

  if (event.name === "QueryOpened" && query) {
    await db.insert(queries).values({
      id: stringField(args.queryId).toLowerCase(),
      ts: new Date(stringField(query.ts) || event.timestamp),
      docCommit: stringField(query.docCommit).toLowerCase(),
      schemaId: Number(query.schemaId),
      schemaVersion: Number(query.schemaVersion),
      n: Number(query.n),
      round: Number(query.round),
      isPublic: Boolean(query.isPublic),
      payPath: Number(query.payPath),
      payerCommit: stringField(query.payerCommit).toLowerCase(),
      paramsHash: stringField(query.paramsHash).toLowerCase(),
      provenanceKind: Number(query.provenanceKind),
      originId: stringField(query.originId).toLowerCase(),
      tokensK: Number(query.tokensK),
      status: QueryStatus.OPEN,
    }).onConflictDoNothing();
    return;
  }

  if ([
    "QuerySealed",
    "QueryExpanded",
    "QueryEscalated",
    "QueryDecidedByPanel",
    "QuerySettled",
    "QueryExpired",
  ].includes(event.name)) {
    let status = Number(query?.status ?? QueryStatus.OPEN);
    if (event.name === "QuerySealed") status = QueryStatus.SEALED;
    if (event.name === "QueryExpanded") status = QueryStatus.OPEN;
    if (event.name === "QuerySettled") {
      status = Number(args.status) === VerdictStatus.VERDICT
        ? QueryStatus.DECIDED
        : QueryStatus.HUNG;
    }
    if (event.name === "QueryExpired") status = QueryStatus.EXPIRED;
    if (event.name === "QueryEscalated") status = QueryStatus.ESCALATED;
    if (event.name === "QueryDecidedByPanel") status = QueryStatus.DECIDED;

    if (query) {
      await db.insert(queries).values({
        id: stringField(args.queryId).toLowerCase(),
        ts: new Date(stringField(query.ts) || event.timestamp),
        docCommit: stringField(query.docCommit).toLowerCase(),
        schemaId: Number(query.schemaId),
        schemaVersion: Number(query.schemaVersion),
        n: Number(query.n),
        round: Number(query.round),
        isPublic: Boolean(query.isPublic),
        payPath: Number(query.payPath),
        payerCommit: stringField(query.payerCommit).toLowerCase(),
        paramsHash: stringField(query.paramsHash).toLowerCase(),
        provenanceKind: Number(query.provenanceKind),
        originId: stringField(query.originId).toLowerCase(),
        tokensK: Number(query.tokensK),
        status,
      }).onConflictDoUpdate({
        target: queries.id,
        set: { status, round: Number(query.round), n: Number(query.n) },
      });
    } else {
      await updateQueryStatus(db, stringField(args.queryId), status);
    }
    return;
  }

  if (event.name === "VerdictPosted" || event.name === "PanelVerdictPosted") {
    const verdict = asRecord(args.verdict);
    if (!verdict) return;
    await db.insert(verdicts).values({
      id: verdictId,
      ts: new Date(Number(verdict.ts) * 1_000 || event.timestamp.getTime()),
      queryId: stringField(verdict.queryId).toLowerCase(),
      round: Number(verdict.round),
      status: Number(verdict.status),
      agreementBps: Number(verdict.agreementBps),
      dissentMask: BigInt(String(verdict.dissentMask ?? 0)),
      timeoutMask: BigInt(String(verdict.timeoutMask ?? 0)),
      evidenceRoot: stringField(verdict.evidenceRoot).toLowerCase(),
      attestationRoot: stringField(verdict.attestationRoot).toLowerCase(),
      answerHash: stringField(verdict.answerHash).toLowerCase(),
      payloadHash: stringField(verdict.payloadHash).toLowerCase(),
      isPublic: Boolean(verdict.isPublic),
      escalated: Boolean(verdict.escalated),
      tx: event.transactionHash.toLowerCase(),
    }).onConflictDoNothing();
    return;
  }

  if (event.name === "AnonymaVoucherUsed") {
    await insertAnonymaVoucher(db, {
      voucherId: stringField(args.voucherId),
      queryId: stringField(args.queryId),
      tier: Number(args.tier),
      usdgAmount: stringField(args.amount),
      settled: false,
    });
    return;
  }

  if (event.name === "Subscribed") {
    await upsertFeedSubscription(
      db,
      stringField(args.feedId),
      stringField(args.consumer),
      new Date(Number(args.until) * 1_000),
      BigInt(String(args.paid)),
    );
    return;
  }

  if (event.name === "FeedUpdated") {
    await upsertFeed(
      db,
      stringField(args.feedId),
      stringField(args.key),
      stringField(args.verdictId),
      new Date(Number(args.asOf) * 1_000),
    );
    const knownVerdict = await db.select({ schemaId: queries.schemaId })
      .from(verdicts)
      .innerJoin(queries, eq(verdicts.queryId, queries.id))
      .where(eq(verdicts.id, stringField(args.verdictId).toLowerCase()))
      .limit(1);
    if (knownVerdict.length > 0 && args.crosscheckEnabled === true) {
      await insertCrosscheckOnce(db, {
        feedId: stringField(args.feedId),
        key: stringField(args.key),
        verdictId: stringField(args.verdictId),
        ok: true,
        detail: { event_id: eventId },
        ts: event.timestamp,
      });
    }
    return;
  }

  if (event.name === "CrosscheckFailed") {
    await insertCrosscheckOnce(db, {
      feedId: stringField(args.feedId),
      key: stringField(args.key),
      verdictId: stringField(args.verdictId),
      ok: false,
      detail: { reason: stringField(args.reason), event_id: eventId },
      ts: event.timestamp,
    });
    return;
  }

  if (["Enrolled", "AttestationRefreshed", "Slashed", "Delisted"].includes(event.name)) {
    const juror = asRecord(args.juror);
    if (!juror) return;
    const key = stringField(args.key).toLowerCase();
    const previous = await db.select().from(jurors).where(eq(jurors.key, key)).limit(1);
    const previousSlashed = previous[0]?.slashed ?? juror.slashed ?? "0";
    const slashed = event.name === "Slashed"
      ? BigInt(String(previousSlashed)) + BigInt(String(args.amount ?? 0))
      : BigInt(String(previousSlashed));
    await upsertJuror(db, {
      key,
      operator: stringField(juror.operator).toLowerCase(),
      measurement: stringField(juror.measurement).toLowerCase(),
      class: Number(juror.jurorClass),
      role: Number(juror.role),
      bond: stringField(juror.bond),
      attestedUntil: new Date(stringField(juror.attestedUntil)),
      uptime30d: Number(juror.uptime30d ?? 0),
      served: Number(juror.served ?? 0),
      timeouts: Number(juror.timeouts ?? 0),
      slashed: slashed.toString(),
      delisted: Boolean(juror.delisted || event.name === "Delisted"),
    });
    return;
  }

  if (["Escalated", "Resolved", "Finalized"].includes(event.name)) {
    const caseView = asRecord(args.caseView);
    const queryId = stringField(args.queryId ?? caseView?.queryId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(queryId)) return;
    const round = Number(args.panelIndex ?? caseView?.panelIndex ?? 0);
    const key = and(eq(escalations.queryId, queryId.toLowerCase()), eq(escalations.round, round));
    const existing = await db.select().from(escalations).where(key).limit(1);
    const row = {
      queryId,
      round,
      panel: Array.isArray(args.panel) ? args.panel.map((a) => String(a).toLowerCase()) : [],
      outcome: { event: event.name, event_id: eventId, ...args },
      appealed: Boolean(args.appealed),
      ts: event.timestamp,
    };
    if (existing.length > 0) await db.update(escalations).set(row).where(key);
    else await insertEscalation(db, row);
  }
}

/** Aggregate Drizzle operations behind the indexer's persistence port. */
export function createStoreAdapter(dbUrl: string) {
  const { db, close } = createDb(dbUrl);
  const store: StorePort & { close: () => Promise<void> } = {
    close,
    getCursor: (name) => getCursor(db, name),
    setCursor: (name, block) => setCursor(db, name, block),
    applyEvent: (event) => applyEventToDatabase(db, event),
    getJurorPassports: (keys) => getJurorPassports(db, keys),
    recordModelDisagreement: (rows) => recordModelDisagreement(db, rows),
    purgeExpiredPrivateResults: (now) => purgeExpiredPrivateResults(db, now),
    setQueryPayer: (queryId, payer) => setQueryPayer(db, queryId, payer.toLowerCase()),
    upsertFeedSubscription: (feedId, consumer, until, paid) =>
      upsertFeedSubscription(db, feedId, consumer.toLowerCase(), until, paid),

    async getVerdict(id) {
      const rows = await db.select({ verdict: verdicts, publicPart: verdictPublic })
        .from(verdicts)
        .leftJoin(verdictPublic, eq(verdictPublic.verdictId, verdicts.id))
        .where(eq(verdicts.id, id.toLowerCase()))
        .limit(1);
      const row = rows[0];
      return row
        ? {
            verdict: row.verdict as unknown as Record<string, unknown>,
            publicPart: row.publicPart as PublicVerdictPart | null,
          }
        : null;
    },

    async listUnreceiptedVerdicts() {
      const rows = await db.select({ verdict: verdicts, query: queries })
        .from(verdicts)
        .innerJoin(queries, eq(verdicts.queryId, queries.id));
      const receiptRows = await db.select({ id: receipts.verdictId }).from(receipts);
      const receiptedIds = new Set(receiptRows.map((row) => row.id));
      return rows.filter(({ verdict }) => !receiptedIds.has(verdict.id)).map(({ verdict, query }) => ({
        id: verdict.id as Hex,
        queryId: verdict.queryId as Hex,
        round: verdict.round,
        status: verdict.status,
        isPublic: query.isPublic,
        escalated: verdict.escalated,
        agreementBps: verdict.agreementBps,
        dissentMask: Number(verdict.dissentMask),
        timeoutMask: Number(verdict.timeoutMask),
        ts: BigInt(Math.floor(verdict.ts.getTime() / 1_000)),
        schemaId: query.schemaId,
        schemaVersion: query.schemaVersion,
        n: query.n,
        payPath: query.payPath,
        payerCommit: query.payerCommit as Hex,
        paramsHash: query.paramsHash as Hex,
        provenanceKind: query.provenanceKind,
        originId: query.originId as Hex,
        tokensK: query.tokensK,
        docCommit: query.docCommit as Hex,
        modelSetHash: `0x${"00".repeat(32)}` as Hex,
        evidenceRoot: verdict.evidenceRoot as Hex,
        attestationRoot: verdict.attestationRoot as Hex,
        answerHash: verdict.answerHash as Hex,
        payloadHash: verdict.payloadHash as Hex,
        provenanceHash: `0x${"00".repeat(32)}` as Hex,
        tx: verdict.tx as Hex,
      } satisfies ChainVerdict));
    },

    async insertReceipt(receipt, disagreementRows = []) {
      await db.transaction(async (transaction) => {
        const inserted = await transaction.insert(receipts).values({
          verdictId: receipt.verdictId.toLowerCase(),
          keyId: receipt.keyId,
          sig: typeof receipt.sig === "string" ? Buffer.from(receipt.sig, "base64") : receipt.sig,
          payload: receipt.payload,
          // The loop uses anchorIndex -1 for "not yet anchored"; the DB stores that as NULL.
          anchorRoot: receipt.anchorIndex < 0 ? null : receipt.anchorRoot,
          anchorIndex: receipt.anchorIndex < 0 ? null : receipt.anchorIndex,
        }).onConflictDoNothing().returning({ verdictId: receipts.verdictId });
        if (inserted.length === 0) return;
        for (const row of disagreementRows) {
          await transaction.insert(disagreement).values({
            ...row,
            window: row.window,
            disagreeRate: String(row.disagreeRate),
          }).onConflictDoUpdate({
            target: [
              disagreement.schemaId,
              disagreement.field,
              disagreement.class,
              disagreement.window,
              disagreement.bucket,
            ],
            set: {
              samples: sql`${disagreement.samples} + excluded.samples`,
              disagreeCount: sql`${disagreement.disagreeCount} + excluded.disagree_count`,
              disagreeRate: sql`COALESCE(
                (${disagreement.disagreeCount} + excluded.disagree_count)::numeric
                / NULLIF(${disagreement.samples} + excluded.samples, 0),
                0
              )`,
            },
          });
        }
      });
    },

    async getReceipt(id) {
      const row = (await db.select().from(receipts)
        .where(eq(receipts.verdictId, id.toLowerCase()))
        .limit(1))[0];
      return row
        ? {
            verdictId: row.verdictId,
            keyId: row.keyId,
            sig: row.sig,
            payload: row.payload as ReceiptRow["payload"],
            anchorRoot: row.anchorRoot ?? `0x${"00".repeat(32)}`,
            anchorIndex: row.anchorIndex ?? -1,
          }
        : null;
    },

    async listUnanchoredReceipts() {
      const rows = await db.select().from(receipts).where(isNull(receipts.anchorIndex));
      return rows.map((row) => ({
        verdictId: row.verdictId,
        payload: row.payload as ReceiptRow["payload"],
      }));
    },

    async insertAnchor(anchor) {
      await db.insert(anchors).values(anchor).onConflictDoNothing();
    },

    async updateReceiptAnchor(root, entries) {
      for (const entry of entries) {
        await db.update(receipts)
          .set({ anchorRoot: root, anchorIndex: entry.index })
          .where(eq(receipts.verdictId, entry.verdictId.toLowerCase()));
      }
    },

    async recordDisagreement(rows) {
      for (const row of rows) await insertOrAggregateDisagreement(db, row);
    },

    async status() {
      const rows = await db.select().from(chainCursors);
      return Object.fromEntries(rows.map((row) => [row.name, row.block]));
    },

    async getReceiptAnchor(verdictId) {
      const receipt = await store.getReceipt(verdictId);
      if (!receipt || receipt.anchorIndex < 0) return null;
      const anchor = (await db.select().from(anchors)
        .where(eq(anchors.root, receipt.anchorRoot))
        .limit(1))[0];
      if (!anchor) return null;
      const rows = await db.select({ payload: receipts.payload })
        .from(receipts)
        .where(eq(receipts.anchorRoot, receipt.anchorRoot));
      const sortedLeaves = rows.map((row) => receiptLeaf(row.payload)).sort();
      return {
        root: receipt.anchorRoot as Hex,
        tx: anchor.tx as Hex,
        proof: merkleProof(sortedLeaves, receiptLeaf(receipt.payload)),
      };
    },
  };
  return { store, db, close };
}

/** Insert or merge one disagreement aggregate. */
async function insertOrAggregateDisagreement(
  db: ReturnType<typeof createDb>["db"],
  row: DisagreementWrite,
): Promise<void> {
  await db.insert(disagreement).values({
    ...row,
    window: row.window,
    disagreeRate: String(row.disagreeRate),
  }).onConflictDoUpdate({
    target: [
      disagreement.schemaId,
      disagreement.field,
      disagreement.class,
      disagreement.window,
      disagreement.bucket,
    ],
    set: {
      samples: sql`${disagreement.samples} + excluded.samples`,
      disagreeCount: sql`${disagreement.disagreeCount} + excluded.disagree_count`,
      disagreeRate: sql`COALESCE(
        (${disagreement.disagreeCount} + excluded.disagree_count)::numeric
        / NULLIF(${disagreement.samples} + excluded.samples, 0),
        0
      )`,
    },
  });
}
