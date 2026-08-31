import {
  activeFeedSubscribers, getDisclosure, getJurorPassports, getPrivateResult, getVerdict,
  disagreementSeries, modelDisagreementSeries, listFeeds, paidVerdictCounts, putPayerResultKey,
  insertAnonymaVoucher, disclosures, type Database,
} from "@mochi/db";
import { and, count, eq, sql } from "drizzle-orm";
import type { Store } from "../ports.ts";

export function createGatewayStore(db: Database): Store {
  return {
    getVerdict: (id) => getVerdict(db, id),
    getPrivateResult: (id) => getPrivateResult(db, id),
    disagreementSeries: (schemaId, field, window) => disagreementSeries(db, schemaId, field, window),
    modelDisagreementSeries: (schemaId, field, window) => modelDisagreementSeries(db, schemaId, field, window),
    getJurorPassports: (keys) => getJurorPassports(db, keys),
    paidVerdictCounts: (from, to, internalPayers) => paidVerdictCounts(db, from, to, internalPayers),
    activeFeedSubscribers: (now) => activeFeedSubscribers(db, now),
    insertDisclosure: (verdictId, recipientKeyHash, envelope) => db.transaction(async (tx) => {
      // Serialize inserts per verdict so concurrent requests cannot exceed the public API cap.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${verdictId}, 0))`);
      const existing = await tx.select({ value: count() }).from(disclosures).where(and(
        eq(disclosures.verdictId, verdictId), eq(disclosures.recipientKeyHash, recipientKeyHash),
      ));
      if (Number(existing[0]?.value ?? 0) > 0) return true;
      const rows = await tx.select({ value: count() }).from(disclosures).where(eq(disclosures.verdictId, verdictId));
      if (Number(rows[0]?.value ?? 0) >= 20) return false;
      await tx.insert(disclosures).values({ verdictId, recipientKeyHash, envelope }).onConflictDoNothing();
      return true;
    }),
    getDisclosure: async (verdictId, recipientKeyHash) => {
      const disclosure = await getDisclosure(db, verdictId, recipientKeyHash);
      return disclosure ? { envelope: disclosure.envelope } : null;
    },
    listFeeds: (feedId) => listFeeds(db, feedId),
    putPayerResultKey: (payerCommit, pub) => putPayerResultKey(db, payerCommit, pub),
    insertAnonymaVoucher: (input) => insertAnonymaVoucher(db, input),
  };
}
