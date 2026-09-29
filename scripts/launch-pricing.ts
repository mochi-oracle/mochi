// Approved launch tariff, in USDG base units (6 decimals). Cost validation remains a launch gate.
// N3 uses LARGE_A + DOC_SPECIALIST + DISSENTER. At tokensK=1, jurors receive $0.08
// and the minimum protocol fee is $0.02, for exactly $0.10 before network gas. Larger evidence bundles
// (tokensK) and larger juries raise the quote; above the minimum the protocol fee is 20% of juror fees.
// $0.10 rather than $0.05: the testnet dress rehearsal measured ~918k gas of protocol-side settlement per
// review (seal + post), about $0.05 at mainnet gas, so five cents could not cover it.
export const LAUNCH_CLASS_PRICES: ReadonlyArray<readonly [number, bigint, bigint]> = [
  [0, 26_400n, 1_600n],
  [1, 26_400n, 1_600n],
  [2, 28_200n, 1_800n],
  [3, 7_800n, 200n],
  [4, 20_800n, 1_200n],
];
export const LAUNCH_PROTOCOL_FEE_BPS = 2_000;
export const LAUNCH_MIN_PROTOCOL_FEE = 20_000n;
