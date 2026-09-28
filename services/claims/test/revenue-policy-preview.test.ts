import { expect, test } from 'bun:test';
import { SqliteBuybackStore } from '../src/buyback-sqlite-store.ts';
import { planOperatingReviewBatch } from '../src/revenue-dry-run.ts';

test('policy preview derives top-up, protects retained reserve, and accumulates below $25', () => {
  const store = new SqliteBuybackStore(':memory:');
  try {
    store.recordSettledReviewEvent({ eventId: 'test', batchId: 'batch', amount: 100_000_000n, source: 'settled_customer_review' });
    store.allocateSettledReviewBatch({ batchId: 'batch', eventIds: ['test'] });
    const input = { availableReviewFunds: 100_000_000n, approvedBudgetId: 'v1', nowMs: 1000,
      budget: { budgetId: 'v1', asOfMs: 1000, uncoveredDailyOperatingCost: 2_000_000n, retainedOperatingReserve: 40_000_000n },
      obligations: { modelLiabilities: 0n, infrastructureLiabilities: 0n, refunds: 0n } };
    const result = planOperatingReviewBatch(store, 'batch', input);
    expect(result.operatingPolicy.requiredTopUp).toBe(20_000_000n);
    expect(result.purchaseAmount).toBe(40_000_000n);
    expect(result.execution).toBe('never');
    const small = planOperatingReviewBatch(store, 'batch', { ...input, availableReviewFunds: 84_999_999n });
    expect(small.batchReady).toBe(false);
    expect(small.purchaseAmount).toBe(0n);
    expect(() => planOperatingReviewBatch(store, 'batch', { ...input, nowMs: 1000 + 86_400_001 })).toThrow('fresh approved');
  } finally { store.close(); }
});
