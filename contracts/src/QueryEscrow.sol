// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiStaking} from "@mochi/interfaces/IMochiStaking.sol";
import {IJurorRegistry} from "@mochi/interfaces/IJurorRegistry.sol";
import {ISchemaRegistry} from "@mochi/interfaces/ISchemaRegistry.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {IShieldedPayments} from "@mochi/interfaces/IShieldedPayments.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title QueryEscrow
/// @notice Prices, escrows, and settles Mochi jury queries across four payment paths.
contract QueryEscrow is IQueryEscrow, EIP712, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    IJurorRegistry public immutable registry;
    ISchemaRegistry public immutable schemas;
    IRandomness public immutable randomness;
    IMochiStaking public staking;
    IShieldedPayments public shielded;
    address public verdicts;
    address public panel;
    address public anonymaSigner;
    /// @notice Optional governance-configured recipient for the VERDICT protocol remainder; zero keeps staking route.
    address public reviewProtocolRecipient;

    mapping(uint8 => uint256) public classBase;
    mapping(uint8 => uint256) public classPerK;
    uint16 public protocolFeeBps = 2_000;
    uint256 public minProtocolFee = 10_000;
    uint16 public panelReserveBps = 2_500;
    uint64 public queryTtl = 1 hours;

    mapping(bytes32 => MochiTypes.Query) private _queries;
    mapping(bytes32 => address[]) private _seats;
    mapping(bytes32 => uint256[9]) private _seatFees;
    mapping(bytes32 => uint8) private _prevN;
    mapping(address => uint256) public override claimable;
    uint256 public override anonymaFloat;
    uint256 public override feedBudget;
    mapping(bytes32 => bool) public override voucherUsed;

    event PanelReserveBpsSet(uint16 bps);
    event QueryTtlSet(uint64 ttl);
    event VerdictsSet(address indexed verdicts);
    event PanelSet(address indexed panel);
    event StakingSet(address indexed staking);
    event ShieldedSet(address indexed shielded);
    event AnonymaSignerSet(address indexed signer);
    event ReviewProtocolRecipientSet(address indexed previousRecipient, address indexed newRecipient);
    event ReviewProtocolRevenueSettled(bytes32 indexed queryId, address indexed recipient, uint256 amount);

    error InvalidBps(uint16 bps);
    error ShieldedShortfall();
    error ZeroAddress();

    /// @notice Sets immutable protocol adapters and grants initial administration roles.
    constructor(
        address admin,
        IERC20 usdg_,
        IJurorRegistry registry_,
        ISchemaRegistry schemas_,
        IRandomness randomness_
    ) EIP712(MochiTypes.ESCROW_DOMAIN_NAME, MochiTypes.DOMAIN_VERSION) {
        if (admin == address(0)) revert ZeroAddress();
        usdg = usdg_;
        registry = registry_;
        schemas = schemas_;
        randomness = randomness_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
        _grantRole(MochiRoles.GUARDIAN_ROLE, admin);
    }

    /// @notice Sets the base and per-thousand-token price for a juror class.
    function setClassPrice(MochiTypes.JurorClass jurorClass, uint256 base, uint256 perK)
        external
        onlyRole(MochiRoles.GOVERNOR_ROLE)
    {
        classBase[uint8(jurorClass)] = base;
        classPerK[uint8(jurorClass)] = perK;
        emit ClassPriceSet(jurorClass, base, perK);
    }

    /// @notice Sets the protocol fee basis points and minimum fee.
    function setProtocolFee(uint16 bps, uint256 minFee) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (bps > MochiTypes.BPS) revert InvalidBps(bps);
        protocolFeeBps = bps;
        minProtocolFee = minFee;
        emit ProtocolFeeSet(bps, minFee);
    }

    /// @notice Sets the protocol fee share reserved for panel escalation.
    function setPanelReserveBps(uint16 bps) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (bps > MochiTypes.BPS) revert InvalidBps(bps);
        panelReserveBps = bps;
        emit PanelReserveBpsSet(bps);
    }

    /// @notice Sets the lifetime of an unsettled query.
    function setQueryTtl(uint64 ttl) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        queryTtl = ttl;
        emit QueryTtlSet(ttl);
    }

    /// @notice Sets the MochiVerdicts caller.
    function setVerdicts(address account) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        verdicts = account;
        emit VerdictsSet(account);
    }

    /// @notice Sets the PanelEscalation contract and reserve recipient.
    function setPanel(address account) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        panel = account;
        emit PanelSet(account);
    }

    /// @notice Sets the staking reward recipient.
    function setStaking(IMochiStaking account) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        staking = account;
        emit StakingSet(address(account));
    }

    /// @notice Optional integration hook for the VERDICT protocol-fee remainder. Zero preserves staking rewards.
    /// @dev This changes routing only; it does not transfer any token other than already-escrowed USDG settlement fees.
    function setReviewProtocolRecipient(address recipient) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        address previous = reviewProtocolRecipient;
        reviewProtocolRecipient = recipient;
        emit ReviewProtocolRecipientSet(previous, recipient);
    }

    /// @notice Sets the shielded payment adapter.
    function setShielded(IShieldedPayments account) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        shielded = account;
        emit ShieldedSet(address(account));
    }

    /// @notice Sets Anonyma's voucher signing key.
    function setAnonymaSigner(address account) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        anonymaSigner = account;
        emit AnonymaSignerSet(account);
    }

    /// @notice Pauses new query openings.
    function pause() external onlyRole(MochiRoles.GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resumes query openings. Governor-only (the timelock after launch): the guardian can stop the
    ///         escrow instantly, but reopening always waits out the governance delay.
    function unpause() external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        _unpause();
    }

    /// @inheritdoc IQueryEscrow
    function quote(uint32, uint8 n, uint32 tokensK)
        external
        view
        override
        returns (uint256 jurorFees, uint256 protocolFee)
    {
        if (!MochiTypes.isValidN(n)) revert InvalidN(n);
        for (uint8 i; i < n; ++i) {
            jurorFees += _price(i, tokensK);
        }
        protocolFee = _protocolFee(jurorFees);
    }

    /// @inheritdoc IQueryEscrow
    function quoteExpansion(bytes32 queryId, uint8 newN)
        external
        view
        override
        returns (uint256 jurorFees, uint256 protocolFee)
    {
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (!MochiTypes.isValidN(newN) || newN <= q.n) revert InvalidN(newN);
        for (uint8 i = q.n; i < newN; ++i) {
            jurorFees += _price(i, q.tokensK);
        }
        protocolFee = _protocolFee(jurorFees);
    }

    /// @inheritdoc IQueryEscrow
    function openWithUSDG(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig
    ) external override nonReentrant returns (bytes32 queryId) {
        uint256 total;
        (queryId, total) = _open(p, prov, intakeSig, MochiTypes.PayPath.USDG);
        usdg.safeTransferFrom(msg.sender, address(this), total);
    }

    /// @inheritdoc IQueryEscrow
    function openShielded(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig,
        bytes32 nullifier,
        bytes calldata proof
    ) external override nonReentrant returns (bytes32 queryId) {
        uint256 total;
        (queryId, total) = _open(p, prov, intakeSig, MochiTypes.PayPath.SHIELDED);
        _spendShielded(nullifier, total, queryId, proof);
    }

    /// @inheritdoc IQueryEscrow
    function openWithVoucher(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig,
        MochiTypes.AnonymaVoucher calldata voucher,
        bytes calldata anonymaSig
    ) external override nonReentrant returns (bytes32 queryId) {
        uint256 total;
        (queryId, total) = _open(p, prov, intakeSig, MochiTypes.PayPath.ANONYMA);
        _useVoucher(voucher, anonymaSig, prov.schemaId, p.n, total, queryId);
    }

    /// @inheritdoc IQueryEscrow
    function openFeed(MochiTypes.OpenParams calldata p, MochiTypes.Provenance calldata prov, bytes calldata intakeSig)
        external
        override
        nonReentrant
        returns (bytes32 queryId)
    {
        if (!hasRole(MochiRoles.FEED_RUNNER_ROLE, msg.sender)) revert NotAuthorized(msg.sender);
        if (!prov.isPublic || prov.kind != uint8(MochiTypes.ProvenanceKind.FETCHED)) {
            revert FeedQueryMustBePublicFetched();
        }
        uint256 total;
        (queryId, total) = _open(p, prov, intakeSig, MochiTypes.PayPath.FEED);
        uint256 available = feedBudget;
        if (total > available) revert InsufficientFeedBudget(total, available);
        feedBudget = available - total;
    }

    function _open(
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        bytes calldata intakeSig,
        MochiTypes.PayPath path
    ) private returns (bytes32 queryId, uint256 total) {
        if (paused()) revert EnforcedPause();
        if (!MochiTypes.isValidN(p.n)) revert InvalidN(p.n);
        if (p.refundTo == address(0)) revert InvalidRefundTo();
        if (prov.tokensK < 1) revert ZeroTokens();
        // The intake grant names its opener and expires; queryId below is fixed by (opener, docCommit, nonce), so a
        // grant opens at most one query and a copied grant cannot open one for anybody else.
        if (prov.opener != msg.sender) revert NotAuthorized(msg.sender);
        if (block.timestamp > prov.expiry) revert ProvenanceExpired(prov.expiry);
        uint16 schemaVersion = schemas.latest(prov.schemaId);
        if (schemaVersion == 0 || schemaVersion != prov.schemaVersion) revert SchemaNotActive(prov.schemaId);
        bytes32 provenanceHash = MochiTypes.hashProvenanceCalldata(prov);
        queryId = computeQueryId(msg.sender, prov.docCommit, prov.nonce);
        if (_queries[queryId].status != MochiTypes.QueryStatus.NONE) revert QueryExists(queryId);
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(provenanceHash), intakeSig);
        total = _recordOpen(queryId, p, prov, path, provenanceHash);
        _emitOpened(queryId, path, total);
        // Interaction last: one registry call checks the intake key and fixes this query's juror pools, in the
        // transaction that drew the first ticket, so before any seed of the query exists.
        if (err != ECDSA.RecoverError.NoError || !registry.openSelection(queryId, signer)) revert BadIntakeSignature();
    }

    function _recordOpen(
        bytes32 queryId,
        MochiTypes.OpenParams calldata p,
        MochiTypes.Provenance calldata prov,
        MochiTypes.PayPath path,
        bytes32 provenanceHash
    ) private returns (uint256 total) {
        // slither-disable-next-line uninitialized-local -- accumulator, starts at zero
        uint256 jurorFees;
        for (uint8 i; i < p.n; ++i) {
            uint256 fee = _price(i, prov.tokensK);
            _seatFees[queryId][i] = fee;
            jurorFees += fee;
        }
        uint256 feeProtocol = _protocolFee(jurorFees);
        total = jurorFees + feeProtocol;
        MochiTypes.Query storage q = _queries[queryId];
        q.docCommit = prov.docCommit;
        q.schemaId = prov.schemaId;
        q.schemaVersion = prov.schemaVersion;
        q.n = p.n;
        q.isPublic = prov.isPublic;
        q.allowPanelDisclosure = prov.allowPanelDisclosure;
        q.payPath = path;
        q.status = MochiTypes.QueryStatus.OPEN;
        q.provenanceKind = MochiTypes.ProvenanceKind(prov.kind);
        q.originId = prov.originId;
        q.tokensK = prov.tokensK;
        q.provenanceHash = provenanceHash;
        q.paramsHash = prov.paramsHash;
        q.payerCommit = prov.payerCommit;
        q.payer = msg.sender;
        q.refundTo = p.refundTo;
        q.openedAt = uint64(block.timestamp);
        q.deadline = uint64(block.timestamp) + queryTtl;
        q.sealBlock = randomness.nextTicket();
        q.paid = total;
        q.protocolFee = feeProtocol;
    }

    function _emitOpened(bytes32 queryId, MochiTypes.PayPath path, uint256 total) private {
        MochiTypes.Query storage q = _queries[queryId];
        emit QueryOpened(queryId, path, q.schemaId, q.schemaVersion, q.n, q.isPublic, q.docCommit, total, q.sealBlock);
    }

    /// @inheritdoc IQueryEscrow
    function seal(bytes32 queryId) external override {
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.OPEN) revert WrongStatus(queryId, q.status);
        // Seed timing is enforced by the randomness source; its SeedNotReady / SeedWindowMissed revert bubbles up
        // unchanged so relays can tell "retry later" from "wrong state".
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        bytes32 seed = randomness.seed(keccak256(abi.encode(queryId, q.docCommit, q.round)), q.sealBlock);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        address[] memory newJurors =
            registry.selectJurors(address(this), queryId, seed, _prevN[queryId], q.n, _seats[queryId]);
        for (uint256 i; i < newJurors.length; ++i) {
            _seats[queryId].push(newJurors[i]);
        }
        q.seed = seed;
        q.status = MochiTypes.QueryStatus.SEALED;
        emit QuerySealed(queryId, q.round, seed, newJurors);
    }

    /// @inheritdoc IQueryEscrow
    function reseal(bytes32 queryId) external override {
        MochiTypes.Query storage q = _requireQuery(queryId);
        // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
        if (q.status != MochiTypes.QueryStatus.OPEN || !randomness.isExpired(q.sealBlock)) {
            revert WrongStatus(queryId, q.status);
        }
        emit QueryResealed(queryId, q.round, _nextTicket(queryId, q));
    }

    /// @inheritdoc IQueryEscrow
    function expand(bytes32 queryId, uint8 newN) external override nonReentrant {
        MochiTypes.Query storage q = _prepareExpansion(queryId, newN, MochiTypes.PayPath.USDG);
        uint256 total = _snapshotExpansion(queryId, q.n, newN, q.tokensK, q);
        if (q.payPath == MochiTypes.PayPath.USDG) usdg.safeTransferFrom(msg.sender, address(this), total);
        _finishExpansion(queryId, q, newN, total);
    }

    /// @inheritdoc IQueryEscrow
    function expandShielded(bytes32 queryId, uint8 newN, bytes32 nullifier, bytes calldata proof)
        external
        override
        nonReentrant
    {
        MochiTypes.Query storage q = _prepareExpansion(queryId, newN, MochiTypes.PayPath.SHIELDED);
        uint256 total = _snapshotExpansion(queryId, q.n, newN, q.tokensK, q);
        _spendShielded(nullifier, total, queryId, proof);
        _finishExpansion(queryId, q, newN, total);
    }

    /// @inheritdoc IQueryEscrow
    function expandWithVoucher(
        bytes32 queryId,
        uint8 newN,
        MochiTypes.AnonymaVoucher calldata voucher,
        bytes calldata anonymaSig
    ) external override nonReentrant {
        MochiTypes.Query storage q = _prepareExpansion(queryId, newN, MochiTypes.PayPath.ANONYMA);
        uint256 total = _snapshotExpansion(queryId, q.n, newN, q.tokensK, q);
        _useVoucher(voucher, anonymaSig, q.schemaId, newN, total, queryId);
        _finishExpansion(queryId, q, newN, total);
    }

    function _prepareExpansion(bytes32 queryId, uint8 newN, MochiTypes.PayPath dedicatedPath)
        private
        view
        returns (MochiTypes.Query storage q)
    {
        q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.HUNG || block.timestamp > q.deadline) {
            revert WrongStatus(queryId, q.status);
        }
        if (!MochiTypes.isValidN(newN) || newN <= q.n) revert InvalidN(newN);
        if (q.payPath == MochiTypes.PayPath.SHIELDED || q.payPath == MochiTypes.PayPath.ANONYMA) {
            if (dedicatedPath != q.payPath) revert NotAuthorized(msg.sender);
        } else if (dedicatedPath == MochiTypes.PayPath.SHIELDED || dedicatedPath == MochiTypes.PayPath.ANONYMA) {
            revert NotAuthorized(msg.sender);
        }
        if (q.payPath == MochiTypes.PayPath.FEED && !hasRole(MochiRoles.FEED_RUNNER_ROLE, msg.sender)) {
            revert NotAuthorized(msg.sender);
        }
    }

    function _snapshotExpansion(bytes32 queryId, uint8 fromN, uint8 newN, uint32 tokensK, MochiTypes.Query storage q)
        private
        returns (uint256 total)
    {
        // slither-disable-next-line uninitialized-local -- accumulator, starts at zero
        uint256 jurorFees;
        for (uint8 i = fromN; i < newN; ++i) {
            uint256 fee = _price(i, tokensK);
            _seatFees[queryId][i] = fee;
            jurorFees += fee;
        }
        q.protocolFee = _protocolFee(jurorFees);
        total = jurorFees + q.protocolFee;
    }

    function _finishExpansion(bytes32 queryId, MochiTypes.Query storage q, uint8 newN, uint256 total) private {
        if (q.payPath == MochiTypes.PayPath.FEED) {
            uint256 available = feedBudget;
            if (total > available) revert InsufficientFeedBudget(total, available);
            feedBudget = available - total;
        }
        _prevN[queryId] = q.n;
        q.n = newN;
        ++q.round;
        q.status = MochiTypes.QueryStatus.OPEN;
        q.paid += total;
        q.deadline = uint64(block.timestamp) + queryTtl;
        emit QueryExpanded(queryId, q.round, newN, total, _nextTicket(queryId, q));
    }

    /// @dev Every ticket after the open's: draw it, then (the interaction last) re-snapshot the juror pools in the same
    ///      transaction, so (as at open) they are fixed before the round's seed can be known, and the round can seat keys
    ///      that joined since the last ticket (e.g. a replacement for a key that left).
    function _nextTicket(bytes32 queryId, MochiTypes.Query storage q) private returns (uint64 ticket) {
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        ticket = randomness.nextTicket();
        q.sealBlock = ticket;
        // slither-disable-next-line unused-return -- no intake key here (open checks it); only the snapshot is wanted
        registry.openSelection(queryId, address(0));
    }

    /// @inheritdoc IQueryEscrow
    function settle(bytes32 queryId, uint8 round, MochiTypes.VerdictStatus result, uint32 timeoutMask)
        external
        override
        nonReentrant
    {
        if (msg.sender != verdicts) revert NotAuthorized(msg.sender);
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.SEALED) revert WrongStatus(queryId, q.status);
        if (round != q.round) revert WrongRound(q.round, round);
        if (result != MochiTypes.VerdictStatus.VERDICT && result != MochiTypes.VerdictStatus.HUNG) {
            revert WrongStatus(queryId, q.status);
        }
        // slither-disable-next-line uninitialized-local -- accumulator, starts at zero
        uint256 refund;
        // slither-disable-next-line uninitialized-local -- accumulator, starts at zero
        uint256 jurorsPaid;
        for (uint8 s = _prevN[queryId]; s < q.n; ++s) {
            uint256 fee = _seatFees[queryId][s];
            if ((timeoutMask & (uint32(1) << s)) != 0) {
                refund += fee;
            } else {
                // aderyn-fp-next-line(reentrancy-state-change) view call (staticcall): cannot reenter or change state
                claimable[registry.operatorOf(_seats[queryId][s])] += fee;
                jurorsPaid += fee;
            }
        }
        uint256 protocol = q.protocolFee;
        q.protocolFee = 0;
        if (result == MochiTypes.VerdictStatus.VERDICT) {
            q.status = MochiTypes.QueryStatus.DECIDED;
            uint256 panelCut = protocol * panelReserveBps / MochiTypes.BPS;
            uint256 rest = protocol - panelCut;
            if (panelCut != 0) usdg.safeTransfer(panel, panelCut);
            if (rest != 0) {
                address recipient = reviewProtocolRecipient;
                if (recipient == address(0)) {
                    usdg.forceApprove(address(staking), rest);
                    staking.notifyReward(rest);
                    usdg.forceApprove(address(staking), 0);
                } else {
                    usdg.safeTransfer(recipient, rest);
                    emit ReviewProtocolRevenueSettled(queryId, recipient, rest);
                }
            }
        } else {
            q.status = MochiTypes.QueryStatus.HUNG;
            refund += protocol;
        }
        uint256 refunded = refund;
        _refund(queryId, q, refund);
        emit QuerySettled(queryId, round, result, jurorsPaid, refunded);
    }

    /// @inheritdoc IQueryEscrow
    function expire(bytes32 queryId) external override nonReentrant {
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.OPEN && q.status != MochiTypes.QueryStatus.SEALED) {
            revert WrongStatus(queryId, q.status);
        }
        if (block.timestamp <= q.deadline) revert DeadlineNotPassed(q.deadline);
        uint256 refund = q.protocolFee;
        q.protocolFee = 0;
        for (uint8 s = _prevN[queryId]; s < q.n; ++s) {
            refund += _seatFees[queryId][s];
        }
        q.status = MochiTypes.QueryStatus.EXPIRED;
        _refund(queryId, q, refund);
        emit QueryExpired(queryId, refund);
    }

    function _refund(bytes32 queryId, MochiTypes.Query storage q, uint256 amount) private {
        if (amount == 0) return;
        if (q.payPath == MochiTypes.PayPath.USDG || q.payPath == MochiTypes.PayPath.SHIELDED) {
            usdg.safeTransfer(q.refundTo, amount);
        } else if (q.payPath == MochiTypes.PayPath.ANONYMA) {
            anonymaFloat += amount;
        } else {
            feedBudget += amount;
        }
        emit Refunded(queryId, q.refundTo, amount);
    }

    /// @inheritdoc IQueryEscrow
    function markEscalated(bytes32 queryId) external override {
        if (msg.sender != panel) revert NotAuthorized(msg.sender);
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.HUNG) revert WrongStatus(queryId, q.status);
        q.status = MochiTypes.QueryStatus.ESCALATED;
        emit QueryEscalated(queryId);
    }

    /// @inheritdoc IQueryEscrow
    function markDecided(bytes32 queryId) external override {
        if (msg.sender != verdicts) revert NotAuthorized(msg.sender);
        MochiTypes.Query storage q = _requireQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.ESCALATED) revert WrongStatus(queryId, q.status);
        q.status = MochiTypes.QueryStatus.DECIDED;
        emit QueryDecidedByPanel(queryId);
    }

    /// @inheritdoc IQueryEscrow
    function claim() external override nonReentrant {
        uint256 amount = claimable[msg.sender];
        claimable[msg.sender] = 0;
        if (amount != 0) usdg.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @inheritdoc IQueryEscrow
    function fundAnonymaFloat(uint256 amount) external override nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        anonymaFloat += amount;
        emit AnonymaFloatFunded(msg.sender, amount);
    }

    /// @inheritdoc IQueryEscrow
    function fundFeedBudget(uint256 amount) external override nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        feedBudget += amount;
        emit FeedBudgetFunded(msg.sender, amount);
    }

    /// @inheritdoc IQueryEscrow
    function getQuery(bytes32 queryId) external view override returns (MochiTypes.Query memory) {
        return _queries[queryId];
    }

    /// @inheritdoc IQueryEscrow
    function jurorsOf(bytes32 queryId) external view override returns (address[] memory) {
        return _seats[queryId];
    }

    /// @inheritdoc IQueryEscrow
    function prevNOf(bytes32 queryId) external view override returns (uint8) {
        return _prevN[queryId];
    }

    /// @inheritdoc IQueryEscrow
    function seatFeeOf(bytes32 queryId, uint8 seat) external view override returns (uint256) {
        return _seatFees[queryId][seat];
    }

    /// @inheritdoc IQueryEscrow
    function computeQueryId(address sender, bytes32 docCommit, uint64 nonce) public view override returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), sender, docCommit, nonce));
    }

    /// @inheritdoc IQueryEscrow
    function domainSeparator() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _requireQuery(bytes32 queryId) private view returns (MochiTypes.Query storage q) {
        q = _queries[queryId];
        if (q.status == MochiTypes.QueryStatus.NONE) revert UnknownQuery(queryId);
    }

    function _price(uint8 seat, uint32 tokensK) private view returns (uint256) {
        uint8 c = uint8(registry.seatClass(seat));
        return classBase[c] + classPerK[c] * uint256(tokensK);
    }

    function _protocolFee(uint256 jurorFees) private view returns (uint256) {
        uint256 variableFee = jurorFees * protocolFeeBps / MochiTypes.BPS;
        return variableFee > minProtocolFee ? variableFee : minProtocolFee;
    }

    function _useVoucher(
        MochiTypes.AnonymaVoucher calldata voucher,
        bytes calldata sig,
        uint32 schemaId,
        uint8 n,
        uint256 amount,
        bytes32 queryId
    ) private {
        // slither-disable-next-line unused-return -- err is checked; the third value only details err
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(_hashTypedDataV4(MochiTypes.hashAnonymaVoucher(voucher)), sig);
        if (err != ECDSA.RecoverError.NoError || signer != anonymaSigner) revert BadVoucherSignature();
        if (voucher.expiry < block.timestamp) revert VoucherExpired();
        if (voucherUsed[voucher.voucherId]) revert VoucherUsed(voucher.voucherId);
        if (
            voucher.queryId != queryId || voucher.schemaId != schemaId || voucher.n != n
                || amount > voucher.maxAmount
        ) revert VoucherMismatch();
        voucherUsed[voucher.voucherId] = true;
        uint256 available = anonymaFloat;
        if (amount > available) revert InsufficientFloat(amount, available);
        anonymaFloat = available - amount;
        emit AnonymaVoucherUsed(voucher.voucherId, queryId, voucher.tier, amount);
    }

    /// @dev Pulls `total` USDG through the shielded pool, bound to `queryId`, and checks it actually arrived.
    ///      Every QueryEscrow path that credits or moves USDG is nonReentrant and the lock is held here, so a reentrant
    ///      deposit cannot be counted both as this payment and as a float/budget/query credit (see
    ///      test/escrow/ShieldedSpendReentrancy.t.sol); a direct transfer that lands meanwhile is a real payment.
    function _spendShielded(bytes32 nullifier, uint256 total, bytes32 queryId, bytes calldata proof) private {
        // slither-disable-next-line reentrancy-balance -- every crediting path is locked; see @dev above
        uint256 beforeBal = usdg.balanceOf(address(this));
        shielded.spend(nullifier, total, address(this), queryId, proof);
        uint256 afterBal = usdg.balanceOf(address(this));
        if (afterBal < beforeBal || afterBal - beforeBal < total) revert ShieldedShortfall();
    }
}
