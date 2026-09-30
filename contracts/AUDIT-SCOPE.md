# Mochi contracts: external audit scope

## Scope and build

The production audit should cover the complete `contracts/src` tree, with focused economic and state-machine review of
the eight contracts below. `src/interfaces`, `src/libraries`, `src/governance`, `src/consumer`, `src/examples`, and
`src/mocks` are supporting scope: verify interface assumptions, roles, and integration behavior. Deployment is not
ready for mainnet until the audit findings below are resolved and reviewed.

Compiler configuration from `foundry.toml`: Solidity 0.8.28, EVM `prague`, optimizer enabled with 200 runs, and
`via_ir = true`. Runtime sizes use `forge build --sizes`; nSLOC is the count of nonblank, non-comment-only Solidity
source lines (imports and declarations included). These sizes are for this build configuration.

| Contract | nSLOC | Runtime bytes | EIP-170 margin |
|---|---:|---:|---:|
| QueryEscrow | 507 | 24,085 | 491 |
| MochiVerdicts | 247 | 12,773 | 11,803 |
| JurorRegistry | 206 | 10,195 | 14,381 |
| PanelEscalation | 449 | 17,738 | 6,838 |
| Feeds | 125 | 6,741 | 17,835 |
| MochiStaking | 121 | 4,937 | 19,639 |
| ClerkVoting | 160 | 5,665 | 18,911 |
| DrandRandomness | 91 | 3,314 | 21,262 |

The production dependency for token safety, access control, cryptography, and timelocks is OpenZeppelin Contracts
5.4. Local tests use the checked-in OpenZeppelin source and `forge-std`; no external dependencies are downloaded by
these checks. `Slither` and `Aderyn` are not installed in this workspace.

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
| Anonyma signer | Voucher signing service | Signs vouchers that spend Anonyma's prefunded USDG float, bound to doc commitment, schema, N, expiry and max amount. |
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
`test/invariant/EscrowInvariant.t.sol` drives USDG opens,
seal, VERDICT/HUNG posts, settlement, and operator claims; it asserts exact escrow balance equality against float,
feed-budget, and claimable liabilities, and checks unique/stored verdict IDs. These lifecycle checks were run with
256 runs × depth 50. The repository default is 512 runs × depth 500, which exceeds the requested floor but makes
full-stack lifecycle invariant runs materially longer.

`test/invariant/ClerkVotingSnapshotPoC.t.sol` contains a deliberately skipped, minimized PoC for the known
ClerkVoting live-stake versus proposal-snapshot defect. It is documented in `AUDIT-FINDINGS.md`.

The following requested stateful invariants are **not yet implemented as invariant-handler properties** and remain
external-audit/test gaps. Existing unit and integration coverage exercises portions of these flows, but is not a
substitute for stateful invariants:

- QueryEscrow shielded/voucher/feed pay-path solvency, expansion, expiry, settlement-once and cumulative per-query
  refunds/payout bounds.
- JurorRegistry bond conservation, slash routing, expiry, and selection exclusion.
- Verdict ID uniqueness; Feeds monotonic `asOf` and eligibility across generated sequences.
- PanelEscalation evaluator stake/fee/slash conservation and at-most-once case resolution.
- ClerkVoting vote sum and at-most-once execution across generated proposals.
- Drand beacon acceptance, ticket derivation, and precompile failure behavior.

## Existing tests and checks

The test tree contains unit suites for escrow/staking, registry/token/randomness/schema, governance/class mix and clerk
voting, verdicts/feeds/crosschecks/feed reader, panel escalation, and integration/full-stack flows. The repository
review log records 104 contract tests green before this audit-prep work. The final `forge test -vv` run passed 124
tests across 20 suites, with the one documented ClerkVoting PoC skipped and no failures. The new invariant suites
contributed five passing invariants (three staking and two escrow/verdict properties).

## Known limitations and exclusions

- This is pre-audit preparation, not an independent audit or deployment approval. In particular, the FINDINGS item
  marked High is unresolved in production code.
- `forge coverage --ir-minimum` did not produce usable coverage because of the compiler failure above.
- Slither and Aderyn were unavailable. No network-based scanner or dependency update was attempted.
- Off-chain TypeScript services, database schemas, frontend/SDK behavior, legal/compliance questions, production key
  custody, TEE vendor infrastructure, and live-chain operational procedures are outside this Solidity test scope.
- Production deployment/handover, real USDG behavior, actual RHC sequencer semantics, and drand precompiles on the
  target chain require environment-specific verification.

## Ten areas for the auditor to prioritize

1. QueryEscrow's near-limit 24,085-byte runtime, settlement waterfall, expansion snapshots, and per-path liability
   accounting (only 491 bytes remain under EIP-170).
2. ClerkVoting proposal snapshot semantics, stake locks across overlapping proposals, quorum math, and execution
   against mutable governance targets.
3. Role handover: DEFAULT_ADMIN/GOVERNOR/guardian separation, timelock ownership, ClerkVoting grants, and the actual
   production deployment script/ceremony.
4. MochiVerdicts signature domains, answer/vote ordering, timeout masks, status threshold boundary math, and
   equivocation evidence verification.
5. JurorRegistry enrollment proof-of-possession, attestation refresh/slashing authority, timeout counters, bond
   withdrawals, and class-mix selection under stale/duplicate keys.
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
