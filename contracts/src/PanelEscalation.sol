// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IPanelEscalation} from "@mochi/interfaces/IPanelEscalation.sol";
import {IQueryEscrow} from "@mochi/interfaces/IQueryEscrow.sol";
import {IMochiVerdicts} from "@mochi/interfaces/IMochiVerdicts.sol";
import {IRandomness} from "@mochi/interfaces/IRandomness.sol";
import {MochiTypes} from "@mochi/libraries/MochiTypes.sol";
import {MochiRoles} from "@mochi/libraries/MochiRoles.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PanelEscalation
/// @notice Stake-gated human panel resolution for HUNG queries.
/// @dev Draw integrity (see IPanelEscalation): the eligible set is fixed when a draw is sealed, before its seed can be
///      known. Eligibility is "active at seal number n and joined warmup tickets before its ticket", read from join and
///      exit records that cannot change for a position a pending draw may pick, and the draw only reads positions below
///      the frozen pool length. Liveness: draws are resumable, so ineligible (dead) positions cost gas but cannot make
///      a possible draw fail; a draw ends only when it is impossible (fewer than three eligible at the seal), its seed
///      is lost, or its expiry (sealTime + unstakeCooldown) passed; positions no pending draw can pick are pruned or
///      reused at any time; payouts that the recipient refuses become claimable balances instead of reverting; and
///      reveals cannot carry the zero result MochiVerdicts rejects.
contract PanelEscalation is IPanelEscalation, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    IQueryEscrow public immutable escrow;
    IMochiVerdicts public immutable verdicts;
    IRandomness public immutable randomness;

    uint64 public commitWindow = 24 hours;
    uint64 public revealWindow = 24 hours;
    uint64 public appealWindow = 24 hours;
    uint64 public unstakeCooldown = 7 days;
    /// @notice Time a sealed panel has to be drawn. Kept below unstakeCooldown, so an evaluator who leaves after a seal
    ///         cannot withdraw before that draw is made or expired.
    uint64 public drawWindow = 1 days;
    /// @notice Randomness tickets an evaluator must have been active before a seal to be drawn for it. Governance keeps
    ///         it at least the randomness lookahead (DrandRandomness.lookaheadRounds, BlockhashRandomness.sealDelay).
    uint64 public warmupTickets = 2;
    /// @notice A seal reads one counter per warm-up ticket, so the warm-up is capped.
    uint64 public constant MAX_WARMUP_TICKETS = 64;
    uint16 public constant SLASH_BPS = 1000;
    /// @notice Positions tried per draw call. A draw that needs more continues in the next call where it stopped.
    uint256 public constant DRAW_ATTEMPTS = 160;
    /// Kept positions examined whenever a draw ends.
    uint256 private constant AUTO_PRUNE = 12;
    /// Steps the oldest-frozen-seal pointer may advance in one call.
    uint256 private constant SCAN_STEPS = 32;
    uint256 public override minStake;
    uint256 public override panelFee;

    mapping(address => uint256) public override stakeOf;
    mapping(address => uint64) public unstakeReadyAt;
    mapping(address => uint256) public openPanels;
    /// @notice Active evaluators, plus inactive ones whose position is kept while a draw is pending.
    address[] public override pool;
    mapping(address => Member) private members;
    /// Kept positions, examined by prune and reused by joins once no pending draw can pick them.
    address[] private deferredExits;
    uint256 public override activeEvaluators;
    /// @notice Cases in DRAWING.
    uint256 public pendingDraws;
    /// @inheritdoc IPanelEscalation
    uint64 public override sealCount;
    /// No seal number below this one is frozen.
    uint64 private oldestFrozen = 1;
    /// Pending draws with at least three eligible evaluators: their seal numbers are frozen (marked in frozenSeal).
    uint256 private frozenDraws;
    mapping(uint64 => bool) private frozenSeal;
    /// Active evaluators by the ticket at which they became active (for the warm-up count at a seal).
    mapping(uint64 => uint256) private activeJoinsAt;
    mapping(bytes32 => DrawState) private draws;
    mapping(bytes32 => Case) private cases;
    mapping(bytes32 => mapping(uint8 => address[3])) private panels;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private commitments;
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) private committed;
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) private revealed;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private answerHashes;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private payloadHashes;
    mapping(bytes32 => mapping(uint8 => uint256)) private panelSlashAmount;
    mapping(bytes32 => uint256) private firstPanelFee;
    /// @notice USDG owed to accounts whose direct payout transfer failed; withdrawn with claim().
    mapping(address => uint256) public owed;

    uint256 public totalStaked;
    uint256 public escrowedCaseFees;
    uint256 public slashedPool;
    uint256 public totalOwed;

    error ZeroAddress();
    error ZeroAmount();
    error NotActive();
    error UnstakeNotReady();
    error PanelStillOpen();
    error ExistingCase(bytes32 caseId);
    error ReserveExceeded(uint256 requested, uint256 available);
    error InvalidParameter();
    error InsufficientBalance(uint256 balance, uint256 amount);

    /// @param admin Initial administrator and governor.
    /// @param usdg_ USDG token used for stake, fees, and reserve.
    /// @param escrow_ Query escrow.
    /// @param verdicts_ Verdict posting contract.
    /// @param randomness_ Selection seed source.
    /// @param minStake_ Minimum evaluator stake.
    /// @param panelFee_ Fee per panel.
    constructor(
        address admin,
        IERC20 usdg_,
        IQueryEscrow escrow_,
        IMochiVerdicts verdicts_,
        IRandomness randomness_,
        uint256 minStake_,
        uint256 panelFee_
    ) {
        if (
            admin == address(0) || address(usdg_) == address(0) || address(escrow_) == address(0)
                || address(verdicts_) == address(0) || address(randomness_) == address(0)
        ) revert ZeroAddress();
        if (minStake_ == 0) revert InvalidParameter();
        usdg = usdg_;
        escrow = escrow_;
        verdicts = verdicts_;
        randomness = randomness_;
        minStake = minStake_;
        panelFee = panelFee_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MochiRoles.GOVERNOR_ROLE, admin);
    }

    /// @notice Update panel timing parameters.
    function setWindows(uint64 commitWindow_, uint64 revealWindow_, uint64 appealWindow_, uint64 unstakeCooldown_)
        external
        onlyRole(MochiRoles.GOVERNOR_ROLE)
    {
        if (commitWindow_ == 0 || revealWindow_ == 0 || appealWindow_ == 0 || unstakeCooldown_ <= drawWindow) {
            revert InvalidParameter();
        }
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
        appealWindow = appealWindow_;
        unstakeCooldown = unstakeCooldown_;
    }

    /// @notice Update the draw deadline window and the evaluator warm-up (in randomness tickets). Pending draws keep
    ///         the warm-up and expiry they were sealed with.
    function setDrawRules(uint64 drawWindow_, uint64 warmupTickets_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (
            drawWindow_ == 0 || drawWindow_ >= unstakeCooldown || warmupTickets_ == 0
                || warmupTickets_ > MAX_WARMUP_TICKETS
        ) {
            revert InvalidParameter();
        }
        drawWindow = drawWindow_;
        warmupTickets = warmupTickets_;
    }

    /// @notice Set the minimum active stake and case fee. After an increase, under-staked evaluators stay in the pool
    ///         until someone calls kick for them.
    function setEconomics(uint256 minStake_, uint256 panelFee_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (minStake_ == 0) revert InvalidParameter();
        minStake = minStake_;
        panelFee = panelFee_;
    }

    /// @notice Withdraw USDG that is not reserved for stakes, fees, slashes, or owed payouts.
    function withdrawReserve(address to, uint256 amount) external onlyRole(MochiRoles.GOVERNOR_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = reserveBalance();
        if (amount > available) revert ReserveExceeded(amount, available);
        usdg.safeTransfer(to, amount);
    }

    /// @notice Current unallocated USDG balance.
    function reserveBalance() public view returns (uint256) {
        uint256 balance = usdg.balanceOf(address(this));
        uint256 liabilities = totalStaked + escrowedCaseFees + slashedPool + totalOwed;
        return balance > liabilities ? balance - liabilities : 0;
    }

    /// @inheritdoc IPanelEscalation
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (unstakeReadyAt[msg.sender] != 0) revert NotActive();
        uint256 total = stakeOf[msg.sender] + amount;
        if (total < minStake) revert StakeTooLow(total, minStake);
        stakeOf[msg.sender] = total;
        totalStaked += amount;
        if (!_isActive(members[msg.sender])) _activate(msg.sender);
        emit EvaluatorStaked(msg.sender, amount);
        usdg.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IPanelEscalation
    function requestUnstake() external {
        if (stakeOf[msg.sender] == 0 || unstakeReadyAt[msg.sender] != 0) revert NotActive();
        uint64 readyAt = uint64(block.timestamp) + unstakeCooldown;
        unstakeReadyAt[msg.sender] = readyAt;
        if (_isActive(members[msg.sender])) _deactivate(msg.sender);
        emit EvaluatorUnstakeRequested(msg.sender, readyAt);
    }

    /// @inheritdoc IPanelEscalation
    function withdraw() external nonReentrant {
        uint256 amount = stakeOf[msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (unstakeReadyAt[msg.sender] == 0 || block.timestamp < unstakeReadyAt[msg.sender]) revert UnstakeNotReady();
        if (openPanels[msg.sender] != 0) revert PanelStillOpen();
        // The stake stays behind a kept position until no pending draw can pick it; the position then goes (or stays
        // as a dead slot nobody can draw, when the pool's last position cannot move yet).
        Member storage m = members[msg.sender];
        if (m.position != 0) {
            if (!_free(m)) revert DrawPending();
            _remove(msg.sender);
        }
        delete stakeOf[msg.sender];
        delete unstakeReadyAt[msg.sender];
        totalStaked -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit EvaluatorWithdrawn(msg.sender, amount);
    }

    /// @inheritdoc IPanelEscalation
    function kick(address evaluator) external {
        if (!_isActive(members[evaluator]) || stakeOf[evaluator] >= minStake) revert NotActive();
        _deactivate(evaluator);
    }

    /// @inheritdoc IPanelEscalation
    function prune(uint256 maxEntries) external returns (uint256) {
        return _prune(maxEntries);
    }

    /// @inheritdoc IPanelEscalation
    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert ZeroAmount();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        usdg.safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc IPanelEscalation
    function escalate(bytes32 queryId) external nonReentrant returns (bytes32 caseId) {
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        MochiTypes.Query memory q = escrow.getQuery(queryId);
        caseId = queryId;
        Case storage c = cases[caseId];
        // A first panel that could not be drawn may be escalated again; the query is already ESCALATED then.
        bool retry = c.status == CaseStatus.DRAW_EXPIRED;
        if (q.status != (retry ? MochiTypes.QueryStatus.ESCALATED : MochiTypes.QueryStatus.HUNG)) {
            revert NotEscalatable(queryId);
        }
        if (!q.isPublic && !q.allowPanelDisclosure) revert DisclosureNotAllowed(queryId);
        // The feed runner pays for feed queries and escalates only those; any other query only its payer.
        if (
            msg.sender != q.payer && msg.sender != q.refundTo
                && (q.payPath != MochiTypes.PayPath.FEED || !hasRole(MochiRoles.FEED_RUNNER_ROLE, msg.sender))
        ) revert Unauthorized(msg.sender);
        if (!retry && c.status != CaseStatus.NONE) revert ExistingCase(caseId);
        uint256 fee = panelFee;
        escrowedCaseFees += fee;
        c.queryId = queryId;
        c.payer = msg.sender;
        c.fee = fee;
        firstPanelFee[caseId] = fee;
        _seal(caseId, c);
        emit Escalated(caseId, queryId, msg.sender, fee);
        usdg.safeTransferFrom(msg.sender, address(this), fee);
        if (!retry) escrow.markEscalated(queryId);
    }

    /// @inheritdoc IPanelEscalation
    function draw(bytes32 caseId) external returns (bool) {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.DRAWING) revert WrongCaseStatus(c.status);
        DrawState storage d = draws[caseId];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > d.expiry) revert WindowClosed();
        if (d.eligible < 3) revert NotEnoughEvaluators();
        return _drawSteps(caseId, c, d);
    }

    /// @inheritdoc IPanelEscalation
    function reseal(bytes32 caseId) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.DRAWING) revert WrongCaseStatus(c.status);
        DrawState storage d = draws[caseId];
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        if (d.seed != 0 || !randomness.isExpired(c.sealBlock)) revert WindowOpen();
        _unfreeze(d.sealNonce);
        _freeze(caseId, c, d);
        emit CaseResealed(caseId, c.sealBlock);
    }

    /// @inheritdoc IPanelEscalation
    function expireDraw(bytes32 caseId) external nonReentrant {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.DRAWING) revert WrongCaseStatus(c.status);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= c.drawDeadline) revert WindowOpen();
        DrawState storage d = draws[caseId];
        // A draw that can still seat a panel is continued, never discarded, so letting the deadline pass cannot drop a
        // known draw (and re-escalating cannot re-roll it). It ends only when it is impossible (fewer than three
        // eligible at the seal), its seed is lost (a blockhash past its window), or its expiry passed, even if no seed
        // was ever published (a drand beacon nobody posted).
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        bool possible = d.eligible >= 3 && (d.seed != 0 || !randomness.isExpired(c.sealBlock));
        // forge-lint: disable-next-line(block-timestamp)
        if (possible && block.timestamp <= d.expiry) {
            _drawSteps(caseId, c, d);
            return;
        }
        uint8 pi = c.panelIndex;
        uint256 refund = c.fee;
        delete panels[caseId][pi]; // seats chosen before the draw ended
        _endDraw(d);
        if (pi == 0) {
            c.fee = 0;
            c.status = CaseStatus.DRAW_EXPIRED;
        } else {
            // No appeal panel can be drawn: the appeal lapses and the first panel's majority decision stands.
            c.panelIndex = 0;
            c.fee = firstPanelFee[caseId];
            c.status = CaseStatus.RESOLVED_MAJORITY;
        }
        emit DrawExpired(caseId, pi, refund);
        _pay(c.payer, refund);
        if (pi != 0) _finalize(caseId, c);
    }

    /// @inheritdoc IPanelEscalation
    function commit(bytes32 caseId, bytes32 commitment) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.COMMIT && c.status != CaseStatus.REVEAL) revert WrongCaseStatus(c.status);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > c.commitDeadline) revert WindowClosed();
        if (!_isPanelist(caseId, c.panelIndex, msg.sender)) revert NotPanelist(msg.sender);
        if (committed[caseId][c.panelIndex][msg.sender]) revert AlreadyCommitted();
        commitments[caseId][c.panelIndex][msg.sender] = commitment;
        committed[caseId][c.panelIndex][msg.sender] = true;
        if (_allCommitted(caseId, c.panelIndex)) c.status = CaseStatus.REVEAL;
        emit Committed(caseId, msg.sender);
    }

    /// @inheritdoc IPanelEscalation
    function reveal(bytes32 caseId, bytes32 answerHash, bytes32 payloadHash, bytes32 salt) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.COMMIT && c.status != CaseStatus.REVEAL) revert WrongCaseStatus(c.status);
        // forge-lint: disable-next-line(block-timestamp)
        if (c.status == CaseStatus.COMMIT && block.timestamp <= c.commitDeadline) revert WindowOpen();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > c.revealDeadline) revert WindowClosed();
        uint8 pi = c.panelIndex;
        if (!_isPanelist(caseId, pi, msg.sender)) revert NotPanelist(msg.sender);
        // A zero result could never be posted (MochiVerdicts rejects it), so a majority on it would block finalize.
        if (
            answerHash == 0 || payloadHash == 0 || !committed[caseId][pi][msg.sender]
                || commitments[caseId][pi][msg.sender]
                    != keccak256(abi.encode(caseId, pi, msg.sender, answerHash, payloadHash, salt))
        ) {
            revert BadReveal();
        }
        if (revealed[caseId][pi][msg.sender]) revert BadReveal();
        revealed[caseId][pi][msg.sender] = true;
        answerHashes[caseId][pi][msg.sender] = answerHash;
        payloadHashes[caseId][pi][msg.sender] = payloadHash;
        if (_allRevealed(caseId, pi)) c.status = CaseStatus.REVEAL;
        emit Revealed(caseId, msg.sender, answerHash, payloadHash);
    }

    /// @inheritdoc IPanelEscalation
    function resolve(bytes32 caseId) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.COMMIT && c.status != CaseStatus.REVEAL) revert WrongCaseStatus(c.status);
        uint8 pi = c.panelIndex;
        // forge-lint: disable-next-line(block-timestamp)
        if (!_allRevealed(caseId, pi) && block.timestamp <= c.revealDeadline) revert WindowOpen();
        for (uint256 i; i < 3; ++i) {
            address e = panels[caseId][pi][i];
            if (!revealed[caseId][pi][e]) _slash(caseId, pi, e);
        }
        (bool majority, bytes32 ah, bytes32 ph) = _majority(caseId, pi);
        c.outcomeAnswerHash = majority ? ah : bytes32(0);
        c.outcomePayloadHash = majority ? ph : bytes32(0);
        c.status = majority ? CaseStatus.RESOLVED_MAJORITY : CaseStatus.RESOLVED_NO_MAJORITY;
        if (pi == 0 && majority) c.appealDeadline = uint64(block.timestamp) + appealWindow;
        emit Resolved(caseId, pi, majority, c.outcomeAnswerHash, c.outcomePayloadHash);
    }

    /// @inheritdoc IPanelEscalation
    function appeal(bytes32 caseId) external nonReentrant {
        Case storage c = cases[caseId];
        if (msg.sender != c.payer) revert Unauthorized(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (c.panelIndex != 0 || c.status != CaseStatus.RESOLVED_MAJORITY || block.timestamp > c.appealDeadline) {
            revert WindowClosed();
        }
        uint256 fee = panelFee;
        escrowedCaseFees += fee;
        c.panelIndex = 1;
        c.fee = fee;
        _seal(caseId, c);
        emit Appealed(caseId, msg.sender, fee);
        usdg.safeTransferFrom(msg.sender, address(this), fee);
    }

    /// @inheritdoc IPanelEscalation
    function finalize(bytes32 caseId) external nonReentrant {
        Case storage c = cases[caseId];
        // forge-lint: disable-next-line(block-timestamp)
        if (c.panelIndex == 0 && c.status == CaseStatus.RESOLVED_MAJORITY && block.timestamp <= c.appealDeadline) {
            revert WindowOpen();
        }
        _finalize(caseId, c);
    }

    /// @inheritdoc IPanelEscalation
    function getCase(bytes32 caseId) external view returns (Case memory) {
        return cases[caseId];
    }

    /// @inheritdoc IPanelEscalation
    function panelOf(bytes32 caseId, uint8 panelIndex) external view returns (address[3] memory) {
        return panels[caseId][panelIndex];
    }

    /// @inheritdoc IPanelEscalation
    function poolLength() external view returns (uint256) {
        return pool.length;
    }

    /// @inheritdoc IPanelEscalation
    function memberOf(address evaluator) external view returns (Member memory) {
        return members[evaluator];
    }

    /// @inheritdoc IPanelEscalation
    function drawStateOf(bytes32 caseId) external view returns (DrawState memory) {
        return draws[caseId];
    }

    /// @inheritdoc IPanelEscalation
    function revealOf(bytes32 caseId, uint8 panelIndex, address evaluator) external view returns (bytes32, bytes32) {
        return (answerHashes[caseId][panelIndex][evaluator], payloadHashes[caseId][panelIndex][evaluator]);
    }

    /// @inheritdoc IPanelEscalation
    function isDrawable(address evaluator) external view returns (bool) {
        Member storage m = members[evaluator];
        return _isActive(m) && uint256(m.joinTicket) + warmupTickets <= randomness.nextTicket();
    }

    function _finalize(bytes32 caseId, Case storage c) private {
        CaseStatus status = c.status;
        if (status != CaseStatus.RESOLVED_MAJORITY && status != CaseStatus.RESOLVED_NO_MAJORITY) {
            revert WrongCaseStatus(status);
        }
        uint8 pi = c.panelIndex;
        bool post = status == CaseStatus.RESOLVED_MAJORITY;
        c.status = CaseStatus.FINAL;
        // Trusted callee: MochiVerdicts is immutable here; postPanelOutcome is nonReentrant and only records the
        // verdict and calls QueryEscrow.markDecided. The case is already FINAL.
        // slither-disable-start unused-return -- the returned verdict id is not needed; a failure reverts
        // aderyn-fp-next-line(reentrancy-state-change) trusted immutable callee that cannot call back; case is FINAL
        if (post) verdicts.postPanelOutcome(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
        // slither-disable-end unused-return
        if (pi == 0) {
            if (post) _payMajority(caseId, 0, c.fee);
            else _payRevealersOrPayer(caseId, 0, c.fee, c.payer);
        } else if (post) {
            _payMajority(caseId, 1, c.fee);
            _payFirstPanelOnAppeal(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
            _slashFirstPanelLosers(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
        } else {
            _payRevealersOrPayer(caseId, 1, c.fee, c.payer);
            _payRevealersOrPayer(caseId, 0, firstPanelFee[caseId], c.payer);
        }
        _distributeSlashes(caseId, pi, post, c.outcomeAnswerHash, c.outcomePayloadHash);
        if (pi == 1) _closePanel(caseId, 0);
        _closePanel(caseId, pi);
        emit Finalized(caseId, post);
    }

    /// Continues the current panel's draw for at most DRAW_ATTEMPTS positions. Seat k takes the first eligible position
    /// in the sequence hash(seed, k, attempt) % poolSize, attempt = 0, 1, ...: a position at or past the pool's end, an
    /// ineligible member, a member already chosen or on the prior panel is skipped. The sequence and every position's
    /// eligibility are fixed for the draw, so the panel does not depend on how the work is split across calls; with at
    /// least three eligible positions (counted at the seal) every seat is eventually filled.
    function _drawSteps(bytes32 caseId, Case storage c, DrawState storage d) private returns (bool) {
        bytes32 seed = d.seed;
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        if (seed == 0) seed = randomness.seed(keccak256(abi.encode(caseId, c.panelIndex)), c.sealBlock);
        uint8 pi = c.panelIndex;
        address[3] memory selected = panels[caseId][pi];
        // slither-disable-next-line uninitialized-local -- no prior panel (all zero) unless this is the appeal
        address[3] memory prior;
        if (pi == 1) prior = panels[caseId][0];
        uint256 filled = d.filled;
        uint256 attempt = d.attempt;
        uint256 size = c.poolSize;
        uint256 len = pool.length;
        uint64 nonce = d.sealNonce;
        uint64 ticket = c.sealBlock;
        uint256 warmup = d.warmup;
        bytes32 slotSeed = keccak256(abi.encode(seed, filled));
        for (uint256 budget = DRAW_ATTEMPTS; budget != 0; --budget) {
            uint256 index = _hashIndex(slotSeed, attempt) % size;
            ++attempt;
            address candidate = index < len ? pool[index] : address(0);
            if (
                candidate == address(0) || !_eligible(candidate, nonce, ticket, warmup)
                    || _contains(selected, candidate) || _contains(prior, candidate)
            ) continue;
            selected[filled] = candidate;
            if (++filled == 3) {
                _seat(caseId, c, d, selected);
                return true;
            }
            attempt = 0;
            slotSeed = keccak256(abi.encode(seed, filled));
        }
        panels[caseId][pi] = selected;
        d.seed = seed;
        // casting to 'uint8' is safe because filled < 3 here
        // forge-lint: disable-next-line(unsafe-typecast)
        d.filled = uint8(filled);
        d.attempt = attempt;
        // casting to 'uint8' is safe because filled < 3 here
        // forge-lint: disable-next-line(unsafe-typecast)
        emit DrawProgress(caseId, uint8(filled), attempt);
        return false;
    }

    function _seat(bytes32 caseId, Case storage c, DrawState storage d, address[3] memory selected) private {
        uint8 pi = c.panelIndex;
        panels[caseId][pi] = selected;
        for (uint256 i; i < 3; ++i) {
            ++openPanels[selected[i]];
        }
        c.status = CaseStatus.COMMIT;
        c.commitDeadline = uint64(block.timestamp) + commitWindow;
        c.revealDeadline = c.commitDeadline + revealWindow;
        _endDraw(d);
        emit PanelDrawn(caseId, pi, selected);
    }

    /// Opens a draw for the current panel (escalate, appeal). The deadline and expiry are fixed here; a reseal keeps
    /// them.
    function _seal(bytes32 caseId, Case storage c) private {
        c.status = CaseStatus.DRAWING;
        c.drawDeadline = uint64(block.timestamp) + drawWindow;
        DrawState storage d = draws[caseId];
        d.sealTime = uint64(block.timestamp);
        d.expiry = uint64(block.timestamp) + unstakeCooldown;
        ++pendingDraws;
        _freeze(caseId, c, d);
    }

    /// Takes a seal number and ticket, freezes the pool length, and counts the evaluators the draw can pick: active
    /// now, past the warm-up at the ticket, and not on the prior panel. A draw with at least three freezes its seal
    /// number.
    function _freeze(bytes32 caseId, Case storage c, DrawState storage d) private {
        uint64 nonce = ++sealCount;
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        uint64 ticket = randomness.nextTicket();
        uint64 warmup = warmupTickets;
        c.sealBlock = ticket;
        // casting to 'uint64' is safe because pool.length cannot approach 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        c.poolSize = uint64(pool.length);
        uint256 eligible = activeEvaluators;
        // Active evaluators that became active at one of the last `warmup` tickets are not warm yet.
        for (uint64 t = ticket; t != 0 && t + warmup > ticket; --t) {
            eligible -= activeJoinsAt[t];
        }
        if (c.panelIndex == 1) {
            for (uint256 i; i < 3; ++i) {
                Member storage m = members[panels[caseId][0][i]];
                if (_isActive(m) && m.joinTicket + warmup <= ticket) --eligible;
            }
        }
        d.seed = 0;
        d.filled = 0;
        d.attempt = 0;
        d.sealNonce = nonce;
        // casting to 'uint16' is safe because warmupTickets <= MAX_WARMUP_TICKETS
        // forge-lint: disable-next-line(unsafe-typecast)
        d.warmup = uint16(warmup);
        // casting to 'uint32' is safe because the value is capped first
        // forge-lint: disable-next-line(unsafe-typecast)
        d.eligible = uint32(eligible > type(uint32).max ? type(uint32).max : eligible);
        if (eligible >= 3) {
            frozenSeal[nonce] = true;
            ++frozenDraws;
        }
    }

    function _unfreeze(uint64 nonce) private {
        if (frozenSeal[nonce]) {
            frozenSeal[nonce] = false;
            --frozenDraws;
        }
    }

    function _endDraw(DrawState storage d) private {
        --pendingDraws;
        _unfreeze(d.sealNonce);
        _prune(AUTO_PRUNE);
    }

    /// Eligible for the draw with seal number `nonce` at `ticket`: active at that seal (became active before it and did
    /// not leave before it; leaving after it does not count) and active since at least `warmup` tickets before
    /// `ticket`. These records do not change while such a draw is pending (see _free).
    function _eligible(address e, uint64 nonce, uint64 ticket, uint256 warmup) private view returns (bool) {
        Member storage m = members[e];
        uint64 exitSeal = m.exitSeal;
        return m.joinSeal < nonce && (exitSeal == 0 || exitSeal > nonce) && uint256(m.joinTicket) + warmup <= ticket;
    }

    /// True if no pending draw can pick this member's position: no frozen seal was made while it was active. Only such
    /// a position may move, be reused, be re-activated, or lose its stake. Conservative: a frozen seal made while the
    /// member was active blocks it even if the member is not eligible for that draw.
    function _free(Member storage m) private returns (bool) {
        uint64 exitSeal = m.exitSeal;
        uint64 last = exitSeal == 0 ? sealCount : exitSeal - 1;
        if (m.joinSeal >= last || frozenDraws == 0) return true;
        uint64 p = oldestFrozen;
        if (p <= last) {
            uint64 top = sealCount;
            for (uint256 i; i < SCAN_STEPS && p <= top && !frozenSeal[p]; ++i) {
                ++p;
            }
            oldestFrozen = p;
        }
        return p > last;
    }

    /// keccak256(abi.encode(slotSeed, attempt)) in scratch space, so the draw loop does not grow memory.
    function _hashIndex(bytes32 slotSeed, uint256 attempt) private pure returns (uint256 h) {
        assembly ("memory-safe") {
            mstore(0x00, slotSeed)
            mstore(0x20, attempt)
            h := keccak256(0x00, 0x40)
        }
    }

    function _isActive(Member storage m) private view returns (bool) {
        return m.position != 0 && m.exitSeal == 0;
    }

    function _ticket() private view returns (uint64 t) {
        // aderyn-fp-next-line(reentrancy-state-change) STATICCALL to an immutable protocol contract; cannot reenter
        t = randomness.nextTicket();
        if (t == 0) t = 1;
    }

    function _activate(address e) private {
        Member storage m = members[e];
        if (m.position == 0) {
            m.position = _place(e);
        } else if (!_free(m)) {
            // Re-activating a kept position rewrites the join record a pending draw reads.
            revert DrawPending();
        }
        uint64 t = _ticket();
        m.joinTicket = t;
        m.joinSeal = sealCount;
        m.exitSeal = 0;
        ++activeEvaluators;
        ++activeJoinsAt[t];
    }

    /// A pool slot for a new member: the last kept position if no pending draw can pick it, else a new one at the end.
    /// The newcomer joined after every pending seal, so it cannot be picked there either.
    function _place(address e) private returns (uint64 position) {
        uint256 n = deferredExits.length;
        if (n != 0) {
            Member storage dead = members[deferredExits[n - 1]];
            position = dead.position;
            if (position != 0 && dead.exitSeal != 0 && _free(dead)) {
                deferredExits.pop();
                dead.position = 0;
                pool[position - 1] = e;
                return position;
            }
        }
        pool.push(e);
        // casting to 'uint64' is safe because pool.length cannot approach 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        position = uint64(pool.length);
    }

    function _deactivate(address e) private {
        Member storage m = members[e];
        m.exitSeal = sealCount + 1;
        --activeEvaluators;
        --activeJoinsAt[m.joinTicket];
        // A position a pending draw may still pick stays in place until that draw ends.
        if (!_free(m) || !_remove(e)) deferredExits.push(e);
    }

    /// Removes a free position by moving the pool's last position into it, if that one is free too. Returns false (and
    /// leaves the position as a dead slot) otherwise.
    function _remove(address e) private returns (bool) {
        Member storage m = members[e];
        uint256 index = m.position - 1;
        uint256 last = pool.length - 1;
        if (index != last) {
            address tail = pool[last];
            Member storage t = members[tail];
            if (!_free(t)) return false;
            pool[index] = tail;
            // casting to 'uint64' is safe because a position is at most pool.length
            // forge-lint: disable-next-line(unsafe-typecast)
            t.position = uint64(index + 1);
        }
        pool.pop();
        m.position = 0;
        return true;
    }

    /// Examines up to maxEntries kept positions (newest first): drops stale entries and removes positions no pending
    /// draw can pick.
    function _prune(uint256 maxEntries) private returns (uint256 removed) {
        uint256 i = deferredExits.length;
        for (; i != 0 && maxEntries != 0; --maxEntries) {
            --i;
            address e = deferredExits[i];
            Member storage m = members[e];
            if (m.position != 0 && m.exitSeal != 0) {
                if (!_free(m) || !_remove(e)) continue;
                ++removed;
            }
            deferredExits[i] = deferredExits[deferredExits.length - 1];
            deferredExits.pop();
        }
    }

    function _slash(bytes32 id, uint8 pi, address e) private {
        uint256 amount = stakeOf[e] * SLASH_BPS / 10_000;
        if (amount == 0) return;
        stakeOf[e] -= amount;
        totalStaked -= amount;
        slashedPool += amount;
        panelSlashAmount[id][pi] += amount;
        emit EvaluatorSlashed(e, amount);
        if (stakeOf[e] < minStake && _isActive(members[e])) _deactivate(e);
    }

    function _contains(address[3] memory list, address e) private pure returns (bool) {
        return list[0] == e || list[1] == e || list[2] == e;
    }

    function _isPanelist(bytes32 id, uint8 pi, address e) private view returns (bool) {
        // aderyn-fp-next-line(storage-array-memory-edit) _contains only reads its memory copy; nothing is written back
        return _contains(panels[id][pi], e);
    }

    function _allCommitted(bytes32 id, uint8 pi) private view returns (bool) {
        address[3] storage p = panels[id][pi];
        return committed[id][pi][p[0]] && committed[id][pi][p[1]] && committed[id][pi][p[2]];
    }

    function _allRevealed(bytes32 id, uint8 pi) private view returns (bool) {
        address[3] storage p = panels[id][pi];
        return revealed[id][pi][p[0]] && revealed[id][pi][p[1]] && revealed[id][pi][p[2]];
    }

    function _majority(bytes32 id, uint8 pi) private view returns (bool, bytes32, bytes32) {
        address[3] storage p = panels[id][pi];
        for (uint256 i; i < 3; ++i) {
            address a = p[i];
            if (!revealed[id][pi][a]) continue;
            for (uint256 j = i + 1; j < 3; ++j) {
                address b = p[j];
                if (
                    revealed[id][pi][b] && answerHashes[id][pi][a] == answerHashes[id][pi][b]
                        && payloadHashes[id][pi][a] == payloadHashes[id][pi][b]
                ) {
                    return (true, answerHashes[id][pi][a], payloadHashes[id][pi][a]);
                }
            }
        }
        return (false, 0, 0);
    }

    function _payMajority(bytes32 id, uint8 pi, uint256 amount) private {
        (bool majority, bytes32 ah, bytes32 ph) = _majority(id, pi);
        require(majority, "no majority");
        address[3] storage p = panels[id][pi];
        // slither-disable-next-line uninitialized-local -- set to the first majority seat below
        address first;
        // slither-disable-next-line uninitialized-local -- counter, starts at zero
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                if (first == address(0)) first = p[i];
                ++count;
            }
        }
        uint256 each = amount / count;
        uint256 dust = amount % count;
        _pay(first, each + dust);
        for (uint256 i; i < 3; ++i) {
            if (
                p[i] != first && revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah
                    && payloadHashes[id][pi][p[i]] == ph
            ) _pay(p[i], each);
        }
    }

    function _payRevealersOrPayer(bytes32 id, uint8 pi, uint256 amount, address payer) private {
        address[3] storage p = panels[id][pi];
        // slither-disable-next-line uninitialized-local -- counter, starts at zero
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]]) ++count;
        }
        if (count == 0) {
            _pay(payer, amount);
            return;
        }
        uint256 each = amount / count;
        uint256 dust = amount % count;
        bool first = true;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]]) {
                _pay(p[i], each + (first ? dust : 0));
                first = false;
            }
        }
    }

    function _payFirstPanelOnAppeal(bytes32 id, bytes32 ah, bytes32 ph) private {
        address[3] storage p = panels[id][0];
        // slither-disable-next-line uninitialized-local -- counter, starts at zero
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][0][p[i]] && answerHashes[id][0][p[i]] == ah && payloadHashes[id][0][p[i]] == ph) ++count;
        }
        if (count == 0) {
            _payMajority(id, 1, firstPanelFee[id]);
            return;
        }
        uint256 amount = firstPanelFee[id];
        uint256 each = amount / count;
        uint256 dust = amount % count;
        bool first = true;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][0][p[i]] && answerHashes[id][0][p[i]] == ah && payloadHashes[id][0][p[i]] == ph) {
                _pay(p[i], each + (first ? dust : 0));
                first = false;
            }
        }
    }

    function _slashFirstPanelLosers(bytes32 id, bytes32 ah, bytes32 ph) private {
        address[3] storage p = panels[id][0];
        for (uint256 i; i < 3; ++i) {
            address e = p[i];
            if (revealed[id][0][e] && (answerHashes[id][0][e] != ah || payloadHashes[id][0][e] != ph)) {
                _slash(id, 0, e);
            }
        }
    }

    function _distributeSlashes(bytes32 id, uint8 pi, bool hasMajority, bytes32 ah, bytes32 ph) private {
        uint256 amount = panelSlashAmount[id][0] + (pi == 1 ? panelSlashAmount[id][1] : 0);
        if (amount == 0) return;
        panelSlashAmount[id][0] = 0;
        if (pi == 1) panelSlashAmount[id][1] = 0;
        slashedPool -= amount;
        if (!hasMajority) return; // becomes reserve
        address[3] storage p = panels[id][pi];
        // slither-disable-next-line uninitialized-local -- counter, starts at zero
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                ++count;
            }
        }
        if (count == 0) return;
        uint256 each = amount / count;
        uint256 dust = amount % count;
        bool first = true;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                _send(p[i], each + (first ? dust : 0));
                first = false;
            }
        }
    }

    function _pay(address to, uint256 amount) private {
        escrowedCaseFees -= amount;
        _send(to, amount);
    }

    /// Pays directly; if the token refuses the recipient (for example a frozen address), the amount becomes claimable
    /// instead of reverting, so one recipient cannot block a case from finishing. A shortfall is never turned into a
    /// claim: the contract always holds its liabilities, so it reverts.
    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        // aderyn-fp-next-line(reentrancy-state-change) view call to the immutable USDG token; cannot change state
        uint256 balance = usdg.balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance(balance, amount);
        if (usdg.trySafeTransfer(to, amount)) return;
        owed[to] += amount;
        totalOwed += amount;
        emit PayoutOwed(to, amount);
    }

    function _closePanel(bytes32 id, uint8 pi) private {
        address[3] storage p = panels[id][pi];
        for (uint256 i; i < 3; ++i) {
            --openPanels[p[i]];
        }
    }
}
