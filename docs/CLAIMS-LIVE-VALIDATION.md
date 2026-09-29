# Claims validation — 28 September 2026

> **Update, September 29, 2026:** the launch tariff is now **$0.10** for the short N3 review at `tokensK = 1` (jurors $0.08, minimum protocol fee $0.02; `scripts/launch-pricing.ts`). The testnet dress rehearsal measured about 918k gas of protocol-side settlement per review (seal + post), roughly $0.05 at mainnet gas, which five cents could not cover. Five-cent figures below are historical.

## Actual model calls

The initial validation record was superseded by the September 28 source-quality audit. That audit's paid evaluation run covered 12 hand-selected cases and 36 inference requests (including the invalid fixture), using Llama 3.3 70B, Nemotron 3.5 Lightning, and Gemma 4 31B through the configured Phala inference endpoint. It resolved eight cases correctly and left four unresolved; three provider inference calls failed. The separate corrected-context case used three more calls and remained unresolved. These are descriptive results for controlled source-backed cases, not a representative accuracy benchmark. See `docs/CLAIMS-LAUNCH-PACKAGE.md` for the launch-safe interpretation. The detailed private audit evidence is maintained outside this public export.

In the audited 12-case run, eight cases resolved correctly and four remained unresolved. The corrected GPT-5 qualifier case remained unresolved: two models treated the shortened claim as supported while one identified the omitted “when thinking” condition. A three-of-three pilot rule withheld the result. The audit's manual semantic review was authored by the engineering operator, not an independent adjudicator. Exact quote matching did not establish truth, source authenticity, or entailment beyond that manual review.

## Measured charges

The audited 12-case run reports a partial token-price estimate of $0.01586906 for calls with prompt and completion usage telemetry. Three failed calls lacked usage, so their eventual cost is unknown; the reported value is neither actual billed cost nor an estimate for all 36 attempts. The additional corrected-context case has a separate reported-token estimate of $0.00169547 for its three calls and no actual billing total. Earlier dashboard examples in the original record showed two tiny synthetic reviews at $0.000969 and $0.001191 in individual model charges; these are individual observed examples, not per-review predictions. Search, failed-request, hosting, gas/settlement, and amortized operating costs are not fully measured. Missing costs must remain unknown, not be treated as zero.

The proposed starting tariff remains $0.05 for the short N3 mix at `tokensK=1`; it is a contract quote configuration, not an active pilot price. This small sample cannot validate all-in economics. Hosting, retrieval, network gas, retries, refunds, and longer evidence still require measured allowances. Do not advertise a margin or an assured buyback amount.

## Implementation status

The claims SDK prepares a private FREEFORM_FACT protocol query with supplied evidence explicitly marked SUBMITTED. It uses the existing attested intake, encryption, quote and payment lifecycle. Preparation is inspectable and does not submit a wallet transaction. The browser integration uses the same claim framing and protocol client. Paid production checkout remains disabled until deployment, enrollment and settlement checks pass.

The review-revenue planner uses exact USDG units, considers both settled gross revenue and actual available review funds, reserves known obligations, and blocks eligibility when costs are unknown. Developer and creator fees are excluded. A separate disabled-by-default purchase orchestration boundary is implemented, with adapter and durable-store interfaces. Neither component supplies a production ledger, signing/router adapter or running purchase worker, and neither changes existing contract settlement routing.

Production deployment tooling accepts the team's future MOCHI contract and does not create or mint a production token. Test tokens remain confined to explicit local/testnet rehearsal modes.

## Limits

Model attestation does not attest local research orchestration. Hardware intake rehearsal is separate from the complete production protocol. The public research endpoint remains disabled until the confidential execution path and release configuration are complete. Paid checkout, production juror enrollment, final settlement routing and automated purchases are not live. Burns remain a manual operator action. No team token was created and no real-money wallet transaction was sent.

## Source checks

The reviewed release candidate passed 80 focused ACI, SDK, claims and deployment-token-policy tests (377 assertions), project TypeScript checking, and the production website build. The new SDK fixture exercises encrypted preparation and sealed-result decryption through the actual SDK with a mocked gateway. These checks are separate from production wallet settlement.

The subsequent browser/revenue integration candidate passed 107 SDK, claims and website tests (487 assertions), project TypeScript checking and the production website build. Payment one-shot/recovery, invalid verdict rejection, uncertain purchase reconciliation and treasury reservation behavior are tested with mock adapters; no production wallet transfer is implied. This is implementation evidence, not a paid production acceptance result.

## Hardware intake verification on the existing Phala VM

The reviewed hardware rehearsal was deployed successfully on September 28 through the official Phala CLI. The dashboard's silent update failure was traced to the provider's 200 KiB combined compose/pre-launch-script limit. Switching the code bundle from gzip to Brotli reduced the rendered compose to170,110 bytes; the renderer now enforces190 KiB headroom and its regression test checks decompression and size. The pinned container image and bounded synthetic-only service remain unchanged.

The authenticated Phala control-plane attestation contained the exact reviewed compose and its matching SHA-256 `6e818accef8cc619d1b28aec869da24074c36728380b7852a9d6dc90a591745a`. Its runtime compose-hash event matched the deployed app configuration. Registers from that independently retrieved control-plane record produced the verifier pin `0xa09fd04ba138b7db9473940a6763a7e814c9c278526f463f9b6de0e83b641cc7`. The public intake endpoint then passed Intel DCAP verification with UpToDate status, no advisories, debug disabled, fresh key-bound reportData and matching measured registers. An encrypted synthetic upload returned the expected document commitment and a valid provenance signature from the attested intake identity.

This is a hardware intake round trip, not production registry enrollment, a paid review, juror/consensus execution or settlement. No real document, wallet transfer or production token was used. The existing VM was stopped after testing; no additional VM was created. Renderer/verifier focused tests: 4 passed, 26 assertions; project typecheck passed.
