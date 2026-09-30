// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {ClassMix} from "@mochi/ClassMix.sol";
import {IClassMix} from "@mochi/interfaces/IClassMix.sol";

contract JurorRegistryTest is Test {
    MochiToken private token;
    JurorRegistry private registry;
    address private constant ADMIN = address(0xA11CE);
    address private constant OP = address(0xB0B);
    address private constant SINK = address(0x5151);
    bytes32 private constant MEASUREMENT = keccak256("measurement");
    uint256 private constant BOND = 25_000 ether;
    uint64 private constant EXIT_DELAY = 7 days;

    function setUp() public {
        token = new MochiToken(address(this), 10_000_000 ether);
        registry = new JurorRegistry(ADMIN, token, SINK, BOND, EXIT_DELAY);
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, true);
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.INTAKE, true);
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.CONSENSUS, true);
        require(token.transfer(OP, 2_000_000 ether));
        vm.prank(OP);
        token.approve(address(registry), type(uint256).max);
        bytes32 attestorRole = registry.ATTESTOR_ROLE();
        bytes32 slasherRole = registry.SLASHER_ROLE();
        vm.prank(ADMIN);
        registry.grantRole(attestorRole, address(this));
        vm.prank(ADMIN);
        registry.grantRole(slasherRole, address(this));
    }

    mapping(address => uint256) private pkOf;

    /// @dev Juror keys are real secp256k1 keys so they can sign the enrollment proof of possession.
    function _key(uint256 seed) private returns (address key) {
        uint256 pk = uint256(keccak256(abi.encode("juror-key", seed))) % (type(uint128).max) + 1;
        key = vm.addr(pk);
        pkOf[key] = pk;
    }

    function _keySig(address key, MochiTypes.JurorClass class_, bytes32 measurement) private view returns (bytes memory) {
        bytes32 digest = registry.enrollmentDigest(OP, key, measurement, class_);
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pkOf[key], ethHash);
        return abi.encodePacked(r, s_, v);
    }

    function _enroll(address key, MochiTypes.JurorClass class_, uint256 bond) private {
        bytes memory sig = _keySig(key, class_, MEASUREMENT);
        vm.prank(OP);
        registry.enrollJuror(key, MEASUREMENT, class_, bond, sig);
    }

    function _attest(address key) private {
        address[] memory keys = new address[](1);
        keys[0] = key;
        registry.refreshAttestation(keys, uint64(block.timestamp + 30 days));
    }

    function _addClass(MochiTypes.JurorClass class_, uint256 n) private returns (address[] memory keys) {
        keys = new address[](n);
        for (uint256 i; i < n; ++i) {
            address key = _key(uint256(keccak256(abi.encode(class_, i))));
            keys[i] = key;
            _enroll(key, class_, BOND);
            _attest(key);
        }
    }

    function testTeamJurorNeedsExactApprovalEvenWithDustBond() public {
        address key = _key(900);
        vm.prank(ADMIN);
        registry.setMinJurorBond(0);
        bytes memory sig = _keySig(key, MochiTypes.JurorClass.LARGE_A, MEASUREMENT);
        vm.expectRevert(abi.encodeWithSelector(JurorRegistry.UnbondedJurorNotApproved.selector, key, OP));
        vm.prank(OP);
        registry.enrollJuror(key, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, 0, sig);
        vm.expectRevert(abi.encodeWithSelector(JurorRegistry.UnbondedJurorNotApproved.selector, key, OP));
        vm.prank(OP);
        registry.enrollJuror(key, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, 1, sig);
        vm.prank(OP);
        vm.expectRevert();
        registry.setUnbondedJuror(key, OP);
        vm.prank(ADMIN);
        registry.setUnbondedJuror(key, address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(JurorRegistry.UnbondedJurorNotApproved.selector, key, OP));
        vm.prank(OP);
        registry.enrollJuror(key, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, 0, sig);
    }

    function testTeamJurorNoTokenCallsAndRevocation() public {
        address key = _key(901);
        vm.startPrank(ADMIN);
        registry.setMinJurorBond(0);
        registry.setUnbondedJuror(key, OP);
        vm.stopPrank();
        vm.mockCallRevert(address(token), abi.encodeWithSelector(token.transferFrom.selector), hex"dead");
        _enroll(key, MochiTypes.JurorClass.LARGE_A, 0);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        _attest(key);
        assertTrue(registry.isActive(key, MochiTypes.Role.JUROR));
        address[] memory selected = registry.selectJurors(bytes32(uint256(1)), 0, 1, new address[](0));
        assertEq(selected[0], key);
        vm.prank(ADMIN);
        registry.setUnbondedJuror(key, address(0));
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.prank(ADMIN);
        registry.setUnbondedJuror(key, OP);
        vm.prank(ADMIN);
        registry.setMinJurorBond(BOND);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.prank(ADMIN);
        registry.setMinJurorBond(0);
        registry.slashEquivocation(key);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        assertTrue(registry.getJuror(key).delisted);
    }

    function testTeamJurorStillRequiresProofAndAttestationAndHonorsExit() public {
        address key = _key(902);
        vm.startPrank(ADMIN);
        registry.setMinJurorBond(0);
        registry.setUnbondedJuror(key, OP);
        vm.stopPrank();
        vm.expectRevert(IJurorRegistry.BadKeySignature.selector);
        vm.prank(OP);
        registry.enrollJuror(key, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, 0, hex"");
        _enroll(key, MochiTypes.JurorClass.LARGE_A, 0);
        _attest(key);
        registry.reportAttestationFailure(key);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        _attest(key);
        vm.prank(OP);
        registry.requestExit(key);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.prank(OP);
        registry.withdrawBond(key);
        assertTrue(registry.getJuror(key).delisted);
    }

    function testEnrollmentAndMeasurementAccess() public {
        address key = _key(0x1111);
        uint256 beforeBal = token.balanceOf(address(registry));
        _enroll(key, MochiTypes.JurorClass.LARGE_A, BOND);
        assertEq(token.balanceOf(address(registry)), beforeBal + BOND);
        assertEq(registry.operatorOf(key), OP);
        assertEq(registry.jurorsOfClass(MochiTypes.JurorClass.LARGE_A)[0], key);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        _attest(key);
        assertTrue(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, false);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, true);
        assertTrue(registry.isActive(key, MochiTypes.Role.JUROR));
    }

    function testEnrollmentReverts() public {
        address k1 = _key(1);
        address k2 = _key(2);
        bytes32 badMeasurement = bytes32(uint256(7));
        bytes memory sigBadM = _keySig(k1, MochiTypes.JurorClass.LARGE_A, badMeasurement);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.MeasurementNotAllowed.selector, badMeasurement, MochiTypes.Role.JUROR));
        vm.prank(OP);
        registry.enrollJuror(k1, badMeasurement, MochiTypes.JurorClass.LARGE_A, BOND, sigBadM);
        bytes memory sig1 = _keySig(k1, MochiTypes.JurorClass.LARGE_A, MEASUREMENT);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.BondTooLow.selector, BOND - 1, BOND));
        vm.prank(OP);
        registry.enrollJuror(k1, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND - 1, sig1);
        _enroll(k1, MochiTypes.JurorClass.LARGE_A, BOND);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.AlreadyEnrolled.selector, k1));
        vm.prank(OP);
        registry.enrollJuror(k1, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND, sig1);
        // no approval / balance for this caller
        bytes memory sig2 = _keySig(k2, MochiTypes.JurorClass.LARGE_A, MEASUREMENT);
        vm.expectRevert();
        registry.enrollJuror(k2, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND, sig2);
    }

    function testEnrollmentRequiresKeyProofOfPossession() public {
        address victimKey = _key(77);
        // attacker (not the key holder) cannot enroll someone else's enclave key
        bytes memory forged = _keySig(_key(78), MochiTypes.JurorClass.LARGE_A, MEASUREMENT);
        vm.expectRevert(IJurorRegistry.BadKeySignature.selector);
        vm.prank(OP);
        registry.enrollJuror(victimKey, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND, forged);
        // a proof made for one operator does not work for another
        bytes memory sigForOp = _keySig(victimKey, MochiTypes.JurorClass.LARGE_A, MEASUREMENT);
        address other = address(0xE0E0);
        require(token.transfer(other, BOND));
        vm.prank(other);
        token.approve(address(registry), BOND);
        vm.expectRevert(IJurorRegistry.BadKeySignature.selector);
        vm.prank(other);
        registry.enrollJuror(victimKey, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND, sigForOp);
        // class is bound too
        vm.expectRevert(IJurorRegistry.BadKeySignature.selector);
        vm.prank(OP);
        registry.enrollJuror(victimKey, MEASUREMENT, MochiTypes.JurorClass.DISSENTER, BOND, sigForOp);
        // the real proof works
        vm.prank(OP);
        registry.enrollJuror(victimKey, MEASUREMENT, MochiTypes.JurorClass.LARGE_A, BOND, sigForOp);
        assertEq(registry.operatorOf(victimKey), OP);
    }

    function testServiceKeysAndRefreshValidation() public {
        address serviceKey = address(0x2222);
        vm.prank(ADMIN);
        registry.registerServiceKey(serviceKey, OP, MEASUREMENT, MochiTypes.Role.INTAKE);
        assertEq(uint256(registry.getJuror(serviceKey).role), uint256(MochiTypes.Role.INTAKE));
        assertEq(uint256(registry.getJuror(serviceKey).jurorClass), uint256(MochiTypes.JurorClass.LARGE_A));
        _attest(serviceKey);
        assertTrue(registry.isActive(serviceKey, MochiTypes.Role.INTAKE));
        assertFalse(registry.isActive(serviceKey, MochiTypes.Role.CONSENSUS));
        vm.prank(ADMIN);
        vm.expectRevert(IJurorRegistry.InvalidRole.selector);
        registry.registerServiceKey(address(3), OP, MEASUREMENT, MochiTypes.Role.JUROR);
        vm.prank(ADMIN);
        vm.expectRevert();
        registry.registerServiceKey(address(3), OP, bytes32(uint256(8)), MochiTypes.Role.CONSENSUS);
        address[] memory unknown = new address[](1);
        unknown[0] = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NotEnrolled.selector, unknown[0]));
        registry.refreshAttestation(unknown, uint64(block.timestamp + 1));
        vm.prank(ADMIN);
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.INTAKE, false);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.MeasurementNotAllowed.selector, MEASUREMENT, MochiTypes.Role.INTAKE));
        _attest(serviceKey);
    }

    function testExitFlowAndOperatorViews() public {
        address key = _key(0x3333);
        _enroll(key, MochiTypes.JurorClass.LARGE_A, BOND);
        _attest(key);
        vm.prank(address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NotOperator.selector, address(0xCAFE)));
        registry.requestExit(key);
        vm.prank(OP);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.ExitNotRequested.selector, key));
        registry.withdrawBond(key);
        vm.prank(OP);
        registry.requestExit(key);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.prank(OP);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.ExitDelayNotElapsed.selector, uint64(block.timestamp + EXIT_DELAY)));
        registry.withdrawBond(key);
        vm.warp(block.timestamp + EXIT_DELAY);
        uint256 beforeBal = token.balanceOf(OP);
        vm.prank(OP);
        registry.withdrawBond(key);
        assertEq(token.balanceOf(OP), beforeBal + BOND);
        assertTrue(registry.getJuror(key).delisted);
        assertEq(registry.getJuror(key).bond, 0);
        assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NotEnrolled.selector, address(0xDEAD)));
        registry.operatorOf(address(0xDEAD));
    }

    function testAttestationFailureAndEquivocationSlashes() public {
        address key = _key(0x4444);
        _enroll(key, MochiTypes.JurorClass.LARGE_A, BOND);
        _attest(key);
        registry.reportAttestationFailure(key);
        assertEq(registry.getJuror(key).bond, BOND * 95 / 100);
        assertEq(token.balanceOf(SINK), BOND / 20);
        assertEq(registry.getJuror(key).attestedUntil, 0);
        registry.slashEquivocation(key);
        assertEq(registry.getJuror(key).bond, 0);
        assertTrue(registry.getJuror(key).delisted);
        assertEq(token.balanceOf(SINK), BOND);
    }

    function testOnlyAuthorizedSlashingAndGovernorSetters() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.setMinJurorBond(1);
        vm.prank(ADMIN);
        registry.setMinJurorBond(9);
        assertEq(registry.minJurorBond(), 9);
        vm.prank(ADMIN);
        registry.setSlashSink(address(0xD00D));
        assertEq(registry.slashSink(), address(0xD00D));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.reportAttestationFailure(address(1));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.slashEquivocation(address(1));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.recordService(new address[](0), 0);
    }

    function testRecordServiceAndTimeoutSlashingThresholds() public {
        address key = _key(0x5555);
        _enroll(key, MochiTypes.JurorClass.LARGE_A, BOND);
        address[] memory keys = new address[](19);
        for (uint256 i; i < 19; ++i) keys[i] = key;
        registry.recordService(keys, type(uint32).max);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.TimeoutSlashNotAllowed.selector, key));
        registry.slashForTimeouts(key);
        address[] memory one = new address[](1);
        one[0] = key;
        registry.recordService(one, 0);
        // 19 timeouts / 20 served is above the strict five percent threshold.
        // Track time explicitly: under via_ir, block.timestamp reads can be cached within one test call.
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1 days);
        registry.slashForTimeouts(key);
        assertEq(registry.getJuror(key).bond, BOND * 99 / 100);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.TimeoutSlashNotAllowed.selector, key));
        registry.slashForTimeouts(key);
        vm.warp(t0 + 2 days);
        registry.slashForTimeouts(key);
        assertEq(registry.getJuror(key).bond, BOND * 99 / 100 * 99 / 100);

        address exact = _key(0x5566);
        _enroll(exact, MochiTypes.JurorClass.LARGE_A, BOND);
        address[] memory exactKeys = new address[](20);
        for (uint256 i; i < 20; ++i) exactKeys[i] = exact;
        registry.recordService(exactKeys, 1); // Exactly 5% is not slashable.
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.TimeoutSlashNotAllowed.selector, exact));
        registry.slashForTimeouts(exact);
    }

    function testGovernedClassMixChangesSelectedClassPerSeat() public {
        for (uint8 c; c < 5; ++c) _addClass(MochiTypes.JurorClass(c), 1);
        ClassMix mix = new ClassMix(address(this));
        uint8[9] memory customMix = [uint8(4), 0, 1, 2, 3, 3, 4, 0, 2];
        mix.setMix(customMix);
        vm.prank(ADMIN);
        registry.setClassMix(IClassMix(address(mix)));
        address[] memory selected = registry.selectJurors(keccak256("custom-mix"), 0, 5, new address[](0));
        for (uint8 seat; seat < 5; ++seat) {
            assertEq(uint8(registry.getJuror(selected[seat]).jurorClass), customMix[seat]);
        }
    }

    function testSelectionDeterminismClassesDistinctAndExclusion() public {
        address[] memory a = _addClass(MochiTypes.JurorClass.LARGE_A, 2);
        _addClass(MochiTypes.JurorClass.LARGE_B, 2);
        _addClass(MochiTypes.JurorClass.DOC_SPECIALIST, 2);
        _addClass(MochiTypes.JurorClass.SMALL_FAST, 2);
        _addClass(MochiTypes.JurorClass.DISSENTER, 2);
        bytes32 seed_ = keccak256("fixed-seed");
        address[] memory empty = new address[](0);
        address[] memory first = registry.selectJurors(seed_, 0, 9, empty);
        address[] memory again = registry.selectJurors(seed_, 0, 9, empty);
        assertEq(keccak256(abi.encode(first)), keccak256(abi.encode(again)));
        assertNotEq(first[0], first[5]); // two LARGE_A seats use distinct enrolled keys
        for (uint8 seat; seat < 9; ++seat) {
            assertTrue(registry.isActive(first[seat], MochiTypes.Role.JUROR));
            assertEq(uint256(registry.getJuror(first[seat]).jurorClass), uint256(MochiTypes.seatClass(seat)));
            for (uint8 prior; prior < seat; ++prior) assertNotEq(first[seat], first[prior]);
        }
        address[] memory excluded = new address[](1);
        excluded[0] = a[0];
        address[] memory selection = registry.selectJurors(seed_, 0, 3, excluded);
        for (uint256 i; i < selection.length; ++i) assertNotEq(selection[i], a[0]);
    }

    function testSelectionSkipsInactiveAndErrorsOnBadRangeOrShortClass() public {
        address inactive = _key(0x6661);
        address active = _key(0x6662);
        _enroll(inactive, MochiTypes.JurorClass.LARGE_A, BOND);
        _enroll(active, MochiTypes.JurorClass.LARGE_A, BOND);
        _attest(active);
        _addClass(MochiTypes.JurorClass.DOC_SPECIALIST, 1);
        _addClass(MochiTypes.JurorClass.DISSENTER, 1);
        address[] memory none = new address[](0);
        address[] memory picked = registry.selectJurors(bytes32(uint256(4)), 0, 1, none);
        assertEq(picked[0], active);
        vm.expectRevert(JurorRegistry.BadSeatRange.selector);
        registry.selectJurors(bytes32(0), 0, 0, none);
        vm.expectRevert(JurorRegistry.BadSeatRange.selector);
        registry.selectJurors(bytes32(0), 0, 10, none);
        vm.expectRevert(abi.encodeWithSelector(IJurorRegistry.NoEligibleJuror.selector, MochiTypes.JurorClass.LARGE_A));
        address[] memory excluded = new address[](1);
        excluded[0] = active;
        registry.selectJurors(bytes32(0), 0, 1, excluded);
    }

    function testFuzzSelectionsAlwaysActiveDistinctAndCorrectClass(bytes32 seed_, uint8 rawN) public {
        MochiTypes.JurorClass[5] memory classes = [
            MochiTypes.JurorClass.LARGE_A,
            MochiTypes.JurorClass.LARGE_B,
            MochiTypes.JurorClass.DOC_SPECIALIST,
            MochiTypes.JurorClass.SMALL_FAST,
            MochiTypes.JurorClass.DISSENTER
        ];
        for (uint256 c; c < classes.length; ++c) _addClass(classes[c], 2);
        uint8[4] memory allowed = [uint8(3), 5, 7, 9];
        uint8 n = allowed[rawN % 4];
        address[] memory none = new address[](0);
        address[] memory selected = registry.selectJurors(seed_, 0, n, none);
        for (uint8 seat; seat < n; ++seat) {
            assertTrue(registry.isActive(selected[seat], MochiTypes.Role.JUROR));
            assertEq(uint256(registry.getJuror(selected[seat]).jurorClass), uint256(MochiTypes.seatClass(seat)));
            for (uint8 earlier; earlier < seat; ++earlier) assertNotEq(selected[seat], selected[earlier]);
        }
    }
}
