/** Check immediately, retry unavailable identities promptly, and never overlap refresh transactions. */
export function startAttestationChecks(
  check: () => Promise<boolean>,
  intervalMs: number,
  schedule: (callback: () => void, delay: number) => unknown = setTimeout,
) {
  const run = async () => {
    let passing = false;
    try { passing = await check(); } catch { /* Retry a failed check without an unhandled rejection. */ } finally {
      schedule(() => { void run(); }, passing ? intervalMs : Math.min(intervalMs, 15_000));
    }
  };
  void run();
}
