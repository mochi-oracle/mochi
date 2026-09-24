import { createHash, randomUUID } from 'node:crypto';
import type { Assessment, ClaimReview, EvidenceBundle, EvidenceSource, Juror, JurorFinding } from './types.ts';

const ASSESSMENTS = new Set<Assessment>(['supported', 'contradicted', 'missing_context', 'insufficient_evidence']);
const MAX_CLAIM = 4_000;
const MAX_BUNDLE_TEXT = 100_000;
const MAX_SOURCE_TEXT = 30_000;
const MAX_EXPLANATION = 2_000;
const MAX_LIMITATION = 500;
const MAX_CITATIONS = 8;
const MAX_QUOTE = 1_000;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function parseFinding(raw: unknown, bundle: EvidenceBundle): Omit<JurorFinding, 'jurorId' | 'model'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_RESPONSE');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['assessment', 'explanation', 'citations', 'limitations'].includes(key))) throw new Error('INVALID_RESPONSE');
  if (typeof value.assessment !== 'string' || !ASSESSMENTS.has(value.assessment as Assessment)) throw new Error('INVALID_RESPONSE');
  if (!boundedText(value.explanation, MAX_EXPLANATION)) throw new Error('INVALID_RESPONSE');
  if (!Array.isArray(value.citations) || value.citations.length > MAX_CITATIONS) throw new Error('INVALID_RESPONSE');
  if (!Array.isArray(value.limitations) || value.limitations.length > 8 || value.limitations.some((item) => !boundedText(item, MAX_LIMITATION))) throw new Error('INVALID_RESPONSE');
  const citations = value.citations.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_CITATION');
    const citation = item as Record<string, unknown>;
    if (Object.keys(citation).some((key) => !['sourceId', 'quote'].includes(key))) throw new Error('INVALID_CITATION');
    if (!boundedText(citation.sourceId, 200) || !boundedText(citation.quote, MAX_QUOTE)) throw new Error('INVALID_CITATION');
    const source = bundle.sources.find((candidate) => candidate.id === citation.sourceId);
    if (!source || !normalizeWhitespace(source.text).includes(normalizeWhitespace(citation.quote))) throw new Error('INVALID_CITATION');
    return { sourceId: citation.sourceId, quote: citation.quote };
  });
  if (value.assessment !== 'insufficient_evidence' && citations.length === 0) throw new Error('INVALID_CITATION');
  return { assessment: value.assessment as Assessment, explanation: value.explanation, citations, limitations: value.limitations as string[] };
}

export type ReviewIntegrityInput = Omit<ClaimReview, 'integrityHash' | 'sources'> & {
  integrityHash?: string;
  sources: Array<Omit<EvidenceSource, 'text'> & { text?: string }>;
};

/** Hashes review substance while omitting source text so public redaction preserves the same hash. */
export function computeReviewIntegrityHash(review: ReviewIntegrityInput | ClaimReview): string {
  const { integrityHash: _omitted, ...substance } = review;
  const projection = {
    ...substance,
    sources: substance.sources.map(({ id, url, title, retrievedAt, publishedAt, contentHash }) => ({ id, url, title, retrievedAt, ...(publishedAt === undefined ? {} : { publishedAt }), contentHash })),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

function finish(review: Omit<ClaimReview, 'integrityHash'>): ClaimReview {
  return { ...review, integrityHash: computeReviewIntegrityHash(review) };
}

function hasUsableEvidence(bundle: EvidenceBundle): boolean {
  return bundle.sources.some((source) => typeof source.text === 'string' && source.text.trim().length > 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export async function reviewBundle(
  bundle: EvidenceBundle,
  jurors: Juror[],
  options: { now?: () => Date; timeoutMs?: number } = {},
): Promise<ClaimReview> {
  if (jurors.length !== 3 || new Set(jurors.map((j) => j.id)).size !== 3 || new Set(jurors.map((j) => j.model)).size !== 3) {
    throw new TypeError('Exactly three jurors with distinct IDs and models are required');
  }
  if (!boundedText(bundle.claim, MAX_CLAIM) || bundle.sources.some((s) => typeof s.text !== 'string' || s.text.length > MAX_SOURCE_TEXT) || bundle.sources.reduce((n, s) => n + s.text.length, 0) > MAX_BUNDLE_TEXT) {
    throw new TypeError('Evidence bundle exceeds review bounds');
  }
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const snapshot = deepFreeze(structuredClone(bundle));
  const base = {
    version: 1 as const, id: randomUUID(), bundleId: bundle.id, claim: bundle.claim, checkedAt,
    status: 'unresolved' as const, assessment: null,
    agreement: { count: 0, total: 3, required: 3 }, findings: [], failures: [], sources: structuredClone(snapshot.sources),
    limitations: [...snapshot.warnings, 'Results are generated from this shared evidence bundle; common sources and related model training can produce correlated errors.', 'This unattested research record binds its contents with a deterministic integrity hash; the hash is not a cryptographic signature or proof that a finding is true.'],
    execution: 'unattested_research' as const,
  };
  if (!hasUsableEvidence(bundle)) {
    return finish({ ...base, status: 'assessed', assessment: 'insufficient_evidence', limitations: [...base.limitations, 'No usable source text was available, so jurors were not called and no model agreement or findings are implied.'] });
  }
  const timeoutMs = options.timeoutMs ?? 45_000;
  const outcomes = await Promise.all(jurors.map(async (juror) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const response = await Promise.race([
        juror.assess(snapshot, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); }),
      ]);
      return { finding: { jurorId: juror.id, model: juror.model, ...parseFinding(response, snapshot) } as JurorFinding };
    } catch (error) {
      const code = error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : error instanceof Error && error.message === 'INVALID_CITATION' ? 'INVALID_CITATION' : 'JUROR_FAILED';
      return { failure: { jurorId: juror.id, code } };
    } finally { if (timer) clearTimeout(timer); }
  }));
  const findings: JurorFinding[] = [];
  const failures: { jurorId: string; code: string }[] = [];
  for (const outcome of outcomes) {
    if ('finding' in outcome && outcome.finding) findings.push(outcome.finding);
    if ('failure' in outcome && outcome.failure) failures.push(outcome.failure);
  }
  const counts = new Map<Assessment, number>();
  for (const f of findings) counts.set(f.assessment, (counts.get(f.assessment) ?? 0) + 1);
  const consensus = [...counts.entries()].find(([, count]) => count === 3);
  const highestAgreement = Math.max(0, ...counts.values());
  return finish({ ...base, status: consensus ? 'assessed' : 'unresolved', assessment: consensus?.[0] ?? null,
    agreement: { count: highestAgreement, total: 3, required: 3 }, findings, failures,
    limitations: [...base.limitations, ...(failures.length ? ['One or more jurors did not return a valid finding; review remains unresolved.'] : []), ...(findings.length && !consensus ? ['Jurors did not unanimously agree; review remains unresolved.'] : [])] });
}
