/** USDG policy v1. Monetary values are atomic units (6 decimals), never floats. */
export const USDG_UNITS = 1_000_000n;
export const MINIMUM_PURCHASE = 25n * USDG_UNITS;
export const OPERATING_RESERVE_DAYS = 30n;
export const MAX_BUDGET_AGE_MS = 24 * 60 * 60 * 1000;

export type OperatingBudget = {
  /** Approved accounting period/version; not inferred from a wallet balance. */
  budgetId: string;
  asOfMs: number;
  /** Future daily costs not covered by juror/panel or another allocation. */
  uncoveredDailyOperatingCost: bigint | null;
  /** Existing earmarked reserve INCLUDED in the treasury balance. */
  retainedOperatingReserve: bigint | null;
};
export type OperatingPolicy = {
  budgetId: string;
  asOfMs: number;
  reserveTarget: bigint;
  retainedReserve: bigint;
  requiredTopUp: bigint;
  minimumPurchase: bigint;
};

export function evaluateOperatingPolicy(budget: OperatingBudget | undefined, expectedId: string, nowMs: number): OperatingPolicy | undefined {
  if (!budget || !expectedId || budget.budgetId !== expectedId
    || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(budget.asOfMs)
    || budget.asOfMs < 0 || budget.asOfMs > nowMs || nowMs - budget.asOfMs > MAX_BUDGET_AGE_MS
    || typeof budget.uncoveredDailyOperatingCost !== 'bigint' || budget.uncoveredDailyOperatingCost < 0n
    || typeof budget.retainedOperatingReserve !== 'bigint' || budget.retainedOperatingReserve < 0n) return undefined;
  const reserveTarget = budget.uncoveredDailyOperatingCost * OPERATING_RESERVE_DAYS;
  return {
    budgetId: budget.budgetId, asOfMs: budget.asOfMs, reserveTarget,
    retainedReserve: budget.retainedOperatingReserve,
    requiredTopUp: reserveTarget > budget.retainedOperatingReserve ? reserveTarget - budget.retainedOperatingReserve : 0n,
    minimumPurchase: MINIMUM_PURCHASE,
  };
}
