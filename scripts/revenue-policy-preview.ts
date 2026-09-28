import { readFileSync } from 'node:fs';
import { SqliteBuybackStore } from '../services/claims/src/buyback-sqlite-store.ts';
import { planOperatingReviewBatch } from '../services/claims/src/revenue-dry-run.ts';

const atomic = (value: unknown): bigint | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new Error('amounts must be non-negative atomic decimal strings or null');
  return BigInt(value);
};
if (import.meta.main) {
  let store: SqliteBuybackStore | undefined;
  try {
    const [path, batchId, manifest, ...extra] = process.argv.slice(2);
    if (!path || !batchId || !manifest || extra.length) throw new Error('usage: bun scripts/revenue-policy-preview.ts <sqlite> <batch-id> <budget.json>');
    const input = JSON.parse(readFileSync(manifest, 'utf8'));
    const available = atomic(input.availableReviewFunds);
    if (available === null) throw new Error('available funds must be known');
    store = new SqliteBuybackStore(path);
    const result = planOperatingReviewBatch(store, batchId, {
      availableReviewFunds: available,
      approvedBudgetId: input.approvedBudgetId,
      nowMs: Date.now(),
      budget: { budgetId: input.budgetId, asOfMs: input.asOfMs,
        uncoveredDailyOperatingCost: atomic(input.uncoveredDailyOperatingCost),
        retainedOperatingReserve: atomic(input.retainedOperatingReserve) },
      obligations: { modelLiabilities: atomic(input.modelLiabilities), infrastructureLiabilities: atomic(input.infrastructureLiabilities), refunds: atomic(input.refunds) },
    });
    console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch { console.error('Policy preview failed: require an allocated batch and complete, fresh approved budget manifest. No transaction was sent.'); process.exitCode = 1; }
  finally { store?.close(); }
}
