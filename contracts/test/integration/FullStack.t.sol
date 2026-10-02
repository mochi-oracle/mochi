// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Harness} from "./utils/Harness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IFeeds} from "@mochi/interfaces/IFeeds.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";

contract FullStackTest is Harness {
    function _sameVotes(bytes32 qid, bytes32 ans) internal view returns (MochiTypes.JurorVote[] memory votes) {
        bytes32[9] memory a; for (uint256 i; i < 9; ++i) a[i] = ans; return _votes(qid, a, 0);
    }

    function test_publicQuery_happyPath_N3() public {
        uint256 payerPk = 0x7777; address payer = vm.addr(payerPk);
        bytes32 doc = keccak256("public-happy");
        MochiTypes.Provenance memory p = _provenance(doc, 0, 0, 1);
        p.opener = payer; p.nonce = 101;
        MochiTypes.OpenParams memory op = MochiTypes.OpenParams(3, payer);
        (uint256 fees, uint256 protocol) = escrow.quote(1, 3, 1); uint256 total = fees + protocol;
        usdg.mint(payer, total); vm.prank(payer); usdg.approve(address(escrow), total);
        bytes memory intakeSig = _signProvenance(p);
        vm.prank(payer); bytes32 qid = escrow.openWithUSDG(op, p, intakeSig);
        _seal(qid);
        MochiTypes.JurorVote[] memory votes = _sameVotes(qid, keccak256("unanimous"));
        bytes memory payload = abi.encode(bytes32("KEY"), uint64(block.timestamp), abi.encode(uint256(42)));
        bytes32 vid = _post(qid, 1, 10000, 0, 0, keccak256(payload), votes);
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.DECIDED));
        MochiTypes.Verdict memory v = verdicts.getVerdict(vid); assertEq(v.status, 1); assertEq(v.payloadHash, keccak256(payload));
        address[] memory seats = escrow.jurorsOf(qid);
        uint256 expectedClaims;
        for (uint256 i; i < seats.length; ++i) {
            address operator = registry.operatorOf(seats[i]); uint256 seatFee = escrow.seatFeeOf(qid, uint8(i));
            assertEq(escrow.claimable(operator), seatFee); expectedClaims += seatFee;
        }
        uint256 reserve = protocol * 2500 / 10000;
        assertEq(usdg.balanceOf(address(panel)), 12_500 * USD + reserve);
        uint256 rewardsAfterStream = block.timestamp + 7 days;
        vm.warp(rewardsAfterStream);
        assertApproxEqAbs(staking.earned(address(this)), staking.rewardRate() * staking.rewardDuration() / 1e18, 2);
        assertEq(usdg.balanceOf(address(escrow)), expectedClaims + escrow.feedBudget() + escrow.anonymaFloat());
        for (uint256 i; i < seats.length; ++i) {
            address operator = registry.operatorOf(seats[i]); uint256 before = usdg.balanceOf(operator);
            vm.prank(operator); escrow.claim(); assertEq(usdg.balanceOf(operator) - before, escrow.seatFeeOf(qid, uint8(i)));
        }
    }

    function test_hung_then_expand_to_N5_verdict() public {
        bytes32 qid = _open(7, 3, keccak256("expand"), false); _seal(qid);
        bytes32[9] memory a; a[0] = keccak256("A"); a[1] = a[0]; a[2] = keccak256("B");
        MochiTypes.JurorVote[] memory votes = _votes(qid, a, 0);
        uint256 beforeRefund = usdg.balanceOf(address(this));
        uint256 protocol = escrow.getQuery(qid).protocolFee;
        _post(qid, 2, 6666, 4, 0, 0, votes);
        assertEq(usdg.balanceOf(address(this)) - beforeRefund, protocol); // USDG path refunds the protocol fee
        assertEq(uint256(escrow.getQuery(qid).status), uint256(MochiTypes.QueryStatus.HUNG));
        for (uint256 i; i < 3; ++i) {
            address operator = registry.operatorOf(escrow.jurorsOf(qid)[i]);
            assertEq(escrow.claimable(operator), escrow.seatFeeOf(qid, uint8(i)));
        }
        uint256[3] memory originalClaimables;
        for (uint256 i; i < 3; ++i) originalClaimables[i] = escrow.claimable(registry.operatorOf(escrow.jurorsOf(qid)[i]));
        uint256 paidExpansion; (uint256 f, uint256 p) = escrow.quoteExpansion(qid, 5); paidExpansion = f + p;
        usdg.mint(address(this), paidExpansion); escrow.expand(qid, 5); _seal(qid);
        address[] memory seats = escrow.jurorsOf(qid);
        assertTrue(seats[3] != seats[0] && seats[3] != seats[1] && seats[3] != seats[2]);
        assertTrue(seats[4] != seats[0] && seats[4] != seats[1] && seats[4] != seats[2]);
        a[3] = a[0]; a[4] = keccak256("dissent");
        votes = _votes(qid, a, 0);
        _post(qid, 1, 8000, 16, 0, keccak256("expanded payload"), votes);
        for (uint256 i; i < seats.length; ++i) {
            IJurorRegistry.Juror memory j = registry.getJuror(seats[i]);
            assertEq(j.served, 1, "each selected seat recorded exactly once");
            assertEq(escrow.claimable(j.operator), i < 3 ? originalClaimables[i] : escrow.seatFeeOf(qid, uint8(i)));
        }
    }

    function test_timeouts() public {
        bytes32 qid = _open(1, 5, keccak256("timeout"), false); _seal(qid);
        bytes32[9] memory a; for (uint256 i = 1; i < 5; ++i) a[i] = keccak256("agree");
        MochiTypes.JurorVote[] memory votes = _votes(qid, a, 1);
        address[] memory seats = escrow.jurorsOf(qid); address timedOut = seats[0];
        uint256 refundBefore = usdg.balanceOf(address(this));
        _post(qid, 1, 8000, 1, 1, keccak256("payload"), votes);
        assertEq(registry.getJuror(timedOut).timeouts, 1);
        assertEq(usdg.balanceOf(address(this)) - refundBefore, escrow.seatFeeOf(qid, 0));
    }

    function test_feed_exDividend_with_crosscheck() public {
        bytes32 qid = _openFeed(keccak256("ex-div-feed"), 3); _seal(qid);
        MochiTypes.JurorVote[] memory votes = _sameVotes(qid, keccak256("feed-answer"));
        uint64 exDate = uint64(block.timestamp + 5 days);
        bytes memory payload = _payload(bytes32("NVDA"), exDate, _exBody(exDate, true));
        bytes32 vid = _post(qid, 1, 10000, 0, 0, keccak256(payload), votes);
        stock.setSchedule(1e18, 2e18, exDate);
        bytes32 feed = keccak256("corp-actions.exdiv@RHC");
        assertTrue(feeds.update(feed, bytes32("NVDA"), vid, payload));
        vm.prank(address(0xBEEF)); IFeeds.Entry memory stored = feeds.latest(feed, bytes32("NVDA")); assertEq(stored.verdictId, vid);

        bytes32 qid2 = _openFeed(keccak256("ex-div-mismatch"), 3); _seal(qid2);
        votes = _sameVotes(qid2, keccak256("feed-answer-two"));
        uint64 later = exDate + 10 days; bytes memory bad = _payload(bytes32("NVDA"), later, _exBody(later, true));
        bytes32 vid2 = _post(qid2, 1, 10000, 0, 0, keccak256(bad), votes);
        vm.expectEmit(true, true, true, false, address(feeds)); emit IFeeds.CrosscheckFailed(feed, bytes32("NVDA"), vid2, bytes32("EFFECTIVE_AT_MISMATCH"));
        assertFalse(feeds.update(feed, bytes32("NVDA"), vid2, bad));
        vm.prank(address(0xBEEF)); assertEq(feeds.latest(feed, bytes32("NVDA")).verdictId, vid);
    }

    function test_feed_poisoning_blocked() public {
        bytes32 doc = keccak256("same-source");
        bytes32 qid = _open(1, 3, doc, true); _seal(qid);
        MochiTypes.JurorVote[] memory votes = _sameVotes(qid, keccak256("attacker-answer"));
        uint64 asOf = uint64(block.timestamp); bytes memory payload = _payload(bytes32("NVDA"), asOf, _exBody(asOf, false));
        bytes32 vid = _post(qid, 1, 10000, 0, 0, keccak256(payload), votes);
        vm.expectRevert(abi.encodeWithSelector(IFeeds.VerdictNotEligible.selector, vid, bytes32("NOT_FEED_QUERY")));
        feeds.update(keccak256("corp-actions.exdiv@RHC"), bytes32("NVDA"), vid, payload);
        vm.prank(address(0xBEEF)); assertEq(feeds.latest(keccak256("corp-actions.exdiv@RHC"), bytes32("NVDA")).verdictId, bytes32(0));
    }

    function test_relay_cannot_drop_dissenter() public {
        bytes32 qid = _open(1, 5, keccak256("relay"), false); _seal(qid);
        bytes32[9] memory a; for (uint256 i; i < 4; ++i) a[i] = keccak256("agree"); a[4] = keccak256("dissent");
        MochiTypes.JurorVote[] memory votes = _votes(qid, a, 0);
        MochiTypes.Query memory q = escrow.getQuery(qid);
        MochiTypes.VerdictInput memory v = MochiTypes.VerdictInput(qid, q.round, 1, 8000, 16, 0, keccak256("answer"), keccak256("payload"), keccak256("evidence"));
        bytes32 dh = MochiTypes.hashVerdictAttestation(v, MochiTypes.hashVotes(votes));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(consensusPk, keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), dh)));
        votes[4].sig = ""; votes[4].answerHash = 0; votes[4].spansRoot = 0; votes[4].quoteHash = 0;
        vm.expectRevert(abi.encodeWithSelector(IMochiVerdicts.TimeoutMaskMismatch.selector, 0, 16));
        verdicts.post(v, votes, abi.encodePacked(r, s, vv));
        votes = _votes(qid, a, 0);
        (vv, r, s) = vm.sign(0x8888, keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), MochiTypes.hashVerdictAttestation(v, MochiTypes.hashVotes(_votes(qid, a, 0))))));
        vm.expectRevert(); verdicts.post(v, votes, abi.encodePacked(r, s, vv));
    }

    function test_selection_is_not_grindable_by_requester() public {
        bytes32 a = _open(1, 3, keccak256("grind-a"), false);
        bytes32 b = _open(1, 3, keccak256("grind-b"), false);
        MochiTypes.Query memory q = escrow.getQuery(a);
        // Regression (found on Robinhood Chain testnet): an early seal must surface SeedNotReady, not WrongStatus,
        // so relays retry instead of giving up.
        vm.expectRevert(abi.encodeWithSelector(IRandomness.SeedNotReady.selector, q.sealBlock, block.number));
        escrow.seal(a);
        uint64 sb = q.sealBlock; vm.roll(uint256(sb) + 1);
        bytes32 context = keccak256(abi.encode(a, q.docCommit, q.round));
        bytes32 expected = keccak256(abi.encode(context, blockhash(sb)));
        escrow.seal(a); assertEq(escrow.getQuery(a).seed, expected);
        q = escrow.getQuery(b); context = keccak256(abi.encode(b, q.docCommit, q.round));
        assertTrue(escrow.getQuery(b).seed == 0); // second query still sealed only after its own call
        escrow.seal(b); assertEq(escrow.getQuery(b).seed, keccak256(abi.encode(context, blockhash(q.sealBlock))));
    }

    function test_blockhashResealWorksAfterExpiredWindow() public {
        bytes32 qid = _open(1, 3, keccak256("reseal-window"), false);
        uint64 oldTicket = escrow.getQuery(qid).sealBlock;
        vm.roll(uint256(oldTicket) + 257);
        assertTrue(randomness.isExpired(oldTicket));
        escrow.reseal(qid);
        assertEq(escrow.getQuery(qid).sealBlock, randomness.nextTicket());
    }

    function test_voucher_path_and_replay() public {
        bytes32 doc = keccak256("voucher"); MochiTypes.Provenance memory p = _provenance(doc, 0, 0, 1); p.nonce = 801;
        MochiTypes.OpenParams memory op = MochiTypes.OpenParams(3, address(this));
        (, uint256 fee) = escrow.quote(1, 3, 1); (uint256 jf,) = escrow.quote(1, 3, 1);
        MochiTypes.AnonymaVoucher memory v = MochiTypes.AnonymaVoucher(keccak256("voucher-id"), escrow.computeQueryId(address(this), doc, p.nonce), 1, 3, jf + fee, 1, uint64(block.timestamp + 1 days));
        bytes32 sh = MochiTypes.hashAnonymaVoucher(v); (uint8 vv, bytes32 r, bytes32 s) = vm.sign(anonymaPk, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), sh)));
        bytes memory sig = abi.encodePacked(r, s, vv); uint256 floatBefore = escrow.anonymaFloat(); bytes memory intakeSig = _signProvenance(p);
        bytes32 qid = escrow.openWithVoucher(op, p, intakeSig, v, sig);
        assertEq(floatBefore - escrow.anonymaFloat(), jf + fee);
        p.nonce++; intakeSig = _signProvenance(p);
        vm.expectRevert(abi.encodeWithSelector(IQueryEscrow.VoucherUsed.selector, v.voucherId)); escrow.openWithVoucher(op, p, intakeSig, v, sig);
        _seal(qid); bytes32[9] memory a; a[0] = keccak256("A"); a[1] = a[0]; a[2] = keccak256("B");
        _post(qid, 2, 6666, 4, 0, 0, _votes(qid, a, 0));
        assertEq(escrow.anonymaFloat(), floatBefore - jf - fee + fee);
    }

    function test_shielded_path() public {
        uint256 amount = 1000 * USD; usdg.mint(address(this), amount); usdg.approve(address(shielded), amount); shielded.fund(amount);
        bytes32 doc = keccak256("shielded"); MochiTypes.Provenance memory p = _provenance(doc, 0, 0, 1);
        p.allowPanelDisclosure = false; p.payerCommit = keccak256("payer-commit"); p.nonce = 900;
        MochiTypes.OpenParams memory op = MochiTypes.OpenParams(3, address(this));
        (uint256 jf, uint256 pf) = escrow.quote(1, 3, 1); bytes32 nullifier = keccak256("nullifier");
        bytes memory intakeSig = _signProvenance(p);
        bytes32 qid = escrow.openShielded(op, p, intakeSig, nullifier, abi.encode(nullifier, jf + pf, address(escrow), escrow.computeQueryId(address(this), doc, p.nonce)));
        assertEq(uint256(escrow.getQuery(qid).payPath), uint256(MochiTypes.PayPath.SHIELDED));
        p.nonce = 901; intakeSig = _signProvenance(p); bytes32 qid2 = escrow.computeQueryId(address(this), doc, p.nonce);
        vm.expectRevert(); escrow.openShielded(op, p, intakeSig, nullifier, abi.encode(nullifier, jf + pf, address(escrow), qid2));
    }

    function test_panel_escalation_full() public {
        bytes32 qid = _openFeed(keccak256("panel-feed"), 3); _seal(qid);
        bytes32[9] memory a; a[0] = keccak256("A"); a[1] = a[0]; a[2] = keccak256("B");
        _post(qid, 2, 6666, 4, 0, 0, _votes(qid, a, 0));
        for (uint8 n = 5; n <= 9; n += 2) {
            uint256 f; uint256 p; (f,p) = escrow.quoteExpansion(qid,n); usdg.mint(address(this), f+p);
            vm.prank(vm.addr(feedRunnerPk)); escrow.expand(qid,n); _seal(qid);
            uint8 support = n - 3;
            bytes32[9] memory b; for (uint8 i; i < support; ++i) b[i] = keccak256(abi.encode("majority", n));
            for (uint8 i = support; i < n; ++i) b[i] = keccak256(abi.encode("minority", n, i));
            _post(qid, 2, uint16(uint256(support)*10000/n), uint32((uint256(1)<<n)-((uint256(1)<<support)-1)), 0, 0, _votes(qid,b,0));
        }
        vm.prank(vm.addr(feedRunnerPk)); bytes32 caseId = panel.escalate(qid); vm.roll(uint256(panel.getCase(caseId).sealBlock)+1); panel.draw(caseId);
        address[3] memory who = panel.panelOf(caseId,0); bytes32 answer = keccak256("panel answer");
        uint64 panelAsOf = uint64(block.timestamp);
        bytes memory panelPayload = _payload(bytes32("NVDA"), panelAsOf, _exBody(panelAsOf, false));
        bytes32 payloadHash = keccak256(panelPayload); bytes32 salt = keccak256("salt");
        for (uint256 i; i < 3; ++i) {
            bytes32 commitment = keccak256(abi.encode(caseId, uint8(0), who[i], answer, payloadHash, salt));
            vm.prank(who[i]); panel.commit(caseId, commitment);
        }
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]); panel.reveal(caseId, answer, payloadHash, salt);
        }
        panel.resolve(caseId); uint256 warpTo = block.timestamp + 1 days + 1; vm.warp(warpTo); panel.finalize(caseId);
        bytes32 vid = verdicts.latestVerdictOf(qid); MochiTypes.Verdict memory result = verdicts.getVerdict(vid);
        assertEq(result.round, MochiTypes.PANEL_ROUND); assertTrue(result.escalated);
        assertTrue(feeds.update(keccak256("corp-actions.exdiv@RHC"), bytes32("NVDA"), vid, panelPayload));
    }

    function test_equivocation_slashes_juror() public {
        bytes32 qid = _open(1, 3, keccak256("equivocate"), false); _seal(qid);
        MochiTypes.Query memory q = escrow.getQuery(qid); address[] memory seats = escrow.jurorsOf(qid); address key = seats[0]; uint256 pk = _pkFor(key);
        bytes32[3] memory a = [keccak256("answer-a"), keccak256("spans-a"), keccak256("quote-a")];
        bytes32[3] memory b = [keccak256("answer-b"), keccak256("spans-b"), keccak256("quote-b")];
        bytes32 ha = MochiTypes.hashJurorAnswer(qid,q.docCommit,q.schemaId,q.schemaVersion,a[0],a[1],a[2]);
        bytes32 hb = MochiTypes.hashJurorAnswer(qid,q.docCommit,q.schemaId,q.schemaVersion,b[0],b[1],b[2]);
        (uint8 va,bytes32 ra,bytes32 sa)=vm.sign(pk,keccak256(abi.encodePacked("\x19\x01",verdicts.domainSeparator(),ha)));
        (uint8 vb,bytes32 rb,bytes32 sb)=vm.sign(pk,keccak256(abi.encodePacked("\x19\x01",verdicts.domainSeparator(),hb)));
        uint256 sinkBefore=mochi.balanceOf(address(this)); verdicts.reportEquivocation(qid,q.docCommit,q.schemaId,q.schemaVersion,a,abi.encodePacked(ra,sa,va),b,abi.encodePacked(rb,sb,vb));
        assertEq(mochi.balanceOf(address(this))-sinkBefore,BOND); assertTrue(registry.getJuror(key).delisted);
        address[] memory none = new address[](0);
        address[] memory replacement = registry.selectJurors(address(escrow), qid, keccak256("after-slash"), 0, 3, none);
        for (uint256 i; i < replacement.length; ++i) assertTrue(replacement[i] != key);
    }

    function test_enrollment_squatting_blocked() public {
        address victim = vm.addr(0x9999); bytes32 d = registry.enrollmentDigest(address(this), victim, MEAS_JUROR, MochiTypes.JurorClass.LARGE_A);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(0x123456,keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",d)));
        vm.expectRevert(IJurorRegistry.BadKeySignature.selector); registry.enrollJuror(victim,MEAS_JUROR,MochiTypes.JurorClass.LARGE_A,BOND,abi.encodePacked(r,s,v));
    }

    function test_expire_refunds_by_path() public {
        bytes32 qid = _open(1,3,keccak256("expire"),false); uint256 paid=escrow.getQuery(qid).paid;
        uint256 before=usdg.balanceOf(address(this)); uint256 deadline=escrow.getQuery(qid).deadline;
        vm.warp(deadline+1); escrow.expire(qid);
        assertEq(usdg.balanceOf(address(this))-before,paid); assertEq(uint256(escrow.getQuery(qid).status),uint256(MochiTypes.QueryStatus.EXPIRED));
    }

    function testFuzz_agreementThresholds(uint8 selector, uint8 rawAgree) public {
        uint8 n = selector % 4 == 0 ? 3 : selector % 4 == 1 ? 5 : selector % 4 == 2 ? 7 : 9;
        uint8 agree = rawAgree % (n + 1); bytes32 qid=_open(1,n,keccak256(abi.encode("threshold",selector,rawAgree)),false); _seal(qid);
        bytes32[9] memory a; for(uint8 i;i<n;++i) a[i]=i<agree?keccak256("yes"):keccak256(abi.encode("no",i));
        MochiTypes.JurorVote[] memory votes=_votes(qid,a,0); uint8 k=MochiTypes.requiredAgree(n);
        uint16 bps=uint16(uint256(agree)*10000/n);
        if(agree>=k) {
            (MochiTypes.VerdictInput memory invalid, bytes memory invalidSig) = _preparePost(qid,2,bps,uint32((uint256(1)<<n)-agree),0,0,votes);
            vm.expectRevert(IMochiVerdicts.InconsistentStatus.selector); verdicts.post(invalid,votes,invalidSig);
            _post(qid,1,bps,uint32((uint256(1)<<n)-agree),0,keccak256("payload"),votes);
        } else {
            (MochiTypes.VerdictInput memory invalid, bytes memory invalidSig) = _preparePost(qid,1,bps,uint32((uint256(1)<<n)-agree),0,keccak256("payload"),votes);
            vm.expectRevert(IMochiVerdicts.InconsistentStatus.selector); verdicts.post(invalid,votes,invalidSig);
            _post(qid,2,bps,uint32((uint256(1)<<n)-agree),0,0,votes);
        }
    }

    /// Regression (found by this suite): at the exact k(N) boundary the floored agreementBps (7/9 → 7777) must only
    /// be accepted as VERDICT; posting HUNG there used to pass too.
    function test_boundary_N9_rejects_HUNG_accepts_VERDICT() public {
        bytes32 qid = _open(1, 9, keccak256("threshold-overlap"), false); _seal(qid);
        bytes32[9] memory a; for (uint8 i; i < 7; ++i) a[i] = keccak256("same");
        for (uint8 i = 7; i < 9; ++i) a[i] = keccak256(abi.encode("dissent", i));
        MochiTypes.JurorVote[] memory votes = _votes(qid, a, 0);
        (MochiTypes.VerdictInput memory hung, bytes memory hungSig) = _preparePost(qid, 2, 7777, 0x180, 0, 0, votes);
        vm.expectRevert(IMochiVerdicts.InconsistentStatus.selector);
        verdicts.post(hung, votes, hungSig);
        _post(qid, 1, 7777, 0x180, 0, keccak256("payload"), votes);
    }
}
