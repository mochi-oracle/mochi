// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "../integration/utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";

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
}

/// @notice Stateful QueryEscrow lifecycle over all four pay paths (USDG, Anonyma voucher, shielded, feed budget):
///         open, seal, reseal, VERDICT/HUNG posts with timeouts, expansion, expiry, operator claims, funding and time.
///         Every action checks its own money movement exactly; the invariants check the global books. Actions only
///         take valid steps, so any revert is a failure (runs and depth come from foundry.toml).
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
        escrow.seal(qid);
        address[] memory seats = escrow.jurorsOf(qid);
        if (before.length != prevN || seats.length != q.n) _flag("seal: wrong seat count");
        for (uint256 i; i < seats.length; ++i) {
            if (i < before.length && seats[i] != before[i]) _flag("seal: an earlier seat moved");
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
            ++calls[msg.sig];
            return;
        }
    }

    function postRound(uint256 pick, uint8 agreeSeed, uint32 timeoutSeed) external onlyHandler {
        bytes32 qid = _find(pick, MochiTypes.QueryStatus.SEALED);
        if (qid == bytes32(0)) return;
        MochiTypes.Query memory q = escrow.getQuery(qid);
        if (vm.getBlockTimestamp() > q.deadline) return; // expiry is the only exit past the deadline
        uint8 n = q.n;
        uint8 prevN = escrow.prevNOf(qid);
        uint32 timeouts = timeoutSeed & uint32((uint256(1) << n) - 1);
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
        seenVerdictIds[vid] = true;
        verdictIds.push(vid);
        ghostStatus[qid] = expected;
        ++calls[msg.sig];
    }

    function verifyStored(bytes32 vid) private view returns (bool) {
        return verdicts.getVerdict(vid).status != 0;
    }

    function expandQuery(uint256 pick, uint8 stepSeed) external onlyHandler {
        bytes32 qid = _find(pick, MochiTypes.QueryStatus.HUNG);
        if (qid == bytes32(0)) return;
        MochiTypes.Query memory q = escrow.getQuery(qid);
        if (q.n == 9 || vm.getBlockTimestamp() > q.deadline) return;
        uint8 newN = q.n + 2 * (1 + stepSeed % ((9 - q.n) / 2));
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

    function warp(uint32 secondsSeed, uint16 blocksSeed) external onlyHandler {
        vm.warp(vm.getBlockTimestamp() + secondsSeed % 2 hours);
        vm.roll(vm.getBlockNumber() + blocksSeed % 300);
        ++calls[msg.sig];
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
        bytes4[12] memory selectors = [
            this.openUSDG.selector, this.openVoucher.selector, this.openShielded.selector, this.openFeed.selector,
            this.sealQuery.selector, this.resealQuery.selector, this.postRound.selector, this.expandQuery.selector,
            this.expireQuery.selector, this.claimOperator.selector, this.warp.selector, this.fund.selector
        ];
        for (uint256 i; i < selectors.length; ++i) assertGt(calls[selectors[i]], 0, vm.toString(selectors[i]));
        invariant_escrowBalanceEqualsLiabilities();
        invariant_queriesFollowTheirLifecycle();
    }
}
