# Claim evaluation runner

Run the deterministic harness offline:

```sh
bun services/claims/eval/run.ts
```

It uses five synthetic cases (support, contradiction, conflicting evidence, no evidence, and instruction injection), makes no network calls, and prints aggregate metrics only. Offline responses are deliberately deterministic to exercise the review and reporting path; their accuracy is not evidence of model quality.

The controlled runner preserves the original synthetic fixture suite by default. Select its separate source-backed suite explicitly for a bounded optional live run:

```sh
bun services/claims/eval/controlled-run.ts --suite representative --live --max-cases 2
```

Live mode is sequential by case. `--max-cases` must be 1 through 12, so the upper bound is three provider calls per selected evidence-bearing case (at most `3 × N`); the no-evidence case makes no calls. There are no model-inference retries; the ACI transport may poll for a signed receipt after its single inference request. The runner needs `PHALA_AI_API_KEY` before it constructs its three fixed jurors. The ACI verifier also uses its existing Intel collateral and TDX policy settings. It does not search key files. `--details` opts into printing each claim, source excerpt, juror explanation, and cited passage for manual review; keep that output private. Without it, the default summary omits claim/source and provider-response text.

Each live run sends public source excerpts and test claims to the configured ACI service and may incur charges. The CLI never prints the key, claim/source text, provider outputs, or raw provider errors. The different `eval/run.ts --live` command uses configurable jurors and synthetic cases; it is not this source-backed harness.

An ACI model receipt verifies the model execution receipt according to that adapter. It does not attest the overall Railway-hosted research flow, source retrieval, evidence handling, review orchestration, or the separate confidential document protocol. The claims pilot remains classified as unattested research; do not describe an ACI receipt as end-to-end TEE attestation.

The representative set has 12 cases captured on 2026-09-28 from official Ethereum, OpenAI, and Anthropic pages. It covers supported and contradicted claims, a missing-qualifier/context case, unsupported ranking with no retrieved evidence, and prompt-injection. Each exact publisher excerpt has a SHA-256 `contentHash` over the excerpt alone, not the entire web page. Anthropic’s excerpt is a publisher table row serialized by joining its cells with ` | ` and is labeled as that extraction; it is not prose. The injection string is a separately labeled test-only source annotation, not text from the publisher. Retrieval timestamps, URLs, excerpts, labels, alternatives, and rationale are recorded in `representative-fixtures.ts`. Labels are hand-adjudicated by the fixture author against the linked passages. Alternate safe outcomes are retained when abstention is also defensible.

This is a reproducible harness set, not a statistically representative sample, independent adjudication, or a promise of launch accuracy. Review every citation manually for whether it entails the specific claim, including scope, dates, and qualifiers: the runner measures exact quote text matching only and emits `semanticCitationReview: not_automated`. A source quote can match while supporting the wrong claim. Offline mode tests harness behavior; its deterministic labels are not model-quality results. Live findings should be manually reviewed before interpreting aggregate scores.

The live report separates requests attempted, telemetry-completed calls, successes, failures, missing token usage, reported tokens, a price-table estimate, and actual billed cost (always `null` until separately supplied). A token-price estimate is not a provider invoice; reconcile with billing records. It also reports per-case latency, citation text matching, assessment acceptance, and failure codes. The dataset is small and hand-selected, so report these only as observations about this run, not expected launch performance. No personal or confidential information is included.

Deterministic offline gates and focused local checks, with no provider calls:

```sh
bun services/claims/eval/controlled-run.ts
bun services/claims/eval/controlled-run.ts --suite representative
bun test services/claims/test/controlled-eval.test.ts services/claims/test/eval.test.ts services/claims/test/eval-cli.test.ts
```
