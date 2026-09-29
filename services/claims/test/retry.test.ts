import { describe, expect, test } from 'bun:test';
import { AciVerificationError, type AciClient } from '@mochi/aci';
import { createAciJuror } from '../src/aci-provider.ts';
import type { ChatJurorTelemetry } from '../src/providers.ts';
import type { EvidenceBundle } from '../src/types.ts';

const bundle: EvidenceBundle = {
  version: 1, id: 'bundle-id', claim: 'A testable public claim', asOf: 'today', warnings: [],
  sources: [{ id: 'source-1', url: 'https://source.test', title: 'Source', text: 'Quoted evidence.', retrievedAt: 'today', contentHash: 'hash' }],
};
const established = { workloadId: 'workload', keysetDigest: 'digest', receiptKeys: [], staleAfter: 2_000_000_000, tcbStatus: 'UpToDate' };
const ok = { json: { choices: [{ message: { content: '{"assessment":"supported"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, established, receipt: {} };
const busy = (status: number) => new AciVerificationError('inference_http', { status });
const injected = (chat: AciClient['chat']) => ({ chat }) as unknown as AciClient;
const instant = { sleep: async () => {}, random: () => 0 };

describe('research reviewer retries', () => {
  test('a 503 is retried with the identical request and telemetry counts both billed attempts', async () => {
    const bodies: string[] = [];
    const events: ChatJurorTelemetry[] = [];
    const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', retry: instant, onTelemetry: e => events.push(e), client: injected(async body => { bodies.push(JSON.stringify(body)); if (bodies.length === 1) throw busy(503); return ok as never; }) });
    expect(await juror.assess(bundle)).toEqual({ assessment: 'supported' });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'success', attempts: 2, attemptFailures: [{ code: 'inference_http', httpStatus: 503 }] });
    expect(JSON.stringify(events[0])).not.toContain('Quoted evidence');
  });

  test('persistent rate limiting fails after three attempts with the provider code', async () => {
    let calls = 0;
    const events: ChatJurorTelemetry[] = [];
    const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', retry: instant, onTelemetry: e => events.push(e), client: injected(async () => { calls++; throw busy(429); }) });
    await expect(juror.assess(bundle)).rejects.toThrow('Provider request unavailable');
    expect(calls).toBe(3);
    expect(events[0]).toMatchObject({ outcome: 'failure', errorCode: 'ACI_INFERENCE_HTTP', attempts: 3 });
  });

  test('attestation and receipt failures are not retried', async () => {
    for (const code of ['tcb_status', 'receipt_binding', 'report_signature']) {
      let calls = 0;
      const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', retry: instant, client: injected(async () => { calls++; throw new AciVerificationError(code); }) });
      await expect(juror.assess(bundle)).rejects.toThrow('Provider request unavailable');
      expect(calls).toBe(1);
    }
  });

  test('a stalled attempt is cut and retried inside the reviewer timeout', async () => {
    let calls = 0;
    const events: ChatJurorTelemetry[] = [];
    const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', timeoutMs: 300, retry: { random: () => 0, minAttemptMs: 10, attemptCapMs: 60 }, onTelemetry: e => events.push(e), client: injected(async (_body, options) => {
      calls++;
      if (calls === 1) return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new AciVerificationError('aborted')), { once: true }));
      return ok as never;
    }) });
    expect(await juror.assess(bundle)).toEqual({ assessment: 'supported' });
    expect(events[0]).toMatchObject({ outcome: 'success', attempts: 2, attemptFailures: [{ code: 'timeout' }] });
  });

  test('a caller abort stops the reviewer without further attempts', async () => {
    let calls = 0;
    const parent = new AbortController();
    const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', retry: { random: () => 0, sleep: async () => { parent.abort(); throw new Error('aborted'); } }, client: injected(async () => { calls++; throw busy(503); }) });
    await expect(juror.assess(bundle, parent.signal)).rejects.toThrow('Provider request unavailable');
    expect(calls).toBe(1);
  });

  test('rejects an invalid attempt limit', () => {
    expect(() => createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', maxAttempts: 0, client: injected(async () => ok as never) })).toThrow('Invalid juror attempt limit');
  });
});
