/**
 * Pure planner for a future review-revenue allocation boundary. This is not a
 * ledger, settlement adapter, purchase worker, or statement about current
 * QueryEscrow routing. Callers should persist the inputs and result under a
 * stable settlement/batch ID; retries should return that stored plan rather
 * than creating a second allocation from changed balances.
 *
 * Only settled customer-review USDG belongs in `grossReviewRevenue`. Creator
 * and developer fees are separate and are deliberately not part of this API.
 */

export type RevenueObligations = {
  /** Measured or accrued provider/model costs. */
  modelLiabilities: bigint | null;
  /** Measured hosting, retrieval, enclave, gas, or other service costs. */
  infrastructureLiabilities: bigint | null;
  /** Refunds owed or reserved for this review-revenue pool. */
  refunds: bigint | null;
  /** Explicit operating or protocol reserves retained from this pool. */
  reserves: bigint | null;
};

export type RevenuePlanInput = {
  /** Atomic USDG units of settled customer review charges in this allocation scope. */
  grossReviewRevenue: bigint;
  /** Atomic USDG units actually available in the review-revenue account/pool. */
  availableReviewFunds: bigint;
  /** Atomic USDG units in one whole USDG. Must represent cents exactly. */
  usdgUnitsPerUsd: bigint;
  obligations: RevenueObligations;
};

export type RevenuePlanBlockReason =
  | 'incomplete_obligations'
  | 'gross_revenue_does_not_cover_obligations'
  | 'available_review_funds_do_not_cover_obligations';

export type ReviewRevenuePlan = {
  currency: 'USDG';
  usdgUnitsPerUsd: bigint;
  grossReviewRevenue: bigint;
  availableReviewFunds: bigint;
  obligations: RevenueObligations;
  totalObligations: bigint | null;
  /** Residual implied by gross revenue after obligations; null if any obligation is unknown. */
  theoreticalResidual: bigint | null;
  /** Actual available review funds after obligations, floored at zero. */
  availableAfterObligations: bigint | null;
  /** Maximum amount eligible for a future purchase policy; never negative or over either cap. */
  eligibleResidual: bigint;
  eligible: boolean;
  blockedReasons: RevenuePlanBlockReason[];
};

const obligationKeys = [
  'modelLiabilities',
  'infrastructureLiabilities',
  'refunds',
  'reserves',
] as const satisfies readonly (keyof RevenueObligations)[];

function assertNonNegative(name: string, amount: bigint): void {
  if (amount < 0n) throw new RangeError(`${name} must be non-negative`);
}

/**
 * Calculate a conservative residual from settled customer-review funds.
 * Unknown obligations block eligibility, while known values remain visible
 * for audit. This function performs no I/O and cannot move funds.
 */
export function planReviewRevenue(input: RevenuePlanInput): ReviewRevenuePlan {
  assertNonNegative('grossReviewRevenue', input.grossReviewRevenue);
  assertNonNegative('availableReviewFunds', input.availableReviewFunds);
  if (input.usdgUnitsPerUsd <= 0n || input.usdgUnitsPerUsd % 100n !== 0n) {
    throw new RangeError('usdgUnitsPerUsd must be positive and divisible by 100 so cents are exact');
  }

  let knownObligations = 0n;
  let complete = true;
  for (const key of obligationKeys) {
    const amount = input.obligations[key];
    if (amount === null) {
      complete = false;
      continue;
    }
    assertNonNegative(key, amount);
    knownObligations += amount;
  }

  const totalObligations = complete ? knownObligations : null;
  const theoreticalResidual = complete
    ? maxZero(input.grossReviewRevenue - knownObligations)
    : null;
  const availableAfterObligations = complete
    ? maxZero(input.availableReviewFunds - knownObligations)
    : null;
  const blockedReasons: RevenuePlanBlockReason[] = [];

  if (!complete) blockedReasons.push('incomplete_obligations');
  if (complete && input.grossReviewRevenue < knownObligations) {
    blockedReasons.push('gross_revenue_does_not_cover_obligations');
  }
  if (complete && input.availableReviewFunds < knownObligations) {
    blockedReasons.push('available_review_funds_do_not_cover_obligations');
  }

  const eligibleResidual = complete
    ? min(theoreticalResidual!, availableAfterObligations!)
    : 0n;
  return {
    currency: 'USDG',
    usdgUnitsPerUsd: input.usdgUnitsPerUsd,
    grossReviewRevenue: input.grossReviewRevenue,
    availableReviewFunds: input.availableReviewFunds,
    obligations: { ...input.obligations },
    totalObligations,
    theoreticalResidual,
    availableAfterObligations,
    eligibleResidual,
    eligible: complete && blockedReasons.length === 0,
    blockedReasons,
  };
}

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
