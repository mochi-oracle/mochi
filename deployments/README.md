# Deployments

`deploy-local.ts` uses a test-only MOCHI deployment on anvil and testnet rehearsal. Production mainnet requires `--mochi-token <TEAM_CREATED_ADDRESS>` and uses that external token; the script never creates or mints a production MOCHI token. It checks contract code plus `name()`, `symbol() == MOCHI`, and 18 decimals before sending deployment transactions. Current staking and bond amounts assume 18 decimals, so incompatible tokens are refused. Team ownership is preserved: deployment does not call `transferMetadataAdmin`, and verification does not inspect the external token's supply balance or metadata administrator. Local and testnet rehearsal must use the test-only deployment path.

Mainnet deployments also require an explicit owner, real USDG address, shielded Privacy Pools, drand randomness, a confirmation summary, and `--yes`. The launch escrow is paused before governance handover. No MOCHI supply is minted by the production deployment.

Mainnet deployment JSON adds `deployer`, `owner`, `timelock`, `guardian`, `paused`, `roles`, `stockTokens`, `tokenSource`, `postman`, and `rehearsal` (plus `mochiRecipient` for test-token deployments only). The deployer address is public metadata; no key material is written. `roles` records the configured final role holders. Optional operational roles without an address are assigned to the timelock so they can be granted later through governance. An omitted Anonyma signer remains zero until set by governance. If `--postman` is omitted, the deployment leaves ASP_POSTMAN vacant after the deployer renounces it; supply a dedicated postman address or rotate one in through the owner role later.

`verify-ownership.ts <deployment.json>` checks the known role constants and ownership surfaces against the recorded actors, escrow pause state, and—only for a test-token deployment—the deployer MOCHI balance. External token verification checks metadata and explicitly leaves custody/admin outside its assertions. AccessControl does not expose member enumeration, so the verifier checks the deployer, owner, guardian, timelock, and every account recorded in `roles`. QueryEscrow's `pause()` needs GUARDIAN_ROLE (the guardian pauses instantly), while `unpause()` needs GOVERNOR_ROLE, which only the timelock holds, so reopening always passes through the timelock delay. The timelock also receives GUARDIAN_ROLE so governance can pause.

`owner-timelock.ts` prints wallet-ready TimelockController calldata by default. `schedule` and `execute` use the same deterministic salt for a target call; pass `--salt 0x…` to both commands when scheduling the same call more than once. `--key-file` sends the operation only for a deployment marked as a chain 46630 rehearsal.

## Mainnet command shape

Use an audited USDG address and deployer keyfile, and fill operational addresses from the actual production runbooks. The `--yes` flag is intentionally explicit after reviewing the printed parameter summary, step plan and pre-flight. Pass a keyed provider URL through `RPC_URL` (never `--rpc`, which shows in the process list); it is never printed or persisted.

```sh
DEPLOY=(bun scripts/deploy-local.ts --mainnet --key-file "$MOCHI_DEPLOYER_KEYFILE" --owner "$MOCHI_OWNER_ADDRESS" --usdg "$REAL_USDG_ADDRESS" --mochi-token "$TEAM_MOCHI_TOKEN" --shielded privacy-pools --randomness drand --timelock-delay 60 --panel-escalation off --guardian "$MOCHI_GUARDIAN_ADDRESS" --rpc-timeout 60 --receipt-timeout 1800 --out "$OUT/deployment.json")
# The rehearsed launch path leaves the operational roles (attestor, feed runner, orchestrator, postman, Anonyma signer) to
# the timelocked configure batch, which grants them to the verified enclave signers. Write the deployment JSON and its
# progress journal to a private directory ($OUT, mode 700) outside the repository.
RPC_URL="$RHC_MAINNET_RPC" "${DEPLOY[@]}"         # review: summary, the ordered step ids, predicted addresses, cost pre-flight; sends nothing
RPC_URL="$RHC_MAINNET_RPC" "${DEPLOY[@]}" --yes   # deploy
```

### Interruptions and `--resume`

Every transaction is one step with a stable id (`deploy.QueryEscrow`, `wire.queryEscrow.setVerdicts`, `handover.panel.renounceRole.GOVERNOR_ROLE.deployer`, …). Each is signed once with an explicit nonce, and its hash is written to `deployments/mainnet.json.progress.json` (mode 600, atomic writes) before it is broadcast. A broadcast that times out is retried with the same signed transaction, and the receipt is awaited for up to `--receipt-timeout` seconds (a stalled sequencer is waited out; nothing is re-signed). Before the first transaction the deployer balance must cover the remaining plan (recorded per-step gas from `scripts/deploy-gas-estimate.json` × current gas price × 2); `--allow-low-balance` overrides only that check.

If a run stops for any reason, do not restart blindly and do not delete the journal:

1. `RPC_URL=… "${DEPLOY[@]}" --resume` checks every recorded step on chain (receipt, sender, nonce, calldata, contract code, role held, parameter value) and the deployer's nonce, prints the plan with each step's state and the next step, and sends nothing.
2. `RPC_URL=… "${DEPLOY[@]}" --resume --yes` continues from the first incomplete step. A recorded transaction that is not mined is re-broadcast unchanged.

`--resume` refuses when the chain contradicts the journal (a recorded transaction missing or different, an address without code, a role or parameter that differs, any deployer transaction the journal does not account for) or when the options, contract artifacts or step order differ from the recorded ones; rerun with exactly the original options. Without `--resume` a run refuses to start while a journal exists, and a new mainnet deployment never starts over an existing `--out` file. A step whose transaction was mined but reverted stops the run; after inspecting it, `--resume --yes --retry-reverted` sends that one step again with the next nonce. The journal holds no key or RPC URL; keep it with the deployment record.

For rehearsal only, use chain 46630 with `--rehearsal`, a throwaway test USDG, and a short timelock. MockUSDG is rejected outside that explicitly flagged rehearsal path.
