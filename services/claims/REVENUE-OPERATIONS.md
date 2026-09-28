# Review-revenue operations

The purchase engine enforces a 30-day operating reserve and a minimum $25 USDG purchase. These are backend checks, not just website calculator assumptions. Developer/creator fees are outside this accounting path. Transaction execution remains disabled: there is no approved token contract or market route yet.

## Read-only settlement worker

Copy `deploy/production/revenue-ingestion.example.json` into private operator configuration. Fill in the actual chain, escrow, USDG token, review-revenue treasury, and deployment block only after those contracts are approved. The example is disabled. RPC URLs can contain credentials; keep the real manifest outside Git.

Run `bun scripts/revenue-ingest.ts /private/path/ingestion.json`. A disabled manifest performs no RPC or database work. An enabled run scans a bounded sequence of finalized blocks and persists a cursor; repeated invocations resume. The command never constructs a wallet, signs, sends, or burns. Schedule it on the existing host when routing is activated; no additional VM is required.

Only the escrow's `ReviewProtocolRevenueSettled` events backed by successful USDG transfers enter this verified ledger. Their amounts are the protocol remainder **after the panel cut**, not gross customer payments. The $0.04 juror/operator allocation from a five-cent review has already left this pool; do not deduct those same covered costs again. FEED-funded activity and arbitrary treasury deposits do not count as customer review revenue.

## Reserve and batch preview

Accumulate confirmed events, then use the store's immutable allocation API to assign them once to a purchase batch. A batch cannot consume the same event twice. The legacy operator-entry ledger exists for compatibility; production reporting requires independently verified settlement records.

Copy `deploy/production/revenue-budget.example.json` to private operator configuration. Supply actual atomic USDG amounts (six decimals), an approved budget ID and timestamp. Unknown costs remain `null` and block eligibility. Only include liabilities and future daily costs that are not covered by another allocation.

Run `bun scripts/revenue-policy-preview.ts /private/path/accounting.sqlite batch-id /private/path/budget.json`.

The preview protects already retained reserves, derives the shortfall to 30 days, deducts uncovered liabilities/refunds, and checks the $25 threshold. Under-threshold funds accumulate. A budget older than 24 hours, from the future, or with an unapproved ID cannot authorize a new purchase. The execution engine repeats these checks, including immediately before submission, and persists the budget snapshot. Existing uncertain transactions are reconciled without submitting again even when a new budget is unavailable.

All preview amounts are accounting estimates, not quotes or permission to transfer. Reconcile liabilities, retained reserve, treasury balance and outstanding reservations before approving a real batch. The report's remaining attributed revenue is not automatically spendable surplus.

## Activation and funding

No funding is needed to run the local tests or build these components. Existing hosting and inference credit remain separate operating expenses. Do not deposit funds to placeholder addresses.

Activation still requires the team's token contract, the actual chain/escrow/treasury routing, a liquid approved USDG-to-MOCHI market supported by the implemented swap adapter, a fresh operating budget, and gas funding priced for that chain. Quote the exact proposed top-up and purpose before spending. The team supplies the token; this project does not create one.

Purchases and burns are separate operations. The purchase engine has no burn method. Manual burn evidence must be checked independently and must not count dead-address transfers as native supply destruction. Export reports using `scripts/revenue-report.ts`; publish only a complete verified report. The public website must not present a sample, missing configuration, or an unverified ledger balance as live financial activity.

## Exporting the public report

Run `bun scripts/revenue-report.ts --config /private/path/report.json --db /private/path/accounting.sqlite --out /private/path/public-report.json --burn-evidence /private/path/burns.json`.

The report configuration supplies `chainId` (number), `rpcUrl`, `settlementStreamId` (from ingestion output), `reviewEscrowAddress`, `usdgAddress`, `usdgDecimals` (6), team-confirmed `mochiAddress` and `mochiDecimals`, `reviewTreasuryAddress`, `purchaseRecipientAddress`, optional `deadAddress`, and positive `minimumConfirmations`. This version verifies direct transactions sent by the treasury to the persisted router; smart-account/relayer routes need a separately verified receipt adapter. It uses finalized blocks plus the configured confirmation threshold, with no fallback to the latest unfinalized head.

Burn evidence is an array of `{ "transactionHash": "0x…", "logIndex": 0, "kind": "native-supply-burn" }` or `dead-address-transfer` records. Supply burns additionally require a matching reduction in total supply. Omit the file to report burn evidence as unconfigured; supply an empty array only when the reconciled evidence list is actually empty. Duplicate or invalid records make the report incomplete rather than silently lowering totals. Burns cannot consume tokens purchased later, and multiple burns cannot reuse purchased inventory.

The exporter opens a read-only SQLite snapshot, checks purchase receipts and net token transfers, and atomically writes JSON. Integrity failures hide aggregate totals and exit nonzero. The report contains public transaction references but excludes RPC details, query IDs, source text and private error messages. The connected service publishes this verified projection at `/api/tokenomics/report`; until configured it returns a status without balances.

## Connected worker and website

`services/claims/src/revenue-worker.ts` connects finalized ingestion, accumulation, immutable allocation, reserve planning, purchase orchestration and public reporting. Its default mode is disabled. Observe mode ingests and reports without signing or spending; execute mode additionally requires the confirmed token, approved route/policy, fresh budget and a private local signer. Pending submissions are reconciled before new purchase decisions. One host-wide scope lock serializes cycles, and incomplete ingestion cannot trigger a new purchase.

`UniswapV3BuybackAdapter` supports an explicitly selected classic SwapRouter or SwapRouter02. Router02 wraps the swap in a deadline-bearing multicall. Router/quoter bytecode hashes are pinned, the signer must match the treasury, calldata and signed chain/value are checked, gas has an explicit ceiling, and allowances are never silently granted. A private journal records signed bytes and their hash before broadcast; uncertain submissions are never sent again blindly. Finalized canonical receipts and net input/output transfers determine completion. Pool selection still depends on where the team launches liquidity; this adapter supports a direct V3 USDG/MOCHI pool, not an arbitrary V4 hook or cross-chain bridge. Official contract references: [Uniswap deployments](https://developers.uniswap.org/deployments).

The existing Phala service can run the worker every minute with `MOCHI_REVENUE_WORKER_MANIFEST` pointing to a private manifest on its persistent volume. With that setting absent, no worker is started. `MOCHI_REVENUE_REPORT_FILE` selects its public JSON output. The service exposes only a validated projection at `/api/tokenomics/report`; Railway reads the fixed path through its existing Phala upstream. No new VM is needed. `MOCHI_TOKEN_CONFIRMED` changes the unconfigured status only; it cannot authorize execution.

The tokenomics page consumes that endpoint and shows a pre-launch, unavailable or stale state without balances when proof is missing. Reports older than 24 hours are withheld. The API strips extra fields and checks accounting conservation; provider URLs and credentials stay private. A local fixture used for UI testing must never be configured as the production report.

### Private worker manifest

Copy `deploy/production/revenue-worker.example.json` outside Git onto the existing persistent volume. The example is deliberately disabled and contains invalid placeholders. `bun scripts/revenue-worker.ts /private/path/worker.json` performs one cycle; `--watch-seconds 60 --cycles 10` performs ten bounded cycles. The Phala host loop already handles scheduling when its manifest path is configured, so do not run another scheduler against the same ledger.

Use one dedicated ledger and signed-transaction journal per approved settlement scope. Set matching chain, escrow, USDG, treasury and team-token addresses in all sections. The worker derives the report's settlement stream ID from ingestion. `maxChunks` bounds each scan; new purchases wait until the finalized horizon is fully ingested. Use `observe` first, with `buyback.enabled: false`, to validate ingestion and reports without opening a signing file. Populate the approved budget IDs, actual cost/liability amounts and millisecond timestamp; unknown costs stay null. Refresh the private budget at least daily. All USDG amounts are integer strings in six-decimal atomic units; gas ceilings are native atomic units.

`burnEvidenceFile` uses the evidence format above. An explicit, reconciled empty list means no burns yet; an omitted list withholds complete reporting. Never default missing evidence to a fabricated zero. Keep the report output distinct from every private input. Only the public report projection is served, never the manifest, journal or key.

Execute activation additionally requires `buyback.enabled: true`, `teamConfirmedTokenAddress: true`, a recorded policy approval, verified router/quoter bytecode hashes, the reviewed direct-pool fee, gas ceiling, matching native currency metadata and a local signer file with mode 0600. The signer must be the review treasury. Approve only the intended USDG allowance separately; this adapter cannot grant it. No private key belongs in this example or Git. Stale budgets and unknown costs prevent new spending while already submitted transactions can still reconcile. Failed or cancelled allocations require an operator review; the worker does not automatically reassign their event IDs.
