// Thin adapter between the paid canary and the public @mochi/sdk API. It is the only launch-ops file that imports
// the SDK, so SDK changes (for example the open/provenance flow) are absorbed here.
//
// SDK surface used: MochiClient, prepareClaimReview, waitForClaimReview, CLAIM_REVIEW_ANSWERS,
// MochiClient.intakeAttestation, MochiClient.decryptPrivateResult (plus privateResultMismatch from @mochi/protocol).
// Since the bound-grant change, `sender` is the opener: the intake signs a 15-minute grant naming the payer wallet as the
// only allowed msg.sender, and prepareQuery rejects gateway calldata that differs from that grant (IntakeBindingError /
// TypeError). The canary sends the prepared transaction itself
// (through the launch-ops transaction guard) instead of askClaimReview, because askClaimReview signs internally and the
// guard must show every transaction and, on mainnet, get a typed yes before it is sent.
//
// Privacy: claim text, excerpts and decrypted answers never leave this module. Callers get ids, hashes, the
// transaction and the enum label only.
import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { CLAIM_REVIEW_ANSWERS, MochiClient, prepareClaimReview, waitForClaimReview, type ClaimReviewAnswer } from "@mochi/sdk";
import { MockQuoteVerifier, quoteVerifierFromEnv, type QuoteVerifier } from "@mochi/tee";
import { privateResultMismatch } from "@mochi/protocol";
import type { Deployment } from "@mochi/chain";

export type ClaimFixture = {
  claim: string;
  evidence: Array<{ id: string; title: string; url: string; excerpt: string }>;
  expected: ClaimReviewAnswer;
};

export type CanarySecrets = { salt: Hex; resultPrivateKey: Hex };

export type PreparedCanary = {
  queryId: Hex;
  tx: { to: Address; data: Hex };
  /** The query's private salt and x25519 result secret. Kept in memory only; never printed or persisted. */
  secrets: CanarySecrets;
};

export type CanaryOutcome =
  | { status: "VERDICT"; answer: ClaimReviewAnswer; verdictId: Hex }
  | { status: "HUNG"; verdictId?: Hex; agreementBps?: number; dissentMask?: number; timeoutMask?: number }
  | { status: "UNRESOLVED"; verdictId?: Hex };

/** keccak256 of the decrypted answerJson, the enum label, and privateResultMismatch against the given on-chain hashes. */
export type DecryptedCheck = { verdictId: Hex; answerHash: Hex; answer?: ClaimReviewAnswer; mismatch?: "answerHash" | "payloadHash" };

export interface ClaimReviewAdapter {
  /** Attested intake identity (quote verified by the SDK against the measurement). */
  intake(): Promise<{ address: Address; measurement: Hex }>;
  prepare(fixture: ClaimFixture, sender: Address): Promise<PreparedCanary>;
  wait(queryId: Hex, secrets: CanarySecrets, timeoutMs: number): Promise<CanaryOutcome>;
  /**
   * Decrypts in memory (the SDK checks it against the on-chain verdict), then checks answerHash and the salted
   * private payloadHash against hashes the caller read from chain itself. Returns hashes and the enum label only.
   */
  decryptAndCheck(queryId: Hex, verdictId: Hex, secrets: CanarySecrets, onChain: { answerHash: Hex; payloadHash: Hex }): Promise<DecryptedCheck>;
}

export function claimFixtureFrom(raw: unknown): ClaimFixture {
  const r = raw as ClaimFixture | null;
  if (!r || typeof r.claim !== "string" || !r.claim.trim() || !Array.isArray(r.evidence) || !r.evidence.length) throw new Error("canary fixture needs claim and evidence[]");
  for (const e of r.evidence) if (typeof e?.id !== "string" || typeof e.title !== "string" || typeof e.url !== "string" || typeof e.excerpt !== "string" || !e.url.startsWith("https://")) throw new Error("canary fixture evidence entries need id, title, https url and excerpt");
  if (!(CLAIM_REVIEW_ANSWERS as readonly string[]).includes(r.expected)) throw new Error(`canary fixture expected must be one of ${CLAIM_REVIEW_ANSWERS.join(", ")}`);
  return { claim: r.claim, evidence: r.evidence.map((e) => ({ id: e.id, title: e.title, url: e.url, excerpt: e.excerpt })), expected: r.expected };
}

/** Every string of the fixture, for output scrubbing (defence in depth: none of them is ever formatted into output). */
export function fixtureSecrets(fixture: ClaimFixture): string[] {
  return [fixture.claim, ...fixture.evidence.flatMap((e) => [e.excerpt, e.title])];
}

export function answerLabelFromJson(answerJson: string): ClaimReviewAnswer | undefined {
  try {
    const answer = (JSON.parse(answerJson) as { fields?: { answer?: { t?: unknown; v?: unknown } } })?.fields?.answer;
    return answer?.t === "str" && typeof answer.v === "string" && (CLAIM_REVIEW_ANSWERS as readonly string[]).includes(answer.v) ? answer.v as ClaimReviewAnswer : undefined;
  } catch { return undefined; }
}

export function createSdkAdapter(options: {
  gatewayUrl: string;
  indexerUrl?: string;
  measurement: Hex;
  deployment: Deployment;
  publicClient: PublicClient;
  /** "dcap" verifies the intake TDX quote with Intel PCS collateral; "mock" is for local anvil fixtures only. */
  quoteVerifier: "dcap" | { mockRootAddress: Address };
  fetch?: typeof fetch;
}): ClaimReviewAdapter {
  const verifier: QuoteVerifier = options.quoteVerifier === "dcap"
    ? quoteVerifierFromEnv({ ...process.env, QUOTE_VERIFIER: "dcap" })
    : new MockQuoteVerifier({ mockRootAddress: options.quoteVerifier.mockRootAddress });
  const client = new MochiClient({
    gatewayUrl: options.gatewayUrl,
    ...(options.indexerUrl ? { indexerUrl: options.indexerUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    quoteVerifier: verifier,
    intakeMeasurement: options.measurement,
    chain: { deployment: options.deployment, publicClient: options.publicClient },
  });
  return {
    async intake() {
      const doc = await client.intakeAttestation();
      return { address: doc.address as Address, measurement: options.measurement };
    },
    async prepare(fixture, sender) {
      const prepared = await prepareClaimReview(client, { claim: fixture.claim, evidence: fixture.evidence, sender, n: 3 });
      const { salt, resultPrivateKey } = prepared.prepared.secrets;
      if (!resultPrivateKey) throw new Error("SDK did not create a private result key");
      return { queryId: prepared.prepared.queryId, tx: prepared.prepared.tx, secrets: { salt, resultPrivateKey } };
    },
    async wait(queryId, secrets, timeoutMs) {
      const outcome = await waitForClaimReview(client, queryId, secrets, { timeoutMs, pollMs: 3_000 });
      if (outcome.status === "VERDICT") return { status: "VERDICT", answer: outcome.answer, verdictId: outcome.verdictId! };
      if (outcome.status === "HUNG") {
        const { verdictId, agreementBps, dissentMask, timeoutMask } = outcome;
        return { status: "HUNG", ...(verdictId ? { verdictId } : {}), ...(agreementBps === undefined ? {} : { agreementBps }), ...(dissentMask === undefined ? {} : { dissentMask }), ...(timeoutMask === undefined ? {} : { timeoutMask }) };
      }
      return { status: "UNRESOLVED", ...(outcome.verdictId ? { verdictId: outcome.verdictId } : {}) };
    },
    async decryptAndCheck(queryId, verdictId, secrets, onChain) {
      const result = await client.decryptPrivateResult(verdictId, { queryId, ...secrets });
      const answer = answerLabelFromJson(result.answerJson);
      const mismatch = privateResultMismatch(result, onChain);
      return { verdictId, answerHash: keccak256(toHex(result.answerJson)), ...(answer ? { answer } : {}), ...(mismatch ? { mismatch } : {}) };
    },
  };
}
