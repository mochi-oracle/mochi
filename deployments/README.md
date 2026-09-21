# Deployments

`deploy-local.ts` uses a test-only MOCHI deployment on anvil and testnet rehearsal. Production mainnet requires `--mochi-token <TEAM_CREATED_ADDRESS>` and uses that external token; the script never creates or mints a production MOCHI token. It checks contract code plus `name()`, `symbol() == MOCHI`, and 18 decimals before sending deployment transactions. Current staking and bond amounts assume 18 decimals, so incompatible tokens are refused. Team ownership is preserved: deployment does not call `transferMetadataAdmin`, and verification does not inspect the external token's supply balance or metadata administrator. Local and testnet rehearsal must use the test-only deployment path.

Mainnet deployments also require an explicit owner, real USDG address, shielded Privacy Pools, drand randomness, a confirmation summary, and `--yes`. The launch escrow is paused before governance handover. No MOCHI supply is minted by the production deployment.

Mainnet deployment JSON adds `deployer`, `owner`, `timelock`, `guardian`, `paused`, `roles`, `stockTokens`, `tokenSource`, `postman`, and `rehearsal` (plus `mochiRecipient` for test-token deployments only). The deployer address is public metadata; no key material is written. `roles` records the configured final role holders. Optional operational roles without an address are assigned to the timelock so they can be granted later through governance. An omitted Anonyma signer remains zero until set by governance. If `--postman` is omitted, the deployment leaves ASP_POSTMAN vacant after the deployer renounces it; supply a dedicated postman address or rotate one in through the owner role later.

`verify-ownership.ts <deployment.json>` checks the known role constants and ownership surfaces against the recorded actors, escrow pause state, and—only for a test-token deployment—the deployer MOCHI balance. External token verification checks metadata and explicitly leaves custody/admin outside its assertions. AccessControl does not expose member enumeration, so the verifier checks the deployer, owner, guardian, timelock, and every account recorded in `roles`. QueryEscrow's existing `unpause()` is guarded by GUARDIAN_ROLE just like `pause()`, so the timelock also receives GUARDIAN_ROLE; owner initiated unpause transactions still pass through its delay.

`owner-timelock.ts` prints wallet-ready TimelockController calldata by default. `schedule` and `execute` use the same deterministic salt for a target call; pass `--salt 0x…` to both commands when scheduling the same call more than once. `--key-file` sends the operation only for a deployment marked as a chain 46630 rehearsal.

## Mainnet command shape

Use an audited USDG address and deployer keyfile, and fill operational addresses from the actual production runbooks. The `--yes` flag is intentionally explicit after reviewing the printed parameter summary.

```sh
bun scripts/deploy-local.ts --mainnet --rpc "$RHC_MAINNET_RPC" --key-file "$MOCHI_DEPLOYER_KEYFILE" --owner "$MOCHI_OWNER_ADDRESS" --usdg "$REAL_USDG_ADDRESS" --mochi-token "$TEAM_MOCHI_TOKEN" --shielded privacy-pools --randomness drand --timelock-delay 86400 --guardian "$MOCHI_GUARDIAN_ADDRESS" --postman "$PRIVACY_POOL_POSTMAN" --attestor "$TEE_ATTESTOR_ADDRESS" --feed-runner "$MOCHI_FEED_RUNNER_ADDRESS" --orchestrator "$MOCHI_ORCHESTRATOR_ADDRESS" --anonyma-signer "$ANONYMA_SIGNER_ADDRESS" --stock-tokens "$STOCK_TOKEN_LIST" --out deployments/mainnet.json --yes
```

For rehearsal only, use chain 46630 with `--rehearsal`, a throwaway test USDG, and a short timelock. MockUSDG is rejected outside that explicitly flagged rehearsal path.
