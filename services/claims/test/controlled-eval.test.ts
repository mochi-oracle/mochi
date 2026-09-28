import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { controlledEvaluationFixtures } from '../eval/controlled-fixtures.ts';
import { representativeEvaluationFixtures } from '../eval/representative-fixtures.ts';
import { CONTROLLED_MAX_CALLS, CONTROLLED_MAX_OUTPUT_TOKENS, CONTROLLED_MODELS, CONTROLLED_SPEND_CAP_USD, createBoundedControlledJurors, parseControlledArgs, runControlled } from '../eval/controlled-run.ts';
import type { Juror } from '../src/types.ts';
import { evaluateClaims } from '../eval/index.ts';

describe('controlled claims evaluation', () => {
  test('preserves the original deterministic synthetic suite as the default', () => {
    expect(controlledEvaluationFixtures).toHaveLength(12);
    expect(controlledEvaluationFixtures.every((item) => item.synthetic && item.bundle.sources.every((source) => source.url.includes('.invalid')))).toBe(true);
    expect(parseControlledArgs([])).toMatchObject({ suite: 'controlled', maxCases: 12, details: false });
  });

  test('representative source excerpts are quote snapshots with retrieval timestamps, hashes, and safe label alternatives', () => {
    expect(representativeEvaluationFixtures).toHaveLength(12);
    expect(new Set(representativeEvaluationFixtures.map((item) => item.expected)).size).toBe(4);
    expect(representativeEvaluationFixtures.every((item) => !item.synthetic && item.bundle.sources.every((source) => source.url.startsWith('https://') && new URL(source.url).hostname !== 'fixture.invalid' || source.id === 'test-injection-annotation'))).toBe(true);
    expect(representativeEvaluationFixtures.flatMap((item) => item.bundle.sources).every((source) => source.retrievedAt === '2026-09-28T17:41:30.000Z' && createHash('sha256').update(source.text).digest('hex') === source.contentHash)).toBe(true);
    expect(representativeEvaluationFixtures.some((item) => item.id === 'ai-current-coding-leader' && item.bundle.sources.length === 0)).toBe(true);
    expect(representativeEvaluationFixtures.find((item) => item.id === 'eth-injection')?.bundle.sources[1]?.title).toContain('Test-only');
    expect(representativeEvaluationFixtures.some((item) => item.acceptedOutcomes?.length)).toBe(true);
    expect(parseControlledArgs(['--suite', 'representative'])).toMatchObject({ suite: 'representative', maxCases: 12 });
  });

  test('arguments restrict calls to 36 and invalid inputs fail closed', () => {
    expect(parseControlledArgs([])).toEqual({ live: false, maxCases: 12, suite: 'controlled', details: false, help: false });
    expect(parseControlledArgs(['--suite', 'representative', '--max-cases', '12'])).toMatchObject({ suite: 'representative', maxCases: 12 });
    expect(() => parseControlledArgs(['--suite', 'representative', '--max-cases', '13'])).toThrow('between 1 and 12');
    expect(parseControlledArgs(['--live', '--max-cases', '12']).maxCases).toBe(12);
    expect(() => parseControlledArgs(['--max-cases', '13'])).toThrow('between 1 and 12');
    expect(() => parseControlledArgs(['--max-cases', '1', '--max-cases', '2'])).toThrow('Duplicate --max-cases');
    expect(parseControlledArgs(['--case', 'crypto-chain-support'])).toMatchObject({ live: false, caseId: 'crypto-chain-support' });
    expect(parseControlledArgs(['--suite', 'representative', '--case', 'eth-pos-2022'])).toMatchObject({ suite: 'representative', caseId: 'eth-pos-2022' });
    expect(() => parseControlledArgs(['--case', 'crypto-chain-support', '--max-cases', '1'])).toThrow('cannot be combined');
    expect(() => parseControlledArgs(['--case', 'unknown-case'])).toThrow('Unknown case ID');
    expect(() => parseControlledArgs(['--mystery'])).toThrow('Unknown or duplicate');
    expect(CONTROLLED_MAX_CALLS).toBe(36);
    expect(CONTROLLED_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(CONTROLLED_MODELS).toHaveLength(3);
    expect(CONTROLLED_SPEND_CAP_USD).toBe(10);
  });

  test('offline default retains synthetic harness and only emits summaries', async () => {
    let output = '';
    expect(await runControlled([], {}, (text) => { output += text; })).toBe(0);
    const report = JSON.parse(output);
    expect(report.mode).toBe('offline');
    expect(report.fixtureCount).toBe(12);
    expect(report.metrics.acceptedOutcomeCorrectCount).toBe(12);
    expect(new Set(report.cases.map((item: { expected: string }) => item.expected))).toEqual(new Set(['supported', 'contradicted', 'missing_context', 'insufficient_evidence']));
    expect(report.evaluationLabel).toContain('Synthetic');
    expect(output).not.toContain('The fictional');
    expect(report.cases.every((item: { details?: unknown }) => item.details === undefined)).toBe(true);
  });

  test('representative details mode keeps per-juror rationale and exact citations for manual review', async () => {
    let output = '';
    const factory = (options: { id: string; model: string }): Juror => ({ id: options.id, model: options.model, async assess(bundle) {
      const source = bundle.sources[0]!;
      return { assessment: 'supported', explanation: 'The excerpt states the claim directly.', citations: [{ sourceId: source.id, quote: source.text }], limitations: [] };
    } });
    expect(await runControlled(['--suite', 'representative', '--live', '--case', 'eth-pos-2022', '--details'], { PHALA_AI_API_KEY: 'mock-key' }, (text) => { output += text; }, { jurorFactory: factory })).toBe(0);
    const report = JSON.parse(output);
    expect(report.cases[0].details.claim).toContain('Ethereum switched');
    expect(report.cases[0].details.findings).toHaveLength(3);
    expect(report.cases[0].details.findings[0].explanation).toContain('states the claim');
    expect(report.cases[0].details.findings[0].citations[0].quote).toContain('proof-of-stake mechanism');
    expect(report.cases[0].semanticCitationReview).toBe('not_automated');
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
    expect(report.providerUsage.attemptedCalls).toBe(33);
    expect(report.providerUsage.completedTelemetry).toBe(33);
    expect(report.estimatedCost.actualBilledCostUsd).toBeNull();
    expect(report.estimatedCost.partialEstimatedCostUsd).toBeGreaterThan(0);
    expect(output).not.toContain('The fictional');
    expect(output).not.toContain('mock-only');
    expect(output).not.toContain('mock response');

    output = '';
    expect(await runControlled(['--live', '--case', 'crypto-chain-support'], { PHALA_AI_API_KEY: 'mock-only' }, (text) => { output += text; }, { jurorFactory: factory })).toBe(0);
    const oneCase = JSON.parse(output);
    expect(oneCase.fixtureCount).toBe(1);
    expect(oneCase.expectedCalls).toBe(3);
    expect(oneCase.providerUsage.attemptedCalls).toBe(3);
    expect(oneCase.cases[0].id).toBe('crypto-chain-support');
  });

  test('counts started attempts separately from absent telemetry and keeps delayed events with their fixture', async () => {
    let output = '';
    const factory = (options: { id: string; model: string; onTelemetry?: (event: { id: string; model: string; elapsedMs: number; outcome: 'success' | 'failure'; stage?: 'complete' | 'request_build' | 'attestation' | 'inference' | 'receipt' | 'aci_exchange' | 'response_parse'; errorCode?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }) => void }): Juror => ({
      id: options.id, model: options.model,
      async assess() {
        if (options.id === 'controlled-1') {
          setTimeout(() => options.onTelemetry?.({ id: options.id, model: options.model, elapsedMs: 4, outcome: 'failure', stage: 'aci_exchange', errorCode: 'REQUEST_ABORTED' }), 0);
          return {};
        }
        return new Promise<never>(() => {});
      },
    });
    const fixture = controlledEvaluationFixtures.find((item) => item.id === 'crypto-chain-support')!;
    expect(await runControlled(['--live', '--case', fixture.id], { PHALA_AI_API_KEY: 'mock-only' }, (text) => { output += text; }, {
      jurorFactory: factory,
      evaluate: async (options) => {
        for (const juror of options?.jurors ?? []) void juror.assess(fixture.bundle);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return evaluateClaims({ fixtures: [fixture] });
      },
    })).toBe(0);
    const report = JSON.parse(output);
    expect(report.providerUsage).toMatchObject({ attemptedCalls: 3, completedTelemetry: 1, missingTelemetry: 2, missingUsageCalls: 3 });
    expect(report.providerUsage.byModel['meta-llama/llama-3.3-70b-instruct']).toMatchObject({ attemptedCalls: 1, completedTelemetry: 1, missingTelemetry: 0, missingUsageCalls: 1 });
    expect(report.providerUsage.byModel['nvidia/nemotron-3.5-lightning']).toMatchObject({ attemptedCalls: 1, completedTelemetry: 0, missingTelemetry: 1, missingUsageCalls: 1 });
    expect(report.cases[0].providerFailures).toEqual([{ model: 'meta-llama/llama-3.3-70b-instruct', stage: 'aci_exchange', errorCode: 'REQUEST_ABORTED' }]);
    expect(output).not.toContain('mock-only');
  });
});
