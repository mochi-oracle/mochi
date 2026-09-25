# Claim evaluation runner

Run the deterministic harness offline:

```sh
bun services/claims/eval/run.ts
```

It uses five synthetic cases (support, contradiction, conflicting evidence, no evidence, and instruction injection), makes no network calls, and prints aggregate metrics only. Offline responses are deliberately deterministic to exercise the review and reporting path; their accuracy is not evidence of model quality.

The optional live mode sends synthetic fixture claims and source passages to three configured jurors:

```sh
bun services/claims/eval/run.ts --live --max-cases 2
```

Live mode is sequential by case. `--max-cases` must be 1 through 5, so the upper bound is three provider calls per selected evidence-bearing case (at most `3 × N`); the empty-evidence fixture makes no calls. There are no model-inference retries; the ACI transport may poll for a signed receipt after its single inference request. The runner validates the full juror configuration and every explicitly named key before the first request. The runner gets juror configuration from `MOCHI_CLAIMS_JURORS` and credentials from the `apiKeyEnv` variables named inside that JSON. The ACI verifier also uses its existing Intel collateral and TDX policy settings. It does not search key files. Unknown flags and malformed configuration fail closed.

Configure the same server-side values described in the parent pilot README: `MOCHI_CLAIMS_JURORS` must be a JSON array of three distinct jurors with distinct IDs and model names, HTTPS `baseUrl` values, and optional `apiKeyEnv` names. Example values:

```json
[
  {"id":"juror-one","model":"MODEL_ONE","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_ONE_KEY"},
  {"id":"juror-two","model":"MODEL_TWO","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_TWO_KEY"},
  {"id":"juror-three","model":"MODEL_THREE","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_THREE_KEY"}
]
```

Only use live mode after selecting the provider/models and setting provider-side spending limits. Each run sends synthetic content to those providers and may incur charges. Output includes aggregate provider-reported token counts by configured model when returned; each field includes its reported and missing call counts, and is `null` when no provider reported it. Token totals do not establish cost; the report keeps cost `not_measured` unless actual billing data is separately collected and documented. The CLI never prints keys, claim/source text, provider outputs, or raw provider errors.

Juror configuration may set `transport` to `chat-completions` (the default) or `phala-aci`. Chat-completions jurors use the fields above and may omit `apiKeyEnv` when the provider accepts unauthenticated requests. A Phala ACI juror requires a named `apiKeyEnv`; the runner rejects it if the key is not present. Unknown transport names and unknown configuration fields fail before any provider request.

An ACI model receipt verifies the model execution receipt according to that adapter. It does not attest the overall Railway-hosted research flow, source retrieval, evidence handling, review orchestration, or the separate confidential document protocol. The claims pilot remains classified as unattested research; do not describe an ACI receipt as end-to-end TEE attestation.

These live runs assess model behavior on controlled fictional examples, not public factual claims. For a meaningful pilot quality evaluation, prepare a separately adjudicated, representative dataset with provenance and accepted outcomes (including abstention and conflicting-source cases), replace or extend the fixtures with that reviewed dataset, and retain provider billing records for actual cost analysis. Do not use confidential or personal material without an appropriate review and consent. Report dataset composition, adjudication method, exclusions, and limitations alongside accuracy and latency. The conflict fixture's `missing_context` target is one harness label; `insufficient_evidence` may also be a reasonable judgment.

Focused local checks, with no provider calls:

```sh
bun test services/claims/test/eval.test.ts services/claims/test/eval-cli.test.ts
```
