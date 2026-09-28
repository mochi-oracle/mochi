# Mochi architecture

Mochi is a model jury for tokenized assets: open models running in TEEs independently read the documents
tokenized-asset protocols depend on (issuer notices, earnings releases, reserve attestations, NAV statements,
invoices) and return one attested verdict on Robinhood Chain, with the disagreement published.

**Principles.** Attested-or-nothing: jurors, intake and consensus all run in TEEs and the orchestrator is an untrusted
relay. Document bytes never leave enclaves. No provenance, no feed. Verdicts carry agreement, dissent and evidence
hashes, never "truth". Payer privacy by default: everything private that touches the chain is a salted commitment.
Feeds fail closed: no verdict, no update, never a stale "yes". Jurors are paid their costs first.
**No KYB/KYC anywhere:** every gate is a TEE attestation or a stake.

## 1. Architecture

```
contracts (RHC)
├─ MochiToken           (ERC20 + permit; fixed supply; timelocked display-metadata changes)
├─ JurorRegistry      (enclave keys by role JUROR/INTAKE/CONSENSUS; measurement allow-list; attestedUntil; bond $MOCHI; one class per juror; selection; slashing)
├─ SchemaRegistry     (task schemas; versioned; governor behind 24h timelock; clerk voting (staked $MOCHI) proposes through the timelock)
├─ QueryEscrow        (query lifecycle open → seal → settle/expire; pricing; USDG / shielded / Anonyma-voucher / feed-budget payment paths)
├─ MochiVerdicts     (verifies selected-juror signatures + consensus-enclave attestation; stores verdicts; equivocation slashing)
├─ Feeds              (named feeds → latest payload per key; origin allow-list; on-chain crosscheck hook; contract-consumer subscriptions)
├─ StockTokenCrosscheck (IFeedCrosscheck: reads newUIMultiplier()/effectiveAt() via adapter; recordBaseline keeps the pre-split multiplier)
├─ PanelEscalation    (HUNG → 3 staked human evaluators; commit-reveal; appeal → second panel; slash 10%)
├─ MochiStaking         (stake $MOCHI; receives protocol-fee residual; reward-per-token accumulator)
└─ BlockhashRandomness (IRandomness v1)

services
├─ gateway            (REST/tRPC + MCP tool; relays ciphertext to intake; never sees document bytes)
├─ intake (TEE)       (receives client-encrypted doc OR fetches docUrl itself over pinned TLS; OCR; docHash; tokensK; signs Provenance; re-wraps the doc key to the selected jurors)
├─ juror node (TEE)   (runs model with schema prompt + extraction spec; normalizes; signs JurorAnswer)
├─ consensus (TEE)    (runs the consensus engine on the jurors' answers; signs VerdictAttestation; encrypts private results to payer)
├─ orchestrator       (untrusted relay: seal → dispatch → collect → consensus enclave → post tx; cannot forge or drop answers undetected)
├─ attestor           (verifies quotes; refreshes attestedUntil on-chain every 10 min; reports failures)
├─ feed-runners       (corp-actions, earnings, attestations: schedule standing queries; intake enclave does the fetching)
├─ crosscheck-monitor (mirrors on-chain crosscheck results into DB, alerts)
├─ disagreement-index (aggregates per schema/field/model class; public API only)
├─ receipts + anchor  (verdict receipts in Anonyma format, hourly merkle anchor)
├─ anonyma-settle     (voucher ledger reconciliation, weekly USDG settlement)
├─ indexer, api
```

---

## 2. Task schemas (v1: seven; ISO 20022-informed field names)

Source of truth: `packages/schemas`. Every field has a kind, a tolerance, a `required` flag, and an evidence requirement (every non-null field must cite ≥1 span, or that juror's value for the field is invalid and counts as dissent).

```jsonc
EX_DIVIDEND        { ticker*, issuer, ex_date*, record_date, pay_date, amount_per_share*, currency*, dividend_type* }   // params: multiplier_token → derived multiplier_effect_expected
SPLIT              { ticker*, ratio_num*, ratio_den*, effective_date* }
EARNINGS           { ticker*, period*, eps_gaap_diluted*, eps_non_gaap_diluted, revenue*, currency*, release_ts }
RESERVE_ATTESTATION{ issuer*, asset_symbol*, as_of*, reported_supply*, reported_reserves*, custodian, auditor, attestation_type, signature_present* }
NAV                { fund_id*, as_of*, nav_per_share*, total_assets, total_liabilities, shares_outstanding }
INVOICE            { payee_id*, payer_id*, amount*, currency*, due_date*, invoice_number* }   // extraction only; no counterparty verification
FREEFORM_FACT      { answer* }   // params: question*, answer_type* (BOOL|NUMBER|STRING) — fixes answer's kind
```
`*` = required (gates VERDICT/HUNG). Non-required fields are reported with their own agreement but never hang a verdict.

**Tolerances** (on normalized values; numbers are fixed-point ×1e8):
- `exact` — per-share amounts, EPS, NAV per share, ratios, dates, enums, bools, tickers, currencies. A one-cent EPS difference is a different answer, because it decides beat/miss.
- `rel(bps)` — large aggregates reported at varying precision: `revenue` 10 bps, `reported_supply`/`reported_reserves` 1 bp, `total_assets`/`total_liabilities`/`shares_outstanding` 10 bps.
- `str` — canonicalized per mode (ticker, currency, name with legal suffixes stripped, id, fiscal period, text); descriptive names that vary in print (custodian, auditor, EX_DIVIDEND issuer) are non-required.

**Derived fields** are computed after consensus, deterministically, never extracted. `EX_DIVIDEND.multiplier_effect_expected` comes from the `multiplier_token` param (set by the feed-runner from the token registry), because an issuer notice never says how a token wrapper applies the dividend. `EARNINGS.beat_eps` / `beat_revenue` compare the agreed values against `consensus_eps` / `consensus_revenue` supplied by the requester in query params (committed on-chain as `paramsHash`). A press release does not contain analyst consensus, so models must not be asked for it.

**On-chain payload.** For every schema the consensus enclave also emits `payload = abi.encode(bytes32 subjectKey, uint64 asOf, bytes body)` with `body = abi.encode(<Schema>Payload)` (structs in `MochiTypes.sol`). `payloadHash = keccak256(payload)` is in the verdict, so feeds and consumer contracts get typed values, not JSON.

---

## 3. Jury protocol

### 3.1 Juror selection (grinding-resistant)
- Model classes: `LARGE_A`, `LARGE_B` (different lineages), `DOC_SPECIALIST` (long-context/vision-capable), `SMALL_FAST`, `DISSENTER` (distinct training family). Each juror key serves exactly one class.
- Class mixes are nested so escalation reuses answers: `N3 = [LARGE_A, DOC_SPECIALIST, DISSENTER]`, `N5 = N3 + [LARGE_B, SMALL_FAST]`, `N7 = N5 + [LARGE_A, DOC_SPECIALIST]`, `N9 = N7 + [LARGE_B, DISSENTER]`.
- Two-step: `open()` fixes `docCommit`, schema, N and records `sealBlock = block.number + SEAL_DELAY`. After `sealBlock`, anyone calls `seal()`: `seed = keccak256(queryId, docCommit, round, blockhash(sealBlock))`; `JurorRegistry.selectJurors(seed, classes, exclude)` picks, per seat, the first active juror of that class probing from `keccak256(seed, seat) mod len`. The selected set is stored on-chain. The requester can't grind (seed unknown when `docCommit` is fixed); the orchestrator can't choose (selection is on-chain). If `seal()` misses the 256-block window, `reseal()` sets a new `sealBlock`.
- Residual trust: the RHC sequencer could bias `blockhash`. `IRandomness` lets a VRF replace it without touching other contracts.

### 3.2 Intake + extraction (inside TEEs)
- **Intake enclave.** Client encrypts the document to the intake enclave's attested HPKE key (no KMS in the trust path), or passes `docUrl`. For `docUrl` and all feed documents, the intake enclave fetches over TLS pinned to an allow-listed origin (EDGAR, registered issuer IR domains, fund administrators), and records `{originId, fetchedAt, transcriptHash}`. It computes `docHash = sha256(bytes)`, `docCommit = keccak256(salt ‖ docHash)` (`salt` = 0 for public queries, payer-random for private), `tokensK` (after in-enclave OCR), and signs `Provenance{docCommit, kind: SUBMITTED|FETCHED, originId, fetchedAt, tokensK, transcriptHash}`. `open()` requires this signature from an active INTAKE key, which makes pricing (`tokensK`) and origin trustworthy.
- After `seal()`, intake re-wraps the document key to each selected juror's attested key.
- Query params (e.g. a FREEFORM question, consensus EPS) and the salt travel only inside the sealed intake envelope; intake returns `paramsHash`, which the payer commits in `open()`, and jurors/consensus re-check it on-chain. For private queries `payerCommit = keccak256("mochi/payer/v1" ‖ payerResultPubKey)` with a fresh x25519 key per query; the consensus enclave encrypts the result only to a key matching that on-chain commitment, so no relay can substitute its own. Wire formats: `packages/protocol`.
- **Juror enclave.** Input: document, schema prompt (versioned), extraction spec (JSON schema + "cite span offsets for every field"), salt. Output: normalized answer, spans, per-field confidence; signs EIP-712 `JurorAnswer{queryId, round, docCommit, schemaId, schemaVersion, answerHash, spansRoot, quoteHash}` where `answerHash = keccak256(canonicalJSON({salt, schemaId, schemaVersion, fields}))`. Salted, so a private bool answer can't be brute-forced from its hash. Document bytes and raw spans stay inside; spans reach the payer only inside the payer-encrypted result.

### 3.3 Consensus (inside the consensus enclave)
```
k(N) = ceil(3N/4)          → N=3:3  N=5:4  N=7:6  N=9:7
for each field f:
  values = valid juror values (normalized; missing span or unparseable → invalid; timeout → invalid)
  exact:  anchor = modal value
  rel/abs: anchor = juror value with max support (#values within tol of it); ties → closest to median, then smallest
  agreeCount(f) = support(anchor);  agreeBps(f) = agreeCount·10000 / N   (timeouts count against)
  verdict[f] = anchor if agreeCount(f) ≥ k(N) else HUNG_f
  dissent[f] = {seat → value} for seats not supporting the anchor
agreement = min over required f of agreeBps(f)  (headline), plus per-field
status = VERDICT if every required field reaches k(N) and none agrees on null; else HUNG
dissentMask = bit per seat that dissented on any required field or timed out
```
The enclave signs `VerdictAttestation{queryId, round, answerHash, payloadHash, evidenceRoot, votesHash, agreementBps, dissentMask, timeoutMask, status}`. `MochiVerdicts.post` checks that every signature comes from the on-chain selected set, that timeouts are declared per seat, that the consensus key is attested, and that status agrees with `agreementBps` and k(N). The orchestrator relays but cannot drop a dissenter (the seat must appear as answer or declared timeout, and the consensus enclave only marks a timeout it observed) or rewrite the result.

Cross-check lives on-chain (see `Feeds`): a feed update for a registered Stock Token calls `StockTokenCrosscheck`; a mismatch emits `CrosscheckFailed` and the feed key keeps its last value. The verdict itself is still posted.

### 3.4 Escalation ladder
- `HUNG` → (a) **expand**: N3→N5→N7→N9, paying only for the added seats; earlier answers are reused (nested mixes); (b) `PanelEscalation`, allowed only for public queries or when the payer set `allowPanelDisclosure` at open (the panel sees the document; intake re-encrypts it to the evaluators); (c) accept HUNG.
- Feeds run (a) up to N9 then (b) automatically (feed documents are public); a feed key stays at its last VERDICT until resolved.

### 3.5 Verdict record (on-chain)
```solidity
struct Verdict { bytes32 queryId; uint8 round; bytes32 docCommit; uint32 schemaId; uint16 schemaVersion; bytes32 modelSetHash; uint16 agreementBps; uint32 dissentMask; uint32 timeoutMask; bytes32 evidenceRoot; bytes32 attestationRoot; bytes32 answerHash; bytes32 payloadHash; bytes32 paramsHash; bytes32 provenanceHash; uint8 provenanceKind; bytes32 originId; bool isPublic; bool escalated; bytes32 payerCommit; uint64 ts; uint8 status; }
```
`verdictId = keccak256(queryId, round)`. If `isPublic`, the answer JSON and payload are published in the receipt (off-chain, anchored); if private, only the payer and view-key holders can decrypt them, and every on-chain hash is salted.

---

## 4. Contracts

### 4.1 `JurorRegistry.sol`
`enroll(key, measurement, class, bond)` by operator (JUROR role; bond ≥ 25,000 $MOCHI); INTAKE/CONSENSUS keys registered by governor. `refreshAttestation(keys[], until)` by ATTESTOR (every 10 min). `isActive(key, role)` = enrolled ∧ ¬delisted ∧ attestedUntil ≥ now ∧ measurement allowed ∧ ¬exiting. Measurements allowed by governor (timelocked). Exit: `requestExit` → 7 days → `withdrawBond`. Slashing to `slashSink`: failed re-attestation while serving 5% (ATTESTOR), equivocation (two answer hashes for one query/round) 100% + delist (anyone, via `MochiVerdicts.reportEquivocation`), timeout rate > 5% over ≥ 20 served: 1%/day (anyone).

### 4.2 `SchemaRegistry.sol`
`propose(schemaId, schemaJsonHash, promptHash, tolerancesHash, crosscheckHash)` → activates after 24h timelock; versioned; old versions stay valid for verification; `isActive(schemaId, version)`, `latest(schemaId)`. Governor = the timelock; clerk voting (staked $MOCHI, snapshot voting power) proposes schema and class-mix changes.

### 4.3 `QueryEscrow.sol`
- Pricing: `quote(schemaId, n, tokensK)` = Σ over the class mix of `(classBase[c] + classPerK[c] · tokensK)` + `protocolFee` (= max(minProtocolFee, jurorFees · protocolFeeBps / 10000)). Class prices are set by governor from measured GPU-TEE cost + margin. The "from $0.05" headline applies to short documents (issuer notices) at N=3.
- Paths: `openWithUSDG`, `openShielded` (via `IShieldedPayments.spend`, payerCommit only; refunds go to a payer-chosen `refundTo`), `openWithVoucher` (Anonyma EIP-712 voucher bound to docCommit; draws from Anonyma's prepaid USDG float in the escrow, which `anonyma-settle` tops up weekly, so jurors are always paid from real USDG; NYMA tier is recorded, and the discount is Anonyma's to absorb), `openFeed` (FEED_RUNNER, from `feedBudget`).
- Lifecycle: `open* → seal → (settle | expand → seal → settle | expire)`; `reseal` if the blockhash window passed; `expire` after `deadline` refunds everything unspent.
- Settlement waterfall (`settle`, only `MochiVerdicts`): answering jurors are credited 100% of their class fee (claimable by operator); timed-out seats refunded; on VERDICT the protocol fee splits `panelReserveBps` → panel pool, remainder → `MochiStaking.notifyReward` by default. A governor-only optional review-protocol recipient can receive only that post-panel VERDICT remainder; zero leaves the existing staking path unchanged. The hook remains unset in deployment/default configuration, does not change panel allocation, and does not route HUNG, timeout-seat, expiry, or unspent-deposit refunds. A final reserve policy and review accounting approval are still required before anyone configures it.
- Guardian pause stops new `open*` only; unpausing is governor-only (timelocked).

### 4.4 `MochiVerdicts.sol`
`post(VerdictInput, JurorVote[], consensusSig)`: query SEALED for this round; votes align 1:1 with the on-chain selected seats; each non-timeout vote has a valid `JurorAnswer` sig from an active JUROR key; `timeoutMask` matches empty sigs; consensus sig valid from an active CONSENSUS key over the input + `votesHash`; `status`, `agreementBps`, `responded ≥ k(N)` consistent; `attestationRoot` computed on-chain from quote hashes. Stores, emits, calls `escrow.settle`, records service/timeouts in the registry. `postPanelOutcome` (only PanelEscalation). `verify(verdictId, answerJSON)`. `reportEquivocation(a1, sig1, a2, sig2)`.

### 4.5 `Feeds.sol`
`register(feedId, schemaId, allowedOrigins[], crosscheck, monthlyFee)` (governor). `update(feedId, key, verdictId, payload)` by anyone: verdict is VERDICT, public, FETCHED, origin allowed, schema matches, `keccak256(payload) == payloadHash`, payload subject == key, `asOf` not older than current; the crosscheck hook, if set, must pass, otherwise `CrosscheckFailed` and no update. `latest(feedId, key)` free for EOAs/eth_call; contract callers need an active subscription (`subscribe(feedId, consumer, months)`, USDG to `feedsTreasury`).

### 4.6 `PanelEscalation.sol`
Evaluators stake USDG (min 2,500). `escalate(queryId)` (payer or feed runner; pays panel fee; public or `allowPanelDisclosure`) → 3 evaluators from `IRandomness`. Commit-reveal of `(answerHash, payloadHash)`; 2-of-3 match → `MochiVerdicts.postPanelOutcome` (escalated = true). No majority → HUNG final. `appeal` within 24h → second panel; first-panel evaluators on the losing side of the final majority are slashed 10%. Majority evaluators split the fee.

### 4.7 `MochiStaking.sol`
Stake/unstake $MOCHI (7-day cooldown); `notifyReward(usdg)` from escrow and feeds treasury; reward-per-token accumulator; `claim`. Receives the protocol-fee residual after jurors and panel reserve are paid when QueryEscrow's optional governor-controlled review recipient is zero.

### 4.8 `MochiToken.sol`
ERC20 + ERC20Permit, 18 decimals, fixed supply minted once to the distribution address. The display name/symbol can be changed only through the timelock (`setMetadata`); balances and the permit domain never change.

### 4.9 Deploy / OPSEC
Fresh deployer; OZ `TimelockController` (24h) owned by the protocol owner holds GOVERNOR on every contract (measurements, schemas, prices, feeds); guardian pause = new queries only (feeds keep last verdict; payouts continue).

---

## 5. Services

| Service | Does |
|---|---|
| `gateway` | REST/tRPC + SDK + MCP tool `mochi.ask`; relays client ciphertext or `docUrl` to intake; returns the signed Provenance + quote so the payer (or relayer/voucher path) calls `open*`. Never holds plaintext |
| `intake` (TEE) | Decrypt/fetch (pinned TLS, origin allow-list), OCR, docHash/docCommit/tokensK, sign Provenance, re-wrap the doc key to selected jurors, and to panel evaluators when permitted |
| `juror node` (TEE) | Model run (vLLM, OpenAI-compatible, JSON-schema constrained), normalize, spans, sign `JurorAnswer`; re-attest every 10 min |
| `consensus` (TEE) | Consensus engine, derived fields, payload, `VerdictAttestation`; private results encrypted to payer (+ view keys) |
| `orchestrator` | Watches `open`, calls `seal`, dispatches, 60s standard timeout, relays to the consensus enclave, posts `post()`, triggers expansion for feeds |
| `attestor` | Quote verification (NRAS + TDX/SNP via `QuoteVerifier`), `refreshAttestation`, failure reports |
| `feed-runners` | `corp-actions`: daily issuer notices for registered Stock Tokens + `newUIMultiplier` events → `EX_DIVIDEND`/`SPLIT`; `earnings`: release calendars → EDGAR 8-K / press release → `EARNINGS`; `attestations`: weekly PoR/NAV per issuer/fund. Submits URLs to intake; never fetches documents itself |
| `crosscheck-monitor` | Indexes `CrosscheckFailed`, alerts |
| `disagreement-index` | Rolling stats per schema/field/model class; API only (public verdicts only) |
| `receipts` + `anchor` | Receipt per verdict (Anonyma v1 envelope + attestation + anchor proof); hourly merkle root |
| `anonyma-settle` | Voucher reconciliation vs float draws, weekly USDG top-up |
| `indexer`, `api` | Public: verdict records, feeds, index, juror stats. Private results stored only as payer-encrypted ciphertext (7-day TTL) |

### 5.1 Tables
```sql
schemas         (id, version, json_hash, prompt_hash, tolerances jsonb, crosschecks jsonb, active, pk(id, version))
jurors          (key pk, operator, measurement, class, role, bond, attested_until, uptime_30d, served, timeouts, slashed, delisted)
queries         (id pk, ts, doc_commit, schema_id, schema_version, n, round, is_public, pay_path, payer_commit, params_hash, provenance_kind, origin_id, tokens_k, status)   -- no doc bytes, no docHash for private
juror_answers   (query_id, round, seat, juror, class, answer_hash, spans_root, quote_hash, sig, timed_out, ts, pk(query_id, round, seat))   -- hashes only
verdicts        (id, ts, query_id, round, status, agreement_bps, dissent_mask, timeout_mask, evidence_root, attestation_root, answer_hash, payload_hash, is_public, escalated, tx, pk(id, ts))   -- hypertable on ts
verdict_public  (verdict_id pk, answer jsonb, payload bytea, dissent jsonb, field_agreement jsonb)   -- public verdicts only
private_results (verdict_id pk, ciphertext bytea, expires_at)   -- payer-encrypted blob only
feeds           (feed_id, key, verdict_id, as_of, updated_at, pk(feed_id, key))
disagreement    (bucket timestamptz, window interval, schema_id, field, class, disagree_rate numeric, samples int, pk(schema_id, field, class, window, bucket))   -- hypertable on bucket
crosschecks     (feed_id, key, verdict_id, ok bool, detail jsonb, ts)
escalations     (query_id, round, panel text[], outcome jsonb, appealed bool, ts)
anonyma_vouchers(voucher_id pk, query_id, tier, usdg_amount, settled bool)
receipts        (verdict_id pk, key_id, sig, payload jsonb, anchor_root, anchor_index)
anchors         (root pk, ts, count, tx)
```

### 5.2 API / SDK / MCP
```
POST /v1/intake  {schema, ciphertext|docUrl, private?} → {provenance, intakeSig, docCommit, tokensK, quote}
POST /v1/query   {provenance, intakeSig, schema, n?, params?, private?, pay: usdg|note|anonyma, voucher?} → {queryId, tx|calldata, eta}
GET  /v1/verdict/:id → {status, fields (public only), agreement, dissent (public only), attestation, receipt, anchor}   // private: ciphertext for payer
GET  /v1/feeds/:feedId/:key
GET  /v1/disagreement?schema=&field=
POST /v1/anonyma/send-to-jury   (Anonyma server → Mochi; voucher path)
MCP: mochi.ask(schema, doc, options) — via Anonyma MCP under Agent Allowances
SDK (TS/Solidity): mochi.ask(), mochi.verify(receipt), IFeeds.latest(feedId, key)
```

---

## 6. Flows

**Earnings day:** `feed-runners` sees the NVDA release → intake fetches the 8-K from EDGAR (FETCHED, origin `sec.gov`) → `EARNINGS`, N=7, params carry the requester's consensus EPS/revenue → six jurors read diluted GAAP EPS 2.11, SMALL_FAST reads basic EPS 2.10 → 6/7 ≥ k(7)=6 → EPS agreed at 86%; revenue 7/7 within 10 bps → VERDICT, agreement 86%, SMALL_FAST in `dissentMask` → posted in ~90s → `earnings@RHC` updates with a typed payload (beat flags derived) → consumers resolve → disagreement index logs the basic-vs-diluted split for SMALL_FAST.
**Ex-div:** issuer notice fetched by intake → `EX_DIVIDEND` → `Feeds.update` runs `StockTokenCrosscheck` vs `effectiveAt()` → match → `corp-actions@RHC` key NVDA updated.
**Private trader query:** shielded note pays; doc encrypted to intake; salted docCommit and answer hashes on-chain; result encrypted to payer; receipt proves the verdict existed at T without revealing content or which public document was asked about.
**Anonyma send-to-jury:** Anonyma server → `/v1/anonyma/send-to-jury` with voucher → `openWithVoucher` → verdict returned to Anonyma with receipt; Anonyma renders it.
**HUNG:** attestation PDF with conflicting totals → HUNG on `reported_reserves` at N=5 → expand to N=9 → still HUNG → panel of 3 (public doc) → outcome → verdict with `escalated=true`; feed updates.

---

## 7. Tests & acceptance

| Test | Pass |
|---|---|
| Juror selection | Deterministic from on-chain seed; seed unknown at `open`; one per seat/class; inactive never selected; nested expansion excludes prior seats |
| Attestation | Inactive/expired key's answer rejected; re-attest failure slashes 5% and deactivates |
| Relay honesty | Orchestrator can't omit a selected seat, substitute a juror, or alter the consensus result (tx reverts) |
| Consensus | k(N) table; exact vs rel tolerance; missing-span invalidation; timeouts count against; required-null → HUNG; dissent mask correct (property tests over synthetic answer sets) |
| Provenance | Feed rejects SUBMITTED docs and non-allow-listed origins; open rejects non-INTAKE signatures |
| Cross-check | `EX_DIVIDEND` mismatch vs `effectiveAt()` → `CrosscheckFailed`; feed unchanged |
| Privacy | No doc bytes, spans, or private field values in any DB/log (CI grep + schema test); private on-chain hashes salted; panel refuses private queries without disclosure flag |
| Pricing | Juror fees = class price × tokensK exactly; HUNG refunds protocol fee; timeouts refunded; waterfall sums to amount paid |
| Feeds | `update` only on public FETCHED VERDICT with matching payload; `asOf` monotonic; subscription gating |
| Anonyma voucher | Invalid sig rejected; replay rejected; float enforced; weekly top-up matches Σ vouchers |
| Panel | 3 staked, random; commit-reveal; appeal; slash 10% on reversal |
| Receipt | Verifies with Anonyma's verifier logic + anchor proof |
| Load | 200-ticker corp-actions run completes daily under 30 min with N=3; earnings verdict p95 < 120s with N=7 |
