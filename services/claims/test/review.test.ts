import { describe, expect, test } from 'bun:test';
import { computeReviewIntegrityHash, reviewBundle } from '../src/review.ts';
import type { EvidenceBundle, Juror } from '../src/types.ts';

const bundle: EvidenceBundle = { version: 1, id: 'bundle-1', claim: 'The cap is 100.', asOf: '2026-09-28', sources: [{ id: 's1', url: 'https://example.test', title: 'Spec', text: 'The token supply is capped at 100 units.', retrievedAt: '2026-09-28T00:00:00Z', contentHash: 'abc' }], warnings: [] };
const finding = { assessment: 'supported', explanation: 'The text states the cap.', citations: [{ sourceId: 's1', quote: 'supply is capped at 100 units' }], limitations: [] };
const jurors = (f: (i: number) => unknown = () => finding): Juror[] => [0, 1, 2].map((i) => ({ id: `j${i}`, model: `m${i}`, assess: async () => f(i) }));

describe('reviewBundle', () => {
  test('unanimous findings are assessed and integrity hash binds the result', async () => {
    const review = await reviewBundle(bundle, jurors(), { now: () => new Date('2026-09-28T12:00:00Z') });
    expect(review.status).toBe('assessed');
    expect(review.assessment).toBe('supported');
    expect(review.agreement).toEqual({ count: 3, total: 3, required: 3 });
    expect(review.findings.map((x) => x.model)).toEqual(['m0', 'm1', 'm2']);
    expect(review.integrityHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test('dissent preserves valid findings and remains unresolved', async () => {
    const review = await reviewBundle(bundle, jurors((i) => i === 0 ? finding : { ...finding, assessment: 'contradicted' }));
    expect(review.status).toBe('unresolved');
    expect(review.assessment).toBeNull();
    expect(review.findings).toHaveLength(3);
    expect(review.agreement.count).toBe(2);
  });
  test('malformed JSON values and forged citations invalidate a juror', async () => {
    for (const [bad, code] of [[null, 'JUROR_FAILED'], [{ ...finding, citations: [{ sourceId: 's1', quote: 'invented text' }] }, 'INVALID_CITATION'], [{ ...finding, citations: [{ sourceId: 'missing', quote: 'supply is capped' }] }, 'INVALID_CITATION'], [{ ...finding, explanation: 'x'.repeat(3000) }, 'JUROR_FAILED']] as const) {
      const review = await reviewBundle(bundle, jurors((i) => i === 0 ? bad : finding));
      expect(review.failures[0]?.code).toBe(code);
      expect(review.status).toBe('unresolved');
    }
  });
  test('empty evidence produces transparent deterministic abstention without calls', async () => {
    let calls = 0;
    const empty = { ...bundle, sources: [] };
    const review = await reviewBundle(empty, jurors(() => { calls++; return finding; }));
    expect(calls).toBe(0);
    expect(review.assessment).toBe('insufficient_evidence');
    expect(review.agreement).toEqual({ count: 0, total: 3, required: 3 });
    expect(review.findings).toHaveLength(0);
    expect(review.limitations.join(' ')).toContain('jurors were not called');
  });
  test('duplicate IDs or model values are rejected; timeout becomes safe failure code', async () => {
    const duplicate = jurors(); duplicate[2] = { ...duplicate[2]!, model: duplicate[1]!.model };
    await expect(reviewBundle(bundle, duplicate)).rejects.toThrow('distinct IDs and models');
    const slow = jurors((i) => i === 0 ? new Promise(() => {}) : finding);
    const result = await reviewBundle(bundle, slow, { timeoutMs: 5 });
    expect(result.failures).toContainEqual({ jurorId: 'j0', code: 'TIMEOUT' });
  });
  test('claim scope is bound into the review', async () => {
    const result = await reviewBundle({ ...bundle, claim: 'The cap is 200.' }, jurors());
    expect(result.claim).toBe('The cap is 200.');
    expect(result.bundleId).toBe(bundle.id);
  });
  test('jurors share an immutable snapshot and bundle warnings survive in review limitations', async () => {
    const observations: string[] = [];
    const adversarial: Juror[] = [
      { id: 'a', model: 'a-model', assess: async (input) => { try { input.sources[0]!.text = 'tampered'; } catch {} return finding; } },
      { id: 'b', model: 'b-model', assess: async (input) => { observations.push(input.sources[0]!.text); return finding; } },
      { id: 'c', model: 'c-model', assess: async (input) => { observations.push(input.sources[0]!.text); return finding; } },
    ];
    const result = await reviewBundle({ ...bundle, warnings: ['One source was unavailable; research may be incomplete.'] }, adversarial);
    expect(observations).toEqual([bundle.sources[0]!.text, bundle.sources[0]!.text]);
    expect(result.sources[0]!.text).toBe(bundle.sources[0]!.text);
    expect(result.limitations[0]).toBe('One source was unavailable; research may be incomplete.');
  });
  test('redacted source text preserves integrity hash while substantive edits change it', async () => {
    const review = await reviewBundle(bundle, jurors());
    expect(computeReviewIntegrityHash(review)).toBe(review.integrityHash);
    const { text: _text, ...redactedSource } = review.sources[0]!;
    const redacted = { ...review, sources: [redactedSource] };
    expect(computeReviewIntegrityHash(redacted)).toBe(review.integrityHash);
    expect(computeReviewIntegrityHash({ ...review, claim: 'Different claim' })).not.toBe(review.integrityHash);
    expect(computeReviewIntegrityHash({ ...review, findings: [{ ...review.findings[0]!, citations: [{ sourceId: 's1', quote: 'changed' }] }, ...review.findings.slice(1)] })).not.toBe(review.integrityHash);
    expect(computeReviewIntegrityHash({ ...review, sources: [{ ...review.sources[0]!, contentHash: 'changed' }] })).not.toBe(review.integrityHash);
  });
  test('parent timeout aborts juror signal', async () => {
    let aborted = false;
    const waiting = jurors((i) => i === 0 ? new Promise<never>((_resolve, reject) => {
      // The custom juror observes the engine signal directly below.
      void reject;
    }) : finding);
    waiting[0] = { id: 'j0', model: 'm0', assess: async (_input, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) };
    await reviewBundle(bundle, waiting, { timeoutMs: 5 });
    expect(aborted).toBe(true);
  });
});
