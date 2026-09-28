# Review revenue accounting scaffold

`revenue.ts` plans against settled customer-review revenue in atomic USDG units. Its API has no creator or developer fee field. Unknown provider costs, infrastructure costs, refunds, or reserves block eligibility. The planner does not establish that a balance is attributable; the caller must supply that evidence.

`buyback-sqlite-store.ts` is a durable local persistence implementation, not a production treasury service. It stores serialized bigint values exactly, keeps in-flight reservations active, and takes SQLite-backed process-shared locks around a batch and treasury. Lock waiting is bounded; only a definitely dead PID is reclaimed. A possibly reused/live PID is left locked. An ambiguous submission remains `submitting`; the orchestration layer must reconcile it by the stable batch id and must never submit it again blindly. Records with changed request/config fingerprints conflict in `runReviewBuyback`.

The settlement ledger API accepts only events typed as `settled_customer_review`. Exact event replay is a no-op; replay with changed fields is rejected. Each batch has one immutable allocation, and an event cannot be allocated into another batch. Durable buyback reservations require that allocation and require its gross amount to match the buyback request. Settlement ingestion and allocation must be fed from an authoritative, independently reconciled source. Do not count customer deposits, creator/developer fees, or unconfirmed amounts as review revenue.

## Safe use today

This is a local audit/reconciliation scaffold. There is no production adapter, router selection, signer, swap, transfer, or deployment policy here. Keep `enabled` unset/false in operator configuration. Even an injected adapter is blocked unless configuration carries a nonempty `reviewedPolicyId` and `teamConfirmedTokenAddress: true`. Actual execution must remain disabled until the token contract address is confirmed by the team, treasury attribution is independently reconciled, and an explicit reviewed purchase policy and approved adapter are supplied. Do not infer contract addresses or economics from sample values.

The dry-run CLI takes its gross review revenue only from a persisted allocation, accepts available funds and obligations as operator-supplied audited values, never opens a wallet, and never calls an execution adapter:

```ts
// obligations.json uses decimal strings or null for each obligation field.
// bun scripts/revenue-dry-run.ts ./accounting.sqlite reviewed-batch-id \
//   500000 1000000 ./obligations.json
```

`obligations.json` must contain exactly `modelLiabilities`, `infrastructureLiabilities`, `refunds`, and `reserves`; each value is a nonnegative decimal string in atomic USDG units or `null`. A `null` value is reported as an eligibility block. The command prints the plan as JSON and exits without constructing a wallet or adapter.

SQLite files contain an accounting audit trail. Back them up, restrict access, and reconcile them against chain settlement records and the treasury before any operational decision. SQLite locks are appropriate for a single host and local processes; they are not a distributed lock or a replacement for a managed transactional database in a multi-host service.

## Read-only on-chain revenue ingestion

`settlement-ingestion.ts` can ingest the opt-in `ReviewProtocolRevenueSettled` event using a read-only viem `PublicClient`. Configure the exact chain, QueryEscrow, USDG, reviewed remainder recipient, start block, and bounded chunk size. It requires an RPC `finalized` block tag and historical reads; there is no latest-block fallback. It records only successful, canonical, attributable transfers for DECIDED USDG/SHIELDED/ANONYMA queries. FEED subsidy events are verified and excluded. The event amount is the post-panel protocol remainder, never gross review payments, developer fees, refunds, or unspent deposits.

Each accepted record persists the chain, escrow, token and recipient plus block/hash, transaction/hash, log index, query ID, pay path/status and matched USDG transfer evidence. A unique chain/transaction/log index and canonical event ID make exact replays harmless and conflicting replays fail. Each chunk advances the SQLite cursor atomically with its records. On restart, the ingester checks the saved checkpoint against the canonical block hash and stops on a reorg or mismatch; it also rechecks the finalized anchor before committing. Keep each poll bounded with `maxChunks`; resume by calling the ingester again. This is a local audit ledger, so independently reconcile it against the chain before operational use and back it up with the rest of the SQLite accounting data.

The opt-in contract hook remains disabled when its recipient is zero. Enabling that governance setting requires deliberate reviewed policy and does not enable automatic purchases or burns. No wallet or write client is used by ingestion.

See [Revenue operations](REVENUE-OPERATIONS.md) for the enforced 30-day reserve, $25 batch threshold, fresh budget requirements, ingestion command and policy-aware preview. The older generic dry-run above does not enforce the launch reserve or batch policy.

The current receipt verifier accepts one revenue settlement event per transaction and exactly one matching preceding USDG transfer. Multi-settlement aggregator transactions fail closed and require an explicitly reviewed extension before use.
