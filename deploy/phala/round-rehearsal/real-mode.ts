export const REAL_MODELS = ['meta-llama/llama-3.3-70b-instruct', 'nvidia/nemotron-3.5-lightning', 'google/gemma-4-31b-it'] as const;
export const REAL_MAX_INPUT_BYTES = 4096;
export const REAL_MAX_OUTPUT_TOKENS = 1024;
// Estimate reserves one input token per allowed input byte plus each model's
// requested output-token limit. Provider-reported usage can differ.
export const REAL_ESTIMATED_COST_USD = 0.01181696;

export function createInferenceCallBudget(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Inference call limit must be a positive integer.');
  let calls = 0;
  return {
    reserve(): boolean {
      if (calls >= limit) return false;
      calls++;
      return true;
    },
    used(): number { return calls; },
  };
}

export function loadRealModeConfig(env: Record<string, string | undefined>) {
  const apiKey = env.PHALA_API_KEY;
  const roundAuthSecret = env.MOCHI_ROUND_AUTH_SECRET;
  if (!apiKey || new TextEncoder().encode(apiKey).byteLength < 16 || !roundAuthSecret || new TextEncoder().encode(roundAuthSecret).byteLength < 32) {
    throw new Error('Real ACI mode requires protected API and round authorization secrets from the environment.');
  }
  const baseUrl = env.PHALA_ACI_BASE_URL ?? 'https://inference.phala.com/v1';
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Real ACI mode requires a clean HTTPS endpoint.');
  if (REAL_ESTIMATED_COST_USD > 10) throw new Error('Configured real-mode cost estimate exceeds the authorized budget.');
  return { apiKey, roundAuthSecret, baseUrl };
}
