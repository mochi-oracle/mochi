# Phala hardware intake rehearsal

This is a bounded hardware rehearsal of the existing `TdxTeeProvider`/`DstackQuoteSource` and `IntakeEnclave.intakeUpload` path. It runs a small Bun service from the existing pinned official Bun image without building a Docker image. The service exposes a fresh `/v1/attestation` quote and the existing `/v1/intake/upload` request shape. Upload plaintext is a synthetic fixture; the intake implementation stores its record through `FileSealedStore`, encrypted under the in-enclave key on a temporary filesystem.

Render the compose bundle locally:

```sh
bun scripts/phala-rehearsal.ts
```

This writes `deploy/phala/rehearsal/compose.yml`. The service uses `TEE_MODE=dstack`, ephemeral process keys, and only the dstack socket. It needs no RPC URL, application API key, database, Docker daemon, or container build. The Brotli-compressed code is split across small environment values to stay under per-argument limits. The renderer also enforces a 190 KiB compose budget below Phala’s 200 KiB combined compose/pre-launch-script limit. Review and replace the compose file in the Phala UI as an explicit operator action. It binds port 8080 and will exit after 30 minutes; restart policy is disabled so it will not reset that cap.

The only accepted upload is the exact fixed synthetic fixture and question, at most 8 KiB of `text/plain`; other documents or params are rejected. The process allows at most 10 upload attempts and one at a time. It has no URL fetch, PDF/OCR, dispatch, juror, consensus, chain, or settlement routes. The sealed store lives on container tmpfs and disappears when the service exits. Health reports `hardware_rehearsal`.

Run the local verifier only after deployment, with the expected measurement obtained and pinned by an operator through a separate trusted review of the exact compose revision:

```sh
bun deploy/phala/rehearsal/verify.ts \
  --base-url https://YOUR-CVM-ENDPOINT \
  --measurement 0x<64-hex-measurement>
```

The verifier rejects a measurement mismatch before upload. It checks a fresh TDX quote against Intel PCS collateral using the existing `DcapQuoteVerifier` and `PcsCollateralSource`, requiring `UpToDate`, no advisories, debug disabled, and a matching TEE identity/encryption-key binding. PCS requests are restricted to the official Intel hosts, HTTPS, redirects disabled, 15-second timeout, and 2 MiB per response. It then seals a synthetic `text/plain` upload with the existing protocol AAD and HPKE envelope helper, checks the returned `docCommit`, and recovers the existing EIP-712 Provenance signature under the rehearsal-only chain ID 31337 and zero escrow address.

The rehearsal signature domain is only a local verification aid. It is not a mainnet/testnet receipt, registry enrollment, quote-verifier result on-chain, payment, settlement, or production provenance. An ACI/model execution receipt does not attest the Railway-hosted research flow or the separate confidential document protocol. This narrow upload rehearsal does not prove full protocol readiness or end-to-end TEE attestation.

No CVM is deployed by the render command. Do not point the verifier at a live endpoint until the operator has selected the exact compose revision and its expected measurement. The local verifier may contact Intel PCS for collateral only when explicitly run; no such request is made by the renderer.
