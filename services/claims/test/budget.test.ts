import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AciClient, reportData, workloadKeysetDigest } from '@mochi/aci';
import { ProviderBudget, defaultDailyCallLimit, estimateCallTokens } from '../src/budget.ts';
import { SqlitePublicClaimStore } from '../src/store.ts';
import { DEFAULT_ACI_MAX_ATTEMPTS, createAciJuror } from '../src/aci-provider.ts';
import { createChatJuror, createClaimChatRequest } from '../src/providers.ts';
import { createClaimsHandler } from '../src/app.ts';
import { createClaimsRuntime } from '../src/runtime.ts';
import { reviewBundle } from '../src/review.ts';
import type { EvidenceBundle, Juror } from '../src/types.ts';

const bundle: EvidenceBundle = {
  version: 1, id: 'bundle-id', claim: 'A testable public claim', asOf: 'today', warnings: [],
  sources: [{ id: 's1', url: 'https://source.test', title: 'Source', text: 'Quoted evidence.', retrievedAt: 'today', contentHash: 'hash' }],
};
const answer = { assessment: 'supported', explanation: 'The source supports it.', citations: [{ sourceId: 's1', quote: 'Quoted evidence.' }], limitations: ['fixture'] };
const envelope = (usage?: unknown) => ({ choices: [{ message: { content: JSON.stringify(answer) } }], ...(usage ? { usage } : {}) });
const established = { workloadId: 'w', keysetDigest: 'd', receiptKeys: [], staleAfter: 2_000_000_000, tcbStatus: 'UpToDate' };
const stores: SqlitePublicClaimStore[] = [];
const dirs: string[] = [];
const store = (path = ':memory:') => { const s = new SqlitePublicClaimStore(path); stores.push(s); return s; };
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('local daily model budget', () => {
  test('caps provider attempts per day, retries included, and resets on the next UTC day', async () => {
    let day = '2026-10-02T12:00:00Z';
    const budget = new ProviderBudget(store(), 'juror-a', { dailyCalls: 3, dailyTokens: 1_000_000 }, () => new Date(day));
    let calls = 0;
    const client = { chat: async () => { calls++; if (calls === 1) throw Object.assign(new Error('busy'), { code: 'inference_http', httpStatus: 503 }); return { json: envelope(), established, receipt: {} }; } } as unknown as AciClient;
    const events: any[] = [];
    const juror = createAciJuror({ id: 'juror-a', model: 'm', baseUrl: 'https://aci.test/v1', client, budget, onTelemetry: e => events.push(e), retry: { sleep: async () => {}, random: () => 0 } });
    await juror.assess(bundle); // two attempts: a retried 503, then success
    expect(calls).toBe(2);
    await juror.assess(bundle);
    expect(calls).toBe(3);
    await expect(juror.assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(calls).toBe(3);
    expect(events.at(-1)).toMatchObject({ outcome: 'failure', errorCode: 'BUDGET_EXHAUSTED' });
    expect(budget.available()).toBe(false);
    day = '2026-10-03T00:00:01Z';
    expect(budget.available()).toBe(true);
    await juror.assess(bundle);
    expect(calls).toBe(4);
  });

  test('reserves a pessimistic token estimate, settles to reported usage, and persists across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-claims-budget-')); dirs.push(dir);
    const path = join(dir, 'claims.sqlite');
    const now = () => new Date('2026-10-02T08:00:00Z');
    const first = store(path);
    const estimate = estimateCallTokens('x'.repeat(9_000), 1400);
    let budget = new ProviderBudget(first, 'j', { dailyCalls: 100, dailyTokens: estimate * 2 }, now);
    const reported = createChatJuror({ id: 'j', model: 'm', baseUrl: 'https://provider.test/v1', budget, fetcher: async () => Response.json(envelope({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })) });
    await reported.assess(bundle);
    expect(first.providerUsage('2026-10-02', 'j')).toEqual({ calls: 1, tokens: 120 });
    const unreported = createChatJuror({ id: 'j', model: 'm', baseUrl: 'https://provider.test/v1', budget, fetcher: async () => Response.json(envelope()) });
    await unreported.assess(bundle);
    const kept = first.providerUsage('2026-10-02', 'j').tokens;
    expect(kept).toBeGreaterThan(120); // no usage reported: the estimate stays charged
    first.close(); stores.splice(stores.indexOf(first), 1);
    const reopened = store(path);
    expect(reopened.providerUsage('2026-10-02', 'j')).toEqual({ calls: 2, tokens: kept });
    budget = new ProviderBudget(reopened, 'j', { dailyCalls: 100, dailyTokens: kept + 10 }, now);
    expect(budget.reserve(estimate)).toBeNull();
    let fetched = 0;
    const blocked = createChatJuror({ id: 'j', model: 'm', baseUrl: 'https://provider.test/v1', budget, fetcher: async () => { fetched++; return Response.json(envelope()); } });
    await expect(blocked.assess(bundle)).rejects.toThrow();
    expect(fetched).toBe(0);
  });

  test('the pilot refuses reviews before spending an action once any juror budget is exhausted', async () => {
    const ACCESS = 'test-pilot-access-token-at-least-24-characters';
    let available = true; let reviews = 0;
    const jurors: Juror[] = [1, 2, 3].map(n => ({ id: `j${n}`, model: `m${n}`, assess: async () => answer }));
    const s = store();
    const handler = createClaimsHandler({ store: s, accessToken: ACCESS, researcher: async () => bundle, reviewer: b => { reviews++; return reviewBundle(b, jurors); }, providerBudgetAvailable: () => available, maxActionsPerDay: 10 });
    const post = (path: string, body: unknown) => handler(new Request(`https://mochi.test/api/claims/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mochi-access-token': ACCESS }, body: JSON.stringify(body) }));
    const research = await (await post('research', { claim: bundle.claim, consent: true })).json() as { researchToken: string };
    available = false;
    const refused = await post('reviews', { researchToken: research.researchToken, consent: true });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'DAILY_LIMIT' } });
    expect(reviews).toBe(0);
    available = true;
    expect((await post('reviews', { researchToken: research.researchToken, consent: true })).status).toBe(200);
  });
});

const instant = { sleep: async () => {}, random: () => 0 };
const DAY = '2026-10-02';
const fixedNow = () => new Date(`${DAY}T12:00:00Z`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const busy = () => Object.assign(new Error('busy'), { code: 'inference_http', httpStatus: 503 });
/** Reservation of one ACI attempt for `bundle` with the default output limit. */
const attemptEstimate = (b: EvidenceBundle = bundle) => estimateCallTokens(createClaimChatRequest('m', b, 1200, { aciVerified: true }), 1200);

// A fake ACI gateway driving the real AciClient: its attestation report verifies against a stub DCAP result that
// echoes the quote bytes (the report's own report_data) as the TD report data.
const keyset = { not_after: 2_000_000_000, receipt_signing_keys: [] };
const keysetDigest = workloadKeysetDigest(keyset);
function attestedReport(url: URL): Response {
  const bound = reportData(keysetDigest, url.searchParams.get('nonce')!);
  return Response.json({ api_version: 'aci/1', workload_keyset_digest: keysetDigest, attestation: { tee_type: 'tdx', workload_keyset: keyset, report_data: bound, evidence: { quote: bound } } });
}
const hang = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
type GatewayHandler = (url: URL, signal?: AbortSignal | null) => Response | Promise<Response>;
function gateway(handlers: { attestation?: GatewayHandler; chat?: GatewayHandler }) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/aci/attestation') return (handlers.attestation ?? attestedReport)(url, init?.signal);
    if (url.pathname === '/v1/chat/completions' && handlers.chat) return handlers.chat(url, init?.signal);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, posts: () => requests.filter(request => request.startsWith('POST')).length };
}
function trackedJuror(budget: ProviderBudget, gw: ReturnType<typeof gateway>, options: { tcbStatus?: string; allowedModels?: string[]; maxAttempts?: number; timeoutMs?: number; attemptCapMs?: number } = {}) {
  return createAciJuror({
    id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', budget,
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    retry: { ...instant, ...(options.attemptCapMs ? { attemptCapMs: options.attemptCapMs, minAttemptMs: 1 } : {}) },
    client: track => new AciClient({
      baseUrl: 'https://aci.test/v1', apiKey: 'test-key', fetch: track(gw.fetch), allowUnpinned: true, allowedModels: options.allowedModels ?? ['m'],
      dcap: quote => { const data = new Uint8Array(64); data.set(quote); return { ok: true, status: options.tcbStatus ?? 'UpToDate', reportType: 'tdx', reportData: data }; },
    }),
  });
}

describe('budget refunds for attempts that never sent the inference request', () => {
  test('attestation failures, TCB refusal, request policy refusal and aborts before sending consume no budget', async () => {
    const s = store();
    const budget = new ProviderBudget(s, 'j', { dailyCalls: 10, dailyTokens: 1_000_000 }, fixedNow);
    const usage = () => s.providerUsage(DAY, 'j');

    const unavailable = gateway({ attestation: () => new Response('busy', { status: 503 }) });
    await expect(trackedJuror(budget, unavailable).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(unavailable.requests).toEqual(Array(DEFAULT_ACI_MAX_ATTEMPTS).fill('GET /v1/aci/attestation')); // retried, never sent
    await tick();
    expect(usage()).toEqual({ calls: 0, tokens: 0 });

    const outdated = gateway({ chat: () => Response.json(envelope()) });
    await expect(trackedJuror(budget, outdated, { tcbStatus: 'OutOfDate' }).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(outdated.posts()).toBe(0);
    await tick();
    expect(usage()).toEqual({ calls: 0, tokens: 0 });

    const refusedModel = gateway({ chat: () => Response.json(envelope()) });
    await expect(trackedJuror(budget, refusedModel, { allowedModels: ['another-model'] }).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(refusedModel.requests).toEqual([]);
    await tick();
    expect(usage()).toEqual({ calls: 0, tokens: 0 });

    const stalled = gateway({ attestation: (_url, signal) => hang(signal), chat: () => Response.json(envelope()) });
    const parent = new AbortController();
    const pending = trackedJuror(budget, stalled).assess(bundle, parent.signal);
    await tick();
    parent.abort();
    await expect(pending).rejects.toThrow('Provider request unavailable');
    expect(stalled.posts()).toBe(0);
    await tick();
    expect(usage()).toEqual({ calls: 0, tokens: 0 });
    expect(budget.reserve(1)).not.toBeNull(); // the store still reserves normally afterwards
  });

  test('attempts that sent or may have sent the inference request stay charged', async () => {
    const s = store();
    const budget = new ProviderBudget(s, 'j', { dailyCalls: 20, dailyTokens: 1_000_000 }, fixedNow);
    const usage = () => s.providerUsage(DAY, 'j');
    const estimate = attemptEstimate();

    const rejected = gateway({ chat: () => new Response('busy', { status: 503 }) });
    await expect(trackedJuror(budget, rejected).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(rejected.posts()).toBe(DEFAULT_ACI_MAX_ATTEMPTS);
    await tick();
    expect(usage()).toEqual({ calls: DEFAULT_ACI_MAX_ATTEMPTS, tokens: DEFAULT_ACI_MAX_ATTEMPTS * estimate });

    // Inference answered, but the receipt step failed afterwards.
    const noReceipt = gateway({ chat: () => Response.json(envelope()) });
    await expect(trackedJuror(budget, noReceipt).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(noReceipt.posts()).toBe(1);
    await tick();
    expect(usage()).toEqual({ calls: DEFAULT_ACI_MAX_ATTEMPTS + 1, tokens: (DEFAULT_ACI_MAX_ATTEMPTS + 1) * estimate });

    // The attempt timed out after the request was handed to fetch.
    const slow = gateway({ chat: (_url, signal) => hang(signal) });
    await expect(trackedJuror(budget, slow, { maxAttempts: 1, timeoutMs: 1_000, attemptCapMs: 30 }).assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(slow.posts()).toBe(1);
    await tick();
    expect(usage()).toEqual({ calls: DEFAULT_ACI_MAX_ATTEMPTS + 2, tokens: (DEFAULT_ACI_MAX_ATTEMPTS + 2) * estimate });
  });

  test('refunds stay conservative: an overlapping send or an unobservable client keeps the charge', async () => {
    const s = store();
    const budget = new ProviderBudget(s, 'j', { dailyCalls: 10, dailyTokens: 1_000_000 }, fixedNow);
    const estimate = attemptEstimate();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    let attestations = 0;
    const gw = gateway({
      attestation: async url => { if (++attestations === 1) { await firstHeld; return new Response('busy', { status: 503 }); } return attestedReport(url); },
      chat: () => new Response('busy', { status: 503 }),
    });
    const juror = trackedJuror(budget, gw, { maxAttempts: 1 });
    const first = juror.assess(bundle).then(() => 'answered', () => 'failed');
    await tick(); // the first attempt now waits for its attestation report
    await expect(juror.assess(bundle)).rejects.toThrow('Provider request unavailable'); // the second one sends
    releaseFirst();
    expect(await first).toBe('failed');
    await tick();
    expect(gw.posts()).toBe(1);
    // The first attempt never sent anything, but it cannot be told apart from the overlapping send, so it stays charged.
    expect(s.providerUsage(DAY, 'j')).toEqual({ calls: 2, tokens: 2 * estimate });

    const prebuilt = { chat: async () => { throw Object.assign(new Error('refused'), { code: 'tcb_status' }); } } as unknown as AciClient;
    await expect(createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', client: prebuilt, budget, retry: instant }).assess(bundle)).rejects.toThrow();
    await tick();
    expect(s.providerUsage(DAY, 'j')).toEqual({ calls: 3, tokens: 3 * estimate });
  });

  test('a released reservation returns its call and tokens once; settle and release are mutually exclusive', () => {
    const s = store();
    const budget = new ProviderBudget(s, 'j', { dailyCalls: 2, dailyTokens: 10_000 }, fixedNow);
    const first = budget.reserve(4_000)!;
    const second = budget.reserve(4_000)!;
    expect(budget.reserve(1)).toBeNull();
    first.release();
    first.release();
    first.settle(10);
    expect(s.providerUsage(DAY, 'j')).toEqual({ calls: 1, tokens: 4_000 });
    second.settle(1_000);
    second.release();
    expect(s.providerUsage(DAY, 'j')).toEqual({ calls: 1, tokens: 1_000 });
    expect(budget.reserve(4_000)).not.toBeNull();
  });
});

describe('default daily call limit', () => {
  test('covers every daily action using all of its ACI attempts, within the call maximum', async () => {
    expect(defaultDailyCallLimit(100, DEFAULT_ACI_MAX_ATTEMPTS)).toBe(300);
    expect(defaultDailyCallLimit(1000, 5)).toBe(5_000);
    expect(defaultDailyCallLimit(5_000, 5)).toBe(10_000);
    const dailyActions = 4;
    const run = async (dailyCalls: number) => {
      const budget = new ProviderBudget(store(), 'j', { dailyCalls, dailyTokens: 1_000_000 }, fixedNow);
      let calls = 0;
      // Every action needs all of its attempts: two retryable failures, then an answer.
      const client = { chat: async () => { calls++; if (calls % DEFAULT_ACI_MAX_ATTEMPTS !== 0) throw busy(); return { json: envelope(), established, receipt: {} }; } } as unknown as AciClient;
      const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', client, budget, retry: instant });
      let answered = 0;
      for (let action = 0; action < dailyActions; action++) answered += await juror.assess(bundle).then(() => 1, () => 0);
      return answered;
    };
    expect(await run(defaultDailyCallLimit(dailyActions, DEFAULT_ACI_MAX_ATTEMPTS))).toBe(dailyActions);
    expect(await run(dailyActions)).toBeLessThan(dailyActions); // the old default: retries starve later actions
  });
});

describe('token estimate', () => {
  test('counts each ASCII digit as a token and keeps digit-free text at a third of a token per byte', () => {
    const prose = 'The ministry reported that the programme expanded across several regions, according to the annual review. ';
    expect(estimateCallTokens(prose, 0)).toBe(Math.ceil(new TextEncoder().encode(prose).length / 3));
    expect(estimateCallTokens(prose, 1200)).toBe(Math.ceil(new TextEncoder().encode(prose).length / 3) + 1200);
    const dated = 'On 2026-10-02 the agency revised its estimate from 4.1 to 3.9 percent.';
    const datedBytes = new TextEncoder().encode(dated).length;
    expect(estimateCallTokens(dated, 0)).toBeGreaterThanOrEqual(Math.ceil(datedBytes / 3));
    expect(estimateCallTokens(dated, 0)).toBeLessThanOrEqual(Math.ceil(datedBytes / 3) + 10); // close for ordinary prose
    const digits = '8406217935'.repeat(1_000);
    expect(estimateCallTokens(digits, 0)).toBe(10_000); // one token per digit, not 3,334
    const table = Array.from({ length: 2_000 }, (_, i) => `${(i * 7_919) % 100_000}.${i % 100}`).join(',');
    const tableDigits = table.replace(/[^0-9]/gu, '').length;
    expect(estimateCallTokens(table, 0)).toBeGreaterThanOrEqual(tableDigits);
    expect(estimateCallTokens(new TextEncoder().encode(table), 0)).toBe(estimateCallTokens(table, 0));
    expect(estimateCallTokens('١٢٣', 0)).toBe(2); // non-ASCII digits are ordinary UTF-8 bytes
  });

  test('both juror transports reserve the digit-aware estimate of the request they send', async () => {
    const numeric: EvidenceBundle = { ...bundle, sources: [{ ...bundle.sources[0]!, text: '73019'.repeat(4_000) }] };
    const request = createClaimChatRequest('m', numeric, 1200, { aciVerified: true });
    const bytes = new TextEncoder().encode(request).length;
    expect(attemptEstimate(numeric)).toBeGreaterThanOrEqual(20_000 + 1200);
    const dailyTokens = Math.ceil(bytes / 3) + 1200 + 2_000; // would admit the old byte-based estimate
    let calls = 0;
    const aci = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', budget: new ProviderBudget(store(), 'j', { dailyCalls: 10, dailyTokens }, fixedNow), retry: instant,
      client: { chat: async () => { calls++; return { json: envelope(), established, receipt: {} }; } } as unknown as AciClient });
    await expect(aci.assess(numeric)).rejects.toThrow('Provider request unavailable');
    const chat = createChatJuror({ id: 'j', model: 'm', baseUrl: 'https://provider.test/v1', budget: new ProviderBudget(store(), 'j', { dailyCalls: 10, dailyTokens }, fixedNow),
      fetcher: async () => { calls++; return Response.json(envelope()); } });
    await expect(chat.assess(numeric)).rejects.toThrow('Provider request unavailable');
    expect(calls).toBe(0);
  });
});

describe('pilot runtime configuration', () => {
  const base = { MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_ACCESS_TOKEN: 'test-pilot-token-at-least-24-characters', MOCHI_CLAIMS_DATABASE: ':memory:', PHALA_API_KEY: 'test-provider-key-value' };
  const jurors = (extra: Record<string, unknown> = {}) => [1, 2, 3].map(n => ({ id: `j${n}`, model: `model-${n}`, baseUrl: 'https://aci.example/v1', transport: 'phala-aci', apiKeyEnv: 'PHALA_API_KEY', ...extra }));
  const enabled = async (config: unknown) => ((await (await createClaimsRuntime({ ...base, MOCHI_CLAIMS_JURORS: JSON.stringify(config) })(new Request('http://localhost/api/claims/config'))).json()) as { enabled: boolean }).enabled;
  test('accepts attested ACI pins and budget fields, and fails closed on invalid ones', async () => {
    expect(await enabled(jurors())).toBe(true);
    expect(await enabled(jurors({ attestation: [`os:${'ab'.repeat(32)}`, `compose:${'cd'.repeat(32)}`], dailyCallLimit: 50, dailyTokenLimit: 500_000, usdPerMillionTokens: 0.5, dailySpendLimitUsd: 1 }))).toBe(true);
    for (const extra of [
      { attestation: ['workload-id-only'] }, { attestation: ['os:short'] }, { attestation: 'os:x' },
      { dailyCallLimit: 0 }, { dailyCallLimit: 1.5 }, { dailyTokenLimit: 10 }, { usdPerMillionTokens: 1 }, { dailySpendLimitUsd: -1, usdPerMillionTokens: 1 },
    ]) expect(await enabled(jurors(extra))).toBe(false);
    expect(await enabled(jurors().map(j => ({ ...j, transport: 'chat-completions', attestation: [`os:${'ab'.repeat(32)}`] })))).toBe(false);
  });
  test('defaults each juror call limit to the daily actions times its attempts per action; an explicit limit wins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-claims-calls-')); dirs.push(dir);
    // Seeds juror j1's usage for today and tomorrow (UTC), so a day boundary during the test cannot reset it.
    const days = () => [0, 1].map(offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10));
    const review = async (name: string, usedCalls: number, entries: unknown[]) => {
      const path = join(dir, `${name}.sqlite`);
      const seed = new SqlitePublicClaimStore(path);
      for (const day of days()) for (let i = 0; i < usedCalls; i++) seed.reserveProvider(day, 'j1', 0, { calls: 10_000, tokens: 1_000_000 });
      seed.close();
      const handler = createClaimsRuntime({ ...base, MOCHI_CLAIMS_DATABASE: path, MOCHI_CLAIMS_DAILY_ACTIONS: '2', MOCHI_CLAIMS_JURORS: JSON.stringify(entries) });
      const post = (route: string, body: unknown) => handler(new Request(`https://mochi.test/api/claims/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mochi-access-token': base.MOCHI_CLAIMS_ACCESS_TOKEN }, body: JSON.stringify(body) }));
      // Research without sources needs no network, and its review calls no juror; only the budget gate is exercised.
      const research = await (await post('research', { claim: bundle.claim, consent: true })).json() as { researchToken: string };
      const response = await post('reviews', { researchToken: research.researchToken, consent: true });
      return response.status === 200 ? 'allowed' : ((await response.json()) as { error: { message: string } }).error.message;
    };
    const exhausted = 'The pilot has reached its daily model budget.';
    // Two daily actions with up to DEFAULT_ACI_MAX_ATTEMPTS ACI attempts each allow six calls per juror.
    expect(DEFAULT_ACI_MAX_ATTEMPTS).toBe(3);
    expect(await review('aci-under', 5, jurors())).toBe('allowed');
    expect(await review('aci-spent', 6, jurors())).toBe(exhausted);
    expect(await review('explicit-under', 2, jurors({ dailyCallLimit: 3 }))).toBe('allowed');
    expect(await review('explicit-spent', 3, jurors({ dailyCallLimit: 3 }))).toBe(exhausted);
    // The chat-completions transport makes one attempt per action, so its default stays the action limit.
    const chat = jurors().map(entry => ({ ...entry, transport: 'chat-completions' }));
    expect(await review('chat-under', 1, chat)).toBe('allowed');
    expect(await review('chat-spent', 2, chat)).toBe(exhausted);
  });
  test('every pilot response carries strict security headers', async () => {
    const handler = createClaimsRuntime({ ...base, MOCHI_CLAIMS_JURORS: JSON.stringify(jurors()) });
    for (const request of [new Request('http://localhost/api/claims/config'), new Request('http://localhost/api/claims/missing'), new Request('http://localhost/api/claims/research', { method: 'POST' })]) {
      const response = await handler(request);
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
  });
});
