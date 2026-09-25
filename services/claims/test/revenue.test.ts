import { describe, expect, test } from 'bun:test';
import { planReviewRevenue, type RevenuePlanInput } from '../src/revenue.ts';

const usdgUnitsPerUsd = 1_000_000n;

function input(overrides: Partial<RevenuePlanInput> = {}): RevenuePlanInput {
  return {
    grossReviewRevenue: 50_000n,
    availableReviewFunds: 50_000n,
    usdgUnitsPerUsd,
    obligations: {
      modelLiabilities: 20_000n,
      infrastructureLiabilities: 5_000n,
      refunds: 5_000n,
      reserves: 10_000n,
    },
    ...overrides,
  };
}

describe('planReviewRevenue', () => {
  test('plans a five-cent review residual using exact USDG atomic units', () => {
    const plan = planReviewRevenue(input());
    expect(plan.grossReviewRevenue).toBe(50_000n); // $0.05 at 1,000,000 units per USDG.
    expect(plan.totalObligations).toBe(40_000n);
    expect(plan.theoreticalResidual).toBe(10_000n);
    expect(plan.availableAfterObligations).toBe(10_000n);
    expect(plan.eligibleResidual).toBe(10_000n);
    expect(plan.eligible).toBe(true);
    expect(plan.blockedReasons).toEqual([]);
  });

  test('unknown model costs block eligibility without treating unknown as zero', () => {
    const plan = planReviewRevenue(input({
      obligations: { ...input().obligations, modelLiabilities: null },
    }));
    expect(plan.totalObligations).toBeNull();
    expect(plan.theoreticalResidual).toBeNull();
    expect(plan.availableAfterObligations).toBeNull();
    expect(plan.eligibleResidual).toBe(0n);
    expect(plan.eligible).toBe(false);
    expect(plan.blockedReasons).toEqual(['incomplete_obligations']);
  });

  test('refund obligations reduce residual and inadequate gross or cash blocks it', () => {
    const grossShort = planReviewRevenue(input({ grossReviewRevenue: 39_999n }));
    expect(grossShort.eligibleResidual).toBe(0n);
    expect(grossShort.blockedReasons).toContain('gross_revenue_does_not_cover_obligations');

    const cashShort = planReviewRevenue(input({ availableReviewFunds: 39_999n }));
    expect(cashShort.theoreticalResidual).toBe(10_000n);
    expect(cashShort.availableAfterObligations).toBe(0n);
    expect(cashShort.eligibleResidual).toBe(0n);
    expect(cashShort.blockedReasons).toContain('available_review_funds_do_not_cover_obligations');
  });

  test('caps the residual at actual available review funds after obligations', () => {
    const plan = planReviewRevenue(input({
      grossReviewRevenue: 100_000n,
      availableReviewFunds: 42_001n,
    }));
    expect(plan.theoreticalResidual).toBe(60_000n);
    expect(plan.availableAfterObligations).toBe(2_001n);
    expect(plan.eligibleResidual).toBe(2_001n);
    expect(plan.eligibleResidual).toBeLessThanOrEqual(plan.theoreticalResidual!);
    expect(plan.eligibleResidual).toBeLessThanOrEqual(plan.availableAfterObligations!);
  });

  test('preserves atomic-unit precision and has no creator/developer fee input or allocation', () => {
    const plan = planReviewRevenue(input({
      grossReviewRevenue: 50_001n,
      availableReviewFunds: 50_001n,
      obligations: {
        modelLiabilities: 20_000n,
        infrastructureLiabilities: 5_000n,
        refunds: 5_000n,
        reserves: 10_000n,
      },
    }));
    expect(plan.eligibleResidual).toBe(10_001n);
    expect(Object.keys(plan)).not.toContain('developerCreatorFees');
    expect(Object.keys(plan)).not.toContain('developerRevenue');
  });

  test('requires a scale that represents cents exactly and rejects negative balances', () => {
    expect(() => planReviewRevenue(input({ usdgUnitsPerUsd: 1_001n }))).toThrow('divisible by 100');
    expect(() => planReviewRevenue(input({ availableReviewFunds: -1n }))).toThrow('non-negative');
    expect(() => planReviewRevenue(input({
      obligations: { ...input().obligations, refunds: -1n },
    }))).toThrow('non-negative');
  });
});
