import { test, expect } from 'bun:test';
import { LAUNCH_CLASS_PRICES, LAUNCH_PROTOCOL_FEE_BPS, LAUNCH_MIN_PROTOCOL_FEE } from '../../scripts/launch-pricing.ts';

test('launch tariff is exactly ten cents for the default short N3 mix and grows with work', () => {
  const mix = [0, 2, 4, 1, 3, 0, 2, 1, 4]; // ClassMix constructor order.
  const quote = (n: number, tokensK: bigint) => {
    const fees = mix.slice(0, n).reduce((sum, cls) => {
      const [, base, perK] = LAUNCH_CLASS_PRICES.find(p => p[0] === cls)!;
      return sum + base + perK * tokensK;
    }, 0n);
    const variable = fees * BigInt(LAUNCH_PROTOCOL_FEE_BPS) / 10_000n;
    return fees + (variable > LAUNCH_MIN_PROTOCOL_FEE ? variable : LAUNCH_MIN_PROTOCOL_FEE);
  };
  expect(new Set(LAUNCH_CLASS_PRICES.map(p => p[0])).size).toBe(5);
  expect(quote(3, 1n)).toBe(100_000n);
  expect(quote(3, 2n)).toBe(104_600n);
  expect([3, 5, 7, 9].map(n => quote(n, 1n))).toEqual([100_000n, 139_200n, 208_800n, 268_800n]);
});
