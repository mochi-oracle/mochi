import { createClaimsHandler } from './app.ts';
import { SqlitePublicClaimStore } from './store.ts';
import { createResearcher, createBraveSearch } from './research.ts';
import { reviewBundle } from './review.ts';
import { createChatJuror } from './providers.ts';
import { createAciJuror, DEFAULT_ACI_MAX_ATTEMPTS } from './aci-provider.ts';
import { DEFAULT_DAILY_TOKENS_PER_JUROR, defaultDailyCallLimit, ProviderBudget, validBudgetLimits } from './budget.ts';
import { parseAciPolicy } from '@mochi/aci';

const optionalInteger = (value: unknown) => value === undefined ? undefined : typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN;

/**
 * Reads only explicitly configured server variables; never forwards provider credentials. Each MOCHI_CLAIMS_JURORS
 * entry may also set `attestation` (ACI pins, e.g. ["os:<64 hex>", "compose:<64 hex>"]; when present they are enforced),
 * `dailyCallLimit` and `dailyTokenLimit` (local per-juror budget; defaults: the daily action limit times the juror's
 * provider attempts per action, retries included, and 1.5M tokens), and `usdPerMillionTokens` with `dailySpendLimitUsd`
 * (lowers the token limit to that spend). Invalid values disable the pilot. `allowedTcbStatuses` is the Intel TCB
 * policy for the ACI gateway (on the CVM, the runtime config's tdxAllowedTcbStatuses); default ["UpToDate"].
 */
export function createClaimsRuntime(env: Record<string, string | undefined> = process.env, options: { allowedTcbStatuses?: readonly string[] } = {}) {
  const disabled = () => createClaimsHandler({ store: new SqlitePublicClaimStore(':memory:') });
  if (env.MOCHI_CLAIMS_MODE !== 'pilot') return disabled();
  let store: SqlitePublicClaimStore | undefined;
  try {
    const token = env.MOCHI_CLAIMS_ACCESS_TOKEN;
    if (!token || token.length < 24 || !env.MOCHI_CLAIMS_DATABASE) return disabled();
    const config: unknown = JSON.parse(env.MOCHI_CLAIMS_JURORS ?? 'null');
    if (!Array.isArray(config) || config.length !== 3) return disabled();
    const configuredActions = Number(env.MOCHI_CLAIMS_DAILY_ACTIONS ?? 100);
    const dailyActions = Number.isInteger(configuredActions) && configuredActions > 0 && configuredActions <= 1000 ? configuredActions : 100;
    store = new SqlitePublicClaimStore(env.MOCHI_CLAIMS_DATABASE);
    const budgets: ProviderBudget[] = [];
    const jurors = config.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('config');
      const item = value as Record<string, unknown>;
      if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) || typeof item.model !== 'string' || item.model.length > 150 || typeof item.baseUrl !== 'string') throw new Error('config');
      if (item.apiKeyEnv !== undefined && (typeof item.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(item.apiKeyEnv))) throw new Error('config');
      const apiKey = typeof item.apiKeyEnv === 'string' ? env[item.apiKeyEnv] : undefined;
      if (item.apiKeyEnv && !apiKey) throw new Error('config');
      const transport = item.transport ?? 'chat-completions';
      if (transport !== 'chat-completions' && transport !== 'phala-aci') throw new Error('config');
      let dailyTokens = optionalInteger(item.dailyTokenLimit) ?? DEFAULT_DAILY_TOKENS_PER_JUROR;
      if (item.usdPerMillionTokens !== undefined || item.dailySpendLimitUsd !== undefined) {
        const price = item.usdPerMillionTokens, spend = item.dailySpendLimitUsd;
        if (typeof price !== 'number' || !(price > 0) || typeof spend !== 'number' || !(spend > 0) || !Number.isFinite(price) || !Number.isFinite(spend)) throw new Error('config');
        dailyTokens = Math.min(dailyTokens, Math.floor(spend / price * 1_000_000));
      }
      // Each action calls every juror at most once, and an ACI juror may retry that call, so by default every allowed
      // action can use all of its attempts. An explicit dailyCallLimit stays authoritative.
      const attemptsPerAction = transport === 'phala-aci' ? DEFAULT_ACI_MAX_ATTEMPTS : 1;
      const limits = { dailyCalls: optionalInteger(item.dailyCallLimit) ?? defaultDailyCallLimit(dailyActions, attemptsPerAction), dailyTokens };
      if (!validBudgetLimits(limits)) throw new Error('config');
      const budget = new ProviderBudget(store!, item.id, limits);
      budgets.push(budget);
      let attestation: string[] | undefined;
      if (item.attestation !== undefined) {
        if (transport !== 'phala-aci' || !Array.isArray(item.attestation) || item.attestation.length > 16 || item.attestation.some(entry => typeof entry !== 'string')) throw new Error('config');
        const policy = parseAciPolicy(item.attestation as string[]);
        if (policy.osMeasurements.length + policy.composeHashes.length === 0) throw new Error('config');
        attestation = item.attestation as string[];
      }
      if (transport === 'phala-aci') {
        if (!apiKey) throw new Error('config');
        return createAciJuror({ id: item.id, model: item.model, baseUrl: item.baseUrl, apiKey, maxOutputTokens: 1400, timeoutMs: 75_000, budget, ...(attestation ? { allowedWorkloads: attestation } : {}), ...(options.allowedTcbStatuses ? { allowedTcbStatuses: options.allowedTcbStatuses } : {}) });
      }
      return createChatJuror({ id: item.id, model: item.model, baseUrl: item.baseUrl, apiKey, maxOutputTokens: 1400, timeoutMs: 45_000, budget });
    });
    if (new Set(jurors.map(j => j.id)).size !== 3 || new Set(jurors.map(j => j.model)).size !== 3) { store.close(); return disabled(); }
    const search = env.MOCHI_CLAIMS_SEARCH_KEY ? createBraveSearch(env.MOCHI_CLAIMS_SEARCH_KEY) : undefined;
    const researcher = createResearcher({ search });
    return createClaimsHandler({ store, accessToken: token, researcher, reviewer: bundle => reviewBundle(bundle, jurors, { timeoutMs: 80_000 }), maxActionsPerDay: Number(env.MOCHI_CLAIMS_DAILY_ACTIONS ?? 100), maxConcurrent: 2,
      providerBudgetAvailable: () => budgets.every(budget => budget.available()) });
  } catch { store?.close(); return disabled(); }
}
