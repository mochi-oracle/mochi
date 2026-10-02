# Claim review launch package

> **Update, September 29, 2026:** the launch tariff is now **$0.10** for the short N3 review at `tokensK = 1` (jurors $0.08, minimum protocol fee $0.02; `scripts/launch-pricing.ts`). The testnet dress rehearsal measured about 918k gas of protocol-side settlement per review (seal + post), roughly $0.05 at mainnet gas, which five cents could not cover. Five-cent figures below are historical.

This package describes two separate offerings: the current unpaid public research invitation and a possible future confidential, escrow-paid short review. The claim SDK/browser bridge and a hardware intake rehearsal exist. Paid activation still depends on production configuration, provider limits, representative evaluation, cost coverage, and end-to-end settlement/refund reconciliation described in [the payment plan](CLAIMS-PAYMENT-PLAN.md).

## Proposed five-cent short review

The proposed short review checks one exact claim against a small, bounded evidence bundle, asks three jurors to assess the same committed input, and returns their findings, source passages, limitations, and a protocol status. It is not a guarantee that a claim is true, that sources are authentic, or that every relevant source was found. The scope limit, source cap, refusal behavior, and final UX still need product acceptance before paid launch.

The tariff is a protocol quote in USDG atomic units (six decimals), not a standalone fixed-price claim endpoint. With the current default N3 seat order `[LARGE_A, DOC_SPECIALIST, DISSENTER]`, the proposed launch class prices in `scripts/launch-pricing.ts`, and `tokensK = 1`, juror fees are 40,000 units ($0.04). The 20% protocol fee computes to 8,000 units, below the 10,000-unit ($0.01) minimum, so the quote totals 50,000 units ($0.05). `tokensK` is the provenance token-size bucket, rounded up per thousand tokens; larger bundles and additional jurors increase the quote. The on-chain class mix and prices are governor-configured, so production must verify the actual quote before checkout. A quote is not a promise that every review costs five cents.

The current quote measures juror fees plus the protocol fee. It does not include web search, source-fetch failures, inference failures or retries, hosting, storage, reconciliation, or payer-side network gas. The private September 28 quality report records 36 paid inference requests across its bounded cases, three failed calls without usage telemetry, and a partial reported-token estimate of $0.01586906 for calls with usage. That is an aggregate partial estimate, not actual billing and not a per-review price. The corrected-context case adds three calls with a separate reported-token estimate of $0.00169547; it remains unresolved. Failed-call cost is unknown where usage is missing. The earlier provider dashboard examples in [live validation](CLAIMS-LIVE-VALIDATION.md) likewise cover individual tiny synthetic calls only. Search, hosting, settlement gas and amortized operating costs have no complete measured totals yet. Treat those values as unknown, not zero. There is no supported all-in margin or cost guarantee.

The same quality report describes 12 hand-selected cases: eight resolved correctly, four unresolved, with 1.0 exact quote-text matching among emitted citations. Its semantic review was performed by the engineering author, not an independent adjudicator; the fixtures do not estimate launch accuracy. One corrected-context case showed a material qualifier disagreement and correctly remained unresolved under its three-of-three local review rule. These observations support continued evaluation only. They do not support accuracy, reliability, or safety claims.

## Payment and outcome rules

The following matrix distinguishes the current escrow behavior from proposed claims-product rules. Escrow behavior comes from `QueryEscrow.settle`, `QueryEscrow.expire`, and `MochiVerdicts.post`; it applies only after a paid query is opened and reaches that lifecycle. The standalone research pilot does not use it.

| Event | Existing escrow behavior | Proposed short-review policy | Status |
| --- | --- | --- | --- |
| Quote or preparation only; payer never submits an opening transaction | No funds enter escrow | No charge | Matches current contract; claims checkout is not active |
| Query opens and posts a `VERDICT`, including an insufficient-evidence answer represented as a valid verdict | Each non-timeout seat fee becomes operator claimable. Timeout-seat fees are refunded to `refundTo`. Protocol fee is split: `panelReserveBps` to panel reserve (0 at launch: panel escalation is off, see `PANEL-ESCALATION.md`; 25% once switched on); remainder to `reviewProtocolRecipient`, or staking when no recipient is configured. | Charge for the completed verdict, including a verdict that says evidence is insufficient. Disclose the quote before wallet approval. | Proposed product rule; requires claims bridge and verified deployment |
| Query opens and posts `HUNG` | Non-timeout seat fees are paid to operators; timeout-seat fees and the entire protocol fee are refunded to `refundTo`. | Explain that HUNG is unresolved. Refund only what the contract returns; do not promise a full refund when non-timeout seats responded. | Contract behavior exists; claims-specific explanation/reconciliation remains future work |
| Query remains OPEN or SEALED past its deadline and anyone calls `expire` | All remaining seat fees and protocol fee are refunded to `refundTo`; query becomes EXPIRED. The default TTL is one hour, but deployment configuration governs. | Show expired/refunded only after observing and reconciling the on-chain result. | Contract behavior exists; user-facing lifecycle and monitoring remain future work |
| Provider error, invalid result, duplicate request, or user cancellation before escrow opening | No opening means no escrow payment. | Do not submit payment until the prepared review is ready and the user approves the quoted opening. Deduplicate by stable request/query identity. | Proposed integration behavior |
| Provider failure, invalid output, retry, or user cancellation after opening | No generic instant-cancel/full-refund operation exists. Timeout bits, a valid HUNG verdict, or expiration determine contract settlement. | Never claim an automatic full refund. Future bridge must define retries and cancellation without bypassing verdict authorization or escrow. | Requires implementation and rehearsal |

An application error or a local `paid` flag is not proof of payment or refund. Production outcomes require the query ID, transaction receipt, verdict/expiry state, and reconciled settlement/refund events. The protocol charges on opening, not after the user sees the result. There is no claims-specific right to cancel once the transaction succeeds. Do not promise one unless the protocol and operations are changed and verified.

The five-cent tariff uses the current class-price plus protocol-fee formula. If product needs a fixed claim price, automatic full refunds, or charging only after successful completion, that requires a governed pricing/escrow design change. Do not silently describe a UI quote as a fixed product price.

## Invitation text for the current unpaid pilot

> Mochi is inviting people to try an unpaid research preview for one short public claim at a time. It gathers a limited set of public sources and compares three configured model readings, showing their quotes, agreement, and limitations. You can supply public URLs or allow bounded public web research. The service and its providers receive the claim and evidence as described in the consent screen. Please do not submit confidential material. This preview does not charge you, guarantee correctness, verify source authenticity, produce a TEE attestation, or settle a blockchain query. A matching quote confirms text overlap, not truth. Results are research aids for your own review.

Use this copy for invited pilot participants only. The live preview requires an invitation access token and source URLs; general web discovery is not configured. Do not describe it as open enrollment.

## Short onboarding and FAQ

**What should I submit?** One exact, checkable statement. Include public sources when you have them. The current pilot allows at most 4,000 claim characters, five supplied URLs, six retrieved sources, and bounded response sizes; it does not read PDFs, authenticated posts, or paywalled material.

**What does a review mean?** Three configured models read the same collected evidence. The pilot requires three valid matching findings for an assessed outcome. A split, malformed result, failed juror, or missing evidence stays unresolved or insufficient; it is not changed into a majority verdict. Provider identity or model diversity does not prove independent training.

**Can I share a result?** In the unpaid pilot, publishing is a separate explicit action. A public link reveals the exact claim, model findings, cited passages, and source metadata. Anyone with the link can view it. Review the contents before publishing.

**Is the five-cent review available now?** No. Five cents is a proposed short N3 tariff under one token-size bucket and a particular governed price configuration. The present research pilot is unpaid. A future escrow-paid review would collect at query opening and follow the actual verdict, timeout, and expiry outcomes in the matrix above.

**What if the review disagrees or a provider fails?** The current pilot keeps disagreement and failures visible and unresolved. In the future escrow lifecycle, a `VERDICT` and `HUNG` are different settlement statuses. `HUNG` refunds protocol fees and timed-out seat fees while paying non-timeout seats. Expiry refunds remaining escrow. No immediate user cancellation or guaranteed full refund exists after opening.

**Is it accurate or confidential?** No accuracy level is promised. The available suite is small and hand-selected, not a representative benchmark. Current public research is not the confidential paid protocol and should not be used for confidential evidence.

## Launch post draft (unpaid invitation)

> We’re inviting a small group to try an unpaid research preview of Mochi, a tool for examining one claim at a time. It reads linked public evidence and places three model readings, quoted passages, disagreement, and limitations side by side so you can inspect them yourself.
>
> This is an early research tool, not a fact guarantee. Its small hand-selected evaluation does not establish general accuracy, and quoted text does not prove a claim or a source’s authenticity. Please use public material only; the claim and evidence may be processed by configured research and model providers as described in the consent screen. Sharing is optional and makes the review contents visible to anyone with the link.
>
> The preview is free and invitation-only. A separate five-cent confidential escrow review is only a future proposal and is not available in this invitation. [Try the research preview](https://web-production-fb1a0.up.railway.app/check/) with an invitation access token.

Before publishing, verify the live service state and access flow. Do not add accuracy percentages, privacy or confidentiality guarantees, a paid launch date, or refund promises based on the current evidence.

## Source trail and launch blockers

- Tariff code and focused quote test: `scripts/launch-pricing.ts`, `web/test/launch-pricing.test.ts`.
- Class ordering, required quorum, and fee settlement: `contracts/src/ClassMix.sol`, `contracts/src/libraries/MochiTypes.sol`, `contracts/src/QueryEscrow.sol`, and `contracts/src/MochiVerdicts.sol`.
- Current unpaid product and data limits: `services/claims/README.md` and `services/claims/src/app.ts`.
- Current bounded-evaluation evidence, including missing cost telemetry: the private source-quality audit dated September 28, 2026 (internal evidence; not part of this public export).
- The bridge, spend limits, representative independent evaluation, cost coverage, production configuration, live settlement/refund observation, and accounting reconciliation remain launch gates in [the payment plan](CLAIMS-PAYMENT-PLAN.md).

## Prelaunch cost worksheet

Use `bun scripts/launch-cost-worksheet.ts scripts/launch-cost-example.json` to see the disabled, all-unknown example. Copy that JSON to a private file and replace values with measured amounts, then run the same command with your private file path. Amounts are exact non-negative USD strings with at most six decimal places; use `null` whenever a category is unknown. Inference cost must include failed calls and retries, and search cost must include failed requests. Enter counts for the same evaluation cohort. `verifiedProductFundingUsd` is a reconciled USD valuation of funds actually available to the review product; it is not gross customer charges or juror compensation.

The worksheet reports the known cost subtotal while any category is unknown, but leaves the complete required funding, normalized costs, and shortfall unknown and marks coverage incomplete. Its five-cent N3/tokensK=1 quote is shown separately as 40,000 USDG units to jurors plus a 10,000-unit protocol fee. Under the current 25% panel reserve setting, 2,500 protocol-fee units go to panel reserve and the post-panel remainder of 7,500 goes to the configured review recipient or staking. Neither amount is assumed to fund review operations. The worksheet estimates only and never submits transactions.

The disabled example is `DISABLED_LAUNCH_COST_EXAMPLE` in the script; every unmeasured cost and funding field is `null`.

Tokenomics status is separate: the buyback/purchase implementation is disabled by default, the future team token address is pending, and no creator/developer fee is included in this review tariff or worker accounting. Commit `230ebc8` refers to software, not a token contract; no team token exists yet. No launch copy should imply automated purchases or burns.
