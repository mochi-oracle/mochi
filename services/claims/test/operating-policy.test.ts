import { expect, test } from 'bun:test';
import { evaluateOperatingPolicy, MAX_BUDGET_AGE_MS, MINIMUM_PURCHASE } from '../src/operating-policy.ts';

const now = 2_000_000;
const budget = { budgetId: 'reviewed-costs-v1', asOfMs: now, uncoveredDailyOperatingCost: 2_000_000n, retainedOperatingReserve: 40_000_000n };
test('30-day reserve keeps retained funds separate and requests only the shortfall', () => {
  expect(evaluateOperatingPolicy(budget, budget.budgetId, now)).toMatchObject({ reserveTarget: 60_000_000n, retainedReserve: 40_000_000n, requiredTopUp: 20_000_000n, minimumPurchase: 25_000_000n });
  expect(evaluateOperatingPolicy({ ...budget, retainedOperatingReserve: 80_000_000n }, budget.budgetId, now)?.requiredTopUp).toBe(0n);
  expect(MINIMUM_PURCHASE).toBe(25_000_000n);
});
test('unknown costs, stale/future snapshots and unapproved budgets fail closed', () => {
  for (const change of [{ uncoveredDailyOperatingCost: null }, { retainedOperatingReserve: null }, { uncoveredDailyOperatingCost: -1n }, { retainedOperatingReserve: -1n }, { asOfMs: now + 1 }, { budgetId: 'different-budget' }]) {
    expect(evaluateOperatingPolicy({ ...budget, ...change }, budget.budgetId, now)).toBeUndefined();
  }
  expect(evaluateOperatingPolicy(budget, budget.budgetId, now + MAX_BUDGET_AGE_MS)).toBeDefined();
  expect(evaluateOperatingPolicy(budget, budget.budgetId, now + MAX_BUDGET_AGE_MS + 1)).toBeUndefined();
});
