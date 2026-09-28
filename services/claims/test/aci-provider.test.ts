import { describe, expect, test } from 'bun:test';
import { AciVerificationError, type AciClient } from '@mochi/aci';
import { createAciJuror } from '../src/aci-provider.ts';
import type { EvidenceBundle } from '../src/types.ts';

const bundle: EvidenceBundle = {
  version: 1, id: 'bundle-id', claim: 'A testable public claim', asOf: 'today', warnings: [],
  sources: [{ id: 'source-1', url: 'https://source.test', title: 'Source', text: 'Quoted evidence.', retrievedAt: 'today', contentHash: 'hash' }],
};
const response = (content: string, usage?: unknown) => ({ choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) });
const established = { workloadId: 'workload', keysetDigest: 'digest', receiptKeys: [], staleAfter: 2_000_000_000, tcbStatus: 'UpToDate' };
function injected(chat: AciClient['chat']): AciClient { return { chat } as unknown as AciClient; }

describe('createAciJuror', () => {
  test('uses the shared bounded evidence request and returns only the verified ACI response content', async () => {
    let sent: unknown; let maxResponseBytes: number | undefined; let requireUpToDate: boolean | undefined;
    const client = injected(async (body, options) => {
      sent = body; maxResponseBytes = options?.maxResponseBytes; requireUpToDate = options?.requireUpToDate;
      return { json: response('{"assessment":"supported"}', { prompt_tokens: 23, completion_tokens: 8, total_tokens: 31 }), established, receipt: {} } as never;
    });
    const events: unknown[] = [];
    const juror = createAciJuror({ id: 'aci-juror', model: 'confidential-model', baseUrl: 'https://aci.test/v1', client, onTelemetry: (event) => events.push(event) });
    expect(await juror.assess(bundle)).toEqual({ assessment: 'supported' });
    const request = sent as { model: string; messages: Array<{ content: string }> };
    expect(request.model).toBe('confidential-model');
    expect(request.messages[1]?.content).toContain('Quoted evidence.');
    expect(maxResponseBytes).toBe(32_000);
    expect(requireUpToDate).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'aci-juror', model: 'confidential-model', outcome: 'success', usage: { promptTokens: 23, completionTokens: 8, totalTokens: 31 } });
    expect(JSON.stringify(events[0])).not.toContain('Quoted evidence');
  });

  test('fails closed for non-UpToDate ACI status, invalid answer JSON, and oversized evidence', async () => {
    let calls = 0;
    const events: unknown[] = [];
    const stale = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', onTelemetry: (event) => events.push(event), client: injected(async () => { calls++; return { json: response('{}'), established: { ...established, tcbStatus: 'OutOfDate' }, receipt: {} } as never; }) });
    await expect(stale.assess(bundle)).rejects.toThrow('Provider request unavailable');
    const invalid = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', onTelemetry: (event) => events.push(event), client: injected(async () => ({ json: response('not-json'), established, receipt: {} } as never)) });
    await expect(invalid.assess(bundle)).rejects.toThrow('Provider request unavailable');
    const proofFailure = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', onTelemetry: (event) => events.push(event), client: injected(async () => { throw new AciVerificationError('receipt_signature'); }) });
    await expect(proofFailure.assess(bundle)).rejects.toThrow('Provider request unavailable');
    const tooLarge = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', client: injected(async () => { calls++; return { json: response('{}'), established, receipt: {} } as never; }) });
    await expect(tooLarge.assess({ ...bundle, claim: 'x'.repeat(125_000) })).rejects.toThrow('Provider request unavailable');
    expect(calls).toBe(1);
    expect(events[0]).toMatchObject({ stage: 'attestation', errorCode: 'TCB_STATUS_NOT_UP_TO_DATE' });
    expect(events[1]).toMatchObject({ stage: 'response_parse', errorCode: 'RESPONSE_INVALID' });
    expect(events[2]).toMatchObject({ stage: 'receipt', errorCode: 'ACI_RECEIPT_SIGNATURE' });
    expect(JSON.stringify(events)).not.toContain('Provider request unavailable');
  });

  test('propagates cancellation to AciClient and isolates telemetry callback failures', async () => {
    let signal: AbortSignal | undefined;
    let telemetryEvent: unknown;
    const client = injected(async (_body, options) => {
      signal = options?.signal;
      return new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const juror = createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1', client, onTelemetry: async (event) => { telemetryEvent = event; throw new Error('private data'); } });
    const controller = new AbortController();
    const pending = juror.assess(bundle, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow('Provider request unavailable');
    expect(signal?.aborted).toBe(true);
    expect(telemetryEvent).toMatchObject({ stage: 'aci_exchange', errorCode: 'REQUEST_ABORTED' });
    expect(JSON.stringify(telemetryEvent)).not.toContain('private data');
  });

  test('requires a key and HTTPS for production construction', () => {
    expect(() => createAciJuror({ id: 'j', model: 'm', baseUrl: 'https://aci.test/v1' })).toThrow('API key');
    expect(() => createAciJuror({ id: 'j', model: 'm', baseUrl: 'http://aci.test/v1', apiKey: 'not-a-real-key' })).toThrow('HTTPS');
  });
});
