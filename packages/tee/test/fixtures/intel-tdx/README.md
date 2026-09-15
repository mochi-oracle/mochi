# Intel TDX attestation fixtures (data only)

Downloaded 2026-09-26 over HTTPS with the user's approval. Nothing here is executable.

| File | Source | SHA-256 |
|---|---|---|
| `tdx_quote` | Phala-Network/dcap-qvl `sample/tdx_quote` @ `f8523593059a1bbce81d82590855c5536276737a` (MIT) | `c42f9164325024bca2757bc8819b11879a0a369132ea4e2b7c85df4805ea72db` |
| `tdx_quote_collateral.json` | same repo/commit, `sample/tdx_quote_collateral.json` | `b0a5f5fd620a8881b1eda45261fdf30dd930b49aff93231556645c81fcb4c0bc` |
| `tdx_quote_outdated` | same, `sample/tdx_quote_outdated` | `4c453ea417a7863ed67c215fe4735d91e26f359c760e5984a277866d8d5758e9` |
| `tdx_quote_outdated_collateral.json` | same, `sample/tdx_quote_outdated_collateral.json` | `05e91466e56352166c15a73654147c3d95d6f4ffa62bd150c3c8cbb1d75c3b15` |
| `verify_quote__could_parse_tdx_quote.snap` | same, `tests/snapshots/…` — dcap-qvl's parsed fields for `tdx_quote` (decimal byte arrays) | `e8388127bd775fce0e5615526700c5a21f6381137d8a1c451bc6fd247383aeff` |
| `LICENSE-dcap-qvl` | same, `LICENSE` (MIT notice for the files above) | `f77e71ba8380d395e78485302cc4beccab400b9a01648e2acaf26085fe65bd7f` |
| `Intel_SGX_Provisioning_Certification_RootCA.cer` | https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer (Intel) | `44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3` |

Checks done at download time:
- `tdx_quote` header `04000200 81000000`: quote v4, ECDSA-P256 attestation key, TEE type TDX. `tdx_quote_outdated` is v5.
- The Intel root certificate downloaded from Intel is byte-identical (same SHA-256 fingerprint) to the root embedded in
  all three issuer chains of `tdx_quote_collateral.json`: self-signed `CN=Intel SGX Root CA`, valid 2018-05-21 → 2049-12-31.
- Collateral validity windows (max of issue/thisUpdate, min of nextUpdate across TCB info, QE identity, both CRLs), and
  the "now" used by tests = last second of the window, the same rule dcap-qvl's own tests use:
  - `tdx_quote_collateral.json`: 2025-06-19 10:32:27 → 2025-07-19 10:00:35 UTC, test now = `1752919234`.
    dcap-qvl expects status `UpToDate`, no advisories. TCB info `fmspc=B0C06F000000`.
  - `tdx_quote_outdated_collateral.json`: 2026-02-18 10:58:51 → 2026-03-20 10:41:15 UTC, test now = `1774003274`.
    TCB info `fmspc=90C06F000000`.

Collateral JSON shape (dcap-qvl `QuoteCollateralV3`): `tcb_info` / `qe_identity` are the exact signed JSON texts
(signatures cover those bytes), `*_signature` are raw 64-byte r‖s hex, `root_ca_crl` / `pck_crl` are DER as hex,
`*_issuer_chain` are PEM chains (signing cert, then the Intel root).
