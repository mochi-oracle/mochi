const RETRY_BASE_MS = 15_000;
/** Shortest retry cap: a key close to expiry is still retried about every 15 s (7.5–15 s with jitter). */
export const RETRY_FLOOR_MS = 15_000;
/** Longest retry cap while a key's on-chain attestation is still valid (or its expiry is unknown). */
export const RETRY_CEILING_IN_VALIDITY_MS = 120_000;

/**
 * Upper bound for one key's next retry. While the key's attestation is valid, the retry comes at the latest after a
 * quarter of its remaining validity, between 15 s and 120 s, so a failure that clears before expiry is retried before
 * expiry. An expired key (nothing left to protect) backs off up to the regular interval. An unknown expiry (the
 * registry could not be read) is treated as valid. Never longer than the regular interval.
 */
export function retryCapMs(intervalMs: number, remainingMs: number | undefined): number {
  if (remainingMs !== undefined && remainingMs <= 0) return intervalMs;
  const quarter = remainingMs === undefined ? RETRY_CEILING_IN_VALIDITY_MS : remainingMs / 4;
  return Math.min(intervalMs, Math.max(RETRY_FLOOR_MS, Math.min(RETRY_CEILING_IN_VALIDITY_MS, quarter)));
}

/**
 * Delay before retrying after `failures` consecutive failed checks of one key: exponential from 15 s, capped at
 * `capMs` (see retryCapMs), with equal jitter (between half and all of that delay) so retries never run in lockstep.
 */
export function retryDelayMs(failures: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, RETRY_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 20));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The result of one key's check in a pass. `attestedUntilSec` is its on-chain expiry after the pass, if known. */
export interface KeyOutcome {
  key: string;
  ok: boolean;
  attestedUntilSec?: number;
}

type KeyState = { failures: number; dueAt: number; attestedUntilMs?: number };

/**
 * When each key is next checked. Keys back off independently: a key that keeps failing (an exited enclave, a
 * de-allowlisted build) never delays the retries of the others, and a key's retries are bounded by its own remaining
 * validity. Passing keys are checked again after the regular interval. All times are milliseconds.
 */
export class AttestationSchedule {
  private readonly keys = new Map<string, KeyState>();
  private passFailures = 0;
  private passRetryAt = 0;

  constructor(private readonly intervalMs: number, private readonly random: () => number = Math.random) {}

  /** A key never seen before is due at once. */
  isDue(key: string, nowMs: number): boolean {
    const state = this.keys.get(key.toLowerCase());
    return !state || state.dueAt <= nowMs;
  }

  /** Record a completed pass: every checked key gets its next check time. */
  record(outcomes: readonly KeyOutcome[], nowMs: number): void {
    this.passFailures = 0;
    for (const outcome of outcomes) {
      const key = outcome.key.toLowerCase();
      const previous = this.keys.get(key);
      const attestedUntilMs = outcome.attestedUntilSec !== undefined ? outcome.attestedUntilSec * 1_000 : previous?.attestedUntilMs;
      if (outcome.ok) {
        this.keys.set(key, { failures: 0, dueAt: nowMs + this.intervalMs, attestedUntilMs });
      } else {
        this.keys.set(key, this.failed(previous?.failures ?? 0, attestedUntilMs, nowMs));
      }
    }
  }

  /**
   * Record a pass that failed before checking any key (for example the registry was unreachable while scanning
   * enrollments). Every key that was due counts one failure against its own validity, and the scan itself is retried
   * with backoff capped as for a key of unknown expiry.
   */
  recordPassFailure(nowMs: number): void {
    this.passFailures += 1;
    for (const [key, state] of this.keys) {
      if (state.dueAt <= nowMs) this.keys.set(key, this.failed(state.failures, state.attestedUntilMs, nowMs));
    }
    this.passRetryAt = nowMs + retryDelayMs(this.passFailures, retryCapMs(this.intervalMs, undefined), this.random);
  }

  /** When the next pass should start: the earliest due key, and at least once per interval to find new enrollments. */
  nextRunAt(nowMs: number): number {
    let next = this.passFailures > 0 ? this.passRetryAt : nowMs + this.intervalMs;
    for (const state of this.keys.values()) next = Math.min(next, state.dueAt);
    return Math.max(next, nowMs);
  }

  private failed(previousFailures: number, attestedUntilMs: number | undefined, nowMs: number): KeyState {
    const failures = previousFailures + 1;
    const cap = retryCapMs(this.intervalMs, attestedUntilMs === undefined ? undefined : attestedUntilMs - nowMs);
    return { failures, dueAt: nowMs + retryDelayMs(failures, cap, this.random), attestedUntilMs };
  }
}

export interface AttestationCheckLoop {
  schedule: AttestationSchedule;
  /** Resolves when the pass that is running (or last ran) has finished and scheduled the next one. */
  idle(): Promise<void>;
}

/**
 * Run a pass immediately, then whenever a key is due (see AttestationSchedule). `check` receives a predicate naming
 * the keys due in this pass, checks those (plus any key it has not seen before) and returns their outcomes. A pass
 * that throws counts as a failure of every due key. Passes never overlap.
 */
export function startAttestationChecks(
  check: (isDue: (key: string) => boolean) => Promise<KeyOutcome[]>,
  intervalMs: number,
  options: {
    schedule?: (callback: () => void, delay: number) => unknown;
    random?: () => number;
    now?: () => number;
  } = {},
): AttestationCheckLoop {
  const schedule = options.schedule ?? setTimeout;
  const now = options.now ?? Date.now;
  const plan = new AttestationSchedule(intervalMs, options.random);
  const run = async () => {
    const startedAt = now();
    try {
      const outcomes = await check((key) => plan.isDue(key, startedAt));
      plan.record(outcomes, now());
    } catch {
      // Retry a failed pass without an unhandled rejection.
      plan.recordPassFailure(now());
    } finally {
      const at = now();
      schedule(trigger, Math.max(0, plan.nextRunAt(at) - at));
    }
  };
  let current: Promise<void> = Promise.resolve();
  const trigger = () => { current = run(); };
  trigger();
  return { schedule: plan, idle: () => current };
}
