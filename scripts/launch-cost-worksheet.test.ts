import { expect, test } from 'bun:test';
import { calculateLaunchCostWorksheet, DISABLED_LAUNCH_COST_EXAMPLE } from './launch-cost-worksheet.ts';

test('keeps incomplete costs and funding shortfall unknown while exposing only a known subtotal', () => {
  const result = calculateLaunchCostWorksheet({
    totalReviews: 12,
    completedReviews: 8,
    costsUsd: {
      inferenceIncludingFailuresAndRetries: '0.015869',
      searchIncludingFailedRequests: null,
      settlementGas: null,
      hostingAllocation: null,
      otherUncovered: null,
    },
    verifiedProductFundingUsd: null,
  });

  expect(result.costCoverageComplete).toBe(false);
  expect(result.knownCostSubtotalUsdMicros).toBe('15869');
  expect(result.requiredFundingUsdMicros).toBeNull();
  expect(result.perAttemptCostUsdMicros).toBeNull();
  expect(result.perCompletedReviewCostUsdMicros).toBeNull();
  expect(result.shortfallUsdMicros).toBeNull();
});

test('calculates exact aggregate, per-attempt, per-completed and shortfall amounts in atomic units', () => {
  const result = calculateLaunchCostWorksheet({
    totalReviews: 3,
    completedReviews: 2,
    costsUsd: {
      inferenceIncludingFailuresAndRetries: '0.10',
      searchIncludingFailedRequests: '0.02',
      settlementGas: '0.01',
      hostingAllocation: '0.03',
      otherUncovered: '0.005',
    },
    verifiedProductFundingUsd: '0.04',
  });

  expect(result.costCoverageComplete).toBe(true);
  expect(result.requiredFundingUsdMicros).toBe('165000');
  expect(result.perAttemptCostUsdMicros).toBe('55000');
  expect(result.perCompletedReviewCostUsdMicros).toBe('82500');
  expect(result.shortfallUsdMicros).toBe('125000');
  expect(result.customerQuote).toEqual({
    tokensK: 1,
    jurorFeesUsdGMicros: '80000',
    protocolFeeUsdGMicros: '20000',
    grossCustomerChargeUsdGMicros: '100000',
    panelReserveShareUsdGMicros: '5000',
    postPanelReviewProtocolRemainderUsdGMicros: '15000',
    note: expect.any(String),
  });
});

test('does not claim coverage for a zero-review cohort and rejects imprecise or floating inputs', () => {
  const completeZeroRun = {
    totalReviews: 0,
    completedReviews: 0,
    costsUsd: {
      inferenceIncludingFailuresAndRetries: '0',
      searchIncludingFailedRequests: '0',
      settlementGas: '0',
      hostingAllocation: '0',
      otherUncovered: '0',
    },
    verifiedProductFundingUsd: null,
  };
  expect(calculateLaunchCostWorksheet(completeZeroRun).costCoverageComplete).toBe(false);
  expect(calculateLaunchCostWorksheet(DISABLED_LAUNCH_COST_EXAMPLE).requiredFundingUsdMicros).toBeNull();
  expect(calculateLaunchCostWorksheet(DISABLED_LAUNCH_COST_EXAMPLE).knownCostSubtotalUsdMicros).toBeNull();
  expect(() => calculateLaunchCostWorksheet({ ...completeZeroRun, costsUsd: { ...completeZeroRun.costsUsd, settlementGas: 0 as unknown as string } })).toThrow();
  expect(() => calculateLaunchCostWorksheet({ ...completeZeroRun, costsUsd: { ...completeZeroRun.costsUsd, settlementGas: '0.0000001' } })).toThrow();
  expect(() => calculateLaunchCostWorksheet({ ...completeZeroRun, costsUsd: { ...completeZeroRun.costsUsd, settlementGas: '9'.repeat(79) } })).toThrow();
});
