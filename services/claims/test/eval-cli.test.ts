import { describe, expect, test } from 'bun:test';
import { parseCliArgs, parseJurorConfig, runCli, summarizeProviderUsage } from '../eval/run.ts';

describe('claim evaluation CLI', () => {
  test('defaults offline and enforces bounded known flags', () => {
    expect(parseCliArgs([])).toEqual({ live: false, maxCases: 5, help: false });
    expect(parseCliArgs(['--live', '--max-cases', '2'])).toEqual({ live: true, maxCases: 2, help: false });
    expect(() => parseCliArgs(['--unknown'])).toThrow('Unknown argument');
    expect(() => parseCliArgs(['--max-cases', '0'])).toThrow('positive integer');
    expect(() => parseCliArgs(['--max-cases', '6'])).toThrow('between 1 and 5');
    expect(() => parseCliArgs(['--live', '--live'])).toThrow('Duplicate');
  });

  test('offline CLI prints aggregate synthetic metrics and does not print claim text', async () => {
    let output = '';
    const code = await runCli(['--max-cases', '1'], {}, (text) => { output += text; });
    expect(code).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.mode).toBe('offline');
    expect(parsed.fixtureCount).toBe(1);
    expect(parsed.cases).toBeUndefined();
    expect(output).not.toContain('The fictional policy allows refunds');
    expect(parsed.cost.status).toBe('not_measured');
  });

  test('live configuration fails before calls on malformed config, missing keys, or duplicate models', async () => {
    const outputs: string[] = [];
    const invoke = (env: Record<string, string | undefined>) => runCli(['--live', '--max-cases', '1'], env, (text) => outputs.push(text));
    expect(await invoke({ MOCHI_CLAIMS_JURORS: '{bad json' })).toBe(2);
    const config = [0, 1, 2].map((i) => ({ id: `j${i}`, model: `m${i}`, baseUrl: 'https://provider.invalid/v1', apiKeyEnv: `CLAIM_KEY_${i}` }));
    expect(await invoke({ MOCHI_CLAIMS_JURORS: JSON.stringify(config), CLAIM_KEY_0: 'secret0', CLAIM_KEY_1: 'secret1' })).toBe(2);
    expect(await invoke({ MOCHI_CLAIMS_JURORS: JSON.stringify(config.map((item) => ({ ...item, model: 'same' }))), CLAIM_KEY_0: 'a', CLAIM_KEY_1: 'b', CLAIM_KEY_2: 'c' })).toBe(2);
    expect(outputs.join(' ')).not.toContain('secret');
    expect(outputs).toHaveLength(3);
  });

  test('configuration defaults transport safely and requires a named key for Phala ACI', () => {
    const chat = [0, 1, 2].map((i) => ({ id: `j${i}`, model: `m${i}`, baseUrl: 'https://provider.invalid/v1' }));
    expect(parseJurorConfig({ MOCHI_CLAIMS_JURORS: JSON.stringify(chat) })[0]?.transport).toBe('chat-completions');
    const aci = chat.map((item, i) => ({ ...item, transport: 'phala-aci', apiKeyEnv: `ACI_KEY_${i}` }));
    expect(parseJurorConfig({ MOCHI_CLAIMS_JURORS: JSON.stringify(aci) })[0]?.transport).toBe('phala-aci');
    expect(() => parseJurorConfig({ MOCHI_CLAIMS_JURORS: JSON.stringify(chat.map((item) => ({ ...item, transport: 'unknown' }))) })).toThrow('Invalid juror configuration');
    expect(() => parseJurorConfig({ MOCHI_CLAIMS_JURORS: JSON.stringify(chat.map((item) => ({ ...item, transport: 'phala-aci' }))) })).toThrow('requires a named apiKeyEnv');
  });

  test('provider token totals include only provider-reported values', () => {
    const result = summarizeProviderUsage([
      { id: 'a', model: 'a', elapsedMs: 5, outcome: 'success', usage: { promptTokens: 12, totalTokens: 15 } },
      { id: 'b', model: 'b', elapsedMs: 7, outcome: 'failure' },
    ]);
    expect(result).toMatchObject({ calls: 2, successes: 1, failures: 1, callsWithUsage: 1, promptTokens: 12, completionTokens: null, totalTokens: 15 });
    expect(result.tokenFieldCounts).toEqual({ promptTokens: { reported: 1, missing: 1 }, completionTokens: { reported: 0, missing: 2 }, totalTokens: { reported: 1, missing: 1 } });
    expect(result.byModel.a?.promptTokens).toBe(12);
    expect(result.byModel.b?.totalTokens).toBeNull();
  });
});
