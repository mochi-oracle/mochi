// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

// Import deployment artifacts from the vendored, unmodified 0xbow contracts.
import {Entrypoint} from "ppcore/contracts/Entrypoint.sol";
import {PrivacyPoolComplex} from "ppcore/contracts/implementations/PrivacyPoolComplex.sol";
import {WithdrawalVerifier} from "ppcore/contracts/verifiers/WithdrawalVerifier.sol";
import {CommitmentVerifier} from "ppcore/contracts/verifiers/CommitmentVerifier.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
