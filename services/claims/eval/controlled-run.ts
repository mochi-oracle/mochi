#!/usr/bin/env bun
import { AsyncLocalStorage } from 'node:async_hooks';
import { createAciJuror } from '../src/aci-provider.ts';
import type { Assessment, Juror } from '../src/types.ts';
import { createClaimChatRequest, type ChatJurorTelemetry } from '../src/providers.ts';
import { controlledEvaluationFixtures, type ControlledFixture } from './controlled-fixtures.ts';
import { evaluateClaims, type ClaimEvaluationReport } from './index.ts';

export const CONTROLLED_MODELS = [
  'meta-llama/llama-3.3-70b-instruct',
  'nvidia/nemotron-3.5-lightning',
  'google/gemma-4-31b-it',
] as const;
export const CONTROLLED_BASE_URL = 'https://inference.phala.com/v1';
export const CONTROLLED_MAX_OUTPUT_TOKENS = 1024;
export const CONTROLLED_MAX_CALLS = 36;
export const CONTROLLED_SPEND_CAP_USD = 10;
const MAX_REQUEST_BYTES = 32_768;
const MAX_RESERVED_OUTPUT_TOKENS = CONTROLLED_MAX_OUTPUT_TOKENS;
const SPEND_CAP_NANODOLLARS = CONTROLLED_SPEND_CAP_USD * 1_000_000_000;
const PRICE: Record<(typeof CONTROLLED_MODELS)[number], { input: number; output: number }> = {
  'meta-llama/llama-3.3-70b-instruct': { input: 0.000002, output: 0.000002 },
  'nvidia/nemotron-3.5-lightning': { input: 0.00000007, output: 0.00000020 },
  'google/gemma-4-31b-it': { input: 0.00000015, output: 0.00000046 },
};
const PRICE_NANODOLLARS: Record<(typeof CONTROLLED_MODELS)[number], { input: number; output: number }> = {
  'meta-llama/llama-3.3-70b-instruct': { input: 2_000, output: 2_000 },
  'nvidia/nemotron-3.5-lightning': { input: 70, output: 200 },
  'google/gemma-4-31b-it': { input: 150, output: 460 },
};

export interface ControlledOptions { live: boolean; maxCases: number; caseId?: string; help: boolean }
export function parseControlledArgs(args: string[]): ControlledOptions {
  let live = false, maxCases = controlledEvaluationFixtures.length, help = false;
  let maxCasesSeen = false;
  let caseId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--live' && !live) live = true;
    else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else if (arg === '--max-cases') {
      if (maxCasesSeen) throw new Error('Duplicate --max-cases flag.');
      maxCasesSeen = true;
      const raw = args[++index];
      if (!raw || !/^[1-9]\d*$/u.test(raw)) throw new Error('--max-cases requires a positive integer.');
      maxCases = Number(raw);
      if (!Number.isSafeInteger(maxCases) || maxCases > controlledEvaluationFixtures.length) throw new Error(`--max-cases must be between 1 and ${controlledEvaluationFixtures.length}.`);
    } else if (arg === '--case') {
      if (caseId !== undefined) throw new Error('Duplicate --case flag.');
      if (maxCasesSeen) throw new Error('--case cannot be combined with --max-cases.');
      const raw = args[++index];
      if (!raw || !controlledEvaluationFixtures.some((item) => item.id === raw)) throw new Error('Unknown controlled case ID.');
      caseId = raw;
    } else throw new Error('Unknown or duplicate argument. Supported flags are --live, --max-cases N, and --help.');
  }
  if (caseId !== undefined && maxCasesSeen) throw new Error('--case cannot be combined with --max-cases.');
  if (help && args.some((arg) => arg !== '--help' && arg !== '-h')) throw new Error('--help cannot be combined with other flags.');
  return { live, maxCases, ...(caseId ? { caseId } : {}), help };
}

type JurorFactory = (options: Parameters<typeof createAciJuror>[0]) => Juror;
interface ControlledTelemetry extends ChatJurorTelemetry { fixtureId: string }
interface ControlledAttempt { fixtureId: string; model: string }
export function createBoundedControlledJurors(
  key: string, telemetry: ControlledTelemetry[], factory: JurorFactory = createAciJuror, attempts: ControlledAttempt[] = [],
): Juror[] {
  let calls = 0;
  let reservedNanoDollars = 0;
  return CONTROLLED_MODELS.map((model, index) => {
    const id = `controlled-${index + 1}`;
    const reserveNanoDollars = MAX_REQUEST_BYTES * PRICE_NANODOLLARS[model].input + MAX_RESERVED_OUTPUT_TOKENS * PRICE_NANODOLLARS[model].output;
    const activeFixtureId = new AsyncLocalStorage<string>();
    const juror = factory({ id, model, baseUrl: CONTROLLED_BASE_URL, apiKey: key, maxOutputTokens: CONTROLLED_MAX_OUTPUT_TOKENS,
      onTelemetry: (event) => { telemetry.push({ ...event, fixtureId: activeFixtureId.getStore() ?? 'unknown' }); } });
    return {
      id, model,
      async assess(bundle, signal) {
        const request = createClaimChatRequest(model, bundle, CONTROLLED_MAX_OUTPUT_TOKENS, { aciVerified: true });
        if (new TextEncoder().encode(request).length > MAX_REQUEST_BYTES) throw new Error('Controlled provider request exceeds the live byte bound.');
        // Reservation is synchronous before assess() can make its single provider request.
        if (calls >= CONTROLLED_MAX_CALLS || reservedNanoDollars + reserveNanoDollars > SPEND_CAP_NANODOLLARS) throw new Error('Controlled live call or spend bound reached.');
        calls++;
        reservedNanoDollars += reserveNanoDollars;
        attempts.push({ fixtureId: bundle.id, model });
        return await activeFixtureId.run(bundle.id, () => juror.assess(bundle, signal));
      },
    };
  });
}

function estimatedCost(telemetry: ControlledTelemetry[], attempts: ControlledAttempt[]) {
  let estimate = 0;
  let complete = telemetry.length === attempts.length;
  const perModel: Record<string, { attemptedCalls: number; completedTelemetry: number; usageReportedCalls: number; missingUsageCalls: number; promptTokens: number; completionTokens: number; partialEstimatedCostUsd: number }> = {};
  for (const attempt of attempts) {
    const row = perModel[attempt.model] ??= { attemptedCalls: 0, completedTelemetry: 0, usageReportedCalls: 0, missingUsageCalls: 0, promptTokens: 0, completionTokens: 0, partialEstimatedCostUsd: 0 };
    row.attemptedCalls++;
    row.missingUsageCalls++;
  }
  for (const event of telemetry) {
    const usage = event.usage;
    if (!(event.model in PRICE)) { complete = false; continue; }
    const row = perModel[event.model] ??= { attemptedCalls: 0, completedTelemetry: 0, usageReportedCalls: 0, missingUsageCalls: 0, promptTokens: 0, completionTokens: 0, partialEstimatedCostUsd: 0 };
    row.completedTelemetry++;
    if (usage?.promptTokens === undefined || usage.completionTokens === undefined) { complete = false; continue; }
    const price = PRICE[event.model as keyof typeof PRICE];
    const cost = usage.promptTokens * price.input + usage.completionTokens * price.output;
    estimate += cost;
    row.usageReportedCalls++;
    row.missingUsageCalls = Math.max(0, row.missingUsageCalls - 1);
    row.promptTokens += usage.promptTokens;
    row.completionTokens += usage.completionTokens;
    row.partialEstimatedCostUsd += cost;
  }
  return { status: 'reported_token_estimate' as const, partialEstimatedCostUsd: estimate, allAttemptedCallsReportedUsage: complete,
    perModel, actualBilledCostUsd: null as null,
    note: 'Partial token-price estimate uses calls with both prompt and completion usage reported. Missing usage means unknown cost; this estimate is not actual billing. The internal pre-request reservation uses the requested 1024 output tokens, which providers may exceed (a prior response reported 1281 completion tokens). The configured provider-side USD 10 limit is the billing safeguard.' };
}

export interface ControlledDependencies { jurorFactory?: JurorFactory; evaluate?: typeof evaluateClaims }
export async function runControlled(args: string[], env: Record<string, string | undefined>, write: (text: string) => void, dependencies: ControlledDependencies = {}): Promise<number> {
  let options: ControlledOptions;
  try { options = parseControlledArgs(args); }
  catch (error) { write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`); return 2; }
  if (options.help) { write('Usage: bun services/claims/eval/controlled-run.ts [--live] [--max-cases N | --case ID]\nOffline by default; live mode requires PHALA_AI_API_KEY and sends at most three assessments per evidence-bearing fictional case.\n'); return 0; }
  const fixtures = options.caseId
    ? controlledEvaluationFixtures.filter((item) => item.id === options.caseId)
    : controlledEvaluationFixtures.slice(0, options.maxCases);
  if (options.live && !env.PHALA_AI_API_KEY) { write('Live mode requires PHALA_AI_API_KEY.\n'); return 2; }
  if (options.live && fixtures.some((item) => CONTROLLED_MODELS.some((model) => {
    try { return new TextEncoder().encode(createClaimChatRequest(model, item.bundle, CONTROLLED_MAX_OUTPUT_TOKENS, { aciVerified: true })).length > MAX_REQUEST_BYTES; }
    catch { return true; }
  }))) {
    write('A selected controlled provider request exceeds the live byte bound.\n'); return 2;
  }
  const telemetry: ControlledTelemetry[] = [];
  const attempts: ControlledAttempt[] = [];
  let jurors: Juror[] | undefined;
  if (options.live) jurors = createBoundedControlledJurors(env.PHALA_AI_API_KEY!, telemetry, dependencies.jurorFactory ?? createAciJuror, attempts);
  let report: ClaimEvaluationReport;
  try { report = await (dependencies.evaluate ?? evaluateClaims)({ mode: options.live ? 'live' : 'offline', allowLiveJurors: options.live, jurors, fixtures, now: () => new Date('2026-09-28T00:00:00.000Z') }); }
  catch { write('Evaluation failed. Raw provider errors and response data are suppressed.\n'); return 1; }
  const accepted = new Map(fixtures.map((item) => [item.id, new Set<Assessment>([item.expected, ...((item as ControlledFixture).acceptedOutcomes ?? [])])]));
  const cases = report.cases.map((item) => ({ id: item.id, expected: item.expected, acceptedOutcomes: [...(accepted.get(item.id) ?? [])], actual: item.actual,
    acceptedOutcomeMatched: item.actual !== null && (accepted.get(item.id)?.has(item.actual) ?? false), status: item.status,
    citationCount: item.citationCount, validCitationCount: item.validCitationCount, citationValidity: item.citationCount ? item.validCitationCount / item.citationCount : null,
    rejectedCitationFindings: item.rejectedCitationFindings, failureCount: item.failureCount, elapsedMs: item.elapsedMs }));
  const acceptedCorrect = cases.filter((item) => item.acceptedOutcomeMatched).length;
  const expectedCalls = fixtures.filter((item) => item.bundle.sources.length > 0).length * 3;
  write(`${JSON.stringify({ mode: report.mode, evaluationLabel: 'Controlled synthetic fictional cases; not an accuracy benchmark.', fixtureCount: report.fixtureCount,
    metrics: { ...report.metrics, acceptedOutcomeCorrectCount: acceptedCorrect, acceptedOutcomeAccuracyAmongResolved: report.metrics.resolvedCount ? acceptedCorrect / report.metrics.resolvedCount : null },
    cases: cases.map((item) => ({ ...item, findingCount: report.cases.find((result) => result.id === item.id)?.findingCount ?? 0,
      agreementCount: report.cases.find((result) => result.id === item.id)?.agreementCount ?? 0,
      findingErrorCodes: report.cases.find((result) => result.id === item.id)?.failureCodes ?? [],
      ...(options.live ? { providerFailures: telemetry.filter((event) => event.fixtureId === item.id && event.outcome === 'failure').map(({ model, stage, errorCode }) => ({ model, stage, errorCode })) } : {}) })),
    ...(options.live ? { models: CONTROLLED_MODELS, baseUrl: CONTROLLED_BASE_URL, maximumCalls: CONTROLLED_MAX_CALLS, expectedCalls,
      preRequestReservationAllowanceUsd: CONTROLLED_SPEND_CAP_USD, providerConfiguredSpendLimitUsd: CONTROLLED_SPEND_CAP_USD,
      requestedMaxOutputTokensPerCall: CONTROLLED_MAX_OUTPUT_TOKENS,
      reservationNote: 'The pre-request reservation is an estimate; provider-reported output usage can exceed the requested output token value.',
      providerUsage: usageSummary(telemetry, attempts), estimatedCost: estimatedCost(telemetry, attempts) } : {}),
    limitations: report.limitations,
  }, null, 2)}\n`);
  return 0;
}

function usageSummary(events: ControlledTelemetry[], attempts: ControlledAttempt[]) {
  const sumField = (rows: ControlledTelemetry[], attemptedCalls: number, field: 'promptTokens' | 'completionTokens' | 'totalTokens') => {
    const reported = rows.map((item) => item.usage?.[field]).filter((value): value is number => value !== undefined);
    return { reportedTokens: reported.length ? reported.reduce((sum, value) => sum + value, 0) : null, reportedCalls: reported.length, missingCalls: attemptedCalls - reported.length };
  };
  const byModel = Object.fromEntries(CONTROLLED_MODELS.map((model) => {
    const rows = events.filter((item) => item.model === model);
    const attemptedCalls = attempts.filter((item) => item.model === model).length;
    const failureCodesByStage: Record<string, number> = {};
    for (const item of rows) if (item.outcome === 'failure') {
      const key = `${item.stage ?? 'unknown'}:${item.errorCode ?? 'unknown'}`;
      failureCodesByStage[key] = (failureCodesByStage[key] ?? 0) + 1;
    }
    return [model, { attemptedCalls, completedTelemetry: rows.length, missingTelemetry: Math.max(0, attemptedCalls - rows.length), successes: rows.filter((item) => item.outcome === 'success').length, failures: rows.filter((item) => item.outcome === 'failure').length,
      callsWithUsage: rows.filter((item) => item.usage).length,
      missingUsageCalls: Math.max(0, attemptedCalls - rows.filter((item) => item.usage?.promptTokens !== undefined && item.usage.completionTokens !== undefined).length),
      promptTokens: sumField(rows, attemptedCalls, 'promptTokens'), completionTokens: sumField(rows, attemptedCalls, 'completionTokens'), totalTokens: sumField(rows, attemptedCalls, 'totalTokens'),
      failureCodesByStage }];
  }));
  return { attemptedCalls: attempts.length, completedTelemetry: events.length, missingTelemetry: Math.max(0, attempts.length - events.length),
    successes: events.filter((item) => item.outcome === 'success').length, failures: events.filter((item) => item.outcome === 'failure').length,
    callsWithUsage: events.filter((item) => item.usage).length,
    missingUsageCalls: Math.max(0, attempts.length - events.filter((item) => item.usage?.promptTokens !== undefined && item.usage.completionTokens !== undefined).length),
    promptTokens: sumField(events, attempts.length, 'promptTokens'), completionTokens: sumField(events, attempts.length, 'completionTokens'), totalTokens: sumField(events, attempts.length, 'totalTokens'), byModel };
}

if (import.meta.main) {
  const code = await runControlled(Bun.argv.slice(2), process.env, (text) => process.stdout.write(text));
  process.exitCode = code;
}
