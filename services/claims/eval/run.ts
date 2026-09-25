#!/usr/bin/env bun
import { createChatJuror, type ChatJurorTelemetry } from '../src/providers.ts';
import { createAciJuror } from '../src/aci-provider.ts';
import type { Juror } from '../src/types.ts';
import { evaluationFixtures } from './fixtures.ts';
import { evaluateClaims, type ClaimEvaluationReport } from './index.ts';

export interface CliOptions { live: boolean; maxCases: number; help: boolean }
const MAX_CASES = evaluationFixtures.length;

export function parseCliArgs(args: string[]): CliOptions {
  let live = false;
  let maxCases = MAX_CASES;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--live') {
      if (live) throw new Error('Duplicate --live flag.');
      live = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--max-cases') {
      const raw = args[++i];
      if (!raw || !/^[1-9]\d*$/u.test(raw)) throw new Error('--max-cases requires a positive integer.');
      maxCases = Number(raw);
      if (!Number.isSafeInteger(maxCases) || maxCases > MAX_CASES) throw new Error(`--max-cases must be between 1 and ${MAX_CASES}.`);
    } else {
      throw new Error('Unknown argument. Supported flags are --live, --max-cases N, and --help.');
    }
  }
  if (help && args.some((arg) => arg !== '--help' && arg !== '-h')) throw new Error('--help cannot be combined with other flags.');
  return { live, maxCases, help };
}

type JurorTransport = 'chat-completions' | 'phala-aci';
interface JurorConfig { id: string; model: string; baseUrl: string; transport: JurorTransport; apiKeyEnv?: string }
export function parseJurorConfig(env: Record<string, string | undefined>): JurorConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(env.MOCHI_CLAIMS_JURORS ?? 'null'); } catch { throw new Error('MOCHI_CLAIMS_JURORS must contain valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('MOCHI_CLAIMS_JURORS must configure exactly three jurors.');
  const configs = parsed.map((raw): JurorConfig => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid juror configuration.');
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['id', 'model', 'baseUrl', 'apiKeyEnv', 'transport'].includes(key)) ||
      typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/u.test(item.id) ||
      typeof item.model !== 'string' || !item.model.trim() || item.model.length > 150 ||
      typeof item.baseUrl !== 'string' || !item.baseUrl.trim() || item.baseUrl.length > 1000 ||
      (item.transport !== undefined && item.transport !== 'chat-completions' && item.transport !== 'phala-aci') ||
      (item.apiKeyEnv !== undefined && (typeof item.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/u.test(item.apiKeyEnv)))) {
      throw new Error('Invalid juror configuration.');
    }
    const transport = (item.transport ?? 'chat-completions') as JurorTransport;
    if (transport === 'phala-aci' && typeof item.apiKeyEnv !== 'string') throw new Error('A Phala ACI juror requires a named apiKeyEnv.');
    return { id: item.id, model: item.model, baseUrl: item.baseUrl, transport, ...(typeof item.apiKeyEnv === 'string' ? { apiKeyEnv: item.apiKeyEnv } : {}) };
  });
  if (new Set(configs.map((item) => item.id)).size !== 3 || new Set(configs.map((item) => item.model)).size !== 3) {
    throw new Error('Juror IDs and model names must be distinct.');
  }
  return configs;
}

export interface ProviderUsageSummary {
  calls: number;
  successes: number;
  failures: number;
  callsWithUsage: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokenFieldCounts: Record<'promptTokens' | 'completionTokens' | 'totalTokens', { reported: number; missing: number }>;
  byModel: Record<string, { calls: number; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }>;
  note: string;
}

function createLiveJurors(env: Record<string, string | undefined>, events: ChatJurorTelemetry[]): Juror[] {
  const config = parseJurorConfig(env);
  // Validate all named keys before creating the jurors or making any provider request.
  for (const item of config) if (item.apiKeyEnv && !env[item.apiKeyEnv]) throw new Error(`Missing configured provider key: ${item.apiKeyEnv}.`);
  return config.map((item) => {
    const jurorOptions = {
      id: item.id, model: item.model, baseUrl: item.baseUrl,
      ...(item.apiKeyEnv ? { apiKey: env[item.apiKeyEnv] } : {}),
      maxOutputTokens: 1400, timeoutMs: 45_000,
      onTelemetry: (event: ChatJurorTelemetry) => { events.push(event); },
    };
    return item.transport === 'phala-aci' ? createAciJuror(jurorOptions) : createChatJuror(jurorOptions);
  });
}

export function summarizeProviderUsage(events: ChatJurorTelemetry[]): ProviderUsageSummary {
  const tokenFields = ['promptTokens', 'completionTokens', 'totalTokens'] as const;
  const sumField = (rows: ChatJurorTelemetry[], field: typeof tokenFields[number]) => {
    const available = rows.map((event) => event.usage?.[field]).filter((value): value is number => value !== undefined);
    return available.length ? available.reduce((sum, value) => sum + value, 0) : null;
  };
  const tokenFieldCounts = Object.fromEntries(tokenFields.map((field) => {
    const reported = events.filter((event) => event.usage?.[field] !== undefined).length;
    return [field, { reported, missing: events.length - reported }];
  })) as ProviderUsageSummary['tokenFieldCounts'];
  const models = [...new Set(events.map((event) => event.model))];
  const byModel = Object.fromEntries(models.map((model) => {
    const rows = events.filter((event) => event.model === model);
    return [model, { calls: rows.length, promptTokens: sumField(rows, 'promptTokens'), completionTokens: sumField(rows, 'completionTokens'), totalTokens: sumField(rows, 'totalTokens') }];
  }));
  return {
    calls: events.length,
    successes: events.filter((event) => event.outcome === 'success').length,
    failures: events.filter((event) => event.outcome === 'failure').length,
    callsWithUsage: events.filter((event) => event.usage).length,
    promptTokens: sumField(events, 'promptTokens'),
    completionTokens: sumField(events, 'completionTokens'),
    totalTokens: sumField(events, 'totalTokens'),
    tokenFieldCounts, byModel,
    note: 'Provider-reported token counts only; missing usage is unknown and costs are not measured.',
  };
}

export async function runCli(args: string[], env: Record<string, string | undefined>, write: (text: string) => void): Promise<number> {
  let options: CliOptions;
  try { options = parseCliArgs(args); }
  catch (error) { write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`); return 2; }
  if (options.help) {
    write('Usage: bun services/claims/eval/run.ts [--live] [--max-cases N]\nOffline is the default. Live mode sends up to 3 × N synthetic fixture assessments.\n');
    return 0;
  }
  const fixtures = evaluationFixtures.slice(0, options.maxCases);
  const telemetry: ChatJurorTelemetry[] = [];
  let jurors: Juror[] | undefined;
  if (options.live) {
    try { jurors = createLiveJurors(env, telemetry); }
    catch (error) { write(`${error instanceof Error ? error.message : 'Invalid live configuration.'}\n`); return 2; }
  }
  let report: ClaimEvaluationReport;
  try {
    report = await evaluateClaims({ mode: options.live ? 'live' : 'offline', allowLiveJurors: options.live, jurors, fixtures });
  } catch {
    write('Evaluation failed. Raw provider errors and response data are suppressed.\n');
    return 1;
  }
  const payload = {
    mode: report.mode,
    fixtureCount: report.fixtureCount,
    metrics: report.metrics,
    cost: report.cost,
    limitations: report.limitations,
    ...(options.live ? {
      providerUsage: summarizeProviderUsage(telemetry),
      callCap: 3 * fixtures.length,
      benchmarkLabel: 'Live model assessment of synthetic controlled cases; not a public-fact quality benchmark.',
    } : { benchmarkLabel: 'Offline deterministic synthetic harness check; not a model quality benchmark.' }),
  };
  write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2), process.env, (text) => process.stdout.write(text));
  process.exitCode = code;
}
