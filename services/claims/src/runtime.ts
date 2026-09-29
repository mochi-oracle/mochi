import { createClaimsHandler } from './app.ts';
import { SqlitePublicClaimStore } from './store.ts';
import { createResearcher, createBraveSearch } from './research.ts';
import { reviewBundle } from './review.ts';
import { createChatJuror } from './providers.ts';
import { createAciJuror } from './aci-provider.ts';

/** Reads only explicitly configured server variables; never forwards provider credentials. */
export function createClaimsRuntime(env: Record<string, string | undefined> = process.env) {
  const disabled = () => createClaimsHandler({ store: new SqlitePublicClaimStore(':memory:') });
  if (env.MOCHI_CLAIMS_MODE !== 'pilot') return disabled();
  try {
    const token = env.MOCHI_CLAIMS_ACCESS_TOKEN;
    if (!token || token.length < 24 || !env.MOCHI_CLAIMS_DATABASE) return disabled();
    const config: unknown = JSON.parse(env.MOCHI_CLAIMS_JURORS ?? 'null');
    if (!Array.isArray(config) || config.length !== 3) return disabled();
    const jurors = config.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('config');
      const item = value as Record<string, unknown>;
      if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) || typeof item.model !== 'string' || item.model.length > 150 || typeof item.baseUrl !== 'string') throw new Error('config');
      if (item.apiKeyEnv !== undefined && (typeof item.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(item.apiKeyEnv))) throw new Error('config');
      const apiKey = typeof item.apiKeyEnv === 'string' ? env[item.apiKeyEnv] : undefined;
      if (item.apiKeyEnv && !apiKey) throw new Error('config');
      const transport = item.transport ?? 'chat-completions';
      if (transport !== 'chat-completions' && transport !== 'phala-aci') throw new Error('config');
      if (transport === 'phala-aci') {
        if (!apiKey) throw new Error('config');
        return createAciJuror({ id: item.id, model: item.model, baseUrl: item.baseUrl, apiKey, maxOutputTokens: 1400, timeoutMs: 75_000 });
      }
      return createChatJuror({ id: item.id, model: item.model, baseUrl: item.baseUrl, apiKey, maxOutputTokens: 1400, timeoutMs: 45_000 });
    });
    if (new Set(jurors.map(j => j.id)).size !== 3 || new Set(jurors.map(j => j.model)).size !== 3) return disabled();
    const search = env.MOCHI_CLAIMS_SEARCH_KEY ? createBraveSearch(env.MOCHI_CLAIMS_SEARCH_KEY) : undefined;
    const researcher = createResearcher({ search });
    const store = new SqlitePublicClaimStore(env.MOCHI_CLAIMS_DATABASE);
    return createClaimsHandler({ store, accessToken: token, researcher, reviewer: bundle => reviewBundle(bundle, jurors, { timeoutMs: 80_000 }), maxActionsPerDay: Number(env.MOCHI_CLAIMS_DAILY_ACTIONS ?? 100), maxConcurrent: 2 });
  } catch { return disabled(); }
}
