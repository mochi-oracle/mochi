# Vendored: 0xbow Privacy Pools (UNMODIFIED)

- Source: https://github.com/0xbow-io/privacy-pools-core @ `d494b63e79f33bb2b0c8ece6cdacdca465c3b884`
- Downloaded 2026-09-27 with the owner's approval; every file verified against the git blob SHA in that commit's tree
  (re-verified after moving into `contracts/vendor/`). Do not edit: upgrades = re-vendor a new pinned commit.
- Licenses: Apache-2.0 (`LICENSE`, `packages/contracts/LICENSE`); the snarkjs-generated verifiers
  (`WithdrawalVerifier.sol`, `CommitmentVerifier.sol`) carry GPL-3.0 headers.
- Audits (per the upstream repo's `audit/` folder): circuits (Oxorio), contracts (Oxorio, Auditware), entrypoint
  upgrade (Oxorio).
- Trusted setup: `packages/circuits/trusted-setup/final-keys/*` from the upstream ceremony, finalized with the public
  random beacon in `trusted-setup/beacon_hash` / `final_contribution_beacon`.
- Solidity deps (npm, installed with scripts disabled, none declare install scripts): `@openzeppelin/contracts-upgradeable`
  5.0.2, `@zk-kit/lean-imt.sol` 2.0.0, `poseidon-solidity` 0.0.5. Proof generation: `snarkjs` 0.7.6 (GPL-3.0),
  `@zk-kit/lean-imt` 2.2.2, `poseidon-lite` 0.3.0.
- Build note: poseidon-solidity's libraries are compiled with the legacy pipeline (see `foundry.toml`
  `compilation_restrictions`); under via_ir they exceed EIP-170.

| File | Bytes | git blob SHA-1 |
|---|---:|---|
| `LICENSE` | 11,339 | `bde31966218d44d2e5e68cd7101858d29c417c16` |
| `packages/circuits/README.md` | 2,246 | `4fea0d4965cd5e68c3b5514fe0c2ec1c8a49d8bc` |
| `packages/circuits/build/commitment/commitment_js/commitment.wasm` | 2,380,442 | `f3b59f1216156396a41bfb2dce1f1552cf99a1ed` |
| `packages/circuits/build/merkleTree/merkleTree_js/merkleTree.wasm` | 1,861,145 | `371fc9617807d09465cba98fffc799682232a167` |
| `packages/circuits/build/withdraw/withdraw_js/withdraw.wasm` | 2,607,967 | `2b3457f0136681163ff6d875441fb3519ec5b5a6` |
| `packages/circuits/circuits/commitment.circom` | 1,367 | `4ce578154298633e112248a0193a417b0a505788` |
| `packages/circuits/circuits/merkleTree.circom` | 3,263 | `f1bf4c341a85d3e6d1082cd9b6c9e050b95ec7a2` |
| `packages/circuits/circuits/withdraw.circom` | 4,656 | `5b596cb85c08dc9b7f04a7d43dc4abe611236f16` |
| `packages/circuits/trusted-setup/beacon_hash` | 65 | `c465650939ceffa023512f3e195bd42d23a845bc` |
| `packages/circuits/trusted-setup/final-keys/commitment.vkey` | 3,477 | `7747b4c6a14e672a71a4e26263e43c40a73fc838` |
| `packages/circuits/trusted-setup/final-keys/commitment.zkey` | 901,233 | `0f621456056f84bf6456361908d03a1bfc57f09f` |
| `packages/circuits/trusted-setup/final-keys/withdraw.vkey` | 4,208 | `f39a0e6f2696cffb587a718275efc980136168b0` |
| `packages/circuits/trusted-setup/final-keys/withdraw.zkey` | 17,793,015 | `5c64ced16184db030e836f41423a983235137f3f` |
| `packages/circuits/trusted-setup/final_contribution_beacon` | 9 | `1bcbe51761bf631c660a3daed58a13fc113013da` |
| `packages/contracts/LICENSE` | 11,340 | `ce1159795f1e9aaf69c9f045db8bee9a3bfae6f2` |
| `packages/contracts/foundry.toml` | 854 | `7b3d83e3d594ed8c0794a559709ab496c0bd658c` |
| `packages/contracts/remappings.txt` | 423 | `c9e611ced7b9e3e01efaa94102c42faa6e2c90f4` |
| `packages/contracts/src/contracts/BatchRelayer.sol` | 3,165 | `9c656858ef9dea101df9d803e3322b90a1537fcb` |
| `packages/contracts/src/contracts/Entrypoint.sol` | 15,955 | `9da293de0e4b41b45df9aff3b4122cc5cc741795` |
| `packages/contracts/src/contracts/PrivacyPool.sol` | 7,758 | `21285abe887318e1f548bf1b92f54db9438d137c` |
| `packages/contracts/src/contracts/State.sol` | 7,061 | `6394c9799eed50b2c714b613c457b0edfe41f5e7` |
| `packages/contracts/src/contracts/implementations/PrivacyPoolComplex.sol` | 3,393 | `004d8f89c9b5b4133d3f7eaa93cbfc87ee04ecc8` |
| `packages/contracts/src/contracts/implementations/PrivacyPoolSimple.sol` | 3,074 | `5bd70f836f049ca17836351184451f3b36cd30df` |
| `packages/contracts/src/contracts/lib/Constants.sol` | 313 | `4f8fd07613eabbb471795f1212548fdd68f44dc5` |
| `packages/contracts/src/contracts/lib/DeployLib.sol` | 1,770 | `e9dcd8fe44d135ca53a316cb4644ed4d8fc3cdcf` |
| `packages/contracts/src/contracts/lib/ProofLib.sol` | 6,589 | `288e91eddf6546bc2f364a733d737b573b54e64e` |
| `packages/contracts/src/contracts/verifiers/CommitmentVerifier.sol` | 8,296 | `4d6bb7b1d426d64d623e264a50b5e46947116f37` |
| `packages/contracts/src/contracts/verifiers/WithdrawalVerifier.sol` | 9,851 | `7dd23e290f456c27c93905f5a5fb977af7da8ffe` |
| `packages/contracts/src/interfaces/IBatchRelayer.sol` | 3,523 | `a69e929a1f1a0c868645f4ef485ea130827ade48` |
| `packages/contracts/src/interfaces/IEntrypoint.sol` | 12,722 | `1d91ce10f62e8bf775b05acd33b12ee22ae07f97` |
| `packages/contracts/src/interfaces/IPrivacyPool.sol` | 6,046 | `258d1a0b0942a7860a13bf30ddb9f9a20d5fa0d7` |
| `packages/contracts/src/interfaces/IState.sol` | 5,321 | `c1ea086ed934b83332ed158a3d0ac0a152764b67` |
| `packages/contracts/src/interfaces/IVerifier.sol` | 1,542 | `4f28f6d6a80adf22c395a97c8a7bc13ac70b8b09` |
| `packages/contracts/src/interfaces/external/ICreateX.sol` | 5,977 | `87fbf639bc28bd6e857620564aee89dc832c487f` |
