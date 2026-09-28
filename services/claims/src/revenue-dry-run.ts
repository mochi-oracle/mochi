import { planReviewRevenue, type RevenueObligations, type ReviewRevenuePlan } from './revenue.ts';
import { SqliteBuybackStore } from './buyback-sqlite-store.ts';

export type AllocatedRevenueDryRun = {
  execution: 'never';
  batchId: string;
  eventIds: string[];
  plan: ReviewRevenuePlan;
};

/** Plan only from the gross amount persisted by the settlement allocation ledger. */
export function planAllocatedReviewBatch(
  store: SqliteBuybackStore,
  batchId: string,
  input: { availableReviewFunds: bigint; usdgUnitsPerUsd: bigint; obligations: RevenueObligations },
): AllocatedRevenueDryRun {
  const allocation = store.allocation(batchId);
  if (!allocation) throw new Error('settled review batch has no persisted allocation');
  return {
    execution: 'never',
    batchId,
    eventIds: allocation.eventIds,
    plan: planReviewRevenue({
      grossReviewRevenue: allocation.amount,
      availableReviewFunds: input.availableReviewFunds,
      usdgUnitsPerUsd: input.usdgUnitsPerUsd,
      obligations: input.obligations,
    }),
  };
}

