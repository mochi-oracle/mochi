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

Activation still requires the team's token contract, the actual chain/escrow/treasury routing, a liquid approved USDG-to-MOCHI market and concrete swap adapter, a fresh operating budget, and gas funding priced for that chain. Quote the exact proposed top-up and purpose before spending. The team supplies the token; this project does not create one.

Purchases and burns are separate operations. The purchase engine has no burn method. Manual burn evidence must be checked independently and must not count dead-address transfers as native supply destruction. Export reports using `scripts/revenue-report.ts`; publish only a complete verified report. The public website must not present a sample, missing configuration, or an unverified ledger balance as live financial activity.

## Exporting the public report

Run `bun scripts/revenue-report.ts --config /private/path/report.json --db /private/path/accounting.sqlite --out /private/path/public-report.json --burn-evidence /private/path/burns.json`.

The report configuration supplies `chainId` (number), `rpcUrl`, `settlementStreamId` (from ingestion output), `reviewEscrowAddress`, `usdgAddress`, `usdgDecimals` (6), team-confirmed `mochiAddress` and `mochiDecimals`, `reviewTreasuryAddress`, `purchaseRecipientAddress`, optional `deadAddress`, and positive `minimumConfirmations`. This version verifies direct transactions sent by the treasury to the persisted router; smart-account/relayer routes need a separately verified receipt adapter. It uses finalized blocks plus the configured confirmation threshold, with no fallback to the latest unfinalized head.

Burn evidence is an array of `{ "transactionHash": "0x…", "logIndex": 0, "kind": "native-supply-burn" }` or `dead-address-transfer` records. Supply burns additionally require a matching reduction in total supply. Omit the file to report burn evidence as unconfigured; supply an empty array only when the reconciled evidence list is actually empty. Duplicate or invalid records make the report incomplete rather than silently lowering totals. Burns cannot consume tokens purchased later, and multiple burns cannot reuse purchased inventory.

The exporter opens a read-only SQLite snapshot, checks purchase receipts and net token transfers, and atomically writes JSON. Integrity failures hide aggregate totals and exit nonzero. The report contains public transaction references but excludes RPC details, query IDs, source text and private error messages. This exporter is implemented; no production report endpoint has been activated yet.
