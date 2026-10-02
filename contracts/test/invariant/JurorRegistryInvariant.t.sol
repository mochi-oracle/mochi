// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {SelectionModel} from "../utils/SelectionModel.sol";

/// @dev Drives the registry in one bond mode: bonded (permissionless, positive minimum) or zero-bond (governor-approved
///      key/operator pairs). Actions: enrollment, attestation and its lapse, the three slashes, service records, exits
///      and withdrawals, zero-bond approval and revocation, governor delisting, pruning, measurement changes, time, and
///      snapshot selection checked seat by seat (and revert by revert) against SelectionModel. It holds ATTESTOR,
///      SLASHER and GOVERNOR. Each action checks its own effect, an expected revert is asserted rather than swallowed,
///      and ghosts track every MOCHI movement and every pool membership.
contract RegistryHandler is Test {
    MochiToken public immutable token;
    JurorRegistry public immutable registry;
    address public immutable sink;
    bool public immutable zeroBond;
    bytes32 public constant MEASUREMENT = keccak256("juror-measurement");
    uint256 public constant MIN_BOND = 1_000 ether;
    uint256 public constant MAX_TRACKED_SNAPSHOTS = 6;

    address[3] public operators;
    address[] public keys;
    mapping(address => uint256) public deposited;
    mapping(address => bool) public withdrawn;
    mapping(address => bool) public governanceDelisted;
    /// @dev Ghost of registry.inPool: set when a refresh leaves a key active, cleared when prunePool drops it.
    mapping(address => bool) public joined;
    mapping(address => bool) public everAttested;
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostSlashed;
    uint256 public violations;
    string public lastViolation;
    uint256 private keyNonce;
    uint256 private snapshotNonce;
    bytes32[] public trackedSnapshots;
    mapping(bytes32 => bytes32) public snapshotHash;
    mapping(bytes4 => uint256) public calls;
    uint256 public selectReverts; // NoEligibleJuror, predicted by the model and seen
    uint256 public selectSeated; // selections that seated every seat, as the model predicted
    uint256 public pruneNothing; // NothingToPrune, predicted and seen

    constructor(MochiToken token_, JurorRegistry registry_, address sink_, bool zeroBond_) {
        token = token_;
        registry = registry_;
        sink = sink_;
        zeroBond = zeroBond_;
        for (uint256 i; i < 3; ++i) {
            operators[i] = makeAddr(string.concat("registry-operator-", vm.toString(i)));
            vm.prank(operators[i]);
            token.approve(address(registry_), type(uint256).max);
        }
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    /// @dev One call per invariant check instead of one per key and ghost (the checks dominate campaign time).
    struct Ghost {
        address key;
        uint256 deposited;
        bool withdrawn;
        bool governanceDelisted;
        bool joined;
        bool everAttested;
    }

    function ghosts() external view returns (Ghost[] memory out) {
        out = new Ghost[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            address key = keys[i];
            out[i] = Ghost(key, deposited[key], withdrawn[key], governanceDelisted[key], joined[key], everAttested[key]);
        }
    }

    function trackedSnapshotCount() external view returns (uint256) {
        return trackedSnapshots.length;
    }

    function _flag(string memory reason) private {
        ++violations;
        lastViolation = reason;
    }

    /// @dev Half the picks land on the first six keys, so multi-step paths (exit, wait, withdraw; twenty services,
    ///      then a timeout slash; revoke, prune, approve, attest) happen on the same key often enough.
    function _pickKey(uint256 seed) private view returns (address) {
        uint256 len = keys.length;
        if (len == 0) return address(0);
        uint256 range = (seed & 1 == 0 && len > 6) ? 6 : len;
        return keys[(seed >> 1) % range];
    }

    function _now() private view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _enroll(MochiTypes.JurorClass c, address operator, uint256 bondSeed, bool attest) private returns (address key) {
        if (!registry.allowedMeasurement(MEASUREMENT, MochiTypes.Role.JUROR)) return address(0); // enrollment would revert
        uint256 pk = uint256(keccak256(abi.encode("registry-invariant-key", ++keyNonce)));
        key = vm.addr(pk);
        // Zero-bond seats need the governor's approval of the exact key and operator; a dust bond is still allowed.
        uint256 bond = zeroBond ? (bondSeed % 4 == 0 ? 1 ether : 0) : MIN_BOND + bondSeed % (2 * MIN_BOND);
        if (zeroBond) registry.setUnbondedJuror(key, operator);
        bytes32 digest = registry.enrollmentDigest(operator, key, MEASUREMENT, c);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        uint256 before = token.balanceOf(address(registry));
        uint256 poolLen = registry.jurorsOfClass(c).length;
        vm.prank(operator);
        registry.enrollJuror(key, MEASUREMENT, c, bond, abi.encodePacked(r, s, v));
        if (token.balanceOf(address(registry)) != before + bond) _flag("enroll: wrong bond pulled");
        if (registry.jurorsOfClass(c).length != poolLen || registry.inPool(key)) _flag("enroll: joined a pool unattested");
        keys.push(key);
        deposited[key] = bond;
        ghostDeposited += bond;
        if (attest) _attest(key, 30 days);
    }

    /// @dev Refreshes one key for `duration` from now (0 = until one second ago, i.e. a lapse).
    function _attest(address key, uint256 duration) private {
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (!registry.allowedMeasurement(j.measurement, j.role)) return; // the refresh would revert
        bool wasIn = registry.inPool(key);
        uint256 poolLen = registry.jurorsOfClass(j.jurorClass).length;
        uint64 until = uint64(duration == 0 ? _now() - 1 : _now() + duration);
        address[] memory one = new address[](1);
        one[0] = key;
        registry.refreshAttestation(one, until);
        IJurorRegistry.Juror memory after_ = registry.getJuror(key);
        if (j.delisted) {
            if (after_.attestedUntil != j.attestedUntil || registry.inPool(key) != wasIn) _flag("attest: delisted key refreshed");
            return;
        }
        if (after_.attestedUntil != until) _flag("attest: attestedUntil not set");
        everAttested[key] = true;
        bool active = registry.isActive(key, MochiTypes.Role.JUROR);
        address[] memory pool = registry.jurorsOfClass(j.jurorClass);
        if (!wasIn && active) {
            joined[key] = true;
            if (pool.length != poolLen + 1 || pool[poolLen] != key || !registry.inPool(key)) {
                _flag("attest: active key did not join the end of its pool");
            }
        } else if (pool.length != poolLen || registry.inPool(key) != wasIn) {
            _flag("attest: pool changed without a join");
        }
    }

    function _modelPrunable(address key, bool zeroBondNow, uint256 staleBefore) private view returns (bool) {
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (j.delisted || j.exitRequestedAt != 0 || uint256(j.attestedUntil) < staleBefore) return true;
        if (!registry.allowedMeasurement(j.measurement, MochiTypes.Role.JUROR)) return true;
        return zeroBondNow ? registry.unbondedJurorOperator(key) != j.operator : j.bond == 0;
    }

    /// @dev Prunes `c` when the model says something would drop (checking every effect), else asserts NothingToPrune.
    function _prune(MochiTypes.JurorClass c) private returns (bool pruned) {
        address[] memory before = registry.jurorsOfClass(c);
        uint256 gen = registry.poolGeneration(c);
        bool[] memory drop = new bool[](before.length);
        uint256 retired;
        bool zeroBondNow = registry.minJurorBond() == 0;
        uint256 grace = registry.ATTESTATION_GRACE();
        uint256 staleBefore = _now() > grace ? _now() - grace : 0; // attestedUntil + grace < now
        for (uint256 i; i < before.length; ++i) {
            drop[i] = _modelPrunable(before[i], zeroBondNow, staleBefore);
            if (drop[i]) ++retired;
        }
        if (retired == 0) {
            try registry.prunePool(c) {
                _flag("prune: nothing to drop, but it pruned");
            } catch (bytes memory reason) {
                if (keccak256(reason) != keccak256(abi.encodeWithSelector(IJurorRegistry.NothingToPrune.selector, c))) {
                    _flag("prune: wrong revert");
                }
                ++pruneNothing;
            }
            return false;
        }
        (uint256 kept, uint256 removed) = registry.prunePool(c);
        address[] memory after_ = registry.jurorsOfClass(c);
        if (removed != retired || kept != before.length - retired || after_.length != kept) _flag("prune: counts");
        if (registry.poolGeneration(c) != gen + 1) _flag("prune: generation");
        uint256 k;
        for (uint256 i; i < before.length; ++i) {
            if (drop[i]) {
                joined[before[i]] = false;
                if (registry.inPool(before[i])) _flag("prune: dropped key still flagged in the pool");
                continue;
            }
            if (k >= after_.length || after_[k] != before[i]) _flag("prune: live key lost or reordered");
            if (!registry.inPool(before[i])) _flag("prune: kept key lost its flag");
            ++k;
        }
        address[] memory old = registry.poolAt(c, gen);
        if (keccak256(abi.encode(old)) != keccak256(abi.encode(before))) _flag("prune: old generation changed");
        return true;
    }

    /// @dev setUp only (excluded from the fuzzed selectors): `count` keys of class `c` attested for one hour, which
    ///      lapse when setUp moves time on. Mostly dead pools are where draws run out (and where a count-based fallback
    ///      would show); prune clears them once ATTESTATION_GRACE has passed.
    function seedLapsedPopulation(MochiTypes.JurorClass c, uint256 count) external {
        for (uint256 i; i < count; ++i) {
            address key = _enroll(c, operators[i % 3], i, false);
            _attest(key, 1 hours);
        }
    }

    // ───────────────────────────── actions ─────────────────────────────

    function enroll(uint8 classSeed, uint8 operatorSeed, uint96 bondSeed, bool attest) external {
        _enroll(MochiTypes.JurorClass(classSeed % 5), operators[operatorSeed % 3], bondSeed, attest);
        ++calls[msg.sig];
    }

    function attest(uint256 keySeed, uint32 durationSeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        _attest(key, 1 hours + uint256(durationSeed) % 30 days);
        ++calls[msg.sig];
    }

    /// The attestor refreshes a key to an attestation that has already expired: the key goes inactive at once.
    function lapse(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        _attest(key, 0);
        if (registry.isActive(key, MochiTypes.Role.JUROR)) _flag("lapse: key still active");
        ++calls[msg.sig];
    }

    /// Lapses every key of a class's current pool but the first `keepSeed % 4` active ones: pools that are mostly dead
    /// with a few live keys are where a draw budget runs out, and where any count-based fallback would show.
    function lapseClass(uint8 classSeed, uint8 keepSeed) external {
        address[] memory pool = registry.jurorsOfClass(MochiTypes.JurorClass(classSeed % 5));
        uint256 keep = keepSeed % 4;
        for (uint256 i; i < pool.length; ++i) {
            if (keep != 0 && registry.isActive(pool[i], MochiTypes.Role.JUROR)) {
                --keep;
                continue;
            }
            _attest(pool[i], 0);
        }
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

    /// Governance retires a key without a slash; its bond stays withdrawable through the exit.
    function delist(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        uint256 bond0 = registry.getJuror(key).bond;
        registry.delist(key);
        IJurorRegistry.Juror memory j = registry.getJuror(key);
        if (!j.delisted || j.bond != bond0 || registry.isActive(key, MochiTypes.Role.JUROR)) _flag("delist: state");
        if (bond0 != 0) governanceDelisted[key] = true;
        ++calls[msg.sig];
    }

    /// Zero-bond approval levers (no effect on eligibility in bonded mode).
    function revoke(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        registry.setUnbondedJuror(key, address(0));
        if (zeroBond && registry.isActive(key, MochiTypes.Role.JUROR)) _flag("revoke: zero-bond key still active");
        ++calls[msg.sig];
    }

    function approve(uint256 keySeed) external {
        address key = _pickKey(keySeed);
        if (key == address(0)) return;
        registry.setUnbondedJuror(key, registry.getJuror(key).operator);
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
        if (registry.lastServedAt(key) != _now()) _flag("service: lastServedAt not stamped");
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
            && _now() >= uint256(j.lastTimeoutSlashAt) + 1 days;
        uint256 sink0 = token.balanceOf(sink);
        try registry.slashForTimeouts(key) {
            uint256 slashed = token.balanceOf(sink) - sink0;
            if (!allowed || slashed != j.bond / 100) _flag("timeouts: slash outside the rule");
            ghostSlashed += slashed;
            ++calls[msg.sig];
        } catch (bytes memory reason) {
            if (allowed) _flag("timeouts: allowed slash reverted");
            if (keccak256(reason) != keccak256(abi.encodeWithSelector(IJurorRegistry.TimeoutSlashNotAllowed.selector, key))) {
                _flag("timeouts: wrong revert");
            }
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
        uint64 served = registry.lastServedAt(key);
        uint256 readyAt = uint256(served > j.exitRequestedAt ? served : j.exitRequestedAt) + registry.exitDelay();
        uint256 got0 = token.balanceOf(j.operator);
        vm.prank(j.operator);
        try registry.withdrawBond(key) {
            if (_now() < readyAt) _flag("withdraw: before the exit delay");
            uint256 got = token.balanceOf(j.operator) - got0;
            IJurorRegistry.Juror memory after_ = registry.getJuror(key);
            if (got != j.bond || after_.bond != 0 || !after_.delisted) _flag("withdraw: wrong amount or state");
            ghostWithdrawn += got;
            withdrawn[key] = true;
            governanceDelisted[key] = false;
            ++calls[msg.sig];
        } catch (bytes memory reason) {
            if (_now() >= readyAt) _flag("withdraw: reverted after the exit delay");
            if (keccak256(reason) != keccak256(abi.encodeWithSelector(IJurorRegistry.ExitDelayNotElapsed.selector, uint64(readyAt)))) {
                _flag("withdraw: wrong revert");
            }
        }
    }

    function prune(uint8 classSeed) external {
        if (_prune(MochiTypes.JurorClass(classSeed % 5))) ++calls[msg.sig];
    }

    function setMeasurement(bool allowed) external {
        registry.setMeasurement(MEASUREMENT, MochiTypes.Role.JUROR, allowed);
        ++calls[msg.sig];
    }

    function warp(uint32 secondsSeed) external {
        vm.warp(_now() + uint256(secondsSeed) % 8 days);
        ++calls[msg.sig];
    }

    function _selectAndCheck(bytes32 qid, bytes32 seed, uint8 n, address[] memory exclude)
        private
        returns (bool ok, address[] memory seats)
    {
        MochiTypes.JurorClass failed;
        (ok, failed, seats) = SelectionModel.select(registry, address(this), qid, seed, 0, n, exclude);
        try registry.selectJurors(address(this), qid, seed, 0, n, exclude) returns (address[] memory got) {
            if (!ok) _flag("select: seated where the spec reverts");
            else if (keccak256(abi.encode(got)) != keccak256(abi.encode(seats))) _flag("select: differs from the spec");
        } catch (bytes memory reason) {
            if (ok) _flag("select: reverted where the spec seats");
            else if (keccak256(reason) != keccak256(abi.encodeWithSelector(IJurorRegistry.NoEligibleJuror.selector, failed))) {
                _flag("select: wrong revert");
            }
        }
    }

    /// Snapshot and select, checked against the model (seats or the exact NoEligibleJuror). Then, after the seed is
    /// known: enroll and attest a key in every class and prune where possible, which must not change the outcome; and
    /// exit one key, which may only change the outcome as the model says and never gives its operator more seats.
    function select(bytes32 seed, uint8 nSeed, uint256 excludeSeed, uint256 exitSeed) external {
        uint8[4] memory sizes = [uint8(3), 5, 7, 9];
        uint8 n = sizes[nSeed % 4];
        bytes32 qid = keccak256(abi.encode("registry-invariant-query", ++snapshotNonce));
        registry.openSelection(qid, address(0));
        uint256 snapshot = registry.selectionSnapshot(address(this), qid);
        if (trackedSnapshots.length < MAX_TRACKED_SNAPSHOTS) {
            trackedSnapshots.push(qid);
            snapshotHash[qid] = SelectionModel.snapshotContents(registry, address(this), qid);
        }
        address[] memory exclude = new address[](keys.length == 0 ? 0 : 1);
        if (keys.length != 0) exclude[0] = keys[excludeSeed % keys.length];
        (bool ok, address[] memory seats) = _selectAndCheck(qid, seed, n, exclude);
        if (ok) {
            ++selectSeated;
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
        } else {
            ++selectReverts;
        }
        for (uint8 c; c < 5; ++c) {
            _enroll(MochiTypes.JurorClass(c), operators[c % 3], c, true);
            _prune(MochiTypes.JurorClass(c));
        }
        (bool okAgain, address[] memory again) = _selectAndCheck(qid, seed, n, exclude);
        if (okAgain != ok || keccak256(abi.encode(again)) != keccak256(abi.encode(seats))) {
            _flag("select: later enrollment, attestation or prune moved a seat");
        }
        // One key exits after the seed is known.
        address leaver = _pickKey(exitSeed);
        if (leaver != address(0) && ok) {
            address operator = registry.getJuror(leaver).operator;
            uint256 held;
            for (uint8 i; i < n; ++i) if (registry.getJuror(seats[i]).operator == operator) ++held;
            vm.prank(operator);
            registry.requestExit(leaver);
            (bool okExit, address[] memory afterExit) = _selectAndCheck(qid, seed, n, exclude);
            if (okExit) {
                uint256 heldAfter;
                for (uint8 i; i < n; ++i) if (registry.getJuror(afterExit[i]).operator == operator) ++heldAfter;
                if (heldAfter > held) _flag("select: an exit after the seed won its operator a seat");
            }
        }
        ++calls[msg.sig];
    }
}

/// @notice JurorRegistry stateful invariants, shared by both bond modes: bond conservation and slash routing, slash
///         bounds, exits and withdrawals, pool membership (only attested keys join; inPool matches the pools exactly),
///         consistency between pools and the active set, and immutability of snapshotted pools.
abstract contract RegistryInvariantBase is Test {
    MochiToken internal token;
    JurorRegistry internal registry;
    RegistryHandler internal handler;
    address internal constant SINK = address(0x5157);

    function _zeroBond() internal pure virtual returns (bool);

    function setUp() public {
        token = new MochiToken(address(this), 10 ** 30);
        registry = new JurorRegistry(address(this), token, SINK, _zeroBond() ? 0 : 1_000 ether, 7 days);
        handler = new RegistryHandler(token, registry, SINK, _zeroBond());
        registry.setMeasurement(handler.MEASUREMENT(), MochiTypes.Role.JUROR, true);
        registry.grantRole(MochiRoles.ATTESTOR_ROLE, address(handler));
        registry.grantRole(registry.SLASHER_ROLE(), address(handler));
        registry.grantRole(MochiRoles.GOVERNOR_ROLE, address(handler));
        for (uint256 i; i < 3; ++i) require(token.transfer(handler.operators(i), 10 ** 28));
        // A small live population per class so selection has something to draw from from the start. Behind LARGE_A's
        // (two seats from N7) sit 24 keys that joined and lapsed: an unpruned pool after an outage of their operators.
        for (uint8 c; c < 5; ++c) {
            for (uint8 j; j < 3; ++j) handler.enroll(c, j, 1, true);
        }
        handler.seedLapsedPopulation(MochiTypes.JurorClass.LARGE_A, 24);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        targetContract(address(handler));
        bytes4[] memory setupOnly = new bytes4[](1);
        setupOnly[0] = handler.seedLapsedPopulation.selector;
        excludeSelector(FuzzSelector(address(handler), setupOnly));
    }

    /// MOCHI is conserved: the registry holds exactly the sum of bonds, which is what was deposited minus what was
    /// withdrawn and slashed, and every slash went to the sink.
    function invariant_bondsAreConserved() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        uint256 sum;
        RegistryHandler.Ghost[] memory all = handler.ghosts();
        for (uint256 i; i < all.length; ++i) {
            IJurorRegistry.Juror memory j = registry.getJuror(all[i].key);
            sum += j.bond;
            assertLe(j.bond, all[i].deposited); // slashes and exits only ever reduce a bond
            // Delisting by a full slash or a withdrawal empties the bond; a governance delisting leaves it to withdraw.
            if (j.delisted && !all[i].governanceDelisted) assertEq(j.bond, 0);
            if (all[i].withdrawn) assertTrue(j.delisted && j.exitRequestedAt != 0);
        }
        assertEq(token.balanceOf(address(registry)), sum);
        assertEq(sum, handler.ghostDeposited() - handler.ghostWithdrawn() - handler.ghostSlashed());
        assertEq(token.balanceOf(SINK), handler.ghostSlashed());
    }

    /// Pools and the active set agree: each class's current pool has no duplicates and only that class's JUROR keys,
    /// every member has inPool set, and inPool is set exactly for the keys a refresh left active and no prune dropped
    /// since (so a key never attested is in no pool, and a key is pooled at most once). Exiting or delisted keys are
    /// never active.
    function invariant_poolsAndActiveSetAreConsistent() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        // One pass over the tracked keys (every key is enrolled through the handler): the pooled ones, by class.
        RegistryHandler.Ghost[] memory all = handler.ghosts();
        address[][5] memory pooledOf;
        uint256[5] memory pooledCount;
        for (uint8 c; c < 5; ++c) pooledOf[c] = new address[](all.length);
        for (uint256 i; i < all.length; ++i) {
            address key = all[i].key;
            IJurorRegistry.Juror memory j = registry.getJuror(key);
            bool pooled = registry.inPool(key);
            assertEq(pooled, all[i].joined, "inPool differs from the joins and drops");
            if (!all[i].everAttested) assertFalse(pooled, "a key joined a pool without an attestation");
            if (j.delisted || j.exitRequestedAt != 0) assertFalse(registry.isActive(key, MochiTypes.Role.JUROR));
            if (!pooled) continue;
            assertEq(uint8(j.role), uint8(MochiTypes.Role.JUROR));
            uint8 c = uint8(j.jurorClass);
            pooledOf[c][pooledCount[c]++] = key;
        }
        // Each class's current pool is exactly its pooled keys: same count, no duplicates, every member one of them.
        for (uint8 c; c < 5; ++c) {
            address[] memory pool = registry.jurorsOfClass(MochiTypes.JurorClass(c));
            assertEq(pool.length, pooledCount[c], "inPool and the pool disagree");
            for (uint256 i; i < pool.length; ++i) {
                bool found;
                for (uint256 k; k < pooledCount[c] && !found; ++k) found = pooledOf[c][k] == pool[i];
                assertTrue(found, "a pool member is not a pooled key of its class");
                for (uint256 k; k < i; ++k) assertTrue(pool[k] != pool[i]);
            }
        }
    }

    /// The pools a selection snapshot names never change, whatever enrollment, attestation and pruning came after.
    function invariant_snapshotsNeverChange() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        uint256 count = handler.trackedSnapshotCount();
        for (uint256 i; i < count; ++i) {
            bytes32 qid = handler.trackedSnapshots(i);
            assertEq(SelectionModel.snapshotContents(registry, address(handler), qid), handler.snapshotHash(qid));
        }
    }

    function _scriptedWalk() internal {
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
        handler.prune(1); // nothing left to drop: NothingToPrune, asserted
        handler.attest(8, 1 days);
        handler.lapse(10);
        handler.lapseClass(3, 1);
        handler.delist(12);
        handler.revoke(14);
        handler.approve(14);
        handler.attest(14, 1 days);
        handler.setMeasurement(false);
        handler.setMeasurement(true);
        handler.select(keccak256("seed"), 0, 7, 9); // N3
        handler.recordService(10, 1, 19); // 20 seats, one timeout: exactly 5%, not slashable
        handler.recordService(10, 1, 0);
        handler.warp(1 days);
        handler.slashForTimeouts(0);
        // Every LARGE_A key goes inactive: the selection must revert NoEligibleJuror(LARGE_A), as the model says.
        for (uint256 i; i < handler.keyCount(); ++i) {
            address key = handler.keys(i);
            if (registry.getJuror(key).jurorClass == MochiTypes.JurorClass.LARGE_A) handler.lapse(2 * i + 1);
        }
        handler.warp(0);
        handler.select(keccak256("no-large-a"), 0, 0, 1);
        handler.enroll(0, 0, 0, false);
        bytes4[19] memory selectors = [
            handler.enroll.selector, handler.attest.selector, handler.lapse.selector, handler.lapseClass.selector,
            handler.reportAttestationFailure.selector, handler.slashEquivocation.selector, handler.delist.selector,
            handler.revoke.selector, handler.approve.selector, handler.recordService.selector,
            handler.slashForTimeouts.selector, handler.requestExit.selector, handler.withdrawBond.selector,
            handler.prune.selector, handler.setMeasurement.selector, handler.warp.selector, handler.select.selector,
            handler.lapse.selector, handler.enroll.selector
        ];
        for (uint256 i; i < selectors.length; ++i) assertGt(handler.calls(selectors[i]), 0, vm.toString(selectors[i]));
        assertGt(handler.selectSeated(), 0, "no selection seated every seat");
        assertGt(handler.selectReverts(), 0, "no selection reverted NoEligibleJuror");
        assertGt(handler.pruneNothing(), 0, "no prune reverted NothingToPrune");
        invariant_bondsAreConserved();
        invariant_poolsAndActiveSetAreConsistent();
        invariant_snapshotsNeverChange();
    }

    function test_handlerReachesEveryPath() public {
        _scriptedWalk();
    }
}

/// @notice Bonded (permissionless) mode.
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract JurorRegistryInvariantTest is RegistryInvariantBase {
    function _zeroBond() internal pure override returns (bool) {
        return false;
    }
}

/// @notice Zero-bond (launch) mode: every juror key needs the governor's approval of its exact operator.
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract JurorRegistryZeroBondInvariantTest is RegistryInvariantBase {
    function _zeroBond() internal pure override returns (bool) {
        return true;
    }
}
