/** Claim-review pilot types. These records are not TEE or chain attestations. */
export type Assessment = 'supported' | 'contradicted' | 'missing_context' | 'insufficient_evidence';
export interface EvidenceSource {
  id: string;
  url: string;
  title: string;
  text: string;
  retrievedAt: string;
  publishedAt?: string;
  contentHash: string;
}
export interface EvidenceBundle {
  version: 1;
  id: string;
  claim: string;
  asOf: string;
  sources: EvidenceSource[];
  warnings: string[];
}
export interface Citation { sourceId: string; quote: string }
export interface JurorFinding {
  jurorId: string;
  model: string;
  assessment: Assessment;
  explanation: string;
  citations: Citation[];
  limitations: string[];
}
export interface ClaimReview {
  version: 1;
  id: string;
  bundleId: string;
  claim: string;
  checkedAt: string;
  status: 'assessed' | 'unresolved';
  assessment: Assessment | null;
  agreement: { count: number; total: number; required: number };
  findings: JurorFinding[];
  failures: { jurorId: string; code: string }[];
  sources: EvidenceSource[];
  limitations: string[];
  integrityHash: string;
  execution: 'unattested_research';
}
export interface ClaimCorrection { note: string; createdAt: string }
export interface PublicClaimRecord { review: ClaimReview; corrections: ClaimCorrection[] }
export interface ResearchInput { claim: string; sourceUrls?: string[] }
export type Researcher = (input: ResearchInput) => Promise<EvidenceBundle>;
export interface Juror { id: string; model: string; assess(bundle: EvidenceBundle, signal?: AbortSignal): Promise<unknown> }
