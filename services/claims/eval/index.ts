import { reviewBundle } from '../src/review.ts';
import type { Assessment, ClaimReview, EvidenceBundle, Juror } from '../src/types.ts';
import { evaluationFixtures, type EvaluationFixture } from './fixtures.ts';

export interface EvaluationCaseResult {
  id: string;
  expected: Assessment;
  actual: Assessment | null;
  status: ClaimReview['status'];
  correct: boolean;
  citationCount: number;
  validCitationCount: number;
  rejectedCitationFindings: number;
  failureCount: number;
  failureCodes: string[];
  findingCount: number;
  agreementCount: number;
  elapsedMs: number;
}

export interface ClaimEvaluationReport {
  mode: 'offline' | 'live';
  fixtureCount: number;
  metrics: {
    resolvedCount: number;
    unresolvedCount: number;
    abstentionCount: number;
    correctCount: number;
    accuracyAmongResolved: number | null;
    coverage: number;
    abstentionRate: number;
    emittedCitationValidity: number | null;
    citationCount: number;
    rejectedCitationFindings: number;
    jurorFailureCount: number;
    latencyMs: { median: number; p95: number; max: number };
  };
  cost: { status: 'not_measured'; reason: string };
  limitations: string[];
  cases: EvaluationCaseResult[];
}

export interface EvaluationOptions {
  /** Live mode can make external, billable calls; it is disabled unless explicitly enabled. */
  mode?: 'offline' | 'live';
  allowLiveJurors?: boolean;
  jurors?: Juror[];
  fixtures?: EvaluationFixture[];
  now?: () => Date;
}

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
function citationIsValid(citation: { sourceId: string; quote: string }, bundle: EvidenceBundle): boolean {
  const source = bundle.sources.find((item) => item.id === citation.sourceId);
  return Boolean(source && normalize(source.text).includes(normalize(citation.quote)));
}
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  return values[Math.max(0, Math.ceil(values.length * p) - 1)]!;
}

function offlineJurors(fixture: EvaluationFixture): Juror[] {
  return [0, 1, 2].map((seat) => ({
    id: `offline-${seat + 1}`, model: `offline-fixture-${seat + 1}`,
    async assess() {
      if (fixture.bundle.sources.length === 0) throw new Error('No-evidence case should not call jurors');
      const cited = fixture.bundle.sources[0]!;
      const quote = fixture.id === 'synthetic-conflict' ? fixture.bundle.sources[seat % 2]!.text : cited.text;
      return {
        assessment: fixture.expected,
        explanation: `Deterministic fixture answer for ${fixture.id}.`,
        citations: [{ sourceId: fixture.id === 'synthetic-conflict' ? fixture.bundle.sources[seat % 2]!.id : cited.id, quote }],
        limitations: [],
      };
    },
  }));
}

/** Runs deterministic fixtures by default. Live mode needs both an explicit flag and caller-provided jurors. */
export async function evaluateClaims(options: EvaluationOptions = {}): Promise<ClaimEvaluationReport> {
  const mode = options.mode ?? 'offline';
  if (mode === 'live' && (!options.allowLiveJurors || !options.jurors || options.jurors.length !== 3)) {
    throw new Error('Live evaluation requires allowLiveJurors: true and exactly three caller-supplied jurors.');
  }
  const fixtures = options.fixtures ?? evaluationFixtures;
  if (fixtures.length === 0) throw new TypeError('At least one evaluation fixture is required.');
  const cases: EvaluationCaseResult[] = [];
  for (const fixture of fixtures) {
    const started = performance.now();
    const jurors = mode === 'live' ? options.jurors! : offlineJurors(fixture);
    const review = await reviewBundle(fixture.bundle, jurors, options.now ? { now: options.now } : {});
    const elapsedMs = Math.max(0, performance.now() - started);
    const citations = review.findings.flatMap((finding) => finding.citations);
    const validCitationCount = citations.filter((citation) => citationIsValid(citation, fixture.bundle)).length;
    cases.push({ id: fixture.id, expected: fixture.expected, actual: review.assessment, status: review.status,
      correct: review.assessment === fixture.expected, citationCount: citations.length, validCitationCount,
      rejectedCitationFindings: review.failures.filter((failure) => failure.code === 'INVALID_CITATION').length,
      failureCount: review.failures.length, failureCodes: review.failures.map((failure) => failure.code),
      findingCount: review.findings.length, agreementCount: review.agreement.count, elapsedMs });
  }
  const resolved = cases.filter((item) => item.actual !== null);
  const unresolvedCount = cases.filter((item) => item.status === 'unresolved').length;
  const citations = cases.reduce((sum, item) => sum + item.citationCount, 0);
  const validCitations = cases.reduce((sum, item) => sum + item.validCitationCount, 0);
  const rejectedCitationFindings = cases.reduce((sum, item) => sum + item.rejectedCitationFindings, 0);
  const latencies = cases.map((item) => item.elapsedMs).sort((a, b) => a - b);
  const correctCount = resolved.filter((item) => item.correct).length;
  return {
    mode, fixtureCount: cases.length,
    metrics: {
      resolvedCount: resolved.length, unresolvedCount,
      abstentionCount: cases.filter((item) => item.actual === 'insufficient_evidence').length,
      correctCount,
      accuracyAmongResolved: resolved.length ? correctCount / resolved.length : null,
      coverage: resolved.length / cases.length,
      abstentionRate: cases.filter((item) => item.actual === 'insufficient_evidence').length / cases.length,
      emittedCitationValidity: citations ? validCitations / citations : null,
      citationCount: citations, rejectedCitationFindings,
      jurorFailureCount: cases.reduce((sum, item) => sum + item.failureCount, 0),
      latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1)! },
    },
    cost: { status: 'not_measured', reason: 'Provider billing data was not supplied; no cost estimate is inferred from tokens, model names, or elapsed time.' },
    limitations: [
      mode === 'offline'
        ? 'Fixtures are synthetic and offline answers are deterministic; they validate harness behavior, not model factual quality.'
        : 'Fixtures are synthetic controlled cases; live model answers measure response to these examples, not public-fact quality.',
      'A production quality estimate needs independently labeled, representative claims with adjudication and source provenance.',
      'Citation validity measures exact text matching only; it does not measure entailment, source authenticity, or truth.',
      'The conflicting-source fixture is labeled missing_context as a harness target; other reasonable adjudications may choose insufficient_evidence.',
      ...(mode === 'live' ? ['Live juror latency and output vary across runs; this report covers only the supplied fixtures and configured jurors.'] : []),
    ],
    cases,
  };
}
