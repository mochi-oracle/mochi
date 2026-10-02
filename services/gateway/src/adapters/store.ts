import {
  activeFeedSubscribers, getDisclosure, getJurorPassports, getPrivateResult, getVerdict,
  disagreementSeries, modelDisagreementSeries, listFeeds, paidVerdictCounts, putPayerResultKey,
  insertAnonymaVoucher, insertDisclosure, listDisclosures, type Database,
} from "@mochi/db";
import { sql } from "drizzle-orm";
import type { Store } from "../ports.ts";
import { log } from "../log.ts";

/**
 * Payer-key rows are written before a private query is opened on-chain. Rows that no indexed query references after
 * the retention window are garbage from abandoned or abusive preparations; purge them at most once per interval.
 */
export const PAYER_KEY_RETENTION_DAYS = 7;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;
export function purgeUnopenedPayerKeys(db: Pick<Database, "execute">) {
  return db.execute(sql`DELETE FROM payer_result_keys k WHERE k.created_at < now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM queries q WHERE q.payer_commit = k.payer_commit)`);
}

export function createGatewayStore(db: Database, options: { now?: () => number } = {}): Store {
  const now = options.now ?? Date.now;
  let lastPurge = -Infinity;
  return {
    getVerdict: (id) => getVerdict(db, id),
    getPrivateResult: (id) => getPrivateResult(db, id),
    disagreementSeries: (schemaId, field, window) => disagreementSeries(db, schemaId, field, window),
    modelDisagreementSeries: (schemaId, field, window) => modelDisagreementSeries(db, schemaId, field, window),
    getJurorPassports: (keys) => getJurorPassports(db, keys),
    paidVerdictCounts: (from, to, internalPayers) => paidVerdictCounts(db, from, to, internalPayers),
    activeFeedSubscribers: (now) => activeFeedSubscribers(db, now),
    insertDisclosure: (verdictId, recipientKeyHash, envelopeHash, envelope) => insertDisclosure(db, verdictId, recipientKeyHash, envelopeHash, envelope),
    getDisclosure: async (verdictId, recipientKeyHash, envelopeHash) => {
      const disclosure = await getDisclosure(db, verdictId, recipientKeyHash, envelopeHash);
      return disclosure ? { envelopeHash: disclosure.envelopeHash, envelope: disclosure.envelope } : null;
    },
    listDisclosures: (verdictId, recipientKeyHash) => listDisclosures(db, verdictId, recipientKeyHash),
    listFeeds: (feedId) => listFeeds(db, feedId),
    putPayerResultKey: async (payerCommit, pub) => {
      await putPayerResultKey(db, payerCommit, pub);
      if (now() - lastPurge < PURGE_INTERVAL_MS) return;
      lastPurge = now();
      await purgeUnopenedPayerKeys(db).catch((error: unknown) => log("error", "payer_key_purge_failed", { message: String((error as Error)?.message ?? error).slice(0, 200) }));
    },
    insertAnonymaVoucher: (input) => insertAnonymaVoucher(db, input),
  };
}
