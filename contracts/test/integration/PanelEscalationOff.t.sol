// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "./utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {MochiTimelock} from "@mochi/governance/MochiTimelock.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// Launch wiring from `deploy-local.ts --panel-escalation off`: PanelEscalation is deployed (and MochiVerdicts still
/// points at it) but QueryEscrow.panel is unset and panelReserveBps is 0. Evaluators are staked here on purpose, to show
/// escalation stays impossible even if someone stakes before governance switches the panel on.
contract PanelEscalationOffTest is Harness {
    function setUp() public override {
        super.setUp();
        escrow.setPanel(address(0));
        escrow.setPanelReserveBps(0);
    }

    function _sameVotes(bytes32 qid, bytes32 ans) internal view returns (MochiTypes.JurorVote[] memory votes) {
        bytes32[9] memory a; for (uint256 i; i < 9; ++i) a[i] = ans; return _votes(qid, a, 0);
    }

    function _hungUserQuery(bytes32 doc) internal returns (bytes32 qid) {
        qid = _open(7, 3, doc, false); _seal(qid);
        bytes32[9] memory a; a[0] = keccak256("A"); a[1] = a[0]; a[2] = keccak256("B");
        _post(qid, 2, 6666, 4, 0, 0, _votes(qid, a, 0));
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.HUNG));
    }

    function test_launchWiring() public view {
        assertEq(escrow.panel(), address(0));
        assertEq(escrow.panelReserveBps(), 0);
        assertEq(verdicts.panel(), address(panel));
    }

    /// A paid query settles exactly as with the panel on, except the 25% reserve share joins the protocol remainder.
    function test_verdictSettlesWithoutPanelCut() public {
        bytes32 qid = _open(1, 3, keccak256("off-verdict"), false); _seal(qid);
        uint256 protocol = escrow.getQuery(qid).protocolFee;
        assertGt(protocol, 0);
        uint256 panelBefore = usdg.balanceOf(address(panel));
        uint256 stakingBefore = usdg.balanceOf(address(staking));
        _post(qid, 1, 10000, 0, 0, keccak256("payload"), _sameVotes(qid, keccak256("unanimous")));
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.DECIDED));
        address[] memory seats = escrow.jurorsOf(qid);
        uint256 claims;
        for (uint256 i; i < seats.length; ++i) {
            uint256 seatFee = escrow.seatFeeOf(qid, uint8(i));
            assertEq(escrow.claimable(registry.operatorOf(seats[i])), seatFee);
            claims += seatFee;
        }
        assertEq(usdg.balanceOf(address(panel)), panelBefore, "no reserve share without a panel");
        assertEq(usdg.balanceOf(address(staking)) - stakingBefore, protocol, "whole protocol fee follows the remainder route");
        assertEq(usdg.balanceOf(address(escrow)), claims + escrow.feedBudget() + escrow.anonymaFloat());
    }

    /// The payer cannot escalate a HUNG check: the call reverts inside QueryEscrow and no USDG moves.
    function test_payerEscalationRevertsAndMovesNoFunds() public {
        bytes32 qid = _hungUserQuery(keccak256("off-hung"));
        usdg.mint(address(this), panel.panelFee()); // funded and approved for the panel fee, so only the wiring can refuse
        usdg.approve(address(panel), type(uint256).max);
        uint256 payerBefore = usdg.balanceOf(address(this));
        uint256 panelBefore = usdg.balanceOf(address(panel));
        uint256 escrowBefore = usdg.balanceOf(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, address(panel)));
        panel.escalate(qid);
        assertEq(usdg.balanceOf(address(this)), payerBefore);
        assertEq(usdg.balanceOf(address(panel)), panelBefore);
        assertEq(usdg.balanceOf(address(escrow)), escrowBefore);
        assertEq(panel.escrowedCaseFees(), 0);
        assertEq(uint256(panel.getCase(qid).status), uint256(IPanelEscalation.CaseStatus.NONE));
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.HUNG));
    }

    /// The orchestrator's feed path (HUNG at N9, feed runner escalates) is refused the same way.
    function test_feedEscalationAtN9Reverts() public {
        bytes32 qid = _openFeed(keccak256("off-feed"), 3); _seal(qid);
        bytes32[9] memory a; a[0] = keccak256("A"); a[1] = a[0]; a[2] = keccak256("B");
        _post(qid, 2, 6666, 4, 0, 0, _votes(qid, a, 0));
        for (uint8 n = 5; n <= 9; n += 2) {
            vm.prank(vm.addr(feedRunnerPk)); escrow.expand(qid, n); _seal(qid);
            uint8 support = n - 3;
            bytes32[9] memory b; for (uint8 i; i < support; ++i) b[i] = keccak256(abi.encode("majority", n));
            for (uint8 i = support; i < n; ++i) b[i] = keccak256(abi.encode("minority", n, i));
            _post(qid, 2, uint16(uint256(support) * 10000 / n), uint32((uint256(1) << n) - ((uint256(1) << support) - 1)), 0, 0, _votes(qid, b, 0));
        }
        address runner = vm.addr(feedRunnerPk);
        uint256 runnerBefore = usdg.balanceOf(runner);
        uint256 panelBefore = usdg.balanceOf(address(panel));
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.NotAuthorized.selector, address(panel)));
        vm.prank(runner); panel.escalate(qid);
        assertEq(usdg.balanceOf(runner), runnerBefore);
        assertEq(usdg.balanceOf(address(panel)), panelBefore);
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.HUNG));
    }

    /// Why the reserve must be 0 when the panel is unset: a reserve share would be sent to the zero address.
    function test_reserveWithoutPanelWouldBlockSettlement() public {
        escrow.setPanelReserveBps(2_500);
        bytes32 qid = _open(1, 3, keccak256("reserve-no-panel"), false); _seal(qid);
        MochiTypes.JurorVote[] memory votes = _sameVotes(qid, keccak256("unanimous"));
        (MochiTypes.VerdictInput memory v, bytes memory sig) = _preparePost(qid, 1, 10000, 0, 0, keccak256("payload"), votes);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        verdicts.post(v, votes, sig);
    }

    /// The reviewed switch-on batch (scripts/panel-escalation.ts) restores escalation and the reserve share.
    function test_switchOnBatchRestoresEscalation() public {
        address owner = makeAddr("owner");
        address[] memory controllers = new address[](1); controllers[0] = owner;
        MochiTimelock timelock = new MochiTimelock(60 seconds, controllers, controllers, address(0));
        escrow.grantRole(MochiRoles.GOVERNOR_ROLE, address(timelock));
        address[] memory targets = new address[](2); targets[0] = address(escrow); targets[1] = address(escrow);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] = abi.encodeCall(QueryEscrow.setPanel, (address(panel)));
        payloads[1] = abi.encodeCall(QueryEscrow.setPanelReserveBps, (uint16(2_500)));
        bytes32 salt = keccak256("panel-on");

        vm.prank(owner); timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, 60 seconds);
        vm.expectRevert();
        vm.prank(owner); timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
        vm.warp(block.timestamp + 60 seconds);
        vm.prank(owner); timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertEq(escrow.panel(), address(panel));
        assertEq(escrow.panelReserveBps(), 2_500);

        bytes32 hung = _hungUserQuery(keccak256("on-hung"));
        usdg.mint(address(this), panel.panelFee());
        usdg.approve(address(panel), type(uint256).max);
        uint256 payerBefore = usdg.balanceOf(address(this));
        panel.escalate(hung);
        assertEq(uint256(escrow.getQuery(hung).status), uint256(MochiTypes.QueryStatus.ESCALATED));
        assertEq(payerBefore - usdg.balanceOf(address(this)), panel.panelFee());

        bytes32 qid = _open(1, 3, keccak256("on-verdict"), false); _seal(qid);
        uint256 protocol = escrow.getQuery(qid).protocolFee;
        uint256 panelBefore = usdg.balanceOf(address(panel));
        _post(qid, 1, 10000, 0, 0, keccak256("payload"), _sameVotes(qid, keccak256("unanimous")));
        assertEq(usdg.balanceOf(address(panel)) - panelBefore, protocol * 2_500 / 10_000);
    }
}
