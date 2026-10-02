// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {MochiToken} from "@mochi/MochiToken.sol";
import {BlockhashRandomness} from "@mochi/BlockhashRandomness.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {SchemaRegistry} from "@mochi/SchemaRegistry.sol";
import {JurorRegistry} from "@mochi/JurorRegistry.sol";
import {QueryEscrow} from "@mochi/QueryEscrow.sol";
import {MochiStaking} from "@mochi/MochiStaking.sol";
import {MochiVerdicts} from "@mochi/MochiVerdicts.sol";
import {Feeds} from "@mochi/Feeds.sol";
import {StockTokenCrosscheck} from "@mochi/StockTokenCrosscheck.sol";
import {PanelEscalation} from "@mochi/PanelEscalation.sol";
import {ReceiptAnchor} from "@mochi/ReceiptAnchor.sol";
import {MockUSDG} from "@mochi/mocks/MockUSDG.sol";
import {MockShieldedPayments} from "@mochi/mocks/MockShieldedPayments.sol";
import {MockStockToken} from "@mochi/mocks/MockStockToken.sol";

abstract contract Harness is Test {
    uint256 internal constant BOND = 25_000 ether;
    uint256 internal constant USD = 1e6;
    bytes32 internal constant ORIGIN = keccak256("www.sec.gov");
    bytes32 internal constant MEAS_JUROR = keccak256("juror-measurement");
    bytes32 internal constant MEAS_INTAKE = keccak256("intake-measurement");
    bytes32 internal constant MEAS_CONSENSUS = keccak256("consensus-measurement");
    uint256 internal intakePk = 0x1111;
    uint256 internal consensusPk = 0x2222;
    uint256 internal anonymaPk = 0x3333;
    uint256 internal attestorPk = 0x4444;
    uint256 internal feedRunnerPk = 0x5555;
    uint256 internal stakerPk = 0x6666;
    uint256[3][5] internal jurorPks;
    address[5] internal panelists;

    MockUSDG internal usdg;
    MochiToken internal mochi;
    IRandomness internal randomness;
    SchemaRegistry internal schemas;
    JurorRegistry internal registry;
    QueryEscrow internal escrow;
    MochiStaking internal staking;
    MochiVerdicts internal verdicts;
    PanelEscalation internal panel;
    Feeds internal feeds;
    StockTokenCrosscheck internal crosscheck;
    ReceiptAnchor internal anchor;
    MockShieldedPayments internal shielded;
    MockStockToken internal stock;

    function setUp() public virtual {
        usdg = new MockUSDG();
        mochi = new MochiToken(address(this), 10 ** 27);
        randomness = _newRandomness();
        schemas = new SchemaRegistry(address(this), 0);
        registry = new JurorRegistry(address(this), mochi, address(this), BOND, 7 days);
        escrow = new QueryEscrow(address(this), usdg, registry, schemas, randomness);
        staking = new MochiStaking(address(this), mochi, usdg, 7 days, 7 days);
        verdicts = new MochiVerdicts(address(this), escrow, registry, address(0));
        panel = new PanelEscalation(address(this), usdg, escrow, verdicts, randomness, 2_500 * USD, 25 * USD);
        feeds = new Feeds(address(this), verdicts, escrow, usdg, address(this));
        crosscheck = new StockTokenCrosscheck(address(this));
        anchor = new ReceiptAnchor(address(this), address(this));
        shielded = new MockShieldedPayments(usdg);
        stock = new MockStockToken();

        escrow.setVerdicts(address(verdicts));
        escrow.setPanel(address(panel));
        escrow.setStaking(staking);
        escrow.setShielded(shielded);
        escrow.setAnonymaSigner(vm.addr(anonymaPk));
        for (uint8 c; c < 5; ++c) escrow.setClassPrice(MochiTypes.JurorClass(c), 4 * USD, 1 * USD);
        escrow.grantRole(MochiRoles.FEED_RUNNER_ROLE, vm.addr(feedRunnerPk));
        verdicts.setPanel(address(panel));
        registry.grantRole(keccak256("mochi.role.SLASHER"), address(verdicts));
        registry.grantRole(MochiRoles.ATTESTOR_ROLE, vm.addr(attestorPk));
        panel.grantRole(MochiRoles.FEED_RUNNER_ROLE, vm.addr(feedRunnerPk));
        registry.setMeasurement(MEAS_JUROR, MochiTypes.Role.JUROR, true);
        registry.setMeasurement(MEAS_INTAKE, MochiTypes.Role.INTAKE, true);
        registry.setMeasurement(MEAS_CONSENSUS, MochiTypes.Role.CONSENSUS, true);
        registry.registerServiceKey(vm.addr(intakePk), address(this), MEAS_INTAKE, MochiTypes.Role.INTAKE);
        registry.registerServiceKey(vm.addr(consensusPk), address(this), MEAS_CONSENSUS, MochiTypes.Role.CONSENSUS);
        for (uint32 s = 1; s <= 7; ++s) schemas.propose(s, keccak256(abi.encode("schema", s)), keccak256(abi.encode("prompt", s)), keccak256("tol"), keccak256(abi.encode("crosscheck", s)));

        address[] memory attested = new address[](17);
        attested[0] = vm.addr(intakePk);
        attested[1] = vm.addr(consensusPk);
        for (uint8 c; c < 5; ++c) {
            for (uint8 j; j < 3; ++j) {
                uint256 pk = uint256(keccak256(abi.encode("juror", c, j)));
                jurorPks[c][j] = pk;
                address key = vm.addr(pk);
                address operator = vm.addr(uint256(keccak256(abi.encode("operator", c, j))));
                mochi.transfer(operator, BOND);
                vm.prank(operator); mochi.approve(address(registry), BOND);
                bytes32 digest = registry.enrollmentDigest(operator, key, MEAS_JUROR, MochiTypes.JurorClass(c));
                (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(pk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
                vm.prank(operator); registry.enrollJuror(key, MEAS_JUROR, MochiTypes.JurorClass(c), BOND, abi.encodePacked(r, sigS, v));
                attested[2 + c * 3 + j] = key;
            }
        }
        vm.prank(vm.addr(attestorPk)); registry.refreshAttestation(attested, uint64(block.timestamp + 30 days));
        for (uint8 i; i < 5; ++i) {
            panelists[i] = vm.addr(uint256(keccak256(abi.encode("panelist", i))));
            usdg.mint(panelists[i], 10_000 * USD);
            vm.prank(panelists[i]); usdg.approve(address(panel), type(uint256).max);
            vm.prank(panelists[i]); panel.stake(2_500 * USD);
        }
        address payer = vm.addr(0x7777);
        usdg.mint(payer, 1_000_000 * USD);
        vm.prank(payer); usdg.approve(address(escrow), type(uint256).max);
        usdg.mint(vm.addr(feedRunnerPk), 1_000_000 * USD);
        vm.prank(vm.addr(feedRunnerPk)); usdg.approve(address(panel), type(uint256).max);
        usdg.mint(address(this), 1_000_000 * USD);
        usdg.approve(address(escrow), type(uint256).max);
        usdg.approve(address(shielded), type(uint256).max);
        usdg.approve(address(staking), type(uint256).max);
        escrow.fundFeedBudget(500_000 * USD);
        escrow.fundAnonymaFloat(500_000 * USD);
        mochi.approve(address(staking), type(uint256).max);
        staking.stake(1 ether);

        bytes32[] memory origins = new bytes32[](1); origins[0] = ORIGIN;
        bytes32 exFeed = keccak256("corp-actions.exdiv@RHC");
        feeds.register(exFeed, uint32(MochiTypes.SchemaId.EX_DIVIDEND), origins, address(crosscheck), 10 * USD);
        feeds.register(keccak256("corp-actions.split@RHC"), uint32(MochiTypes.SchemaId.SPLIT), origins, address(crosscheck), 10 * USD);
        feeds.register(keccak256("earnings@RHC"), uint32(MochiTypes.SchemaId.EARNINGS), origins, address(0), 10 * USD);
        crosscheck.setToken(bytes32("NVDA"), address(stock));
    }

    function _newRandomness() internal virtual returns (IRandomness) {
        return IRandomness(address(new BlockhashRandomness(1)));
    }

    /// @dev A public grant for address(this): schema 1, nonce = uint64(docCommit), expiring in one hour.
    function _provenance(bytes32 docCommit, uint8 kind, bytes32 origin, uint32 tokensK) internal view returns (MochiTypes.Provenance memory p) {
        p.docCommit = docCommit; p.kind = kind; p.originId = origin; p.tokensK = tokensK;
        if (kind == 1) { p.fetchedAt = uint64(block.timestamp); p.transcriptHash = keccak256("tls"); }
        p.opener = address(this); p.schemaId = 1; p.schemaVersion = 1; p.isPublic = true; p.allowPanelDisclosure = true;
        p.nonce = uint64(uint256(docCommit)); p.expiry = uint64(block.timestamp + 1 hours);
    }
    function _signProvenance(MochiTypes.Provenance memory p) internal view returns (bytes memory) {
        bytes32 structHash = MochiTypes.hashProvenance(p);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(intakePk, digest);
        return abi.encodePacked(r, s, v);
    }
    function _open(uint32 schema, uint8 n, bytes32 doc, bool fetched) internal returns (bytes32 qid) {
        MochiTypes.Provenance memory p = _provenance(doc, fetched ? 1 : 0, fetched ? ORIGIN : bytes32(0), 1);
        p.schemaId = schema;
        MochiTypes.OpenParams memory op = MochiTypes.OpenParams(n, address(this));
        (uint256 jf, uint256 pf) = escrow.quote(schema, n, 1);
        usdg.mint(address(this), jf + pf);
        qid = escrow.openWithUSDG(op, p, _signProvenance(p));
    }
    function _openFeed(bytes32 doc, uint8 n) internal returns (bytes32 qid) {
        MochiTypes.Provenance memory p = _provenance(doc, 1, ORIGIN, 1);
        p.schemaId = uint32(MochiTypes.SchemaId.EX_DIVIDEND); p.opener = vm.addr(feedRunnerPk);
        MochiTypes.OpenParams memory op = MochiTypes.OpenParams(n, vm.addr(feedRunnerPk));
        bytes memory sig = _signProvenance(p);
        vm.prank(vm.addr(feedRunnerPk)); qid = escrow.openFeed(op, p, sig);
    }
    function _seal(bytes32 qid) internal {
        MochiTypes.Query memory q = escrow.getQuery(qid);
        vm.roll(uint256(q.sealBlock) + 1);
        escrow.seal(qid);
    }
    function _votes(bytes32 qid, bytes32[9] memory answers, uint32 timeoutMask) internal view returns (MochiTypes.JurorVote[] memory votes) {
        address[] memory seats = escrow.jurorsOf(qid);
        MochiTypes.Query memory q = escrow.getQuery(qid);
        votes = new MochiTypes.JurorVote[](seats.length);
        for (uint256 i; i < seats.length; ++i) {
            votes[i].juror = seats[i];
            if ((timeoutMask & uint32(uint256(1) << i)) != 0) continue;
            uint256 pk = _pkFor(seats[i]);
            votes[i].answerHash = answers[i]; votes[i].spansRoot = keccak256(abi.encode("spans", i)); votes[i].quoteHash = keccak256(abi.encode("quote", i));
            bytes32 sh = MochiTypes.hashJurorAnswer(qid, q.docCommit, q.schemaId, q.schemaVersion, answers[i], votes[i].spansRoot, votes[i].quoteHash);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), sh)));
            votes[i].sig = abi.encodePacked(r, s, v);
        }
    }
    function _pkFor(address key) internal view returns (uint256) {
        if (key == vm.addr(intakePk)) return intakePk;
        for (uint8 c; c < 5; ++c) for (uint8 j; j < 3; ++j) if (vm.addr(jurorPks[c][j]) == key) return jurorPks[c][j];
        revert("unknown juror key");
    }
    function _post(bytes32 qid, uint8 status, uint16 agreement, uint32 dissent, uint32 timeouts, bytes32 payloadHash, MochiTypes.JurorVote[] memory votes) internal returns (bytes32 vid) {
        (MochiTypes.VerdictInput memory v, bytes memory sig) = _preparePost(qid, status, agreement, dissent, timeouts, payloadHash, votes);
        vid = verdicts.post(v, votes, sig);
    }
    function _preparePost(bytes32 qid, uint8 status, uint16 agreement, uint32 dissent, uint32 timeouts, bytes32 payloadHash, MochiTypes.JurorVote[] memory votes) internal view returns (MochiTypes.VerdictInput memory v, bytes memory sig) {
        MochiTypes.Query memory q = escrow.getQuery(qid);
        v = MochiTypes.VerdictInput(qid, q.round, status, agreement, dissent, timeouts, keccak256("answer"), payloadHash, keccak256("evidence"));
        bytes32 vh = MochiTypes.hashVotes(votes);
        bytes32 sh = MochiTypes.hashVerdictAttestation(v, vh);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(consensusPk, keccak256(abi.encodePacked("\x19\x01", verdicts.domainSeparator(), sh)));
        sig = abi.encodePacked(r, s, vv);
    }
    function _payload(bytes32 key, uint64 asOf, MochiTypes.ExDividendBody memory b) internal pure returns (bytes memory) { return abi.encode(key, asOf, abi.encode(b)); }
    function _exBody(uint64 date, bool effect) internal pure returns (MochiTypes.ExDividendBody memory) { return MochiTypes.ExDividendBody(bytes32("NVDA"), date, 0, 0, 100000000, bytes32("USD"), 0, effect); }
}
