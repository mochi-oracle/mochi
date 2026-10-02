import { and, eq, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { feedQueries, queries, jurorAnswers, verdicts } from "@mochi/db";
import { getCursor, setCursor, getFeedQuery, getPayerResultKey, insertJurorAnswer, insertVerdict, storePrivateResult, updateQueryStatus } from "@mochi/db";
import type { Database } from "@mochi/db";
import type { Hex } from "viem";
import type { Store } from "../ports.ts";

/**
 * Rows the orchestrator lists each tick. Terminal DB statuses (DECIDED 3, ESCALATED 5, EXPIRED 6) are only written after
 * everything is persisted. With `escalatedFeed`, ESCALATED feed queries are listed too (their panel case may need
 * escalating again); the orchestrator reads each one's case at most once per backoff period.
 */
export function openQueryFilter(escalatedFeed = false): SQL | undefined {
  const open = notInArray(queries.status, [3, 5, 6]);
  if (!escalatedFeed) return open;
  return or(open, and(eq(queries.status, 5), inArray(queries.id, sql`(select ${feedQueries.queryId} from ${feedQueries})`)));
}

export function createDbAdapter(db: Database): Store {
  return {
    async insertQuery(row) {
      const value = { id: row.id, ts: row.ts, docCommit: row.docCommit, schemaId: row.schemaId, schemaVersion: row.schemaVersion, n: row.n, round: row.round, isPublic: row.isPublic, payPath: row.payPath, payerCommit: row.payerCommit, paramsHash: row.paramsHash, provenanceKind: row.provenanceKind, originId: row.originId, tokensK: row.tokensK, status: row.status };
      await db.insert(queries).values(value).onConflictDoUpdate({ target: queries.id, set: { n: value.n, round: value.round, status: value.status } });
    },
    getCursor: (name) => getCursor(db, name), setCursor: (name, block) => setCursor(db, name, block),
    async queryIds(options) {
      const rows = await db.select({ id: queries.id }).from(queries).where(openQueryFilter(options?.escalatedFeed));
      return rows.map(x => x.id as Hex);
    },
    async hasVerdict(verdictId) {
      const rows = await db.select({ id: verdicts.id }).from(verdicts).where(eq(verdicts.id, verdictId)).limit(1);
      return rows.length > 0;
    },
    async getFeedQuery(id) { const row = await getFeedQuery(db, id); return row ? { feedId: row.feedId as Hex, key: row.key as Hex } : null; },
    async getPayerResultKey(payerCommit) { return (await getPayerResultKey(db, payerCommit)) as Hex | null; },
    insertJurorAnswer: (input) => insertJurorAnswer(db, { ...input, sig: new Uint8Array(input.sig) }),
    insertVerdict: (v, part) => insertVerdict(db, v as never, part as never),
    storePrivateResult: (id, bytes) => storePrivateResult(db, id, bytes),
    updateQueryStatus: (id, status) => updateQueryStatus(db, id, status),
    async statusCounts() {
      const rows = await db.select({ status: queries.status, count: sql<number>`count(*)::int` }).from(queries).groupBy(queries.status);
      return Object.fromEntries(rows.map(x => [String(x.status), x.count]));
    },
  };
}
