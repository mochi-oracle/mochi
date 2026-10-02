// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {SelectionModel} from "../utils/SelectionModel.sol";

interface IEscrowInvariantActions {
    function openUSDG(uint8 nSeed, bool isPublic) external;
    function openVoucher(uint8 nSeed) external;
    function openShielded(uint8 nSeed) external;
    function openFeed(uint8 nSeed) external;
    function sealQuery(uint256 pick) external;
    function resealQuery(uint256 pick) external;
    function postRound(uint256 pick, uint8 agreeSeed, uint32 timeoutSeed) external;
    function expandQuery(uint256 pick, uint8 stepSeed) external;
    function expireQuery(uint256 pick) external;
    function claimOperator(uint8 operatorSeed) external;
    function warp(uint32 secondsSeed, uint16 blocksSeed) external;
    function fund(bool float_, uint32 amountSeed) external;
    function setJurorAttestation(uint8 keySeed, bool restore) external;
}

/// @dev The fuzzer calls this; it forwards to the test contract, which holds the signing keys.
contract EscrowHandler {
    IEscrowInvariantActions private immutable actions;

    constructor(IEscrowInvariantActions actions_) {
        actions = actions_;
    }

    function openUSDG(uint8 nSeed, bool isPublic) external { actions.openUSDG(nSeed, isPublic); }
    function openVoucher(uint8 nSeed) external { actions.openVoucher(nSeed); }
    function openShielded(uint8 nSeed) external { actions.openShielded(nSeed); }
    function openFeed(uint8 nSeed) external { actions.openFeed(nSeed); }
    function seal(uint256 pick) external { actions.sealQuery(pick); }
    function reseal(uint256 pick) external { actions.resealQuery(pick); }
    function post(uint256 pick, uint8 agreeSeed, uint32 timeoutSeed) external { actions.postRound(pick, agreeSeed, timeoutSeed); }
    function expand(uint256 pick, uint8 stepSeed) external { actions.expandQuery(pick, stepSeed); }
    function expire(uint256 pick) external { actions.expireQuery(pick); }
    function claim(uint8 operatorSeed) external { actions.claimOperator(operatorSeed); }
    function warp(uint32 secondsSeed, uint16 blocksSeed) external { actions.warp(secondsSeed, blocksSeed); }
    function fund(bool float_, uint32 amountSeed) external { actions.fund(float_, amountSeed); }
    function attestation(uint8 keySeed, bool restore) external { actions.setJurorAttestation(keySeed, restore); }
}

/// @notice Stateful QueryEscrow lifecycle over all four pay paths (USDG, Anonyma voucher, shielded, feed budget):
///         open, seal, reseal, VERDICT/HUNG posts with timeouts (also after the deadline, while nobody expired the
///         round), expansion, expiry, operator claims, funding, juror attestation lapses and restores, and time.
///         Every action checks its own money movement exactly; the invariants check the global books. Seals are checked
///         seat by seat against SelectionModel, including the NoEligibleJuror reverts it predicts when a class has no
///         active key. Actions otherwise only take valid steps, so any other revert is a failure (runs and depth come
///         from foundry.toml).
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract EscrowInvariantTest is Harness {
    EscrowHandler private handler;
    uint64 private nonce;
    bytes32[] private queries;
    mapping(bytes32 => uint256) private ghostPaid;
    mapping(bytes32 => MochiTypes.QueryStatus) private ghostStatus;
    mapping(bytes32 => bool) private seenVerdictIds;
    bytes32[] private verdictIds;
    address[15] private operators;
    uint256 public violations;
    string public lastViolation;
    mapping(bytes4 => uint256) public calls; // successful actions, by selector (coverage evidence)
    mapping(bytes4 => uint256) public attempts; // every handler call, by selector
    uint256 public sealNoJuror; // seals that reverted NoEligibleJuror, as the model predicted
    uint256 public latePosts; // rounds posted after their query deadline (nobody had expired them)
    uint256 public lateExpandsRefused; // expansions refused because the deadline had passed
    bool private legacyWarp; // test_randomWalkCoverage: the warp distribution before the rebalance, for comparison

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(IEscrowInvariantActions(address(this)));
        for (uint8 c; c < 5; ++c) {
            for (uint8 j; j < 3; ++j) operators[c * 3 + j] = vm.addr(uint256(keccak256(abi.encode("operator", c, j))));
        }
        targetContract(address(handler));
    }

    // ───────────────────────────── helpers ─────────────────────────────

    modifier onlyHandler() {
        require(msg.sender == address(handler), "handler only");
        ++attempts[msg.sig];
        _;
    }

    function _flag(string memory reason) private {
        ++violations;
        lastViolation = reason;
    }

    function _size(uint8 seed) private pure returns (uint8) {
        uint8[4] memory sizes = [uint8(3), 5, 7, 9];
        return sizes[seed % 4];
    }

    function _claimables() private view returns (uint256 sum) {
        for (uint256 i; i < operators.length; ++i) sum += escrow.claimable(operators[i]);
    }

    function _pools() private view returns (uint256) {
        return escrow.anonymaFloat() + escrow.feedBudget();
    }

    /// @dev USDG the escrow still holds for a query: the current round's seat fees and protocol fee until it settles
    ///      or expires; nothing in any other status.
    function _outstanding(bytes32 qid) private view returns (uint256 amount) {
        MochiTypes.Query memory q = escrow.getQuery(qid);
        if (q.status != MochiTypes.QueryStatus.OPEN && q.status != MochiTypes.QueryStatus.SEALED) return 0;
        amount = q.protocolFee;
        for (uint8 s = escrow.prevNOf(qid); s < q.n; ++s) amount += escrow.seatFeeOf(qid, s);
    }

    function _find(uint256 pick, MochiTypes.QueryStatus status) private view returns (bytes32) {
        uint256 len = queries.length;
        for (uint256 i; i < len; ++i) {
            bytes32 qid = queries[(pick % len + i) % len];
            if (escrow.getQuery(qid).status == status) return qid;
        }
        return bytes32(0);
    }

    function _findBeforeDeadline(uint256 pick, MochiTypes.QueryStatus status) private view returns (bytes32) {
        uint256 len = queries.length;
        for (uint256 i; i < len; ++i) {
            bytes32 qid = queries[(pick % len + i) % len];
            MochiTypes.Query memory q = escrow.getQuery(qid);
            if (q.status == status && vm.getBlockTimestamp() <= q.deadline && q.n < 9) return qid;
        }
        return bytes32(0);
    }

    function _grant(uint8 n, bool isPublic) private returns (MochiTypes.Provenance memory p, uint256 total) {
        bytes32 doc = keccak256(abi.encode("invariant-doc", ++nonce));
        p = _provenance(doc, 0, bytes32(0), 1);
        p.nonce = nonce;
        if (!isPublic) {
            p.isPublic = false;
            p.payerCommit = keccak256(abi.encode("payer-key", nonce));
        }
        (uint256 jf, uint256 pf) = escrow.quote(1, n, 1);
        total = jf + pf;
    }

    function _signVoucher(MochiTypes.AnonymaVoucher memory v) private view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), MochiTypes.hashAnonymaVoucher(v)));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(anonymaPk, digest);
        return abi.encodePacked(r, s, vv);
    }

    /// @dev Checks an open's money movement and starts tracking the query.
    function _opened(bytes32 qid, uint256 total, uint256 bal0, uint256 pools0, bool external_, string memory path) private {
        uint256 bal1 = usdg.balanceOf(address(escrow));
        uint256 pools1 = _pools();
        if (external_ ? (bal1 != bal0 + total || pools1 != pools0) : (bal1 != bal0 || pools0 != pools1 + total)) {
            _flag(string.concat(path, ": open moved the wrong amount"));
        }
        MochiTypes.Query memory q = escrow.getQuery(qid);
        if (q.paid != total || q.status != MochiTypes.QueryStatus.OPEN || _outstanding(qid) != total) {
            _flag(string.concat(path, ": open recorded the wrong query"));
        }
        queries.push(qid);
        ghostPaid[qid] = total;
        ghostStatus[qid] = MochiTypes.QueryStatus.OPEN;
        ++calls[msg.sig];
    }

    // ───────────────────────────── actions ─────────────────────────────

    function openUSDG(uint8 nSeed, bool isPublic) external onlyHandler {
        uint8 n = _size(nSeed);
        (MochiTypes.Provenance memory p, uint256 total) = _grant(n, isPublic);
        usdg.mint(address(this), total);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        bytes32 qid = escrow.openWithUSDG(MochiTypes.OpenParams(n, address(this)), p, _signProvenance(p));
        _opened(qid, total, bal0, pools0, true, "usdg");
    }

    function openVoucher(uint8 nSeed) external onlyHandler {
        uint8 n = _size(nSeed);
        (MochiTypes.Provenance memory p, uint256 total) = _grant(n, true);
        bytes32 expected = escrow.computeQueryId(address(this), p.docCommit, p.nonce);
        MochiTypes.AnonymaVoucher memory v = MochiTypes.AnonymaVoucher(
            keccak256(abi.encode("voucher", nonce)), expected, 1, n, total, 1, uint64(vm.getBlockTimestamp() + 1 hours)
        );
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        bytes32 qid =
            escrow.openWithVoucher(MochiTypes.OpenParams(n, address(this)), p, _signProvenance(p), v, _signVoucher(v));
        if (qid != expected || !escrow.voucherUsed(v.voucherId)) _flag("voucher: wrong query or voucher not spent");
        _opened(qid, total, bal0, pools0, false, "voucher");
    }

    function openShielded(uint8 nSeed) external onlyHandler {
        uint8 n = _size(nSeed);
        (MochiTypes.Provenance memory p, uint256 total) = _grant(n, false);
        bytes32 expected = escrow.computeQueryId(address(this), p.docCommit, p.nonce);
        usdg.mint(address(this), total);
        shielded.fund(total);
        bytes32 nullifier = keccak256(abi.encode("nullifier", nonce));
        bytes memory proof = abi.encode(nullifier, total, address(escrow), expected);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        bytes32 qid =
            escrow.openShielded(MochiTypes.OpenParams(n, address(this)), p, _signProvenance(p), nullifier, proof);
        _opened(qid, total, bal0, pools0, true, "shielded");
    }

    function openFeed(uint8 nSeed) external onlyHandler {
        uint8 n = _size(nSeed);
        (uint256 jf, uint256 pf) = escrow.quote(uint32(MochiTypes.SchemaId.EX_DIVIDEND), n, 1);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        bytes32 qid = _openFeed(keccak256(abi.encode("feed-doc", ++nonce)), n);
        _opened(qid, jf + pf, bal0, pools0, false, "feed");
    }

    function sealQuery(uint256 pick) external onlyHandler {
        bytes32 qid = _find(pick, MochiTypes.QueryStatus.OPEN);
        if (qid == bytes32(0)) return;
        MochiTypes.Query memory q = escrow.getQuery(qid);
        uint256 bn = vm.getBlockNumber();
        if (bn > uint256(q.sealBlock) + 256) return; // ticket missed: resealQuery handles it
        if (bn <= q.sealBlock) vm.roll(uint256(q.sealBlock) + 1);
        uint8 prevN = escrow.prevNOf(qid);
        address[] memory before = escrow.jurorsOf(qid);
        bytes32 seed = randomness.seed(keccak256(abi.encode(qid, q.docCommit, q.round)), q.sealBlock);
        (bool ok, MochiTypes.JurorClass failed, address[] memory expected) =
            SelectionModel.select(registry, address(escrow), qid, seed, prevN, q.n, before);
        try escrow.seal(qid) {
            if (!ok) _flag("seal: seated where the spec reverts");
        } catch (bytes memory reason) {
            if (ok || keccak256(reason) != keccak256(abi.encodeWithSelector(IJurorRegistry.NoEligibleJuror.selector, failed))) {
                _flag("seal: unexpected revert");
            }
            if (escrow.getQuery(qid).status != MochiTypes.QueryStatus.OPEN) _flag("seal: a failed seal changed the status");
            ++sealNoJuror;
            return;
        }
        address[] memory seats = escrow.jurorsOf(qid);
        if (before.length != prevN || seats.length != q.n) _flag("seal: wrong seat count");
        for (uint256 i; i < seats.length; ++i) {
            if (i < before.length && seats[i] != before[i]) _flag("seal: an earlier seat moved");
            if (i >= prevN && seats[i] != expected[i - prevN]) _flag("seal: differs from the spec");
            if (registry.getJuror(seats[i]).jurorClass != registry.seatClass(uint8(i))) _flag("seal: wrong class");
            for (uint256 j; j < i; ++j) if (seats[j] == seats[i]) _flag("seal: juror seated twice");
        }
        ghostStatus[qid] = MochiTypes.QueryStatus.SEALED;
        ++calls[msg.sig];
    }

    function resealQuery(uint256 pick) external onlyHandler {
        uint256 len = queries.length;
        for (uint256 i; i < len; ++i) {
            bytes32 qid = queries[(pick % len + i) % len];
            MochiTypes.Query memory q = escrow.getQuery(qid);
            if (q.status != MochiTypes.QueryStatus.OPEN || !randomness.isExpired(q.sealBlock)) continue;
            uint256 out0 = _outstanding(qid);
            escrow.reseal(qid);
            if (_outstanding(qid) != out0 || escrow.getQuery(qid).sealBlock <= q.sealBlock) _flag("reseal changed funds");
            if (registry.selectionSnapshot(address(escrow), qid) != _currentPools()) _flag("reseal: pools not re-snapshotted");
            ++calls[msg.sig];
            return;
        }
    }

    /// @dev A round is postable while SEALED, also after its deadline when nobody has expired it yet. Seats whose key is
    ///      no longer active (attestation lapsed) can only be declared timeouts.
    function postRound(uint256 pick, uint8 agreeSeed, uint32 timeoutSeed) external onlyHandler {
        bytes32 qid = _find(pick, MochiTypes.QueryStatus.SEALED);
        if (qid == bytes32(0)) return;
        MochiTypes.Query memory q = escrow.getQuery(qid);
        bool late = vm.getBlockTimestamp() > q.deadline;
        uint8 n = q.n;
        uint8 prevN = escrow.prevNOf(qid);
        uint32 timeouts = timeoutSeed & uint32((uint256(1) << n) - 1);
        address[] memory seated = escrow.jurorsOf(qid);
        for (uint8 i; i < n; ++i) {
            if (!registry.isActive(seated[i], MochiTypes.Role.JUROR)) timeouts |= uint32(1) << i;
        }
        uint8 answering = n - MochiTypes.popcount(timeouts);
        uint8 agree = answering == 0 ? 0 : agreeSeed % (answering + 1);
        bool verdict = agree >= MochiTypes.requiredAgree(n);
        bytes32[9] memory answers;
        uint32 dissent = timeouts;
        uint8 assigned;
        for (uint8 i; i < n; ++i) {
            if ((timeouts & (uint32(1) << i)) != 0) continue;
            if (assigned < agree) {
                answers[i] = keccak256("agreed");
                ++assigned;
            } else {
                answers[i] = keccak256(abi.encode("dissent", i));
                dissent |= uint32(1) << i;
            }
        }
        uint256 jurorPay;
        for (uint8 s = prevN; s < n; ++s) if ((timeouts & (uint32(1) << s)) == 0) jurorPay += escrow.seatFeeOf(qid, s);
        uint256 out0 = _outstanding(qid);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        uint256 claims0 = _claimables();
        bytes32 vid = _post(
            qid,
            verdict ? 1 : 2,
            uint16(uint256(agree) * 10_000 / n),
            dissent,
            timeouts,
            verdict ? keccak256(abi.encode("payload", qid)) : bytes32(0),
            _votes(qid, answers, timeouts)
        );
        uint256 bal1 = usdg.balanceOf(address(escrow));
        uint256 pools1 = _pools();
        uint256 claims1 = _claimables();
        if (claims1 - claims0 != jurorPay) _flag("post: jurors paid the wrong amount");
        if (bal1 > bal0 || pools1 < pools0 || (claims1 - claims0) + (bal0 - bal1) + (pools1 - pools0) != out0) {
            _flag("post: settlement did not release exactly the round's escrow");
        }
        if (_outstanding(qid) != 0 || escrow.getQuery(qid).protocolFee != 0) _flag("post: round still holds funds");
        MochiTypes.QueryStatus expected = verdict ? MochiTypes.QueryStatus.DECIDED : MochiTypes.QueryStatus.HUNG;
        if (escrow.getQuery(qid).status != expected) _flag("post: wrong status");
        if (seenVerdictIds[vid] || verifyStored(vid) == false) _flag("post: duplicate or missing verdict id");
        for (uint8 s = prevN; s < n; ++s) {
            if (registry.lastServedAt(seated[s]) != vm.getBlockTimestamp()) _flag("post: service not stamped at the post");
        }
        seenVerdictIds[vid] = true;
        verdictIds.push(vid);
        ghostStatus[qid] = expected;
        if (late) ++latePosts;
        ++calls[msg.sig];
    }

    function verifyStored(bytes32 vid) private view returns (bool) {
        return verdicts.getVerdict(vid).status != 0;
    }

    /// @dev Prefers a HUNG query still before its deadline; otherwise a late one, whose expansion must be refused.
    function expandQuery(uint256 pick, uint8 stepSeed) external onlyHandler {
        bytes32 qid = _findBeforeDeadline(pick, MochiTypes.QueryStatus.HUNG);
        if (qid == bytes32(0)) qid = _find(pick, MochiTypes.QueryStatus.HUNG);
        if (qid == bytes32(0)) return;
        MochiTypes.Query memory q = escrow.getQuery(qid);
        if (q.n == 9) return;
        uint8 newN = q.n + 2 * (1 + stepSeed % ((9 - q.n) / 2));
        if (vm.getBlockTimestamp() > q.deadline) {
            // Past the deadline a HUNG query can no longer be expanded (on any path).
            vm.prank(vm.addr(feedRunnerPk));
            try escrow.expand(qid, newN) {
                _flag("expand: accepted after the deadline");
            } catch (bytes memory reason) {
                bytes memory wrong = abi.encodeWithSignature("WrongStatus(bytes32,uint8)", qid, uint8(MochiTypes.QueryStatus.HUNG));
                if (keccak256(reason) != keccak256(wrong)) _flag("expand: wrong revert after the deadline");
                ++lateExpandsRefused;
            }
            return;
        }
        (uint256 jf, uint256 pf) = escrow.quoteExpansion(qid, newN);
        uint256 total = jf + pf;
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        bool external_ = q.payPath == MochiTypes.PayPath.USDG || q.payPath == MochiTypes.PayPath.SHIELDED;
        if (q.payPath == MochiTypes.PayPath.USDG) {
            usdg.mint(address(this), total);
            escrow.expand(qid, newN);
        } else if (q.payPath == MochiTypes.PayPath.SHIELDED) {
            usdg.mint(address(this), total);
            shielded.fund(total);
            bytes32 nullifier = keccak256(abi.encode("expand-nullifier", qid, newN));
            escrow.expandShielded(qid, newN, nullifier, abi.encode(nullifier, total, address(escrow), qid));
        } else if (q.payPath == MochiTypes.PayPath.ANONYMA) {
            MochiTypes.AnonymaVoucher memory v = MochiTypes.AnonymaVoucher(
                keccak256(abi.encode("expand-voucher", qid, newN)), qid, q.schemaId, newN, total, 1,
                uint64(vm.getBlockTimestamp() + 1 hours)
            );
            escrow.expandWithVoucher(qid, newN, v, _signVoucher(v));
        } else {
            vm.prank(vm.addr(feedRunnerPk));
            escrow.expand(qid, newN);
        }
        uint256 bal1 = usdg.balanceOf(address(escrow));
        uint256 pools1 = _pools();
        if (external_ ? (bal1 != bal0 + total || pools1 != pools0) : (bal1 != bal0 || pools0 != pools1 + total)) {
            _flag("expand: moved the wrong amount");
        }
        MochiTypes.Query memory after_ = escrow.getQuery(qid);
        ghostPaid[qid] += total;
        if (
            after_.status != MochiTypes.QueryStatus.OPEN || after_.n != newN || after_.round != q.round + 1
                || escrow.prevNOf(qid) != q.n || after_.paid != ghostPaid[qid] || _outstanding(qid) != total
        ) _flag("expand: wrong round state");
        if (registry.selectionSnapshot(address(escrow), qid) != _currentPools()) _flag("expand: pools not re-snapshotted");
        ghostStatus[qid] = MochiTypes.QueryStatus.OPEN;
        ++calls[msg.sig];
    }

    function expireQuery(uint256 pick) external onlyHandler {
        uint256 len = queries.length;
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 i; i < len; ++i) {
            bytes32 qid = queries[(pick % len + i) % len];
            MochiTypes.Query memory q = escrow.getQuery(qid);
            if (q.status != MochiTypes.QueryStatus.OPEN && q.status != MochiTypes.QueryStatus.SEALED) continue;
            if (now_ <= q.deadline) continue;
            uint256 out0 = _outstanding(qid);
            uint256 bal0 = usdg.balanceOf(address(escrow));
            uint256 pools0 = _pools();
            uint256 claims0 = _claimables();
            escrow.expire(qid);
            uint256 bal1 = usdg.balanceOf(address(escrow));
            uint256 pools1 = _pools();
            if (_claimables() != claims0 || bal1 > bal0 || pools1 < pools0 || (bal0 - bal1) + (pools1 - pools0) != out0) {
                _flag("expire: refund is not exactly the round's escrow");
            }
            bool external_ = q.payPath == MochiTypes.PayPath.USDG || q.payPath == MochiTypes.PayPath.SHIELDED;
            if (external_ ? pools1 != pools0 : bal1 != bal0) _flag("expire: refund went to the wrong place");
            if (escrow.getQuery(qid).status != MochiTypes.QueryStatus.EXPIRED || _outstanding(qid) != 0) {
                _flag("expire: wrong final state");
            }
            ghostStatus[qid] = MochiTypes.QueryStatus.EXPIRED;
            ++calls[msg.sig];
            return;
        }
    }

    function claimOperator(uint8 operatorSeed) external onlyHandler {
        address operator = operators[operatorSeed % operators.length];
        uint256 owed = escrow.claimable(operator);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 got0 = usdg.balanceOf(operator);
        vm.prank(operator);
        escrow.claim();
        if (escrow.claimable(operator) != 0 || bal0 - usdg.balanceOf(address(escrow)) != owed || usdg.balanceOf(operator) - got0 != owed) {
            _flag("claim: paid the wrong amount");
        }
        ++calls[msg.sig];
    }

    /// @dev Mostly short steps (under five minutes, under 16 blocks), so a round usually gets sealed and posted before
    ///      its one-hour deadline; one call in eight jumps up to two hours and 300 blocks, which drives expiry, late posts,
    ///      refused late expansions and missed seal windows (reseal). Uniform two-hour, 300-block steps (the earlier
    ///      distribution) expired most rounds before they were posted.
    function warp(uint32 secondsSeed, uint16 blocksSeed) external onlyHandler {
        bool jump = legacyWarp || (secondsSeed >> 29) == 0;
        vm.warp(vm.getBlockTimestamp() + secondsSeed % (jump ? 2 hours : 5 minutes));
        vm.roll(vm.getBlockNumber() + blocksSeed % (jump ? 300 : 16));
        ++calls[msg.sig];
    }

    /// The attestor lets juror attestations lapse, or restores them: one key of a class (keySeed / 5 % 4 < 3) or all
    /// three. With every key of a class lapsed, seals of rounds needing that class revert NoEligibleJuror, and seated
    /// lapsed keys can only time out.
    function setJurorAttestation(uint8 keySeed, bool restore) external onlyHandler {
        uint8 c = keySeed % 5;
        uint8 which = (keySeed / 5) % 4;
        address[] memory keys = new address[](which == 3 ? 3 : 1);
        for (uint8 j; j < keys.length; ++j) keys[j] = vm.addr(jurorPks[c][which == 3 ? j : which]);
        uint256 now_ = vm.getBlockTimestamp();
        vm.prank(vm.addr(attestorPk));
        registry.refreshAttestation(keys, uint64(restore ? now_ + 30 days : now_ - 1));
        for (uint256 j; j < keys.length; ++j) {
            if (registry.isActive(keys[j], MochiTypes.Role.JUROR) != restore) _flag("attestation: wrong activity");
        }
        ++calls[msg.sig];
    }

    /// @dev The registry's current pools as a snapshot word (what openSelection records).
    function _currentPools() private view returns (uint256 word) {
        word = 1 << 255;
        for (uint8 c; c < 5; ++c) {
            MochiTypes.JurorClass jc = MochiTypes.JurorClass(c);
            word |= (registry.poolGeneration(jc) | (registry.jurorsOfClass(jc).length << 24)) << (uint256(c) * 48);
        }
    }

    function fund(bool float_, uint32 amountSeed) external onlyHandler {
        uint256 amount = uint256(amountSeed % 1_000) * USD;
        if (amount == 0) return;
        usdg.mint(address(this), amount);
        uint256 bal0 = usdg.balanceOf(address(escrow));
        uint256 pools0 = _pools();
        if (float_) escrow.fundAnonymaFloat(amount);
        else escrow.fundFeedBudget(amount);
        if (usdg.balanceOf(address(escrow)) != bal0 + amount || _pools() != pools0 + amount) _flag("fund: wrong amount");
        ++calls[msg.sig];
    }

    // ───────────────────────────── invariants ─────────────────────────────

    /// The escrow holds exactly its liabilities: Anonyma's float, the feed budget, operators' claimable fees, and the
    /// current round's fees of every OPEN or SEALED query. No action moved money other than as checked above.
    function invariant_escrowBalanceEqualsLiabilities() public view {
        assertEq(violations, 0, lastViolation);
        uint256 liabilities = _pools() + _claimables();
        for (uint256 i; i < queries.length; ++i) liabilities += _outstanding(queries[i]);
        assertEq(usdg.balanceOf(address(escrow)), liabilities);
    }

    /// Queries only move along the lifecycle the handler drove (no status changes behind its back), their recorded
    /// payments equal what was paid in, seats match the round, and every posted verdict id is unique and stored.
    function invariant_queriesFollowTheirLifecycle() public view {
        assertEq(violations, 0, lastViolation);
        for (uint256 i; i < queries.length; ++i) {
            bytes32 qid = queries[i];
            MochiTypes.Query memory q = escrow.getQuery(qid);
            assertEq(uint8(q.status), uint8(ghostStatus[qid]));
            assertEq(q.paid, ghostPaid[qid]);
            uint256 seats = escrow.jurorsOf(qid).length;
            if (q.status == MochiTypes.QueryStatus.OPEN) assertEq(seats, escrow.prevNOf(qid));
            else if (q.status != MochiTypes.QueryStatus.EXPIRED) assertEq(seats, q.n);
        }
        for (uint256 i; i < verdictIds.length; ++i) assertTrue(verdicts.getVerdict(verdictIds[i]).status != 0);
    }

    /// Scripted walk through every handler path, so a path the random campaign happens to miss is still exercised
    /// (and the per-action money checks run on it).
    function test_handlerReachesEveryPath() public {
        handler.openUSDG(0, true);
        handler.openVoucher(0);
        handler.openShielded(0);
        handler.openFeed(0);
        handler.openUSDG(1, false);
        for (uint256 i; i < 5; ++i) handler.seal(i);
        // HUNG everywhere (one agreeing seat, seat 1 timed out), then expand every path.
        for (uint256 i; i < 5; ++i) handler.post(i, 1, 2);
        for (uint256 i; i < 4; ++i) handler.expand(i, 0);
        for (uint256 i; i < 3; ++i) handler.seal(i);
        handler.post(0, 255, 0); // unanimous VERDICT
        handler.post(1, 4, 1); // VERDICT with a timeout
        handler.warp(7_199, 299); // past every deadline, and a few hundred blocks
        handler.expire(0);
        handler.expire(1);
        handler.openUSDG(2, true);
        handler.warp(0, 299);
        handler.reseal(0);
        handler.seal(0);
        for (uint8 o; o < 15; ++o) handler.claim(o);
        handler.fund(true, 500);
        handler.fund(false, 500);
        // Every LARGE_A key lapses: the next round needing LARGE_A cannot be sealed (NoEligibleJuror, as the model
        // predicts); restoring one key lets it seal.
        handler.openUSDG(0, true); // queries[6], N3
        handler.attestation(15, false); // all three LARGE_A keys
        handler.seal(6);
        assertEq(sealNoJuror, 1, "the lapsed class did not stop the seal");
        handler.attestation(0, true);
        handler.seal(6);
        // Nobody expires it, so it is still postable after its deadline (HUNG), and then too late to expand.
        handler.warp(4_000, 0);
        handler.post(6, 0, 0);
        handler.expand(6, 0);
        bytes4[13] memory selectors = [
            this.openUSDG.selector, this.openVoucher.selector, this.openShielded.selector, this.openFeed.selector,
            this.sealQuery.selector, this.resealQuery.selector, this.postRound.selector, this.expandQuery.selector,
            this.expireQuery.selector, this.claimOperator.selector, this.warp.selector, this.fund.selector,
            this.setJurorAttestation.selector
        ];
        for (uint256 i; i < selectors.length; ++i) assertGt(calls[selectors[i]], 0, vm.toString(selectors[i]));
        assertGt(latePosts, 0, "no post after the deadline");
        assertGt(lateExpandsRefused, 0, "no expansion refused after the deadline");
        invariant_escrowBalanceEqualsLiabilities();
        invariant_queriesFollowTheirLifecycle();
    }

    /// A deterministic stand-in for the fuzzer (uniform actions, pseudo-random arguments, 16 runs of depth 64 from the
    /// same start), to check that the action mix reaches the paths that matter often enough: posts, expansions,
    /// NoEligibleJuror seals and late posts. It also measures the warp distribution used before the rebalance.
    function test_randomWalkCoverage() public {
        (uint256[13] memory tried, uint256[13] memory did, uint256 noJuror, uint256 late) = _walk(16, 64, false);
        (uint256[13] memory triedOld, uint256[13] memory didOld,,) = _walk(16, 64, true);
        string[13] memory names = ["openUSDG", "openVoucher", "openShielded", "openFeed", "seal", "reseal", "post",
            "expand", "expire", "claim", "warp", "fund", "attestation"];
        for (uint256 i; i < 13; ++i) {
            emit log_string(string.concat(names[i], ": ", vm.toString(did[i]), " of ", vm.toString(tried[i]),
                " (uniform 2 h warps: ", vm.toString(didOld[i]), " of ", vm.toString(triedOld[i]), ")"));
        }
        emit log_named_uint("seals reverting NoEligibleJuror", noJuror);
        emit log_named_uint("posts after the deadline", late);
        // Minimum coverage: at least half of post calls and a sixth of expand calls do something, which the uniform
        // two-hour warps did not reach.
        assertGe(did[6] * 2, tried[6], "posts rarely find a postable round");
        assertGe(did[7] * 6, tried[7], "expansions rarely find an expandable round");
        assertGt(did[6] * triedOld[6], didOld[6] * tried[6], "the rebalance did not raise the post rate");
        assertGt(noJuror, 0, "no seal reverted NoEligibleJuror");
        assertGt(late, 0, "no post after the deadline");
    }

    function _walk(uint256 runs, uint256 depth, bool legacy)
        private
        returns (uint256[13] memory tried, uint256[13] memory did, uint256 noJuror, uint256 late)
    {
        legacyWarp = legacy;
        bytes4[13] memory sels = [
            this.openUSDG.selector, this.openVoucher.selector, this.openShielded.selector, this.openFeed.selector,
            this.sealQuery.selector, this.resealQuery.selector, this.postRound.selector, this.expandQuery.selector,
            this.expireQuery.selector, this.claimOperator.selector, this.warp.selector, this.fund.selector,
            this.setJurorAttestation.selector
        ];
        for (uint256 r; r < runs; ++r) {
            uint256 snap = vm.snapshotState();
            for (uint256 d; d < depth; ++d) _step(uint256(keccak256(abi.encode("walk", r, d))));
            for (uint256 i; i < 13; ++i) {
                tried[i] += attempts[sels[i]];
                did[i] += calls[sels[i]];
            }
            noJuror += sealNoJuror;
            late += latePosts;
            vm.revertToState(snap);
        }
    }

    function _step(uint256 x) private {
        uint256 a = x % 13;
        uint256 y = x >> 8;
        if (a == 0) handler.openUSDG(uint8(y), y & 1 == 0);
        else if (a == 1) handler.openVoucher(uint8(y));
        else if (a == 2) handler.openShielded(uint8(y));
        else if (a == 3) handler.openFeed(uint8(y));
        else if (a == 4) handler.seal(y);
        else if (a == 5) handler.reseal(y);
        else if (a == 6) handler.post(y, uint8(y >> 64), uint32(y >> 72));
        else if (a == 7) handler.expand(y, uint8(y >> 64));
        else if (a == 8) handler.expire(y);
        else if (a == 9) handler.claim(uint8(y));
        else if (a == 10) handler.warp(uint32(y), uint16(y >> 32));
        else if (a == 11) handler.fund(y & 1 == 0, uint32(y >> 1));
        else handler.attestation(uint8(y), (y >> 8) & 1 == 0);
    }
}
