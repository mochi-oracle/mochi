import { JurorClass } from "./types.ts";

export const VALID_N = [3, 5, 7, 9] as const;
export type JurySize = (typeof VALID_N)[number];

export function isValidN(n: number): n is JurySize {
  return (VALID_N as readonly number[]).includes(n);
}

/** k(N) = ceil(3N/4): 3→3, 5→4, 7→6, 9→7. Mirrors MochiTypes.requiredAgree. */
export function requiredAgree(n: number): number {
  return Math.floor((n * 3 + 3) / 4);
}

/** Nested seat ordering (N9). Seats [0, n) form the mix for jury size n. Mirrors MochiTypes.seatClass. */
export const SEAT_CLASSES: readonly JurorClass[] = [
  JurorClass.LARGE_A,
  JurorClass.DOC_SPECIALIST,
  JurorClass.DISSENTER,
  JurorClass.LARGE_B,
  JurorClass.SMALL_FAST,
  JurorClass.LARGE_A,
  JurorClass.DOC_SPECIALIST,
  JurorClass.LARGE_B,
  JurorClass.DISSENTER,
];

export function seatClass(seat: number): JurorClass {
  const c = SEAT_CLASSES[seat];
  if (c === undefined) throw new RangeError(`seat out of range: ${seat}`);
  return c;
}

export function classMix(n: number): JurorClass[] {
  if (!isValidN(n)) throw new RangeError(`invalid n: ${n}`);
  return SEAT_CLASSES.slice(0, n);
}

/** floor(agreeCount * 10000 / n) */
export function agreeBps(agreeCount: number, n: number): number {
  return Math.floor((agreeCount * 10000) / n);
}

export function popcount(x: number): number {
  let c = 0;
  let v = x >>> 0;
  while (v !== 0) {
    v &= v - 1;
    c++;
  }
  return c;
}

/** Default dispatch timeout per juror (ms). */
export const JUROR_TIMEOUT_MS = 60_000;
