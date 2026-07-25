# Notices

Required Notice: Copyright Mochi contributors

Mochi's own source code is licensed under the PolyForm Noncommercial License 1.0.0 (`LICENSE`); documentation and
media under CC BY-NC 4.0 (`LICENSE-docs.md`). For commercial use, open an issue to ask for a commercial license.

## Third-party components

These keep their own licenses; nothing in this repository changes them.

| Component | Where | License |
|---|---|---|
| OpenZeppelin Contracts v5.4 | `contracts/lib/openzeppelin-contracts` | MIT |
| forge-std | `contracts/lib/forge-std` | MIT OR Apache-2.0 |
| 0xbow Privacy Pools core @ `d494b63e` (unmodified) | `contracts/vendor/privacy-pools-core` | Apache-2.0 (see its `LICENSE`) |
| Phala ACI verifier @ `c51c76c0` (ported, modified) | `packages/aci` | Apache-2.0 (`packages/aci/LICENSE-APACHE-2.0`); our changes: PolyForm Noncommercial 1.0.0 |
| Phala dcap-qvl test vectors | `packages/tee/test/fixtures/intel-tdx` | MIT (`LICENSE-dcap-qvl`) |
| Intel SGX/TDX root CA certificate | `packages/tee/src/dcap/intel-root.ts` | Public certificate, pinned for verification |
| npm dependencies | `package.json` | Each package's own license |

`packages/aci` is a TypeScript port of Phala's Apache-2.0 reference verifier: formulas and checks follow the reference;
the code was rewritten for this codebase and extended (DCAP policy, compose-hash replay, workload binding).
