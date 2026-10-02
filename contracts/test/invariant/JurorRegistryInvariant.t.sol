// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";

/// @dev Drives a bonded (permissionless) registry: enrollment, attestation, the three slashes, service records, exits
///      and withdrawals, pruning, measurement changes, time, and snapshot selection. It holds ATTESTOR, SLASHER and
///      GOVERNOR. Each action checks its own effect; ghosts track every MOCHI movement.
contract RegistryHandler is Test {
    MochiToken public immutable token;
    JurorRegistry public immutable registry;
    address public immutable sink;
    bytes32 public constant MEASUREMENT = keccak256("juror-measurement");
    uint256 public constant MIN_BOND = 1_000 ether;

    address[3] public operators;
    address[] public keys;
    mapping(address => uint256) public deposited;
    mapping(address => bool) public withdrawn;
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostSlashed;
    uint256 public violations;
    string public lastViolation;
    uint256 private keyNonce;
    uint256 private snapshotNonce;
    mapping(bytes4 => uint256) public calls;

    constructor(MochiToken token_, JurorRegistry registry_, address sink_) {
        token = token_;
        registry = registry_;
        sink = sink_;
        for (uint256 i; i < 3; ++i) {
            operators[i] = makeAddr(string.concat("registry-operator-", vm.toString(i)));
            vm.prank(operators[i]);
            token.approve(address(registry_), type(uint256).max);
        }
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function _flag(string memory reason) private {
        ++violations;
        lastViolation = reason;
    }

    /// @dev Half the picks land on the first six keys, so multi-step paths (exit, wait, withdraw; twenty services,
    ///      then a timeout slash) happen on the same key often enough.
    function _pickKey(uint256 seed) private view returns (address) {
        uint256 len = keys.length;
        if (len == 0) return address(0);
        uint256 range = (seed & 1 == 0 && len > 6) ? 6 : len;
        return keys[(seed >> 1) % range];
    }

    function _enroll(MochiTypes.JurorClass c, address operator, uint256 bond, bool attest) private returns (address key) {
        if (!registry.allowedMeasurement(MEASUREMENT, MochiTypes.Role.JUROR)) return address(0); // enrollment would revert
        uint256 pk = uint256(keccak256(abi.encode("registry-invariant-key", ++keyNonce)));
        key = vm.addr(pk);
        bytes32 digest = registry.enrollmentDigest(operator, key, MEASUREMENT, c);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        uint256 before = token.balanceOf(address(registry));
        uint256 poolLen = registry.jurorsOfClass(c).length;
        vm.prank(operator);
        registry.enrollJuror(key, MEASUREMENT, c, bond, abi.encodePacked(r, s, v));
        if (token.balanceOf(address(registry)) != before + bond) _flag("enroll: wrong bond pulled");
        address[] memory pool = registry.jurorsOfClass(c);
        if (pool.length != poolLen + 1 || pool[poolLen] != key) _flag("enroll: key not appended to the current pool");
        keys.push(key);
        deposited[key] = bond;
        ghostDeposited += bond;
        if (attest) _attest(key, 30 days);
    }

    function _attest(address key, uint256 duration) private {
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (j.delisted || !registry.allowedMeasurement(j.measurement, j.role)) return;
        address[] memory one = new address[](1);
        one[0] = key;
        registry.refreshAttestation(one, uint64(vm.getBlockTimestamp() + duration));
    }

    // ───────────────────────────── actions ─────────────────────────────

    function enroll(uint8 classSeed, uint8 operatorSeed, uint96 bondSeed, bool attest) external {
        uint256 bond = MIN_BOND + uint256(bondSeed) % (2 * MIN_BOND);
        _enroll(MochiTypes.JurorClass(classSeed % 5), operators[operatorSeed % 3], bond, attest);
        ++calls[msg.sig];
    }

    function attest(uint256 keySeed, uint32 durationSeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        _attest(key, 1 hours + uint256(durationSeed) % 30 days);
        ++calls[msg.sig];
    }

    function reportAttestationFailure(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        uint256 bond0 = registry.getJuror(key).bond;
        uint256 sink0 = token.balanceOf(sink);
        registry.reportAttestationFailure(key);
        uint256 slashed = token.balanceOf(sink) - sink0;
        if (slashed != bond0 * 500 / 10_000 || registry.getJuror(key).bond != bond0 - slashed) {
            _flag("attestation failure: wrong 5% slash");
        }
        if (registry.isActive(key, MochiTypes.Role.JUROR)) _flag("attestation failure: key still active");
        ghostSlashed += slashed;
        ++calls[msg.sig];
    }

    function slashEquivocation(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        uint256 bond0 = registry.getJuror(key).bond;
        uint256 sink0 = token.balanceOf(sink);
        registry.slashEquivocation(key);
        uint256 slashed = token.balanceOf(sink) - sink0;
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (slashed != bond0 || j.bond != 0 || !j.delisted) _flag("equivocation: not a full slash and delist");
        ghostSlashed += slashed;
        ++calls[msg.sig];
    }

    /// Records `count` (1..25) settled seats for one key; bit i of `timeoutMask` marks seat i as timed out.
    function recordService(uint256 keySeed, uint32 timeoutMask, uint8 countSeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        uint256 count = 1 + uint256(countSeed) % 25;
        address[] memory batch = new address[](count);
        for (uint256 i; i < count; ++i) batch[i] = key;
        uint32 mask = timeoutMask & uint32((uint256(1) << count) - 1);
        IJurorRegistry.Juror memory j0 = registry.getJuror(key);
        registry.recordService(batch, mask);
        IJurorRegistry.Juror memory j1 = registry.getJuror(key);
        if (j1.served != j0.served + count || j1.timeouts != j0.timeouts + MochiTypes.popcount(mask)) {
            _flag("service: counters");
        }
        if (registry.lastServedAt(key) != vm.getBlockTimestamp()) _flag("service: lastServedAt not stamped");
        ++calls[msg.sig];
    }

    /// @dev First key from a random offset that has requested exit (withdrawable or not), or 0.
    function _pickExited(uint256 seed) private view returns (address) {
        uint256 len = keys.length;
        for (uint256 i; i < len; ++i) {
            address key = keys[(seed % len + i) % len];
            if (registry.getJuror(key).exitRequestedAt != 0) return key;
        }
        return address(0);
    }

    /// @dev First key from a random offset with at least 20 recorded seats (slashable or not), or 0.
    function _pickServed(uint256 seed) private view returns (address) {
        uint256 len = keys.length;
        for (uint256 i; i < len; ++i) {
            address key = keys[(seed % len + i) % len];
            if (registry.getJuror(key).served >= 20) return key;
        }
        return address(0);
    }

    function slashForTimeouts(uint256 keySeed) external {
        address key = _pickServed(keySeed);
        if (key == address(0)) return;
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        bool allowed = j.served >= 20 && uint256(j.timeouts) * 10_000 > uint256(j.served) * 500
            && vm.getBlockTimestamp() >= uint256(j.lastTimeoutSlashAt) + 1 days;
        uint256 sink0 = token.balanceOf(sink);
        try registry.slashForTimeouts(key) {
            uint256 slashed = token.balanceOf(sink) - sink0;
            if (!allowed || slashed != j.bond / 100) _flag("timeouts: slash outside the rule");
            ghostSlashed += slashed;
            ++calls[msg.sig];
        } catch {
            if (allowed) _flag("timeouts: allowed slash reverted");
        }
    }

    function requestExit(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        vm.prank(registry.getJuror(key).operator);
        registry.requestExit(key);
        if (registry.isActive(key, MochiTypes.Role.JUROR)) _flag("exit: key still active");
        ++calls[msg.sig];
    }

    function withdrawBond(uint256 keySeed) external {
        address key = _pickExited(keySeed);
        if (key == address(0)) return;
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (j.exitRequestedAt == 0) return;
        uint64 served = registry.lastServedAt(key);
        uint256 readyAt = uint256(served > j.exitRequestedAt ? served : j.exitRequestedAt) + registry.exitDelay();
        uint256 got0 = token.balanceOf(j.operator);
        vm.prank(j.operator);
        try registry.withdrawBond(key) {
            if (vm.getBlockTimestamp() < readyAt) _flag("withdraw: before the exit delay");
            uint256 got = token.balanceOf(j.operator) - got0;
            IJurorRegistry.Juror memory after_ = registry.getJuror(key);
            if (got != j.bond || after_.bond != 0 || !after_.delisted) _flag("withdraw: wrong amount or state");
            ghostWithdrawn += got;
            withdrawn[key] = true;
            ++calls[msg.sig];
        } catch {
            if (vm.getBlockTimestamp() >= readyAt) _flag("withdraw: reverted after the exit delay");
        }
    }

    function prune(uint8 classSeed) external {
        MochiTypes.JurorClass c = MochiTypes.JurorClass(classSeed % 5);
        address[] memory before = registry.jurorsOfClass(c);
        uint256 gen = registry.poolGeneration(c);
        uint256 retired;
        for (uint256 i; i < before.length; ++i) {
            IJurorRegistry.Juror memory j = registry.getJuror(before[i]);
            if (j.delisted || j.exitRequestedAt != 0) ++retired;
        }
        if (retired == 0) return;
        (uint256 kept, uint256 removed) = registry.prunePool(c);
        address[] memory after_ = registry.jurorsOfClass(c);
        if (removed != retired || kept != before.length - retired || after_.length != kept) _flag("prune: counts");
        if (registry.poolGeneration(c) != gen + 1) _flag("prune: generation");
        uint256 k;
        for (uint256 i; i < before.length; ++i) {
            IJurorRegistry.Juror memory j = registry.getJuror(before[i]);
            if (j.delisted || j.exitRequestedAt != 0) continue;
            if (k >= after_.length || after_[k] != before[i]) _flag("prune: live key lost or reordered");
            ++k;
        }
        address[] memory old = registry.poolAt(c, gen);
        if (keccak256(abi.encode(old)) != keccak256(abi.encode(before))) _flag("prune: old generation changed");
        ++calls[msg.sig];
    }

    function setMeasurement(bool allowed) external {
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, allowed);
        ++calls[msg.sig];
    }

    function warp(uint32 secondsSeed) external {
        vm.warp(vm.getBlockTimestamp() + uint256(secondsSeed) % 8 days);
        ++calls[msg.sig];
    }

    /// Snapshot, select, then enroll a fresh active key in every class and prune where possible: the selection over
    /// the snapshot must not change, and every seat must be an eligible key of the snapshot's pools.
    function select(bytes32 seed, uint8 nSeed, uint256 excludeSeed) external {
        uint8[4] memory sizes = [uint8(3), 5, 7, 9];
        uint8 n = sizes[nSeed % 4];
        bytes32 qid = keccak256(abi.encode("registry-invariant-query", ++snapshotNonce));
        registry.openSelection(qid, address(0));
        uint256 snapshot = registry.selectionSnapshot(address(this), qid);
        address[] memory exclude = new address[](keys.length == 0 ? 0 : 1);
        if (keys.length != 0) exclude[0] = keys[excludeSeed % keys.length];
        address[] memory seats;
        try registry.selectJurors(address(this), qid, seed, 0, n, exclude) returns (address[] memory s) {
            seats = s;
        } catch {
            return; // too few eligible keys in some class
        }
        for (uint8 i; i < n; ++i) {
            address seat = seats[i];
            MochiTypes.JurorClass c = registry.seatClass(i);
            if (!registry.isActive(seat, MochiTypes.Role.JUROR)) _flag("select: inactive seat");
            if (registry.getJuror(seat).jurorClass != c) _flag("select: wrong class");
            if (exclude.length != 0 && seat == exclude[0]) _flag("select: excluded key seated");
            for (uint8 e; e < i; ++e) if (seats[e] == seat) _flag("select: duplicate seat");
            uint256 word = snapshot >> (uint256(uint8(c)) * 48);
            address[] memory pool = registry.poolAt(c, uint24(word));
            bool member;
            for (uint256 p; p < uint24(word >> 24); ++p) if (pool[p] == seat) member = true;
            if (!member) _flag("select: seat outside the snapshot");
        }
        for (uint8 c; c < 5; ++c) {
            _enroll(MochiTypes.JurorClass(c), operators[c % 3], MIN_BOND, true);
            try registry.prunePool(MochiTypes.JurorClass(c)) {} catch {}
        }
        address[] memory again = registry.selectJurors(address(this), qid, seed, 0, n, exclude);
        if (keccak256(abi.encode(again)) != keccak256(abi.encode(seats))) _flag("select: later enrollment or prune moved a seat");
        ++calls[msg.sig];
    }
}

/// @notice JurorRegistry stateful invariants: bond conservation and slash routing, slash bounds, exits and
///         withdrawals, and consistency between keys, pools and the active set.
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract JurorRegistryInvariantTest is Test {
    MochiToken private token;
    JurorRegistry private registry;
    RegistryHandler private handler;
    address private constant SINK = address(0x5157);

    function setUp() public {
        token = new MochiToken(address(this), 10 ** 30);
        registry = new JurorRegistry(address(this), token, SINK, 1_000 ether, 7 days);
        handler = new RegistryHandler(token, registry, SINK);
        registry.setMeasurement(handler.MEASUREMENT(), MochiTypes.Role.JUROR, true);
        registry.grantRole(MochiRoles.ATTESTOR_ROLE, address(handler));
        registry.grantRole(registry.SLASHER_ROLE(), address(handler));
        registry.grantRole(MochiRoles.GOVERNOR_ROLE, address(handler));
        for (uint256 i; i < 3; ++i) require(token.transfer(handler.operators(i), 10 ** 28));
        // A small live population per class so selection has something to draw from from the start.
        for (uint8 c; c < 5; ++c) {
            for (uint8 j; j < 3; ++j) handler.enroll(c, j, 0, true);
        }
        targetContract(address(handler));
    }

    /// MOCHI is conserved: the registry holds exactly the sum of bonds, which is what was deposited minus what was
    /// withdrawn and slashed, and every slash went to the sink.
    function invariant_bondsAreConserved() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        uint256 sum;
        uint256 count = handler.keyCount();
        for (uint256 i; i < count; ++i) {
            address key = handler.keys(i);
            IJurorRegistry.Juror memory j = registry.getJuror(key);
            sum += j.bond;
            assertLe(j.bond, handler.deposited(key)); // slashes and exits only ever reduce a bond
            if (j.delisted) assertEq(j.bond, 0); // delisting comes from a full slash or a withdrawal
            if (handler.withdrawn(key)) assertTrue(j.delisted && j.exitRequestedAt != 0);
        }
        assertEq(token.balanceOf(address(registry)), sum);
        assertEq(sum, handler.ghostDeposited() - handler.ghostWithdrawn() - handler.ghostSlashed());
        assertEq(token.balanceOf(SINK), handler.ghostSlashed());
    }

    /// Pools and the active set agree: each class's current pool has no duplicates and only that class's JUROR keys;
    /// every key that has not exited or been delisted is still in its pool (so it stays selectable); exiting or
    /// delisted keys are never active.
    function invariant_poolsAndActiveSetAreConsistent() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        for (uint8 c; c < 5; ++c) {
            address[] memory pool = registry.jurorsOfClass(MochiTypes.JurorClass(c));
            for (uint256 i; i < pool.length; ++i) {
                IJurorRegistry.Juror memory j = registry.getJuror(pool[i]);
                assertEq(uint8(j.jurorClass), c);
                assertEq(uint8(j.role), uint8(MochiTypes.Role.JUROR));
                for (uint256 k; k < i; ++k) assertTrue(pool[k] != pool[i]);
            }
        }
        uint256 count = handler.keyCount();
        for (uint256 i; i < count; ++i) {
            address key = handler.keys(i);
            IJurorRegistry.Juror memory j = registry.getJuror(key);
            bool retired = j.delisted || j.exitRequestedAt != 0;
            if (retired) {
                assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
                continue;
            }
            address[] memory pool = registry.jurorsOfClass(j.jurorClass);
            bool member;
            for (uint256 k; k < pool.length; ++k) if (pool[k] == key) member = true;
            assertTrue(member, "live key missing from its pool");
        }
    }

    function test_handlerReachesEveryPath() public {
        // Even seeds pick from the first six keys: key(i) = seed 2 * i.
        handler.recordService(0, 1, 0);
        handler.reportAttestationFailure(2);
        handler.slashEquivocation(4);
        handler.requestExit(6);
        handler.recordService(6, 1, 0); // a round it sat in settles after the exit request
        handler.warp(6 days);
        handler.withdrawBond(0); // the only exited key, before the hold ends: must revert inside the handler
        handler.warp(3 days);
        handler.withdrawBond(0);
        handler.prune(1); // key 3 (class 1) exited
        handler.attest(8, 1 days);
        handler.setMeasurement(false);
        handler.setMeasurement(true);
        handler.select(keccak256("seed"), 0, 7); // N3
        handler.recordService(10, 1, 19); // 20 seats, one timeout: exactly 5%, not slashable
        handler.recordService(10, 1, 0);
        handler.warp(1 days);
        handler.slashForTimeouts(0);
        bytes4[13] memory selectors = [
            handler.enroll.selector, handler.attest.selector, handler.reportAttestationFailure.selector,
            handler.slashEquivocation.selector, handler.recordService.selector, handler.slashForTimeouts.selector,
            handler.requestExit.selector, handler.withdrawBond.selector, handler.prune.selector,
            handler.setMeasurement.selector, handler.warp.selector, handler.select.selector, handler.enroll.selector
        ];
        for (uint256 i; i < selectors.length; ++i) assertGt(handler.calls(selectors[i]), 0, vm.toString(selectors[i]));
        invariant_bondsAreConserved();
        invariant_poolsAndActiveSetAreConsistent();
    }
}
