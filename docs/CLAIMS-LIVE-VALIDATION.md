# Claims validation — 28 September 2026

## Actual model calls

Three distinct models ran through the Phala ACI adapter with verified confidential model receipts and an UpToDate, non-debug TDX policy: DeepSeek V4 Flash, Qwen 3.8 27B, and Gemma 4 31B IT. These calls used fictional controlled evidence, not private documents.

The initial five-case test made 12 model requests. Supported and contradicted examples each resolved correctly at 3/3, with matching source quotes. Their review latencies were approximately 6.1s and 29.6s. The no-evidence case abstained without a model call. Conflicting sources remained unresolved after one Qwen request exceeded the 45-second limit; the remaining responses were not promoted into a unanimous verdict. The instruction-injection fixture produced valid but disagreeing responses and also remained unresolved.

The system prompt was then strengthened to distinguish source assertions from embedded commands. One focused live retest of the injection fixture made three additional requests: all three returned the expected supported assessment, with matching quotes, in 12.3s. This single retest is not proof of general resistance to prompt injection. The full initial suite was not repeated against the revised prompt.

## Measured charges

Phala's usage dashboard showed the first simple review's three individual model charges as $0.000222, $0.000676 and $0.000071 (sum $0.000969). The second showed $0.000261, $0.000856 and $0.000074 (sum $0.001191). These are displayed rounded provider charges for tiny synthetic examples, not estimates of all-in production cost. The timed-out request did not yet have a matching spend record at inspection; its eventual charge remains unknown.

The approved starting price remains $0.05 for a short three-juror review. This small sample supports further testing of that price; hosting, retrieval, gas, refunds, longer evidence and escalation still require a measured allowance. Do not advertise the difference as an assured buyback amount.

## Implementation status

The claims SDK prepares a private FREEFORM_FACT protocol query with supplied evidence explicitly marked SUBMITTED. It uses the existing attested intake, encryption, quote and payment lifecycle. Preparation is inspectable and does not submit a wallet transaction. The browser integration uses the same claim framing and protocol client. Paid production checkout remains disabled until deployment, enrollment and settlement checks pass.

The review-revenue planner uses exact USDG units, considers both settled gross revenue and actual available review funds, reserves known obligations, and blocks eligibility when costs are unknown. Developer and creator fees are excluded. A separate disabled-by-default purchase orchestration boundary is implemented, with adapter and durable-store interfaces. Neither component supplies a production ledger, signing/router adapter or running purchase worker, and neither changes existing contract settlement routing.

Production deployment tooling accepts the team's future MOCHI contract and does not create or mint a production token. Test tokens remain confined to explicit local/testnet rehearsal modes.

## Limits

Model attestation does not attest local research orchestration. Hardware intake rehearsal is separate from the complete production protocol. The public research endpoint remains disabled until the confidential execution path and release configuration are complete. Paid checkout, production juror enrollment, final settlement routing and automated purchases are not live. Burns remain a manual operator action. No team token was created and no real-money wallet transaction was sent.

## Source checks

The reviewed release candidate passed 80 focused ACI, SDK, claims and deployment-token-policy tests (377 assertions), project TypeScript checking, and the production website build. The new SDK fixture exercises encrypted preparation and sealed-result decryption through the actual SDK with a mocked gateway. These checks are separate from production wallet settlement.

The subsequent browser/revenue integration candidate passed 107 SDK, claims and website tests (487 assertions), project TypeScript checking and the production website build. Payment one-shot/recovery, invalid verdict rejection, uncertain purchase reconciliation and treasury reservation behavior are tested with mock adapters; no production wallet transfer is implied.

## Hardware intake verification on the existing Phala VM

The reviewed hardware rehearsal was deployed successfully on September 28 through the official Phala CLI. The dashboard's silent update failure was traced to the provider's 200 KiB combined compose/pre-launch-script limit. Switching the code bundle from gzip to Brotli reduced the rendered compose to170,110 bytes; the renderer now enforces190 KiB headroom and its regression test checks decompression and size. The pinned container image and bounded synthetic-only service remain unchanged.

The authenticated Phala control-plane attestation contained the exact reviewed compose and its matching SHA-256 `6e818accef8cc619d1b28aec869da24074c36728380b7852a9d6dc90a591745a`. Its runtime compose-hash event matched the deployed app configuration. Registers from that independently retrieved control-plane record produced the verifier pin `0xa09fd04ba138b7db9473940a6763a7e814c9c278526f463f9b6de0e83b641cc7`. The public intake endpoint then passed Intel DCAP verification with UpToDate status, no advisories, debug disabled, fresh key-bound reportData and matching measured registers. An encrypted synthetic upload returned the expected document commitment and a valid provenance signature from the attested intake identity.

This is a hardware intake round trip, not production registry enrollment, a paid review, juror/consensus execution or settlement. No real document, wallet transfer or production token was used. The existing VM was stopped after testing; no additional VM was created. Renderer/verifier focused tests: 4 passed, 26 assertions; project typecheck passed.
