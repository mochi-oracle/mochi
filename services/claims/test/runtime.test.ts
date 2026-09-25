import { expect, test } from 'bun:test';
import { createClaimsRuntime } from '../src/runtime.ts';

test('runtime stays disabled for absent or incomplete explicit pilot configuration', async () => {
  for (const env of [{}, { MOCHI_CLAIMS_MODE: 'pilot' }, { MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_ACCESS_TOKEN: 'too-short' }]) {
    const handler = createClaimsRuntime(env);
    const config = await (await handler(new Request('http://localhost/api/claims/config'))).json() as { enabled: boolean; requiresAccessToken: boolean };
    expect(config.enabled).toBe(false); expect(config.requiresAccessToken).toBe(true);
  }
});

test('runtime rejects duplicate models and missing named provider credentials without network calls', async () => {
  const base = { MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_ACCESS_TOKEN: 'test-pilot-token-at-least-24-characters', MOCHI_CLAIMS_DATABASE: ':memory:' };
  const jurors = [1, 2, 3].map(n => ({ id: `j${n}`, model: 'duplicate', baseUrl: 'https://provider.example/v1' }));
  for (const config of [jurors, jurors.map((j, i) => ({ ...j, model: `m${i}`, apiKeyEnv: 'MISSING_API_KEY' }))]) {
    const handler = createClaimsRuntime({ ...base, MOCHI_CLAIMS_JURORS: JSON.stringify(config) });
    const body = await (await handler(new Request('http://localhost/api/claims/config'))).json() as { enabled: boolean };
    expect(body.enabled).toBe(false);
    expect(JSON.stringify(body)).not.toContain(base.MOCHI_CLAIMS_ACCESS_TOKEN);
  }
});


test('runtime rejects unknown transport and ACI without credentials, without network calls', async () => {
  const base = { MOCHI_CLAIMS_MODE: 'pilot', MOCHI_CLAIMS_ACCESS_TOKEN: 'test-pilot-token-at-least-24-characters', MOCHI_CLAIMS_DATABASE: ':memory:' };
  for (const transport of ['invalid', 'phala-aci', ['phala-aci']]) {
    const jurors = [1, 2, 3].map(n => ({ id: `j${n}`, model: `model-${n}`, baseUrl: 'https://provider.example/v1', transport }));
    const handler = createClaimsRuntime({ ...base, MOCHI_CLAIMS_JURORS: JSON.stringify(jurors) });
    const config = await (await handler(new Request('http://localhost/api/claims/config'))).json() as { enabled: boolean };
    expect(config.enabled).toBe(false);
  }
});
