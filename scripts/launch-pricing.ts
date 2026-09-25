// Approved launch tariff, in USDG base units (6 decimals). Cost validation remains a launch gate.
// N3 uses LARGE_A + DOC_SPECIALIST + DISSENTER. At tokensK=1, jurors receive $0.04
// and the minimum protocol fee is $0.01, for exactly $0.05 before network gas.
export const LAUNCH_CLASS_PRICES: ReadonlyArray<readonly [number, bigint, bigint]> = [
  [0, 13_200n, 800n],
  [1, 13_200n, 800n],
  [2, 14_100n, 900n],
  [3, 3_900n, 100n],
  [4, 10_400n, 600n],
];
export const LAUNCH_PROTOCOL_FEE_BPS = 2_000;
export const LAUNCH_MIN_PROTOCOL_FEE = 10_000n;
