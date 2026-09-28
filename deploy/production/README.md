# Production release planner and activation scaffold

For the Railway switch and rollback, use [WEBSITE-ACTIVATION.md](./WEBSITE-ACTIVATION.md). Local governance rehearsal: `bun scripts/production-activation-rehearsal.ts` starts its own loopback Anvil, runs the paused testnet-style deployment and both full timelock delays using local time advancement, then verifies guardian pause. It uses test tokens and development identities; it does not prove production enrollment, real model quality, payment settlement or external-token deployment.

This package prepares a reviewable production release plan without sending transactions, reading wallet keys, creating MOCHI, or provisioning infrastructure. Run the dry-run against the public input template:

```sh
bun scripts/production-release.ts deploy/production/release-input.example.json
```

It is expected to report incomplete required fields as blockers and still emit a useful staged plan. Copy the input template to a protected review location, fill in real approved public addresses and budget values, and keep all secret values outside the file. The planner rejects wrong chain IDs, zero/malformed addresses, owner/guardian or owner/service-signer collisions, unsupported juror class counts, insufficient stated bond, and any delay other than 86,400 seconds because the current batch builder schedules at exactly that delay. It does not claim that supplied addresses or configuration are valid on chain.

The team must provide the external MOCHI CA. The release deploy command is pinned to chain 4663 and `--mochi-token`; production token creation is not part of this flow. When `deploymentFile` and `identitiesFile` are supplied, the planner uses the existing `buildPhalaBatch` implementation to generate distinct, unsigned configure and activation review payloads offline. It checks deployment/input chain and address consistency; a missing CA remains a blocker and keeps activation readiness false while still allowing payload preparation from a supplied local or production deployment fixture.

For public read-only chain checks, add `--check-rpc`. To also inspect the distinct configure and activation timelock operations, add `--check-timelock`:

```sh
bun scripts/production-release.ts <completed-release-input.json> --check-rpc
bun scripts/production-release.ts <completed-release-input.json> --check-timelock
```

This requires `deploymentFile` and an HTTPS RPC URL. It reads chain ID, contract bytecode, MOCHI/USDG decimals, selected access-control roles, each intake/consensus/juror registration and active status, each juror's bond, the protocol's `QueryEscrow.feedBudget` accounting field, and native balances for required role wallets. It never loads a key or calls a write method. These checks are observations only and do not establish off-chain service health or current TDX evidence. Tests inject a read-only reader interface and the offline fixture test builds both real batch payloads without accessing a network.

`--check-timelock` also requires deployment and reviewed identities files plus the batch salt. It verifies the RPC chain ID is 4663 and matches the deployment before deriving operation IDs with `buildPhalaBatch`, then reads the latest block timestamp and TimelockController `getTimestamp` for each operation. The plan reports `unscheduled`, `pending`, `ready`, `done`, or `read-failed`, with the observed chain and timestamps and a concrete next action. `ready` means only that the on-chain delay elapsed; it never marks phase prerequisites or off-chain activation readiness complete. Configure and activation retain their separate 86,400-second delays. A failed read remains unknown and must be retried. The plan also includes a separate unsigned configure execution payload whose operation ID matches its configure schedule payload.

`role-manifest.json` maps governance, service, and enclave identities to their actual protocol roles. Token distribution recipient and fee treasury are optional bookkeeping decisions: neither is a required input for `deploy-local.ts` when MOCHI is external, and neither is part of the current `phala-batch.ts` role set. Owner and guardian custody are separated; configured service signer addresses are isolated from owner. The service `.env.example` files mirror the current service config schemas and entrypoints; angle-bracket values are placeholders, not valid configuration. Populate secrets only in the approved encrypted secret store. Production must use DCAP verification, confidential TEE mode, and persistent keys; mock defaults in application config are not production-ready.

The release phases mirror `scripts/phala-batch.ts`: configure while paused, wait the full 86,400-second timelock, execute, enroll and activate all identities and verify services/funding while paused, then schedule the separate activation batch and wait another full delay before execution. Preserve and review calldata, operation IDs, salts and transaction receipts. `buildPhalaBatch` requires nine jurors with class counts 2/2/2/1/2 and distinct enclave keys. Each juror needs at least 25,000 MOCHI, so the launch minimum is 225,000 MOCHI total, in addition to USDG feed budget and transaction gas.

The deployment command template intentionally has no execution confirmation or key value. Operators must separately verify the exact final config, multisig custody, contracts, token metadata, service readiness, health, balances, cost cap, and release evidence before using the existing deployment and timelock tools. Payload generation and RPC checks do not perform these transactions or off-chain checks.
