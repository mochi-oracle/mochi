import { expect, test } from 'bun:test';
import { illustrateReviewEconomics } from '../site/src/tokenomics-policy.js';

test('five-cent allocations conserve funds, including fractional cents', () => {
  for (const count of ['0', '1', '1000', '1000000']) {
    const p = illustrateReviewEconomics(count, '0');
    expect(p.jurors + p.panel + p.remainder).toBe(p.total);
    expect(p.eligible).toBe(p.remainder);
  }
  expect(illustrateReviewEconomics('1', '0').eligible).toBe(7500n);
});
test('uncovered obligations reduce surplus without a negative budget', () => {
  expect(illustrateReviewEconomics('10000', '50').eligible).toBe(25_000_000n);
  expect(illustrateReviewEconomics('1000', '50').eligible).toBe(0n);
  expect(illustrateReviewEconomics('1000', '0.01').eligible).toBe(7_490_000n);
});
test('batch threshold is exact and malformed input cannot display stale economics', () => {
  expect(illustrateReviewEconomics('10000', '50').minimumBatchReached).toBe(true);
  expect(illustrateReviewEconomics('10000', '50.01').minimumBatchReached).toBe(false);
  for (const count of ['-1', '1.5', '', '1e3', '1000001']) expect(() => illustrateReviewEconomics(count, '0')).toThrow();
  for (const value of ['-1', '0.001', '', 'NaN', '1e3', '1000000001']) expect(() => illustrateReviewEconomics('1', value)).toThrow();
});
