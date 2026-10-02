const RETRY_BASE_MS = 15_000;

/**
 * Delay before retrying after `failures` consecutive failed or incomplete checks: exponential from 15 s, capped at the
 * regular interval, with equal jitter (between half and all of that delay) so retries never run in lockstep.
 */
export function retryDelayMs(failures: number, intervalMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(intervalMs, RETRY_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 20));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Check immediately, then every `intervalMs` while all identities pass. After a failed or incomplete check, retry with
 * exponential backoff and jitter (see retryDelayMs) instead of a fixed 15 s. Checks never overlap.
 */
export function startAttestationChecks(
  check: () => Promise<boolean>,
  intervalMs: number,
  schedule: (callback: () => void, delay: number) => unknown = setTimeout,
  random: () => number = Math.random,
) {
  let failures = 0;
  const run = async () => {
    let passing = false;
    try { passing = await check(); } catch { /* Retry a failed check without an unhandled rejection. */ } finally {
      failures = passing ? 0 : failures + 1;
      schedule(() => { void run(); }, passing ? intervalMs : retryDelayMs(failures, intervalMs, random));
    }
  };
  void run();
}
