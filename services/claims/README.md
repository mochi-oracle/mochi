# Mochi claim research pilot

Standalone claim research at `/check/`, sharing the existing website server. The pilot researches one exact claim, retrieves bounded sources, runs three independently configured models, validates source quotes, and displays agreement separately from the assessment. It collects no customer payment and produces no TEE attestation or chain receipt.

## Configuration

The default is disabled. Configure server-side variables through the hosting provider, never the browser or repository:

- `MOCHI_CLAIMS_MODE=pilot`
- `MOCHI_CLAIMS_ACCESS_TOKEN`: a random invitation secret of at least 24 characters. Supply it privately to pilot testers; do not put it in a URL.
- `MOCHI_CLAIMS_DATABASE`: a writable SQLite path on a persistent volume, for example `/data/claims.sqlite`. Use one server replica; private research sessions remain in process memory.
- `MOCHI_CLAIMS_JURORS`: JSON configuration for exactly three distinct IDs and model names. Each entry has `id`, `model`, `baseUrl` (HTTPS chat-completions-compatible API base), optional `transport` (`chat-completions`, the default, or `phala-aci`), and optional `apiKeyEnv` naming the server environment variable holding that provider's key. The `phala-aci` transport requires a named key. No actual secret belongs in this JSON.
- Provider keys: set only the explicitly named `apiKeyEnv` variables in the hosting service. Keys are neither returned to clients nor persisted by this service.
- `MOCHI_CLAIMS_SEARCH_KEY`: optional Brave Search API key. Without it, research uses only user-provided URLs and prominently reports that external discovery is unavailable. Configure it for the proposed general claim-research experience.
- `MOCHI_CLAIMS_DAILY_ACTIONS`: default 100, maximum 1000. Both research and new jury runs reserve one action, including failed attempts. This limits request volume, not dollar cost. Set provider-side spending caps separately before launch.

Configuration example with placeholders to replace:

```json
[
  {"id":"juror-one","model":"MODEL_ONE","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_ONE_KEY"},
  {"id":"juror-two","model":"MODEL_TWO","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_TWO_KEY"},
  {"id":"juror-three","model":"MODEL_THREE","baseUrl":"https://PROVIDER_HOST/v1","apiKeyEnv":"CLAIM_PROVIDER_THREE_KEY"}
]
```

Choose models with different training lineages where feasible. Distinct configured model strings do not prove independent training or endpoints. The adapter expects JSON-object chat-completion responses; verify compatibility with each provider and test actual costs. No models or paid subscriptions are provisioned automatically.

For Phala, `transport: "phala-aci"` uses the existing ACI verifier to check fresh gateway attestation and signed confidential inference receipts, requires UpToDate TCB status, and rejects debug TDs even if a shared-service debug override is set. Failed verification fails the juror rather than falling back to ordinary inference. This verifies the provider request path only: source retrieval, research sessions and aggregation still run outside a TEE on Railway, so results remain `unattested_research`. It does not activate the confidential document protocol or chain settlement.

## Data and access

- Research needs the pilot access token and explicit consent to external research. At most 4000 claim characters, five supplied URLs, six retrieved sources, 512 KiB per retrieved response, 18,000 characters per source and 64,000 aggregate evidence-text bytes.
- Fetches accept public HTTPS HTML/plain text only, with DNS address validation and pinning, redirect revalidation, bounded time and response size. No PDFs, authenticated posts, browser rendering or paywall bypass.
- Private source bundles last 30 minutes in memory. Private results last 60 minutes. Restarting the service loses these private sessions. Download a result before leaving if needed. Public results and aggregate daily usage counters persist in SQLite.
- Review requests reuse a pending or completed result for the same research token rather than calling models twice. Expired sessions return 410.
- Publishing separately requires the pilot access token, the unpredictable review-owner token and explicit consent. It publishes the exact claim, model findings, cited passages and source metadata. Full source text is removed. Anyone with the share link can view it.
- The integrity digest binds review content and source metadata/content hashes, excluding raw source text. It is not a signature or proof of correctness. Shared and private projections preserve the same digest.
- Reviews require three of three valid matching findings. Two of three remains unresolved. No usable evidence produces deterministic insufficiency without running models. Malformed output and invalid quotes are failures, never supporting votes.
- A quote matching a retrieved passage establishes a textual match; it does not independently prove semantic entailment, source authenticity or factual truth.

The first pilot supports explicit public sharing, not publication deletion or a correction-history UI. Do not submit confidential material: external search and model providers receive the claim/evidence under the consent shown in the interface. The confidential document-review protocol is a separate integration.

## Local operation and verification

Build with `cd web/site && bun run build`; serve from the root with `bun web/server.ts`. Do not load real credentials merely to run unit tests.

Focused gate: `bun test services/claims/test web/test`. Project typecheck: `bun run typecheck`.

Browser checks use a separate localhost fixture server with clearly identified synthetic model findings. They establish UI behavior, not model accuracy. A separate actual IANA source fetch passed. Before paid or open public use, evaluate independently reviewed claims using the configured real models, benchmark complete costs and latency, verify provider spending limits, and implement and test production payment settlement. The five-cent short-review target is not a live price charged by this pilot.

## Bounded evaluation

Run `bun services/claims/eval/run.ts` for the offline harness. The fixtures are synthetic and do not establish factual quality. Explicit live evaluation requires `--live --max-cases N` and the server-side juror configuration; it reports provider token usage where available and keeps absent usage unknown. A count cap is not a dollar cap: set provider spending limits and agree a test budget first. See `eval/README.md` for the controls and the independent real-claim evaluation still required.

## APIs

`GET /api/claims/config`; `POST /api/claims/research`; `POST /api/claims/reviews`; `POST /api/claims/reviews/:id/share`; `GET /api/claims/shared/:shareId`.

Research and review requests send `x-mochi-access-token`; sharing additionally sends `x-mochi-review-token`. Public shared reads require neither. Errors return safe `{error:{code,message}}` objects. No endpoint returns provider credentials or provider error bodies.

## Separate confidential checkout and review revenue

`packages/sdk/src/claims.ts` adapts supplied claim evidence into the existing private protocol. The browser client in `web/site/src/claim-protocol-client.js` uses that same framing and the existing attested-intake/wallet lifecycle. Supplied URLs are metadata, not proof that a source was fetched or authenticated. Deployment must be configured and verified before payment is offered; an unpaid research result cannot settle an escrow query.

`src/revenue.ts` computes eligible residual review revenue after known costs, refunds and reserves. `src/buybacks.ts` is a disabled-by-default orchestration boundary for a future approved chain adapter and durable accounting store. It is not a running purchase service: no router, signing wallet, settlement ledger or production store is supplied. Developer/creator fees are outside this boundary. The team's future token address is required before activation; this project never creates that token. Purchases and manual burns are separate actions.
