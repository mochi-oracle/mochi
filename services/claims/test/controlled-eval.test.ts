import { describe, expect, test } from 'bun:test';
import { controlledEvaluationFixtures } from '../eval/controlled-fixtures.ts';
import { CONTROLLED_MAX_CALLS, CONTROLLED_MAX_OUTPUT_TOKENS, CONTROLLED_MODELS, CONTROLLED_SPEND_CAP_USD, createBoundedControlledJurors, parseControlledArgs, runControlled } from '../eval/controlled-run.ts';
import type { Juror } from '../src/types.ts';

describe('controlled claims evaluation', () => {
  test('contains 12 deterministic fictional evidence cases with varied labels and bounded source text', () => {
    expect(controlledEvaluationFixtures).toHaveLength(12);
    expect(new Set(controlledEvaluationFixtures.map((item) => item.expected)).size).toBe(4);
    expect(controlledEvaluationFixtures.every((item) => item.synthetic && item.bundle.sources.every((source) => source.url.includes('.invalid')))).toBe(true);
    expect(controlledEvaluationFixtures.some((item) => item.acceptedOutcomes?.length)).toBe(true);
  });

  test('arguments restrict calls to 36 and invalid inputs fail closed', () => {
    expect(parseControlledArgs([])).toEqual({ live: false, maxCases: 12, help: false });
    expect(parseControlledArgs(['--live', '--max-cases', '12']).maxCases).toBe(12);
    expect(() => parseControlledArgs(['--max-cases', '13'])).toThrow('between 1 and 12');
    expect(() => parseControlledArgs(['--max-cases', '1', '--max-cases', '2'])).toThrow('Duplicate --max-cases');
    expect(parseControlledArgs(['--case', 'crypto-supply-contradiction'])).toMatchObject({ live: false, caseId: 'crypto-supply-contradiction' });
    expect(() => parseControlledArgs(['--case', 'crypto-supply-contradiction', '--max-cases', '1'])).toThrow('cannot be combined');
    expect(() => parseControlledArgs(['--case', 'unknown-case'])).toThrow('Unknown controlled case ID');
    expect(() => parseControlledArgs(['--mystery'])).toThrow('Unknown or duplicate');
    expect(CONTROLLED_MAX_CALLS).toBe(36);
    expect(CONTROLLED_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(CONTROLLED_MODELS).toHaveLength(3);
    expect(CONTROLLED_SPEND_CAP_USD).toBe(10);
  });

  test('offline CLI covers all labels without provider calls or fixture text output', async () => {
    let output = '';
    expect(await runControlled([], {}, (text) => { output += text; })).toBe(0);
    const report = JSON.parse(output);
    expect(report.mode).toBe('offline');
    expect(report.fixtureCount).toBe(12);
    expect(report.metrics.acceptedOutcomeCorrectCount).toBe(12);
    expect(new Set(report.cases.map((item: { expected: string }) => item.expected))).toEqual(new Set(['supported', 'contradicted', 'missing_context', 'insufficient_evidence']));
    expect(output).not.toContain('The fictional');
  });

  test('shared call and spend reservation exhausts at 36 and oversized exact requests fail before assessment', async () => {
    let underlyingCalls = 0;
    const factory = (options: { id: string; model: string }): Juror => ({ id: options.id, model: options.model, async assess() { underlyingCalls++; return {}; } });
    const jurors = createBoundedControlledJurors('mock-only', [], factory);
    const regular = controlledEvaluationFixtures[0]!.bundle;
    for (let index = 0; index < CONTROLLED_MAX_CALLS; index++) await jurors[index % 3]!.assess(regular);
    await expect(jurors[0]!.assess(regular)).rejects.toThrow('call or spend bound reached');
    expect(underlyingCalls).toBe(36);

    const isolated = createBoundedControlledJurors('mock-only', [], factory);
    const oversized = { ...regular, claim: 'x'.repeat(4_000), sources: [{ ...regular.sources[0]!, text: 'y'.repeat(30_000) }] };
    await expect(isolated[0]!.assess(oversized)).rejects.toThrow('request exceeds the live byte bound');
    expect(underlyingCalls).toBe(36);
  });

  test('live mode requires the named key before constructing jurors and emits redacted per-case metrics', async () => {
    let constructions = 0;
    let output = '';
    const factory = (options: { id: string; model: string; onTelemetry?: (event: { id: string; model: string; elapsedMs: number; outcome: 'success' | 'failure'; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }) => void }): Juror => {
      constructions++;
      return { id: options.id, model: options.model, async assess(bundle) {
        const fixture = controlledEvaluationFixtures.find((item) => item.id === bundle.id)!;
        const src = bundle.sources[0];
        options.onTelemetry?.({ id: options.id, model: options.model, elapsedMs: 1, outcome: 'success', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } });
        return { assessment: fixture.expected, explanation: 'mock response', citations: src ? [{ sourceId: src.id, quote: src.text }] : [], limitations: [] };
      } };
    };
    expect(await runControlled(['--live', '--max-cases', '1'], {}, (text) => { output += text; }, { jurorFactory: factory })).toBe(2);
    expect(constructions).toBe(0);

    output = '';
    expect(await runControlled(['--live'], { PHALA_AI_API_KEY: 'mock-only' }, (text) => { output += text; }, { jurorFactory: factory })).toBe(0);
    const report = JSON.parse(output);
    expect(constructions).toBe(3);
    expect(report.fixtureCount).toBe(12);
    expect(report.cases).toHaveLength(12);
    expect(report.cases.find((item: { id: string }) => item.id === 'crypto-no-evidence')?.status).toBe('assessed');
    expect(report.providerUsage.calls).toBe(33);
    expect(report.estimatedCost.actualBilledCostUsd).toBeNull();
    expect(report.estimatedCost.partialEstimatedCostUsd).toBeGreaterThan(0);
    expect(output).not.toContain('The fictional');
    expect(output).not.toContain('mock-only');
    expect(output).not.toContain('mock response');

    output = '';
    expect(await runControlled(['--live', '--case', 'crypto-supply-contradiction'], { PHALA_AI_API_KEY: 'mock-only' }, (text) => { output += text; }, { jurorFactory: factory })).toBe(0);
    const oneCase = JSON.parse(output);
    expect(oneCase.fixtureCount).toBe(1);
    expect(oneCase.expectedCalls).toBe(3);
    expect(oneCase.providerUsage.calls).toBe(3);
    expect(oneCase.cases[0].id).toBe('crypto-supply-contradiction');
  });
});
