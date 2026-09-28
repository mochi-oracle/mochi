# Confidential three-juror execution rehearsal

This bounded service connects the existing `IntakeEnclave`, three `JurorEnclave` instances and `ConsensusEnclave` in one Phala CVM. A client verifies all five attested identities, encrypts one fixed synthetic evidence document to intake, and supplies an ephemeral result key. Intake verifies peers and re-encrypts the document; jurors sign their findings and encrypt their answers to consensus; consensus verifies the votes and returns a signed decision encrypted to the client.

The client verifies the signatures, commitments and result before reporting success. The returned public response contains metadata, signatures and ciphertext, not the claim or evidence. Stores are encrypted with each role's enclave key and use temporary storage. The fixed synthetic fixture is intentionally public source code; this is not a private customer-data service.

## What this does and does not establish

A hardware run verifies the composed execution path under a pinned TDX workload measurement. Five separate signing/encryption identities are **co-resident in one CVM**, not independently operated enclaves. The runners return fixed synthetic outputs. Chain reads come from a fixed fixture; there is no RPC, token, registry enrollment, customer payment, swap or settlement. This rehearsal must never be represented as a production review, independent-model quality result or on-chain verdict. Real-model ACI evaluation is a separate existing test.

Only the exact fixture is accepted. The HTTP surface permits three round attempts, one active round, bounded request bodies and thirty attestation requests. It has no document-fetch or production review routes. The server requires `TEE_MODE=dstack`, `TEE_KEYS=ephemeral` and `MOCHI_ROUND_MODE=synthetic-only`. It exits after thirty minutes and has no restart loop. The operator must also stop the VM after the test; process exit alone does not stop VM billing.

## Build, publish and deploy

Run focused tests and the dedicated typecheck before generating the deployment artifact:

```sh
bun test deploy/phala/round-rehearsal
bun x tsc -p deploy/phala/round-rehearsal/tsconfig.json --noEmit
bun scripts/phala-round-rehearsal.ts --build-artifact
```

The builder scans the decoded JavaScript against the repository's identity/credential rules and private local denylist before writing `assets/round-service.br`. Rebuild it after changes to its source or dependencies. Commit the source and artifact together with the repository's neutral author identity, then use the guarded publisher. Do not put credentials in either artifact or compose.

Render a small compose file using the **published full commit SHA** and the compressed artifact's SHA-256 printed by the builder:

```sh
bun scripts/phala-round-rehearsal.ts --revision <40-hex-commit> --sha256 <64-hex-digest> --out /tmp/mochi-round-compose.yml
```

The bootstrap fetches only the immutable public GitHub artifact, rejects redirects and oversized responses, verifies SHA-256 before decompressing or executing, and limits expanded code to 2 MiB. Its URL and expected digest are literal measured compose inputs. This keeps the compose below the existing 190 KiB safety budget; the full inline bundle is too large for that budget. The Bun image, resource limits, read-only filesystem, dropped capabilities and dstack socket are inherited from the earlier intake rehearsal.

Update the existing approved VM with this reviewed compose. Do not create or resize a VM as an implicit side effect. Obtain the exact compose and measured registers through the authenticated Phala control plane, compare the compose to the reviewed artifact and derive the expected measurement independently of the application's advertised quote.

## Verify

```sh
bun deploy/phala/round-rehearsal/verify.ts --base-url https://YOUR-CVM-ENDPOINT --measurement 0x<64-hex-measurement>
```

The CLI requires fresh, pinned Intel DCAP evidence, UpToDate TCB, no advisories and non-debug execution. Unit tests inject a mock verifier explicitly; the CLI has no mock override. Verification failures print a generic error rather than response bodies or decrypted content. Stop the existing VM after the bounded run, retain the safe report and record the code revision, artifact digest and measurement.

Keep the public research and paid checkout configurations disabled until the separate production execution, enrollment, governance, accounting and settlement requirements pass. The team supplies the production token address; this tooling does not create it.
