// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

interface IEscrowInvariantActions {
    function driveSettledQuery(uint8 sizeSeed, bool hung) external;
    function claimOperator(uint8 classSeed, uint8 jurorSeed) external;
}

contract EscrowHandler {
    IEscrowInvariantActions private immutable actions;
    constructor(IEscrowInvariantActions actions_) { actions = actions_; }
    function settle(uint8 sizeSeed, bool hung) external { actions.driveSettledQuery(sizeSeed, hung); }
    function claim(uint8 classSeed, uint8 jurorSeed) external { actions.claimOperator(classSeed, jurorSeed); }
}

contract EscrowInvariantTest is Harness {
    EscrowHandler private handler;
    uint64 private nonce;
    uint256 private createdVerdicts;
    bytes32 private lastVerdictId;
    mapping(bytes32 => bool) private seenVerdictIds;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(IEscrowInvariantActions(address(this)));
        targetContract(address(handler));
    }

    function driveSettledQuery(uint8 sizeSeed, bool hung) external {
        require(msg.sender == address(handler), "handler only");
        uint8[4] memory sizes = [uint8(3), 5, 7, 9];
        uint8 n = sizes[sizeSeed % 4];
        bytes32 doc = keccak256(abi.encode("invariant-doc", ++nonce));
        bytes32 queryId = _open(1, n, doc, false);
        _seal(queryId);
        bytes32[9] memory answers;
        for (uint8 i; i < n; ++i) answers[i] = keccak256(abi.encode("answer", queryId, i));
        MochiTypes.JurorVote[] memory votes = _votes(queryId, answers, 0);
        bytes32 verdictId = _post(queryId, hung ? 2 : 1, hung ? 0 : 10_000, 0, 0, hung ? bytes32(0) : keccak256("payload"), votes);
        require(!seenVerdictIds[verdictId], "duplicate verdict id");
        seenVerdictIds[verdictId] = true;
        lastVerdictId = verdictId;
        ++createdVerdicts;
    }

    function claimOperator(uint8 classSeed, uint8 jurorSeed) external {
        require(msg.sender == address(handler), "handler only");
        address operator = vm.addr(uint256(keccak256(abi.encode("operator", classSeed % 5, jurorSeed % 3))));
        vm.prank(operator);
        escrow.claim();
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 50
    function invariant_escrowBalanceCoversExactRecordedLiabilities() public view {
        uint256 liabilities = escrow.feedBudget() + escrow.anonymaFloat();
        for (uint8 c; c < 5; ++c) {
            for (uint8 j; j < 3; ++j) {
                address operator = vm.addr(uint256(keccak256(abi.encode("operator", c, j))));
                liabilities += escrow.claimable(operator);
            }
        }
        assertEq(usdg.balanceOf(address(escrow)), liabilities);
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 50
    function invariant_verdictIdsAreUniqueAndStored() public view {
        assertEq(createdVerdicts, nonce);
        if (createdVerdicts != 0) assertTrue(verdicts.getVerdict(lastVerdictId).status != 0);
    }
}
