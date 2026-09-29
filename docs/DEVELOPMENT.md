# Developing Mochi

The model jury: open models in TEEs read the documents tokenized-asset protocols depend on and return one attested
verdict on Robinhood Chain, with the disagreement published. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).
Backend only — no frontend in this repo. No KYB/KYC anywhere: every gate is a TEE attestation or a stake.

## Layout
```
contracts/          Foundry: MochiToken, JurorRegistry, SchemaRegistry, QueryEscrow, MochiVerdicts, Feeds,
                    StockTokenCrosscheck, PanelEscalation, MochiStaking, ReceiptAnchor, BlockhashRandomness
  src/interfaces/   the normative interfaces (NatSpec is the spec)
  src/libraries/    MochiTypes (structs, EIP-712 typehashes, k(N), class mix), MochiRoles
packages/
  core/             TS mirror of MochiTypes: enums, canonical JSON, hashes, EIP-712 types, jury math
  schemas/          the 7 task schemas, normalization, extraction prompt/JSON-schema, payload ABI encoding
  consensus/        the consensus engine (runs in the consensus enclave)
  tee/              TeeProvider/QuoteVerifier interfaces, mock enclave, X25519+AES-GCM envelopes, EIP-712 signing
  protocol/         wire formats between services (zod)
  receipts/         Anonyma-compatible Ed25519 receipts + merkle anchors
  db/               Postgres + Timescale schema, migrations, repositories
  chain/            generated ABIs + typed viem client
  sdk/              TypeScript client (ask, verify receipts, decrypt private results, feeds, disclosures)
services/           intake · juror · consensus (enclave apps) · orchestrator · attestor · gateway · indexer ·
                    feed-runners · anonyma-settle · panel-desk (human-panel keeper + evaluator API/CLI)
scripts/            deploy-local.ts, e2e-core.ts, gen-abis.ts
```

## Run it locally
```bash
bun install
```
```bash
cd contracts && forge test
```
```bash
bun test
```
```bash
anvil
```
```bash
bun scripts/deploy-local.ts
```
```bash
bun scripts/e2e-core.ts
```
Full system (every service as a real process, fake model server, local document origin):
```bash
bun scripts/e2e.ts
```
Randomness defaults to blockhash. For a local Prague/Anvil run with automatically posted drand beacons:
```bash
MOCHI_E2E_RANDOMNESS=drand bun scripts/e2e.ts
```
Deploy directly with `bun scripts/deploy-local.ts --randomness drand`; the default drand configuration is quicknet.
Load targets from spec §7 (200-ticker corp-actions at N=3; earnings p95 at N=7):
```bash
MOCHI_E2E_MODE=load bun scripts/e2e.ts
```
Robinhood Chain testnet (chain 46630). Deployment files and run logs are local outputs; this export does not include a configured live deployment.
The deployer key lives only in `~/.config/mochi/testnet-deployer.json`; fund it from faucet.testnet.chain.robinhood.com.
Short governance delays so the whole path can be exercised:
```bash
bun scripts/deploy-local.ts --rpc https://rpc.testnet.chain.robinhood.com/rpc --key-file ~/.config/mochi/testnet-deployer.json --out deployments/testnet.json --voting-period 120 --execution-delay 60 --timelock-delay 60
MOCHI_DEPLOYMENT=deployments/testnet.json MOCHI_KEY_FILE=$HOME/.config/mochi/testnet-deployer.json bun scripts/e2e-core.ts
MOCHI_DEPLOYMENT=deployments/testnet.json MOCHI_KEY_FILE=~/.config/mochi/testnet-deployer.json bun scripts/register-stock-tokens.ts TSLA=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E AMD=0x71178BAc73cBeb415514eB542a8995b82669778d
MOCHI_DEPLOYMENT=deployments/testnet.json MOCHI_KEY_FILE=~/.config/mochi/testnet-deployer.json bun scripts/governance-demo.ts
```
DB-backed tests expect TimescaleDB at `postgres://mochi:mochi@127.0.0.1:55432/mochi` (published on localhost only; never
expose dev databases to the network). Every service binds `127.0.0.1` unless `HOST` is set (e.g. `HOST=0.0.0.0` inside a container):
```bash
docker run -d --name mochi-pg -e POSTGRES_PASSWORD=mochi -e POSTGRES_USER=mochi -e POSTGRES_DB=mochi -p 127.0.0.1:55432:5432 -v mochi-pg-data:/var/lib/postgresql/data timescale/timescaledb:latest-pg17
```

## Trust model in one paragraph
Intake, juror and consensus services are enclave apps: their signing keys are generated inside the TEE and
registered on-chain only with a proof of possession, and they are active only while the attestor keeps their quotes
fresh. Documents, params and salts travel only inside envelopes sealed to attested keys. Jurors are selected on-chain
from a seed nobody knows when the query is opened. The orchestrator is an untrusted relay: `MochiVerdicts.post`
re-checks seat alignment, every juror signature, the consensus enclave's attestation over all votes, and the k(N)
threshold. Feeds accept only verdicts from feed-runner queries on FETCHED documents from allow-listed origins, and
pass an on-chain crosscheck where one exists.

## What's mocked
See [MOCKS.md](../MOCKS.md).

## Shielded pool payments

Local proof of the whole on-chain path (real Groth16 proofs, run under Node because snarkjs crashes under Bun):
`anvil --host 127.0.0.1 --hardfork prague --port 18999 &`, then
`bun scripts/deploy-local.ts --rpc http://127.0.0.1:18999 --out /tmp/pp.json --shielded privacy-pools` and
`bun scripts/privacy-roundtrip.ts /tmp/pp.json`.

Set `RELAYER_KEY` on the gateway to enable `GET /v1/relayer`, `POST /v1/relay/open-shielded`, and
`POST /v1/relay/expand-shielded`. Without the key, these endpoints return `503`. The SDK's
`pay: { path: "shielded-pool", note, depositInfo }` path reads the relayer address, obtains a query quote, syncs the
pool trees, builds a Groth16 proof, and asks the gateway to relay the open transaction. The SDK returns `changeNote`;
the caller must securely store it to keep the remainder spendable. Relaying obscures the transaction sender from the
payer address, while the proof remains bound to the configured adapter, QueryEscrow, and query ID.

## Running on Intel TDX

Set `TEE_MODE=tdx` for the intake, juror, and consensus services. `TSM_ROOT` selects the Linux configfs TSM report
directory (default `/sys/kernel/config/tsm/report`). Each service obtains its signing and encryption keys from the TDX
guest and reports its address and measurement at startup. Set `QUOTE_VERIFIER=dcap` on services that verify enclave
quotes (including attestor and feed-runners); mock mode remains the default for local development.

DCAP collateral and policy settings are:

| Variable | Default | Purpose |
|---|---|---|
| `TEE_MODE` | `mock` | `mock`, `tdx` (configfs-tsm), or `dstack` (Phala Cloud / dstack CVMs) for intake, juror, consensus |
| `DSTACK_SOCKET` | probes `/var/run/dstack.sock` … | dstack guest-agent socket (`TEE_MODE=dstack`) |
| `TSM_ROOT` | `/sys/kernel/config/tsm/report` | Linux configfs TSM report root |
| `QUOTE_VERIFIER` | `mock` | `mock` or Intel `dcap` quote verification |
| `PCS_BASE_URL` | Intel PCS default | Intel PCS API base URL |
| `PCS_ROOT_CA_CRL_URL` | Intel certificate service default | Root CA CRL URL |
| `TDX_ALLOWED_TCB_STATUSES` | `UpToDate` | Comma-separated accepted Intel TCB statuses; `Revoked` is forbidden |
| `TDX_REJECT_ADVISORIES` | empty | Comma-separated Intel advisory IDs to reject |
| `TDX_ALLOW_DEBUG` | `0` | Set to `1` only to permit debug TDs |

To get the on-chain measurement from inside the new TDX VM, run `bun scripts/tdx-measurement.ts <quote-file>` or pipe a
hex-encoded quote to `bun scripts/tdx-measurement.ts -`. Add `--verify` to fetch Intel PCS collateral and check the
quote. Register the printed `measurement` through the deployment's `JurorRegistry.setMeasurement` governance path. TDX
keys are generated per boot, so register the new service address and measurement again after each VM restart until a
KMS is available.

**Verified on real hardware (Phala Cloud).** `deploy/phala/quote-probe.compose.yml` runs a tiny quote probe in a dstack
CVM (official Bun image pinned by digest; no secrets). `bun scripts/tdx-probe-check.ts <probe URL>` sends fresh report
data (a throwaway key binding + time), verifies the returned quote against Intel's live collateral with the Mochi
verifier, and with `--register-intake <deployment.json>` (plus `MOCHI_KEY_FILE`) allow-lists the measurement. On
dstack, RTMR3 includes instance-specific events, so the measurement identifies one CVM instance.

## OCR for PDFs

Intake rejects PDFs unless OCR is enabled. `docker build -t mochi-ocr:1 ops/ocr` builds the runtime (Debian pinned by
digest, Tesseract + poppler from Debian's signed packages); `PDF_OCR=docker` runs it per document with no network, a
read-only filesystem, all capabilities dropped and capped memory/pids. Pages with a text layer use it; scanned pages
are OCR'd. Inside the intake enclave image use `PDF_OCR=native`. See `ops/ocr/README.md`.
## Jurors on Phala Confidential AI

Jurors can send extraction requests to Phala's GPU TEE endpoint. The juror verifies the gateway's TDX report and the signed response receipt, including the exact request/response body hashes and the provider's verified upstream session, before using a model answer. Routed model answers without a verified confidential session are rejected.

| Variable | Purpose | Default |
|---|---|---|
| `MODEL_PROVIDER` | `openai` or `phala-aci` | `openai` |
| `PHALA_ACI_BASE_URL` | OpenAI-compatible API base URL | `https://inference.phala.com/v1` |
| `PHALA_AI_API_KEY` | Phala API key (secret; never logged) | required for `phala-aci` |
| `PHALA_ACI_MODEL` | Model slug served by this juror process | required for `phala-aci` |
| `PHALA_ACI_ALLOWED_WORKLOADS` | Optional comma-separated attested workload IDs | unset |
| `PCS_BASE_URL` | Intel PCS collateral endpoint for gateway quote verification | Intel default |
| `PCS_ROOT_CA_CRL_URL` | Intel root CA CRL endpoint | Intel default |
| `TDX_ALLOWED_TCB_STATUSES` | Accepted Intel TCB statuses | `UpToDate` |
| `TDX_REJECT_ADVISORIES` | Comma-separated advisory IDs to reject | unset |
| `TDX_ALLOW_DEBUG` | Permit debug TDX VMs | `0` |

Production model assignment by juror class (pinned in `deploy/production/runtime.ts`; selection evidence in
`docs/JURY-MODEL-SELECTION.md`):

| Juror class | Model |
|---|---|
| `LARGE_A` | `openai/gpt-oss-120b` |
| `LARGE_B` | `deepseek/deepseek-v4-flash-0731` |
| `DOC_SPECIALIST` | `google/gemma-4-31b-it` |
| `SMALL_FAST` | `moonshotai/kimi-k2.6` |
| `DISSENTER` | `qwen/qwen3.6-35b-a3b` |
