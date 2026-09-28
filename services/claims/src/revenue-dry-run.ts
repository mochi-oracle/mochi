import { planReviewRevenue, type RevenueObligations, type ReviewRevenuePlan } from './revenue.ts';
import { SqliteBuybackStore } from './buyback-sqlite-store.ts';
import { evaluateOperatingPolicy, USDG_UNITS, type OperatingBudget } from './operating-policy.ts';

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

/** Production policy preview: protect existing reserves and derive the required top-up. */
export function planOperatingReviewBatch(
  store: SqliteBuybackStore,
  batchId: string,
  input: { availableReviewFunds: bigint; obligations: Omit<RevenueObligations, 'reserves'>; budget: OperatingBudget; approvedBudgetId: string; nowMs: number },
) {
  const policy = evaluateOperatingPolicy(input.budget, input.approvedBudgetId, input.nowMs);
  if (!policy) throw new Error('fresh approved operating budget required');
  if (input.availableReviewFunds < 0n) throw new Error('available review funds must be non-negative');
  const spendable = input.availableReviewFunds > policy.retainedReserve ? input.availableReviewFunds - policy.retainedReserve : 0n;
  const result = planAllocatedReviewBatch(store, batchId, {
    availableReviewFunds: spendable, usdgUnitsPerUsd: USDG_UNITS,
    obligations: { ...input.obligations, reserves: policy.requiredTopUp },
  });
  const batchReady = result.plan.eligible && result.plan.eligibleResidual >= policy.minimumPurchase;
  return { ...result, operatingPolicy: policy, batchReady, purchaseAmount: batchReady ? result.plan.eligibleResidual : 0n };
}
