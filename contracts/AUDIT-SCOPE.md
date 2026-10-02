# Mochi contracts: external audit scope

## Scope and build

The production audit should cover the complete `contracts/src` tree, with focused economic and state-machine review of
the eight contracts below. `src/interfaces`, `src/libraries`, `src/governance`, `src/consumer`, `src/examples`, and
`src/mocks` are supporting scope: verify interface assumptions, roles, and integration behavior. Deployment is not
ready for mainnet until the audit findings are resolved and reviewed. Findings are tracked privately pending launch;
they are not published in this repository.

Compiler configuration from `foundry.toml`: Solidity 0.8.28, EVM `prague`, optimizer enabled with 200 runs,
`via_ir = true`, and `bytecode_hash = "none"` with `cbor_metadata = true` (no metadata hash in the runtime code, so
comments, whitespace and source paths do not change bytecode; the CBOR tail records only the solc version). Runtime
sizes use `forge build --sizes` (Foundry v1.7.1); nSLOC is the count of nonblank, non-comment-only Solidity source
lines (imports and declarations included). These sizes are for this build configuration and were refreshed on
2026-10-02; contract changes after that date move them.

| Contract | nSLOC | Runtime bytes | EIP-170 margin |
|---|---:|---:|---:|
| QueryEscrow | 523 | 24,274 | 302 |
| MochiVerdicts | 247 | 12,732 | 11,844 |
| JurorRegistry | 307 | 12,493 | 12,083 |
| PanelEscalation | 680 | 21,693 | 2,883 |
| Feeds | 147 | 7,466 | 17,110 |
| MochiStaking | 173 | 7,474 | 17,102 |
| ClerkVoting | 180 | 6,278 | 18,298 |
| DrandRandomness | 91 | 3,273 | 21,303 |

The production dependency for token safety, access control, cryptography, and timelocks is OpenZeppelin Contracts
5.4. Local tests use the checked-in OpenZeppelin source and `forge-std`; no external dependencies are downloaded by
these checks. CI runs pinned Slither and Aderyn on `contracts/src` (`.github/workflows/security.yml`, configured by
`slither.config.json` and `aderyn.toml`). Every Slither High/Medium and Aderyn High finding has been triaged; none was
a bug. Accepted ones carry an inline reason (`slither-disable-next-line` / `aderyn-fp-next-line`); `slither.db.json`
and `aderyn-baseline.json` hold findings that cannot carry one (none for PanelEscalation). CI fails on any new Slither
Medium or High and any new Aderyn High; Low findings are reported only.

`forge coverage --ir-minimum` was attempted. The coverage build failed in solc 0.8.28 with a Yul stack-depth
exception (`Variable expr_1 is 1 too deep in the stack`), after `--ir-minimum` changed optimizer settings. No coverage
percentage is claimed. The normal build and test profile uses `via_ir = true` and succeeds.

## Deployment identities and roles

`scripts/deploy-local.ts` is explicitly a local deployment: it initializes the deployer as admin/governor, uses mock
USDG and shielded payments, and does not perform the production handover. It grants ATTESTOR to the configured
attestor, FEED_RUNNER to both feed runner and orchestrator, SLASHER on JurorRegistry to MochiVerdicts, GOVERNOR on
SchemaRegistry and ClassMix plus LOCKER on MochiStaking to ClerkVoting, and FEED_RUNNER on PanelEscalation to the feed
runner and orchestrator. The local admin/deployer retains DEFAULT_ADMIN and governor powers.

The documented production design is a fresh deployer followed by a 2-of-3 multisig controlling an OZ timelock with a
60-second default delay; deployment and launch tooling accepts only 0–3600 seconds. The timelock is intended to hold DEFAULT_ADMIN/GOVERNOR on the governed contracts. The deployed
operations identities are expected to be separate: attestor, feed runner, orchestrator/anchorer, Anonyma signer,
juror operators, and evaluator accounts. The repository script accepts one key file and reuses it for its operational
identities; this is a local/test convenience and must not be treated as production key separation. Confirm the actual
role handover and multisig ownership in the production deployment ceremony.

| Role / identity | Intended holders | Capabilities and fund impact |
|---|---|---|
| DEFAULT_ADMIN_ROLE | Timelock after production handover | Grant/revoke roles; can ultimately appoint every privileged operator. |
| GOVERNOR_ROLE | Timelock; ClerkVoting on SchemaRegistry and ClassMix | QueryEscrow governor sets class prices, protocol fee, panel reserve, TTL, and contract addresses; can redirect payments by replacing trusted modules. Feeds governor registers feeds/origins/crosschecks and changes subscription treasury. JurorRegistry governor changes allowed measurements, class mix, minimum bond, and slash sink. Panel governor changes minimum stake, panel fee, timing, and can withdraw unreserved USDG. |
| GUARDIAN_ROLE | Emergency guardian, specified as separate operational role | QueryEscrow pause blocks new opens; unpause resumes opens. Existing payouts/settlement remain enabled. Local script initially gives this role to deployer. |
| FEED_RUNNER_ROLE | Feed runner and orchestrator | Opens/expands budgeted FEED queries; authorized to escalate feed cases. `Feeds.update` is permissionless, but validates eligibility and crosschecks. |
| ATTESTOR_ROLE | Attestation service | Refreshes key attestations and can apply 5% attestation-failure slashes. Must only report cryptographic failures, as noted in review log. |
| SLASHER_ROLE | MochiVerdicts | Records service/timeout data and slashes for verified equivocation. |
| LOCKER_ROLE | ClerkVoting | Locks voting stake through the proposal's end time. It cannot transfer stake. |
| Anonyma signer | Voucher signing service | Signs vouchers that spend Anonyma's prefunded USDG float, bound to one queryId (`computeQueryId(opener, docCommit, nonce)`), schema, N, expiry and max amount. |
| Intake / consensus keys | Attested service keys in JurorRegistry | Intake provenance signatures gate opens; consensus signatures authorize verdict posts. Registry governor controls allowed measurements and service-key registration. |
| Juror operators / juror keys | Bonding operators and enrolled enclave signing keys | Operators receive earned USDG; juror keys sign answers; bonds can be slashed and withdrawn after exit delay. |
| Evaluators / panel | Stake-bearing evaluator addresses | Selected evaluators commit/reveal outcomes; panel fees and slash pool are distributed by PanelEscalation. |
| Feed subscribers | Consumer contracts | Pay USDG to the configured treasury for gated contract reads. EOAs and `eth_call` reads remain free. |

## Trust assumptions and boundaries

- Random selection assumes the configured randomness source is unbiased enough for the selection window. The local
  harness uses `BlockhashRandomness`; `DrandRandomness` verifies quicknet-style BLS signatures through Prague
  EIP-2537 precompiles. The spec still identifies sequencer timestamp/blockhash bias as residual risk for the
  blockhash source and timestamp backdating/lookahead assumptions for drand.
- Intake TLS origin allowlists, document fetch/OCR, quote token counts, and provenance statements are trusted only
  through the intake TEE key and its attestation. Consensus correctness and private-result encryption depend on the
  consensus enclave and its attested key. Juror answers depend on the enrolled TEE measurements and operator service.
- The off-chain attestor must bind current quotes to the measurement registered on-chain. TEE vendor roots, quote
  freshness, revocation collateral, enclave image reproducibility, and key custody are audit dependencies outside
  Solidity alone.
- Feed correctness additionally trusts the feed runner's source discovery/fetch process, origin allowlist, public
  fetched-query restriction, schema-specific payload decoding, and any configured crosscheck implementation.
- USDG is assumed to be a correctly behaving 6-decimal ERC-20. The code uses SafeERC20, but does not defend against
  an issuer freeze, blacklist, rebasing, fee-on-transfer behavior, or malicious governance replacement of the token
  integrations.
- Timestamps are chain timestamps. Cooldowns, expiry, proposal periods, appeal windows, and subscription expiry
  inherit sequencer/miner timestamp behavior and chain reorg/finality assumptions.
- Private document bytes, raw text, spans, and private field values are out of contract scope; contracts should see
  hashes and ciphertext only. Review event payloads and revert data for the same privacy boundary.

## Invariant coverage

Implemented in `test/invariant/StakeInvariant.t.sol`: stateful stake/request-unstake/withdraw, reward notification and
claim, and vote-lock sequences. It asserts `totalStaked == Σ stakeOf`, paid plus accrued/streaming/unallocated rewards
do not exceed notifications, and locked stake cannot be unstaked before expiry for the handler's four actors.
`test/invariant/EscrowInvariant.t.sol` drives the whole QueryEscrow lifecycle on all four pay paths: USDG, Anonyma
voucher (bound to the queryId), shielded (mock pool) and feed-budget opens; seal and reseal; VERDICT and HUNG posts
with random timeout masks through MochiVerdicts, also after the query deadline while nobody has expired the round;
USDG, shielded, voucher and feed expansions, and expansions refused after the deadline; expiry; operator claims; float
and budget funding; juror attestation lapses and restores (one key or a whole class); and time and block warps, mostly
short with one call in eight jumping up to two hours. Each action checks its own money movement exactly (an open or
expansion moves exactly the quote; a post pays exactly the answering seats' fees, releases exactly the round's escrow
and stamps `lastServedAt`; an expiry refunds exactly the round's escrow to the path's refund target; a claim pays
exactly what was owed). Every seal is checked seat by seat against `test/utils/SelectionModel.sol`, a reference model
written from the `selectJurors` spec, which also predicts each `NoEligibleJuror` revert (a lapsed class) that the
handler then asserts; expansion and reseal must leave a fresh pool snapshot. The invariants assert that the escrow
balance equals Anonyma's float plus the feed budget plus all claimable fees plus the current-round escrow of every
OPEN or SEALED query, that each query's status and `paid` match the handler's ghost state (no transition behind its
back), that seat counts match the round, and that every posted verdict ID is unique and stored.
`test_randomWalkCoverage` replays a fixed pseudo-random action mix (16 runs × depth 64) and asserts minimum effective
rates (at least half of post calls and a sixth of expand calls do something, at least one `NoEligibleJuror` seal and
one late post); it also measures the earlier uniform two-hour warps, which posted 32 of 66 and expanded 11 of 89
against 41 of 66 and 18 of 89.
`test/invariant/JurorRegistryInvariant.t.sol` runs the same handler in bonded (permissionless) and zero-bond
(governor-approved) mode, from 15 live keys and, behind LARGE_A's, 24 keys that joined and lapsed: enrollment,
attestation and its lapse (one key or a whole class), the attestation-failure, equivocation and timeout slashes,
service records, exits and withdrawals (including withdrawals attempted before the hold ends), zero-bond approval and
revocation, governor delisting, pruning, measurement changes, time, and snapshot selection. It asserts that the
registry's MOCHI equals the sum of bonds, which equals deposits minus withdrawals minus slashes, and that the sink
holds exactly the slashes; that no bond exceeds its deposit and only a governance delisting leaves a delisted key with
a bond; that every pool has only its class's JUROR keys with no duplicates and `inPool` set exactly for the keys an
attestation refresh left active and no prune dropped since (so an unattested key is in no pool); that exited or
delisted keys are never active; and that the pools a snapshot names never change. Its selection action checks every
seat, or the exact `NoEligibleJuror` revert, against `SelectionModel`; that enrollment, joining and pruning after the
seed change nothing; and that one key exiting after the seed changes only what the model says and never gives its
operator more seats. Prune predicts the keys it drops and asserts `NothingToPrune` when there are none. Expected
reverts are predicted and asserted inside the handlers, so any other handler revert fails the campaign; each suite has
a scripted test that reaches every action and both outcomes of selection. A mutation that restores the old 16-draw
count-based fallback fails every JurorRegistry campaign within the default 128 runs.

Invariant runs and depth come from `contracts/foundry.toml`: the default profile is 128 runs × depth 64, and the `deep`
profile (`FOUNDRY_PROFILE=deep forge test --match-test '^invariant_'`) is 1,600 runs × depth 64. Suites under
`test/invariant` no longer cap runs inline. On 2026-10-02 every invariant passed at the deep profile (27 properties:
102,400 calls each with zero reverts; 207 s wall-clock, 1,139 s CPU, of which each JurorRegistry bond mode took about
410 s). `test/panel/PanelEscalationInvariant.t.sol` no
longer caps runs inline either; its seven properties (now including fixed eligibility of pending draws, seed-fixed
seated panels, and void panels slashing nobody, with dead positions, held draws and abstentions in the handler) passed
at the deep profile on 2026-10-02 (102,400 calls each, zero reverts).

`test/invariant/ClerkVotingSnapshotPoC.t.sol` is now a regression suite for the ClerkVoting live-stake versus
proposal-snapshot issue (late or same-timestamp stake has no weight; stake moved after the snapshot gives the
recipient no weight), and `test/invariant/ClerkVotingSnapshotInvariant.t.sol` asserts that proposal votes never exceed
the snapshot. The finding itself is tracked privately pending launch.

The following requested stateful invariants are **not yet implemented as invariant-handler properties** and remain
external-audit/test gaps. Existing unit and integration coverage exercises portions of these flows, but is not a
substitute for stateful invariants:

- Feeds monotonic `asOf` and eligibility across generated sequences.
- PanelEscalation at-most-once case resolution (`test/panel/PanelEscalationInvariant.t.sol` covers stake, fee and
  reserve accounting).
- ClerkVoting vote sum and at-most-once execution across generated proposals.
- Drand beacon acceptance, ticket derivation, and precompile failure behavior.

## Existing tests and checks

The test tree contains unit suites for escrow/staking, registry/token/randomness/schema, governance/class mix and clerk
voting, verdicts/feeds/crosschecks/feed reader, panel escalation, and integration/full-stack flows. The repository
review log records 104 contract tests green before this audit-prep work. On 2026-10-02 `forge test` passed 340 tests
across 57 suites with none skipped, including 27 invariants (three staking, four staking reward-accounting, three
staking probe, two ClerkVoting snapshot, two escrow lifecycle, six JurorRegistry (three per bond mode) and seven
PanelEscalation properties).

## Known limitations and exclusions

- This is pre-audit preparation, not an independent audit or deployment approval. Review findings are tracked
  privately pending launch; this document does not claim that any of them is resolved.
- `forge coverage --ir-minimum` did not produce usable coverage because of the compiler failure above.
- Slither Low/Informational and Aderyn Low findings are reported in CI but not gated.
- Off-chain TypeScript services, database schemas, frontend/SDK behavior, legal/compliance questions, production key
  custody, TEE vendor infrastructure, and live-chain operational procedures are outside this Solidity test scope.
- Production deployment/handover, real USDG behavior, actual RHC sequencer semantics, and drand precompiles on the
  target chain require environment-specific verification.

## Ten areas for the auditor to prioritize

1. QueryEscrow's near-limit 24,274-byte runtime, settlement waterfall, per-ticket juror-pool snapshots (open,
   expansion, reseal; `openSelection` is each transaction's last call), and per-path liability accounting (only 302
   bytes remain under EIP-170).
2. ClerkVoting proposal snapshot semantics, stake locks across overlapping proposals, quorum math, and execution
   against mutable governance targets.
3. Role handover: DEFAULT_ADMIN/GOVERNOR/guardian separation, timelock ownership, ClerkVoting grants, and the actual
   production deployment script/ceremony.
4. MochiVerdicts signature domains, answer/vote ordering, timeout masks, status threshold boundary math, and
   equivocation evidence verification.
5. JurorRegistry enrollment proof-of-possession, attestation refresh/slashing authority, timeout counters, bond
   withdrawals and the post-service hold, selection snapshots, rehash selection with a 128-draw budget and no
   fallback, pool entry on attestation, pool pruning (exits, delisting, lapses past the grace, revoked approvals) and
   governor delisting. `prunePool` is linear in the pool size (cold, about 35k gas per kept key and 17k per dropped
   key), so a class pool of more than about 900 keys cannot be pruned in one 32M-gas block; bonded mode needs an
   incremental prune before it reaches that scale.
6. PanelEscalation commit/reveal deadlines, reseal, appeals, slash attribution, fee and reserve conservation, and
   handling of zero-reveal/no-majority panels.
7. MochiStaking reward accumulator precision/remainder behavior, just-in-time staking around notifications, and vote
   lock enforcement under simultaneous governance proposals.
8. Feeds eligibility and same-`asOf` replacement semantics, payload decoding, crosscheck failure behavior, and
   subscription/treasury accounting.
9. DrandRandomness hash-to-curve encoding, EIP-2537 precompile assumptions, duplicate beacon handling, and
   ticket/round timing under sequencer manipulation.
10. Cross-contract external calls and mutable address wiring: reentrancy, malicious/replaced token or adapter,
    fee-on-transfer assumptions, and atomic rollback when downstream settlement or governance execution fails.

Active runtime restart permits expired attestations only when operator, measurement, role, class, exit/delisting, measurement approval and configured/on-chain bond or exact zero-bond team approval checks pass. The attestor checks immediately and retries failed checks after 15 seconds; valid quote verification and chain refresh remain required. Prepare/enroll still require paused escrow. This does not change the separate panel, voting, withdrawal or schema windows documented in `docs/WAIT-WINDOWS.md`.
