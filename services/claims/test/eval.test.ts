import { describe, expect, test } from 'bun:test';
import { evaluateClaims } from '../eval/index.ts';
import type { Juror } from '../src/types.ts';

describe('claim evaluation harness', () => {
  test('offline fixtures report labeled outcomes, abstention, citation validity, and latency', async () => {
    const report = await evaluateClaims({ now: () => new Date('2026-09-28T12:00:00.000Z') });
    expect(report.mode).toBe('offline');
    expect(report.fixtureCount).toBe(5);
    expect(report.metrics.correctCount).toBe(5);
    expect(report.metrics.accuracyAmongResolved).toBe(1);
    expect(report.metrics.abstentionCount).toBe(1);
    expect(report.metrics.emittedCitationValidity).toBe(1);
    expect(report.metrics.rejectedCitationFindings).toBe(0);
    expect(report.metrics.jurorFailureCount).toBe(0);
    expect(report.metrics.latencyMs.max).toBeGreaterThanOrEqual(0);
    expect(report.cost.status).toBe('not_measured');
    expect(report.limitations.join(' ')).toContain('offline answers are deterministic');
  });

  test('live mode refuses to call supplied jurors without explicit opt-in', async () => {
    let calls = 0;
    const jurors: Juror[] = [0, 1, 2].map((i) => ({ id: `j${i}`, model: `m${i}`, async assess() { calls++; return {}; } }));
    await expect(evaluateClaims({ mode: 'live', jurors })).rejects.toThrow('allowLiveJurors: true');
    expect(calls).toBe(0);
  });

  test('live mode uses only explicitly supplied jurors and reports invalid outputs as failures', async () => {
    const jurors: Juror[] = [0, 1, 2].map((i) => ({ id: `j${i}`, model: `m${i}`, async assess() {
      return { assessment: 'supported', explanation: 'Claim is supported.', citations: [{ sourceId: 'refund-policy', quote: 'fabricated citation' }], limitations: [] };
    } }));
    const report = await evaluateClaims({ mode: 'live', allowLiveJurors: true, jurors, fixtures: undefined });
    expect(report.mode).toBe('live');
    expect(report.metrics.rejectedCitationFindings).toBe(12); // Three rejected findings for each of four evidence-bearing fixtures.
    expect(report.metrics.jurorFailureCount).toBeGreaterThan(0);
    expect(report.cost.status).toBe('not_measured');
  });
});
