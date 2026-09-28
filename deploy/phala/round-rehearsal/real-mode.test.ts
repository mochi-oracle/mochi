import { expect, test } from 'bun:test';
import { createInferenceCallBudget, loadRealModeConfig, REAL_MODELS, REAL_ESTIMATED_COST_USD } from './real-mode.ts';

test('real ACI config requires protected env-only secrets and pins three models under budget', () => {
  expect(() => loadRealModeConfig({})).toThrow();
  expect(() => loadRealModeConfig({ PHALA_API_KEY: 'x'.repeat(32) })).toThrow();
  expect(loadRealModeConfig({ PHALA_API_KEY: 'x'.repeat(32), MOCHI_ROUND_AUTH_SECRET: 'y'.repeat(40) }).baseUrl).toBe('https://inference.phala.com/v1');
  expect(REAL_MODELS).toEqual(['meta-llama/llama-3.3-70b-instruct', 'nvidia/nemotron-3.5-lightning', 'google/gemma-4-31b-it']);
  expect(REAL_ESTIMATED_COST_USD).toBeLessThan(10);
  expect(() => loadRealModeConfig({ PHALA_API_KEY: 'x'.repeat(32), MOCHI_ROUND_AUTH_SECRET: 'y'.repeat(40), PHALA_ACI_BASE_URL: 'http://provider.test' })).toThrow();
});

test('process-wide inference budget reserves exactly three model calls', () => {
  const budget = createInferenceCallBudget(3);
  expect([budget.reserve(), budget.reserve(), budget.reserve(), budget.reserve()]).toEqual([true, true, true, false]);
  expect(budget.used()).toBe(3);
  expect(() => createInferenceCallBudget(0)).toThrow();
});
