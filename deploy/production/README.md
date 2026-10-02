# Production release planner and activation scaffold

For the Railway switch and rollback, use [WEBSITE-ACTIVATION.md](./WEBSITE-ACTIVATION.md). Local governance rehearsal: `bun scripts/production-activation-rehearsal.ts` starts its own loopback Anvil, runs the paused testnet-style deployment and both full timelock delays using local time advancement, then verifies guardian pause. It uses test tokens and development identities; it does not prove production enrollment, real model quality, payment settlement or external-token deployment.

This package prepares a reviewable production release plan without sending transactions, reading wallet keys, creating MOCHI, or provisioning infrastructure. Run the dry-run against the public input template:

```sh
bun scripts/production-release.ts deploy/production/release-input.example.json
```

It is expected to report incomplete required fields as blockers and still emit a useful staged plan. Copy the input template to a protected review location, fill in real approved public addresses and budget values, and keep all secret values outside the file. The planner rejects wrong chain IDs, zero/malformed addresses, owner/service-signer collisions, unsupported juror class counts, insufficient stated bond, and delays outside 0–3600 seconds or an input delay that differs from the recorded deployment (default 60 seconds). It does not claim that supplied addresses or configuration are valid on chain.

The team must provide the external MOCHI CA. The release deploy command is pinned to chain 4663 and `--mochi-token`; production token creation is not part of this flow. When `deploymentFile` and `identitiesFile` are supplied, the planner uses the existing `buildPhalaBatch` implementation to generate distinct, unsigned configure and activation review payloads offline. It checks deployment/input chain and address consistency; a missing CA remains a blocker and keeps activation readiness false while still allowing payload preparation from a supplied local or production deployment fixture.

For public read-only chain checks, add `--check-rpc`. To also inspect the distinct configure and activation timelock operations, add `--check-timelock`:

```sh
bun scripts/production-release.ts <completed-release-input.json> --check-rpc
bun scripts/production-release.ts <completed-release-input.json> --check-timelock
```

This requires `deploymentFile` and an HTTPS RPC URL. It reads chain ID, contract bytecode, MOCHI/USDG decimals, selected access-control roles, each intake/consensus/juror registration and active status, each juror's bond, the protocol's `QueryEscrow.feedBudget` accounting field, and native balances for required role wallets. It never loads a key or calls a write method. These checks are observations only and do not establish off-chain service health or current TDX evidence. Tests inject a read-only reader interface and the offline fixture test builds both real batch payloads without accessing a network.

`--check-timelock` also requires deployment and reviewed identities files plus the batch salt. It verifies the RPC chain ID is 4663 and matches the deployment before deriving operation IDs with `buildPhalaBatch`, then reads the latest block timestamp and TimelockController `getTimestamp` for each operation. The plan reports `unscheduled`, `pending`, `ready`, `done`, or `read-failed`, with the observed chain and timestamps and a concrete next action. `ready` means only that the on-chain delay elapsed; it never marks phase prerequisites or off-chain activation readiness complete. Configure and activation each use the recorded deployment delay, default 60 seconds. A failed read remains unknown and must be retried. The plan also includes a separate unsigned configure execution payload whose operation ID matches its configure schedule payload.

`role-manifest.json` maps governance, service, and enclave identities to their actual protocol roles. Token distribution recipient and fee treasury are optional bookkeeping decisions: neither is a required input for `deploy-local.ts` when MOCHI is external, and neither is part of the current `phala-batch.ts` role set. Owner and guardian may use the same address for the initial launch. This combines custody risk, but not contract permissions: pause remains immediate, reopening and configuration remain delayed. Configured service signers and the deployer remain separate from the control wallet. The service `.env.example` files mirror the current service config schemas and entrypoints; angle-bracket values are placeholders, not valid configuration. Populate secrets only in the approved encrypted secret store. Production must use DCAP verification, confidential TEE mode, and persistent keys; mock defaults in application config are not production-ready.

The release phases mirror `scripts/phala-batch.ts`: configure while paused, wait the recorded timelock delay (default 60 seconds), execute, enroll and activate all identities and verify services/funding while paused, then schedule the separate activation batch and wait another full delay before execution. Preserve and review calldata, operation IDs, salts and transaction receipts. `buildPhalaBatch` requires nine jurors with class counts 2/2/2/1/2 and distinct enclave keys. New mainnet-style deployments default to `--min-juror-bond 0`: no MOCHI purchase, approval or deposit is required for the team-operated jury. The configure batch approves each exact juror key/operator; an unapproved caller cannot bypass this with a tiny bond. Attestation, class, proof-of-key ownership and delisting checks remain. USDG operating funds and transaction gas are still needed. Future bonded launches can set a positive minimum; positive amounts below the historical 25,000 default require `"bondBelowSpecApproved": true`. Existing deployments with omitted bond metadata retain their legacy 25,000 interpretation.

The deployment command template intentionally has no execution confirmation or key value. Operators must separately verify the exact final config, control-wallet custody, contracts, token metadata, service readiness, health, balances, cost cap, and release evidence before using the existing deployment and timelock tools. Payload generation and RPC checks do not perform these transactions or off-chain checks.

## Testnet dress rehearsal

The same external-token path can run on Robinhood Chain testnet before mainnet. Deploy with `scripts/deploy-local.ts --mainnet --rehearsal --mochi-token <stand-in ERC20> --timelock-delay <seconds from 0 to 3600> --panel-escalation off` on chain 46630; the deployment JSON records `rehearsal: true`, `timelockDelay` and `minJurorBond`. The runtime, launch preparation, enrollment builder, batch builder and planner accept exactly that shape (chain 46630 with `rehearsal: true`) as the only alternative to mainnet 4663, schedule with the recorded delay (default 60 seconds on both chains), and label the plan `REHEARSAL`. Enrollment digests bind the deployment's chain ID, so rehearsal proofs never validate on mainnet. Rules live in `chain-policy.ts`.

Launch deploys with `--panel-escalation off` (required choice with `--mainnet`): PanelEscalation is deployed and keeps its roles, but `QueryEscrow.panel` stays unset and `panelReserveBps` is 0, so escalation reverts before any fee moves and the whole protocol fee follows the remainder route. Launch preparation refuses a deployment that records `on` or records no mode. Switching on later is a reviewed timelock batch built by `scripts/panel-escalation.ts switch-on`; see [docs/PANEL-ESCALATION.md](../../docs/PANEL-ESCALATION.md).

## Existing-CVM runtime

The claims-service compose renderer can also install the production services on the existing Phala CVM. It preserves the claims data volume, mounts the guest dstack socket, and adds a private, persistent Timescale database. Both downloaded artifacts are pinned to a Git commit and SHA-256 digest; runtime archive extraction accepts only known service and migration paths. No database or internal service port is published.

Build the artifacts before publishing the reviewed commit:

```sh
bun scripts/phala-production-runtime.ts --build-artifact
bun scripts/phala-claims-service.ts --build-artifact
```

Render with `scripts/phala-claims-service.ts --revision <published-sha> --sha256 <claims-digest> --out <private-compose-path> --runtime-sha256 <runtime-digest>`. The encrypted deployment environment needs `MOCHI_PRODUCTION_POSTGRES_PASSWORD` and `MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN`, in addition to the existing provider and pilot configuration. Keep their values outside Git and logs. Absent `MOCHI_PRODUCTION_CONFIG_JSON`, the runtime stays in standby: no protocol children, database migrations, signing or chain writes are started. The private database container can still start and persist its own database files.

The public `/production/status` endpoint distinguishes standby from a configured runtime. `/production/identities` returns public keys and fresh TDX evidence for intake, consensus and nine jurors, plus service/receipt public keys. Verify the quotes locally with `scripts/verify-production-identities.ts --url https://<host>/production/identities --measurement <reviewed-pin> --out <new-report>`. After updating or restarting the same CVM, use `--previous <prior-report>` to reject unexpected key rotation. The summary reports each quote's MRCONFIGID version; `--require-config-version 2,3` rejects quotes that do not bind the app ID and key provider; the current CVM's dstack 0.5.9 guest boots only V1/V2 and Phala's VMM would emit V3 with a key provider set, so this CVM stays on V1 and is verified with `--require-config-version 1` plus the `--attestation`/`--app-id`/`--key-provider-id` checks below. With `--attestation <phala cvms attestation --json output from the same boot>` the tool replays the RTMR3 boot events against every DCAP-verified quote, recomputes the MRCONFIGID from the attested app-compose, and with `--app-id`, `--key-provider-id <KMS root CA SubjectPublicKeyInfo hex>` and `--reviewed-compose <rendered compose>` checks the app, the issuing KMS and the compose text. Preserve the CVM app ID and immutable key derivation labels; a replacement application can have a different KMS namespace. These identities share one CVM and are not nine independent operators.

With a reviewed external-token deployment and verified identity report, the launch configuration uses three explicit stages:

1. `prepare`: escrow must be paused. Starts the intake, consensus, nine jurors and gateway, with durable sealed storage. Public paid routes remain closed. GET `/production/enrollment` returns the nine fixed, operator-bound enrollment proofs; caller-selected signing data is never accepted.
2. `enroll`: escrow remains paused; registrations, operator identities, model classes, configured bonds (or team approval for zero-bond mode) and required service roles must match. Starts the attestor so registered identities can become active before unpausing. Paid routes remain closed. A juror key joins its class's selection pool (`JurorRegistry.inPool`, event `PoolJoined`) at the attestor's first refresh that leaves it active, not at enrollment, so the order is: configure batch (approvals) → enrollment → attestor refresh in enroll mode → every juror `isActive` and `inPool` → activation batch. The activation CLI (`scripts/phala-batch.ts … activate`) refuses to schedule until all nine jurors are in their pools.
3. `active`: requires unpaused escrow, matching enrolled identities and required roles. An inactive identity is accepted only when its attestation has expired and every other registry eligibility condition still passes. Starts indexing, orchestration, shielded relay and the privacy postman. The public protocol proxy opens only while all required children are healthy. The website has its separate, explicit activation switch.

### Public write limits and client keys

The public protocol proxy (`public-proxy.ts`) limits uploads and queries per client and in total; each per-client limit is 5–6.25% of the matching global one (numbers in `DEFAULT_PUBLIC_QUOTAS`). It reads at most 1 MiB for an upload and 64 KiB for a query (the gateway's own query cap). An upload body must arrive whole within 12 s before it takes one of 8 intake slots (at most 2 per client). A refused body (408, 413, or 503 while it is still arriving) is answered with `Connection: close`, and the server then gives that socket the shortest idle timeout: Bun would otherwise keep it open for the server's 120 s `idleTimeout` while the caller keeps sending, so it now closes within about 4 s.

A client is, in order: a website visitor named by the website's signed `X-Mochi-Visitor` header; the right-most `X-Forwarded-For` entry, only if the launch config sets `"publicProxy": {"trustForwardedFor": true}`; otherwise the transport peer. The CVM has no hop-count setting: a trusted ingress must append exactly one entry. (The website on Railway keys on the second entry from the right instead; see [WEBSITE-ACTIVATION.md](./WEBSITE-ACTIVATION.md).) The `X-Mochi-Visitor` header is a MAC under a key derived from the visitor secret, which `visitorSecretFromEnv` in `services/claims/src/visitor-key.ts` names (`MOCHI_VISITOR_KEY_SECRET`, a dedicated secret that Railway and the CVM both hold; not the pilot invitation token). The visitor in it is a pseudonym under a random key each website process keeps to itself, so the CVM, which holds the secret, still cannot recover a visitor's address by trying all IPv4 addresses. The CVM does see which requests come from one visitor, until the website restarts. The proxy passes that key to the gateway on its loopback hop as `X-Mochi-Client`, which the gateway honours only from loopback. Callers whose addresses the CVM ingress hides share one client key and one client share of the budget. Anyone holding the secret can mint visitor keys, so the global limits remain the bound.

`GET /production/status` carries a content-free `client` object for the rehearsal: `keySource` (`visitor`, `forwarded`, `peer` or `none`), `keyTag` (a per-process tag: equal for two callers exactly when they share limits), `forwardedFor.entries`, `forwardedFor.last` (the class of the last entry: `absent`, `public`, `private`, `loopback` or `invalid`) and `forwardedFor.lastTag`, `realIpHeader`, `peer` (the class of the transport peer) and `peerTag`, `visitor` (`absent`, `valid`, `invalid`, `expired` or `unconfigured`) and `visitorKeyCheck`. It never shows an address, header value, secret, or anything derived from the secret: an earlier `visitorKeyId` fingerprint let anyone test token guesses offline and is gone. Set `trustForwardedFor` only if the rehearsal shows that the ingress appends the caller's public address to every request.

To confirm that the website and the CVM hold the same visitor secret, run on a trusted machine, with the secret in a protected file:

```sh
bun scripts/visitor-key-check.ts https://<website>/health https://<cvm-host>/production/status < <protected secret file>
```

The script sends each server a fresh `X-Mochi-Key-Check` proof (a MAC of a random nonce under the derived key). Each server answers `client.visitorKeyCheck`: `match` or `mismatch` (`absent`, `invalid`, `unconfigured`, or `rate_limited` after 10 checks per address or 60 in total per hour). The script exits 0 only when both answer `match`. A caller without the secret learns only that one guess was wrong.

A provider workload pin identifies the ACI workload, not a model name. Obtain and verify its current attestation before preparing the launch configuration. The configured model families are GPT-OSS, DeepSeek, Gemma, Kimi and Qwen (one per juror class; see `docs/JURY-MODEL-SELECTION.md`); unavailable provider weight hashes remain explicitly unknown, and the passports make no ZDR claim. Empty fetch-origin configuration permits pasted/uploaded material while URL fetching remains closed until reviewed origins are supplied.

The runtime and unsigned payload tools do not create governance custody, fund service wallets, supply MOCHI bonds, execute timelocks, or prove real mainnet settlement. Those are launch operations with the team's actual token and approved wallets. Keep paid access disabled until the funded production canary and release checks pass.

## Launch handoff files

After deployment, download a fresh public identity report and verify the reviewed measurement. Then prepare the configuration and unsigned release inputs together:

```sh
bun scripts/prepare-production-launch.ts --report <fresh-report.json> --deployment <mainnet.json> --operator <approved-public-operator> --measurement <reviewed-pin> --out-dir <new-directory>
```

This re-verifies the report locally, discovers a nonce-bound/DCAP-verified public ACI workload and pins its attested OS measurement (`os:`) and, when the report carries event-log evidence, its compose hash (`compose:`), creates a fresh batch salt, and emits `production-runtime.json` (prepare mode), `production-identities.json`, `production-release-input.json`, and `website-config.json` (disabled). An explicit reviewed `--workloads <json>` map can replace provider discovery; each value must include at least one `os:` or `compose:` pin, since the report's workload ID is not attested. It never overwrites an output directory, selects governance wallets or submits transactions. Supply the actual feed budget in the release input after funding; `null` deliberately means unconfirmed.

After starting prepare mode, save GET `/production/enrollment` and generate the operator's unsigned transactions:

```sh
bun scripts/prepare-production-enrollment.ts --deployment <mainnet.json> --identities <production-identities.json> --operator <approved-public-operator> --proofs <enrollment-response.json> --out <new-transactions.json>
```

Each possession proof must match the configured key, class, measurement, operator, chain and registry, with a valid juror signature. For zero-bond mode, output contains nine enrollment calls and no token approval. For a positive bond it also contains one approval for exactly nine times the deployment's `minJurorBond`. Review and execute these from the approved operator wallet after the configure timelock has executed. Repeated execution is not a recovery mechanism; check on-chain enrollment and allowance before signing. Then select enroll mode, verify active attestations and pool membership (`inPool`), and continue the separate activation phase described above.

## Re-pinning the Phala ACI gateway after a provider change

Each juror passport's `workload` pins the ACI gateway by its OS measurement, `os:<sha256(MRTD‖RTMR0‖RTMR1‖RTMR2)>`.
That covers the virtual firmware, the VM shape (vCPUs, memory, ACPI tables) and the dstack kernel, initrd and command
line. It also pins the compose hash (`compose:`) when the report carries event-log evidence. SECURITY.md describes
what an `os:`-only pin leaves open. If Phala changes the gateway's OS image, firmware or VM shape, the `os:` value
changes and **every juror seat refuses the gateway** until it is re-pinned. MOCHI's own attestations are not affected,
but no juror answers and queries time out or refund.

1. **Recognize it.** Every seat's model calls fail with the cause code `os_measurement`, and warm-up reports
   `warmup_failed` at start. `tcb_status` is a TCB recovery (next section). `dcap_failed` means the gateway quote
   itself, or its collateral, failed.
2. **Discover the new pin [LEAD].** Discovery reads only the public attestation report. It sends no API key and runs no
   inference, and it accepts only a nonce-bound, DCAP-verified, `UpToDate` report:

   ```sh
   bun -e 'import { discoverPhalaAciWorkload } from "./scripts/prepare-production-launch.ts"; console.log(await discoverPhalaAciWorkload())'
   ```

   Run it several times. A load balancer can serve several VM shapes, and each distinct `os:` value needs its own pin.
3. **Review it [OWNER].** Attribute the change to a Phala announcement or a published dstack OS image release before
   accepting it. A change that cannot be attributed is a stop: treat it as a possible substitution of the gateway.
4. **Update the reviewed runtime config.** Append each new pin to every passport's `workload`, comma-separated, for
   example `os:<old>,os:<new>`. Keep the old pin until Phala confirms the old shape is retired. The listed `os:` values
   are alternatives: a report that matches any one of them is accepted.
5. **Apply it [GO].** Render the environment with `bun scripts/phala-cvm-env.ts --base <protected base.env> --config
   <updated production-runtime.json> --out <file>` and redeploy that environment with the unchanged compose. Config
   values are not part of the measurement, so the enclave identities and registry state are untouched. The
   attestations ride out a short restart within their validity window.
6. **Verify it.** Each seat logs `warmup_ok`, and a canary query is answered.

## Intel TCB recoveries

All DCAP checks share one Intel TCB policy, `tdxAllowedTcbStatuses` in the runtime config. The protocol services
receive it as `TDX_ALLOWED_TCB_STATUSES`. The claims service applies the same list to the checks it makes itself: the
research pilot's ACI gateway checks and `/production/identities` (`launchTdxAllowedTcbStatuses` in `runtime.ts`). The
website publishes its own copy as `tdxAllowedTcbStatuses` in `/mochi-config.json`, and the browser checks the intake's
quote against it. The policy defaults to `["UpToDate"]`, and `prepare-production-launch.ts` writes that value explicitly
into both `production-runtime.json` and `website-config.json`. When Intel publishes a TCB recovery, platforms that have
not yet been patched are rated `OutOfDate` or `SWHardeningNeeded`. Every attestor check then reports
`tcb status OutOfDate`, which is not slashable, so the attestations lapse within 1200 s. Jurors refuse the gateway with
`tcb_status`, the research pilot's jurors fail with `ACI_TCB_STATUS`, `/production/identities` answers 503, and the
browser refuses the intake ("Intake attestation failed. No document was uploaded."). The collateral cache picks up new
TCB info within a day.

The strict default accepts that outage until Phala patches. The alternative is an owner decision recorded in the launch
evidence, applied to both copies of the list:

1. **Decide [OWNER].** Record the Intel advisory, the statuses to accept and the expected patch date. `Revoked` is
   never accepted, and `UpToDate` must stay in the list.
2. **CVM.** Set `tdxAllowedTcbStatuses` in the reviewed runtime config to, for example,
   `["UpToDate", "SWHardeningNeeded", "OutOfDate"]`, and apply it as in step 5 above. Config values are not part of
   the measurement, so identities and registry state are unchanged.
3. **Website.** Set the same list as `tdxAllowedTcbStatuses` in Railway's `MOCHI_WEB_CONFIG_JSON`. Updating the
   variable restarts the website; it submits no transaction.
4. **Verify.** `/mochi-config.json` shows the list, `/production/identities` answers 200, the attestor's checks pass
   again, and a canary query is answered.
5. **Revert** both copies to `["UpToDate"]` once Phala has patched and PCS rates the platform `UpToDate` again.

While the lists differ, the stricter one decides: a CVM that accepts `OutOfDate` while the website does not still
blocks checkout.

## Environment names are part of the measurement

dstack measures the app definition, including the list of allowed encrypted-environment variable **names** (not their
values). Deploying standby without `MOCHI_PRODUCTION_CONFIG_JSON` and the production modes with it produces two
different measurements, and an intake/consensus key registered under one can never match the other (the registry has no
way to change a registered service key's measurement). Always write the VM environment with
`bun scripts/phala-cvm-env.ts --base <protected base.env> [--config production-runtime.json] --out <file>`, which emits
the same six names in the same order in every mode (an empty config means standby), and read the identity report for
enrollment only from a VM deployed that way. The testnet dress rehearsal found this.

## Restart-stable application measurement

Production dstack quotes explicitly use the `dstack-config-v1` measurement scheme. Phala's `mr-kms` boot event can change between restarts even when the application, key provider and persistent keys are unchanged, making a digest of the entire RTMR3 unsuitable for immutable registry enrollment. See [Phala's MR-CONFIG-ID documentation](https://phala.com/tr/posts/mr-config-id-tutorial).

The new scheme hashes a domain separator, MRTD, RTMR0–2 and the hardware-signed MRCONFIGID. It accepts only the documented nonzero V1/V2/V3 configuration commitment layouts with zero padding. V1 binds the application compose hash; V2 additionally binds the application and key provider identity; V3 (dstack 0.6 VMM and guest) hashes a launch document with the compose hash, app ID, key provider, key provider ID and, unless `no_instance_id`, the instance ID. The whole register is hashed into the pin, so accepting a layout adds no trust. A reviewed configuration pin and the expected enclave public-key binding remain required at enrollment and by protocol peers. This identifies approved software configuration, not an independently operated VM. The legacy full-register scheme remains the default outside the explicit dstack production configuration.

DCAP signature/collateral verification, TCB status, debug-mode rejection, quote freshness and report-data/key binding continue to apply to the full signed quote. Unknown measurement schemes and malformed configuration identifiers are rejected; there is no fallback that accepts an unverified quote. A code, compose or OS change still changes the configuration measurement and needs a separately reviewed release; restart stability does not imply upgrade compatibility for already-enrolled keys.


## Initial launch decision: one control wallet, team-operated jury

Use the owner's address for guardian too (deploy-local defaults guardian to owner if omitted). Do not give that key to a hosted service. The shared key can pause instantly; it cannot directly reopen or bypass the existing two launch timelocks. Losing or compromising it affects both administration and emergency response.

The initial jury uses zero deposits and explicit on-chain approval of each key/operator. This is a permissioned team-operated service, not token-backed insurance or a decentralized operator network. Refunds follow the existing payment contracts; removing deposits creates no new refund or compensation promise. MOCHI's CA is still required by the rest of the configured protocol, and developer fees remain separate.

`setUnbondedJuror(key, operator)` is governor-only; a zero operator revokes that seat's approval, and `prunePool` can then drop the key from its pool (re-approval plus the attestor's next refresh brings it back). `delist(key)` is governor-only and permanent; it slashes nothing (a juror's operator withdraws any bond through the normal exit), and the attestor's refresh batches skip the key. Approval alone never replaces valid attestation, software measurement or enrollment signature checks. Setting a positive minimum disables zero-bond seats; changing to zero requires approvals for any existing seats that should remain eligible. Either switch deactivates every juror of the other mode at once, so in-flight rounds could no longer post their answers or seat new jurors: switch modes only while QueryEscrow is paused and has no OPEN or SEALED query (drained). Existing deployed registry bytecode does not gain this feature automatically: a new deployment and matching runtime are required. Do not use a zero-bond config against an older registry.

Active restarts after an attestation-only outage do not require pause → enroll → unpause. The attestor checks immediately at startup, retries failed checks with exponential backoff and jitter (from about 15 seconds up to the interval, including endpoints still starting), and resumes the normal 600-second refresh interval once checks pass; attestations last 1200 seconds. It re-sends a refresh only for keys whose attestation was not extended in the last 5 minutes. If the outage outlasted the registry's `ATTESTATION_GRACE` (one day), anyone may have pruned the lapsed juror keys from their pools; the attestor's first successful refresh adds them back, with no governance step. Refresh still requires valid quotes and successful chain transactions, so recovery time depends on endpoint and chain availability. Changed operators, roles, classes or measurements, revoked measurement/team approval, exits, delisting and insufficient bonds still abort startup. Prepare and enroll still require a paused escrow. These settings govern new deployments; existing timelock contracts are not changed by a software release. See [WAIT-WINDOWS.md](../../docs/WAIT-WINDOWS.md) for unchanged protocol windows.
