# Panel escalation at launch: off

PanelEscalation has 24-hour commit, reveal and appeal windows and needs at least three drawable evaluators to draw a
panel. At launch there are no evaluators, so an escalated query could never be drawn (`NotEnoughEvaluators`): after the
1-day draw deadline its panel fee is refunded, but the query stays `ESCALATED` with no verdict. Launch therefore makes
escalation impossible, and turning it on later is a reviewed governance batch (timelock delay, default 60 seconds), not a
redeploy.

No contract source and no enclave code changed. The enclave's runtime checks only that the PanelEscalation contract has
code and that the feed runner and orchestrator hold `FEED_RUNNER_ROLE` on it. Both still hold.

## Launch wiring (`scripts/deploy-local.ts --panel-escalation off`)

| Item | Off (launch) | On (local fixtures; after switch-on) |
|---|---|---|
| PanelEscalation deployed, roles granted (`FEED_RUNNER_ROLE` for feed runner and orchestrator) | yes | yes |
| `QueryEscrow.panel` | `0x0` (no `setPanel` call) | PanelEscalation |
| `QueryEscrow.panelReserveBps` | `0` (`setPanelReserveBps(0)`) | `2500` (contract default) |
| `MochiVerdicts.panel` | PanelEscalation | PanelEscalation |
| Deployment JSON `panelEscalation` | `"off"` | `"on"` |

- `--mainnet` (including `--rehearsal`) requires an explicit `--panel-escalation off|on`. Local runs default to `on`,
  so the end-to-end panel tests keep working.
- The deploy reads `panel()` and `panelReserveBps()` back and stops if they do not match the chosen mode.

## Why each piece

- **No `QueryEscrow.setPanel`.** `markEscalated` requires `msg.sender == panel`. With a zero panel it reverts with
  `NotAuthorized(PanelEscalation)`, and `PanelEscalation.escalate` reverts atomically, including its panel-fee
  `transferFrom`. No fee moves and the query stays `HUNG` (the HUNG refunds have already been paid).
- **`panelReserveBps = 0`.** VERDICT settlement transfers `protocolFee * panelReserveBps / 10000` to `panel`. A nonzero
  reserve with a zero panel would transfer to the zero address and revert every VERDICT settlement.
- **`MochiVerdicts.setPanel` is kept.** It only authorises PanelEscalation to post a panel outcome, and
  `postPanelOutcome` requires the query to be `ESCALATED` in QueryEscrow, which cannot happen while `QueryEscrow.panel`
  is zero. Keeping it leaves the verdict wiring identical to tested deployments. Switch-on then changes one contract
  (QueryEscrow) instead of two.
- **Orchestrator feed path.** The orchestrator escalates only queries in its `feed_queries` table that are HUNG at N9.
  Only the feed-runners service writes that table, and feed-runners is not among the enclave's runtime services, so the
  path is unreachable at launch. A funded feed budget alone would not open it: `fundFeedBudget` is permissionless.
  If the path is ever enabled while escalation is off, the orchestrator reads `QueryEscrow.panel()` first and, while it
  is zero (or not the deployment's PanelEscalation), sends nothing: no `approve`, no `escalate`, one content-free
  `orchestrator.panel_escalation_off` log, and a 15-minute backoff before it reads the wiring again. It approves the
  panel fee only when the existing allowance does not cover it. Keep feed-runners out of the runtime until escalation
  is on all the same.

## Where the 0.5 cent goes

On a $0.10 check the protocol fee is 0.020 USDG. With the panel on, 0.005 (25%) would go to the panel reserve and
0.015 to the remainder route. With the panel off, **the whole 0.020 follows the remainder route**:

- to `reviewProtocolRecipient` when governance has set one;
- otherwise (the deployed default) to `MochiStaking.notifyReward`, streamed to MOCHI stakers over up to 7 days. While nobody
  stakes, it accumulates as `undistributed` and is carried into the next stream; it is not lost.

Juror fees, timeout refunds, HUNG refunds and expiry refunds are unchanged.

One policy consequence for the owner: with the panel on, the 25% reserve sat in PanelEscalation, where governance can
move it with `withdrawReserve`. MochiStaking has no admin withdrawal. With the panel off, governance captures no protocol
fee unless it sets `reviewProtocolRecipient` (a QueryEscrow governor call through the timelock).

## Verification (panel-off is the expected verified state)

- `bun scripts/verify-ownership.ts <deployment.json>` adds a `QueryEscrow | panel escalation` row and fails on a
  mismatch with the recorded mode.
- `bun scripts/panel-escalation.ts inspect <deployment.json> [--rpc …]` is a read-only report: observed wiring, recorded
  mode, the panel's bindings (`MochiVerdicts.panel()` and PanelEscalation's fixed `escrow`, `verdicts`, `usdg` and
  `randomness`, each compared with the deployment's contracts), and the evaluator pool (active, drawable, pool size).
  It exits 1 on any mismatch.
- `verify-ownership.ts` also has a `PanelEscalation | bindings` row with the same binding check.
- `bun scripts/prepare-production-launch.ts …` refuses a deployment that records `on` or records no mode, carries
  `panelEscalation` into the runtime deployment, and writes website `jurySizes: [3]`. To re-prepare after a governed
  switch-on, pass `--allow-panel-escalation-on`.
- `bun scripts/production-release.ts <input> --check-rpc` always runs a `panel-escalation` preflight check against the
  chain. A deployment with no recorded mode is held to `off`, because older deployments were wired on.
- `verify-ownership.ts` cannot know the intent of an unrecorded deployment, so for those it checks only the
  settlement-blocking combination (a reserve with no panel).
- The deploy retries the read-back a few times, so a lagging load-balanced RPC node cannot abort it mid-way.

## Switching on later (governance, not a redeploy)

Do this only when at least six evaluators are drawable and the owner has decided the panel windows and the customer
escalation policy (see `WAIT-WINDOWS.md`). Once escalation is on, every historic HUNG query that is public or allowed
panel disclosure becomes escalatable by its payer, with no time limit.

```
RPC_URL="$RPC" bun scripts/panel-escalation.ts switch-on "$OUT/deployment.json" schedule --salt <0x + 64 hex, keep it> > panel-on-schedule.json
RPC_URL="$RPC" bun scripts/panel-escalation.ts switch-on "$OUT/deployment.json" execute  --salt <same salt>           > panel-on-execute.json
bun scripts/owner-console.ts --deployment "$OUT/deployment.json" --batch panel-on-schedule.json --batch panel-on-execute.json --expect-from <owner>
RPC_URL="$RPC" bun scripts/panel-escalation.ts record-on "$OUT/deployment.json"   # after the execute is confirmed
```

The batch is two calls on QueryEscrow, `setPanel(PanelEscalation)` and `setPanelReserveBps(2500)`, scheduled with the
deployment's recorded timelock delay. `switch-on` reads the chain and refuses while fewer than six evaluators are
drawable (`isDrawable`: active and past the warm-up; a panel needs three and an appeal three more outside it), and on
any binding mismatch (`MochiVerdicts.panel()` is not PanelEscalation, or PanelEscalation's `escrow`, `verdicts`, `usdg`
or `randomness` is not the deployment's contract). It only builds and prints the batch; the owner signs schedule
and then execute in the owner console. Until `record-on` runs, `inspect`, `verify-ownership.ts` and the release
preflight report a mismatch, because the file still records `off`. `record-on` first checks that the chain shows the
panel on, then records `"panelEscalation": "on"` plus a `panelSwitchedOn` entry in the deployment file.

## Evaluator pool and draw rules (panel audit and review fixes)

These hold once the panel is on; nothing here changes the launch-off wiring above.

- `stake` must bring an evaluator to at least `minStake`. Active evaluators (no unstake request, not slashed below
  `minStake`, not kicked after a `minStake` increase) form a pool.
- Each seal (`escalate`, `appeal`, `reseal`) takes a seal number and a randomness ticket, freezes the pool length, and
  counts exactly how many evaluators the draw can pick: those active at the seal that became active at least
  `warmupTickets` tickets before it (default 2; keep it at least the randomness lookahead; capped at 64), minus the
  prior panel for an appeal. An exit before the seal excludes an evaluator even in the same ticket; an exit after it
  does not. The warm-up and the expiry below are fixed at the seal, so governance changes do not touch pending draws.
- A draw only reads positions below the frozen length, and a position a pending draw can still pick cannot move,
  be re-activated (a top-up after a kick or slash reverts `DrawPending`) or lose its stake (`withdraw` reverts
  `DrawPending`) until that draw is seated or ends. Nothing done after the seed is public changes who is drawn.
- Positions no pending draw can pick are removed at once (an evaluator that stakes and leaves with no seal in
  between leaves nothing behind), reused by the next join, or pruned by anyone at any time with `prune`; each draw
  that ends prunes up to 12. With no draw pending, no dead position remains.
- Draws are resumable: an ineligible position is skipped by rehashing, a `draw` call tries at most 160 positions
  (about 0.9M gas cold), and a draw that needs more keeps its seed and progress and continues on the next call with
  the same sequence. Dead positions cost gas, never the draw: in the review's worst case (300 positions, 297 dead,
  3 eligible) every draw is seated, in at most 11 calls and 7.7M gas in total.
- Every draw has a deadline (`drawWindow`, default 1 day) and an expiry (`sealTime + unstakeCooldown`, 7 days). After
  the deadline, `expireDraw` continues a draw that can still seat a panel; it ends the draw only if it is impossible
  from the seal (fewer than three eligible), its seed is lost (a blockhash past its window), or the expiry passed,
  even with no seed (a drand beacon nobody posted). No panel is seated after the expiry. Ending a draw refunds the
  panel fee: a first panel becomes `DRAW_EXPIRED` and may be escalated again; an appeal lapses and the first panel's
  majority is finalized, releasing its stake.
- An appeal needs three drawable evaluators outside the first panel, so six in total (switch-on requires six).
- Only a query's payer may escalate it; `FEED_RUNNER_ROLE` may escalate only FEED queries.
- Without a final majority a case ends `FINAL` with zero outcome hashes (a final HUNG). QueryEscrow has no transition
  out of `ESCALATED` other than a posted verdict, so such a query stays `ESCALATED`; recording a terminal HUNG on the
  query needs a QueryEscrow/MochiVerdicts change.
- Reveals of a zero result are refused, and a payout the recipient refuses (a frozen address) becomes a balance the
  recipient can `claim`. A shortfall in the contract's own USDG balance reverts instead.

## Panel desk

- The keeper continues resumable draws (up to 8 calls a tick), ends impossible or expired draws without waiting for a
  beacon, drops finished cases from the set it reads each tick, and prunes kept positions when that removes any.
- Materials include the query's on-chain `openedAt`; pass it to `buildAnswer` (the payload `asOf` for schemas without a
  date field).
- `/payload` keeps a public payload only after the evaluator's on-chain reveal and only if it matches the revealed
  payload hash (`PanelEscalation.revealOf`). Private payloads are refused, and the evaluator CLI does not send them.

## Tests

- `contracts/test/integration/PanelEscalationOff.t.sol`:
  - with the panel unwired and reserve 0, a paid query settles with identical juror credits and no panel cut;
  - payer and feed-runner `escalate` on a HUNG query revert with `NotAuthorized` and move no USDG;
  - a reserve without a panel would block settlement;
  - the timelocked switch-on batch restores escalation and the 25% reserve share.
- `scripts/panel-escalation.test.ts`: option parsing, wiring checks, batch encoding and operation ID, owner-console
  decoding, and evaluator counts from the pool getters.
- `contracts/test/panel/`: the audit proofs of concept (`PanelEscalationAuditPoC.t.sol`), the review's proofs of
  concept as regression tests (`review/`, each failing on the previous contract), the draw and deadline rules and the
  review's smaller fixes (`PanelEscalationReviewFixes.t.sol`), an invariant suite (USDG held = stakes + escrowed fees +
  slashed pool + owed payouts + reserve; no case stuck; draw cost per call bounded; a pending draw's eligible
  positions fixed; seated panels eligible and equal to the panel its seed fixed; no dead position once no draw is
  pending, with sybil bursts, held draws and appeal front-runs in the handler), and a final HUNG against the real
  QueryEscrow (`PanelFinalHungQuery.t.sol`).
- Additions in `scripts/prepare-production-launch.test.ts` and `scripts/production-release.test.ts`.
- `scripts/production-activation-rehearsal.ts` deploys with `--panel-escalation off` and asserts the wiring. After the
  timelocked configure and activate steps, it runs the generated switch-on batch through the deployed timelock: early
  execution reverts, and after the delay the panel is on.
- Deviation from "existing tests unchanged": the launch-prep test fixture now records `panelEscalation: "off"`, because
  launch preparation requires a recorded mode.
