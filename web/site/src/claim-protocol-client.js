import { createClaimReviewProtocolInput } from '../../../packages/sdk/src/claims.ts';
import { SchemaId, VerdictStatus } from '@mochi/core';
import { MochiVerdictsAbi, QueryEscrowAbi } from '../../../packages/chain/src/abis.ts';
import { LiveClient } from './live-client.js';

const claimBytes = 4_000;
const excerptBytes = 18_000;
const aggregateBytes = 64_000;
const encoder = new TextEncoder();
const answers = new Set(['supported', 'contradicted', 'missing_context', 'insufficient_evidence']);
const submittedQuotes = new WeakSet();

export async function loadProtocolConfig(fetcher = fetch) {
  const response = await fetcher('/mochi-config.json', { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('Deployment configuration is unavailable.');
  const config = await response.json();
  if (config?.enabled !== true) return { enabled: false, reason: 'Protocol payments are pending deployment configuration.' };
  return { enabled: true, config };
}

export function createProtocolClient(config, options) {
  if (!config || config.enabled !== true) throw new Error('Protocol payments are not enabled for this deployment.');
  return new LiveClient(config, options);
}

function validateEvidence(claim, evidence) {
  if (typeof claim !== 'string' || !claim.trim() || encoder.encode(claim).byteLength > claimBytes) throw new RangeError('Enter one claim up to 4,000 UTF-8 bytes.');
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 5) throw new RangeError('Provide 1–5 user-submitted source excerpts.');
  let total = 0;
  for (const source of evidence) {
    if (!source || typeof source.title !== 'string' || !source.title.trim() || encoder.encode(source.title).byteLength > 2048) throw new TypeError('Each source needs a title up to 2,048 UTF-8 bytes.');
    if (typeof source.url !== 'string') throw new TypeError('Each source needs an HTTPS URL.');
    let url;
    try { url = new URL(source.url); } catch { throw new TypeError('Each source needs an HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || encoder.encode(source.url).byteLength > 2048) throw new TypeError('Each source needs an HTTPS URL without embedded credentials.');
    if (typeof source.text !== 'string' || !source.text.trim()) throw new TypeError('Each source needs an exact text excerpt.');
    const size = encoder.encode(source.text).byteLength;
    if (size > excerptBytes) throw new RangeError('A source excerpt exceeds 18,000 UTF-8 bytes.');
    total += size;
  }
  if (total > aggregateBytes) throw new RangeError('Source excerpts exceed 64,000 aggregate UTF-8 bytes.');
}

export async function preparePaidClaimReview(client, { claim, evidence }) {
  if (!client?.account) throw new Error('Connect your wallet before preparing a quote.');
  validateEvidence(claim, evidence);
  if (!client.config.jurySizes.includes(3)) throw new Error('This deployment does not support a three-juror claim review. No quote was prepared.');
  const shared = createClaimReviewProtocolInput({
    claim,
    evidence: evidence.map(({ title, url, text }, index) => ({ id: `source-${index + 1}`, title, url, excerpt: text })),
    sender: client.account,
    n: 3,
  });
  const prepared = await client.prepare({
    bytes: shared.document.bytes,
    contentType: shared.document.contentType,
    schema: 'FREEFORM_FACT',
    n: shared.n,
    isPublic: false,
    params: shared.params,
  });
  return { execution: 'prepared_unsubmitted', provenance: 'SUBMITTED', sourcesFetched: false, prepared };
}

/** Explicit payment confirmation through the existing exact-allowance LiveClient flow. */
export function payForClaimReview(client, prepared, onProgress) {
  if (!prepared?.prepared || typeof prepared.prepared !== 'object') throw new TypeError('A prepared claim quote is required.');
  if (submittedQuotes.has(prepared.prepared)) throw new Error('This quote has already been submitted or attempted. Prepare a new quote only after checking the saved query ID.');
  submittedQuotes.add(prepared.prepared);
  return client.submit(prepared.prepared, onProgress);
}

export function parseClaimRecovery(value, config) {
  if (!value || value.kind !== 'MOCHI_QUERY_RECOVERY' || value.chainId !== config.chainId || value.escrow?.toLowerCase() !== config.contracts.queryEscrow.toLowerCase() || !/^0x[0-9a-f]{64}$/i.test(value.queryId ?? '') || !/^0x[0-9a-f]{64}$/i.test(value.secrets?.salt ?? '') || !/^0x[0-9a-f]{64}$/i.test(value.secrets?.resultPrivateKey ?? '')) throw new Error('Recovery file does not match this deployment or is incomplete.');
  return { execution: 'submitted_recovery', provenance: 'SUBMITTED', prepared: { queryId: value.queryId, chainId: value.chainId, escrow: value.escrow, secrets: value.secrets } };
}

export async function waitForPaidClaimReview(client, prepared, { signal, onProgress = () => {}, timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const query = await client.read('queryEscrow', QueryEscrowAbi, 'getQuery', [prepared.prepared.queryId]);
    const queryStatus = Number(query.status);
    if (Number(query.schemaId) !== SchemaId.FREEFORM_FACT) return { execution: 'onchain_protocol', status: 'unresolved' };
    onProgress(['Unknown', 'Opened', 'Jury selected', 'Decided', 'HUNG', 'Escalated', 'Expired'][queryStatus] ?? 'Pending');
    if (queryStatus === 4) return { execution: 'onchain_protocol', status: 'HUNG' };
    if (queryStatus === 6) return { execution: 'onchain_protocol', status: 'unresolved' };
    const verdictId = await client.read('verdicts', MochiVerdictsAbi, 'latestVerdictOf', [prepared.prepared.queryId]);
    if (verdictId !== `0x${'0'.repeat(64)}`) {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const response = await client.fetcher(`/api/v1/verdict/${verdictId}`, { signal: requestSignal, cache: 'no-store', redirect: 'error' });
      if (response.ok) {
        const packet = await response.json();
        const verified = await client.verifyResult({ queryId: prepared.prepared.queryId, verdictId, packet }, prepared.prepared.secrets);
        const status = Number(verified.chain?.status);
        if (status === VerdictStatus.HUNG) return { execution: 'onchain_protocol', status: 'HUNG', verdictId };
        if (status !== VerdictStatus.VERDICT || Number(verified.chain?.schemaId) !== SchemaId.FREEFORM_FACT) return { execution: 'onchain_protocol', status: 'unresolved', verdictId };
        const answerValue = verified.answer?.fields?.answer;
        const answer = answerValue?.v;
        if (verified.verified && answerValue?.t === 'str' && typeof answer === 'string' && answers.has(answer)) return { execution: 'onchain_protocol', status: 'VERDICT', verdictId, answer, verified: true, chain: verified.chain };
        return { execution: 'onchain_protocol', status: 'unresolved', verdictId };
      }
      if (response.status !== 404) throw new Error('Verdict retrieval failed. Resume with the saved query ID.');
    }
    await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, 1500);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  return { execution: 'onchain_protocol', status: 'unresolved' };
}
