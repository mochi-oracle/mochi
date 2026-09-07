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
    uint16 public constant SLASH_BPS = 1000;
    uint256 public override minStake;
    uint256 public override panelFee;

    mapping(address => uint256) public override stakeOf;
    mapping(address => uint64) public unstakeReadyAt;
    mapping(address => uint256) public openPanels;
    address[] public evaluators;
    mapping(address => bool) private knownEvaluator;
    mapping(bytes32 => Case) private cases;
    mapping(bytes32 => mapping(uint8 => address[3])) private panels;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private commitments;
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) private committed;
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) private revealed;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private answerHashes;
    mapping(bytes32 => mapping(uint8 => mapping(address => bytes32))) private payloadHashes;
    mapping(bytes32 => mapping(uint8 => uint256)) private panelSlashAmount;
    mapping(bytes32 => uint256) private firstPanelFee;

    uint256 public totalStaked;
    uint256 public escrowedCaseFees;
    uint256 public slashedPool;

    error ZeroAddress();
    error ZeroAmount();
    error NotActive();
    error UnstakeNotReady();
    error PanelStillOpen();
    error ExistingCase(bytes32 caseId);
    error ReserveExceeded(uint256 requested, uint256 available);
    error InvalidParameter();

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
        if (commitWindow_ == 0 || revealWindow_ == 0 || appealWindow_ == 0 || unstakeCooldown_ == 0) {
            revert InvalidParameter();
        }
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
        appealWindow = appealWindow_;
        unstakeCooldown = unstakeCooldown_;
    }

    /// @notice Set the minimum active stake and case fee.
    function setEconomics(uint256 minStake_, uint256 panelFee_) external onlyRole(MochiRoles.GOVERNOR_ROLE) {
        if (minStake_ == 0) revert InvalidParameter();
        minStake = minStake_;
        panelFee = panelFee_;
    }

    /// @notice Withdraw USDG that is not reserved for stakes, fees, or slashes.
    function withdrawReserve(address to, uint256 amount) external onlyRole(MochiRoles.GOVERNOR_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = reserveBalance();
        if (amount > available) revert ReserveExceeded(amount, available);
        usdg.safeTransfer(to, amount);
    }

    /// @notice Current unallocated USDG balance.
    function reserveBalance() public view returns (uint256) {
        uint256 balance = usdg.balanceOf(address(this));
        uint256 liabilities = totalStaked + escrowedCaseFees + slashedPool;
        return balance > liabilities ? balance - liabilities : 0;
    }

    /// @inheritdoc IPanelEscalation
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        stakeOf[msg.sender] += amount;
        totalStaked += amount;
        if (!knownEvaluator[msg.sender]) {
            knownEvaluator[msg.sender] = true;
            evaluators.push(msg.sender);
        }
        emit EvaluatorStaked(msg.sender, amount);
    }

    /// @inheritdoc IPanelEscalation
    function requestUnstake() external {
        if (stakeOf[msg.sender] == 0 || unstakeReadyAt[msg.sender] != 0) revert NotActive();
        uint64 readyAt = uint64(block.timestamp) + unstakeCooldown;
        unstakeReadyAt[msg.sender] = readyAt;
        emit EvaluatorUnstakeRequested(msg.sender, readyAt);
    }

    /// @inheritdoc IPanelEscalation
    function withdraw() external nonReentrant {
        uint256 amount = stakeOf[msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (unstakeReadyAt[msg.sender] == 0 || block.timestamp < unstakeReadyAt[msg.sender]) revert UnstakeNotReady();
        if (openPanels[msg.sender] != 0) revert PanelStillOpen();
        delete stakeOf[msg.sender];
        delete unstakeReadyAt[msg.sender];
        totalStaked -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit EvaluatorWithdrawn(msg.sender, amount);
    }

    /// @inheritdoc IPanelEscalation
    function escalate(bytes32 queryId) external nonReentrant returns (bytes32 caseId) {
        MochiTypes.Query memory q = escrow.getQuery(queryId);
        if (q.status != MochiTypes.QueryStatus.HUNG) revert NotEscalatable(queryId);
        if (!q.isPublic && !q.allowPanelDisclosure) revert DisclosureNotAllowed(queryId);
        if (msg.sender != q.payer && msg.sender != q.refundTo && !hasRole(MochiRoles.FEED_RUNNER_ROLE, msg.sender)) {
            revert Unauthorized(msg.sender);
        }
        caseId = queryId;
        if (cases[caseId].status != CaseStatus.NONE) revert ExistingCase(caseId);
        uint256 fee = panelFee;
        usdg.safeTransferFrom(msg.sender, address(this), fee);
        escrow.markEscalated(queryId);
        escrowedCaseFees += fee;
        Case storage c = cases[caseId];
        c.queryId = queryId;
        c.status = CaseStatus.DRAWING;
        c.sealBlock = randomness.nextTicket();
        c.payer = msg.sender;
        c.fee = fee;
        firstPanelFee[caseId] = fee;
        emit Escalated(caseId, queryId, msg.sender, fee);
    }

    /// @inheritdoc IPanelEscalation
    function draw(bytes32 caseId) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.DRAWING) revert WrongCaseStatus(c.status);
        uint8 pi = c.panelIndex;
        bytes32 seed = randomness.seed(keccak256(abi.encode(caseId, pi)), c.sealBlock);
        uint256 len = evaluators.length;
        if (len < 3) revert NotEnoughEvaluators();
        address[3] memory selected;
        for (uint256 slot; slot < 3; ++slot) {
            uint256 start = uint256(keccak256(abi.encode(seed, slot))) % len;
            bool found;
            for (uint256 step; step < len; ++step) {
                address candidate = evaluators[(start + step) % len];
                if (!_active(candidate) || _contains(selected, candidate)) continue;
                if (pi == 1 && _contains(panels[caseId][0], candidate)) continue;
                selected[slot] = candidate;
                found = true;
                break;
            }
            if (!found) revert NotEnoughEvaluators();
        }
        panels[caseId][pi] = selected;
        for (uint256 i; i < 3; ++i) {
            ++openPanels[selected[i]];
        }
        c.status = CaseStatus.COMMIT;
        c.commitDeadline = uint64(block.timestamp) + commitWindow;
        c.revealDeadline = c.commitDeadline + revealWindow;
        emit PanelDrawn(caseId, pi, selected);
    }

    /// @inheritdoc IPanelEscalation
    function reseal(bytes32 caseId) external {
        Case storage c = cases[caseId];
        if (c.status != CaseStatus.DRAWING) revert WrongCaseStatus(c.status);
        if (!randomness.isExpired(c.sealBlock)) revert WindowOpen();
        c.sealBlock = randomness.nextTicket();
        emit CaseResealed(caseId, c.sealBlock);
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
        if (
            !committed[caseId][pi][msg.sender]
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
            if (!revealed[caseId][pi][e]) {
                uint256 slash = stakeOf[e] * SLASH_BPS / 10_000;
                if (slash != 0) {
                    stakeOf[e] -= slash;
                    totalStaked -= slash;
                    slashedPool += slash;
                    panelSlashAmount[caseId][pi] += slash;
                    emit EvaluatorSlashed(e, slash);
                }
            }
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
        usdg.safeTransferFrom(msg.sender, address(this), fee);
        escrowedCaseFees += fee;
        c.panelIndex = 1;
        c.status = CaseStatus.DRAWING;
        c.sealBlock = randomness.nextTicket();
        c.fee = fee;
        emit Appealed(caseId, msg.sender, fee);
    }

    /// @inheritdoc IPanelEscalation
    function finalize(bytes32 caseId) external nonReentrant {
        Case storage c = cases[caseId];
        uint8 pi = c.panelIndex;
        bool post;
        if (pi == 0) {
            if (c.status == CaseStatus.RESOLVED_MAJORITY) {
                // forge-lint: disable-next-line(block-timestamp)
                if (block.timestamp <= c.appealDeadline) revert WindowOpen();
                post = true;
                verdicts.postPanelOutcome(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
                _payMajority(caseId, 0, c.fee);
            } else if (c.status == CaseStatus.RESOLVED_NO_MAJORITY) {
                _payRevealersOrPayer(caseId, 0, c.fee, c.payer);
            } else {
                revert WrongCaseStatus(c.status);
            }
        } else {
            if (c.status != CaseStatus.RESOLVED_MAJORITY && c.status != CaseStatus.RESOLVED_NO_MAJORITY) {
                revert WrongCaseStatus(c.status);
            }
            if (c.status == CaseStatus.RESOLVED_MAJORITY) {
                post = true;
                verdicts.postPanelOutcome(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
                _payMajority(caseId, 1, c.fee);
                _payFirstPanelOnAppeal(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
                _slashFirstPanelLosers(caseId, c.outcomeAnswerHash, c.outcomePayloadHash);
            } else {
                _payRevealersOrPayer(caseId, 1, c.fee, c.payer);
                _payRevealersOrPayer(caseId, 0, firstPanelFee[caseId], c.payer);
            }
        }
        _distributeSlashes(caseId, pi, post, c.outcomeAnswerHash, c.outcomePayloadHash);
        if (pi == 1) _closePanel(caseId, 0);
        _closePanel(caseId, pi);
        c.status = CaseStatus.FINAL;
        emit Finalized(caseId, post);
    }

    /// @inheritdoc IPanelEscalation
    function getCase(bytes32 caseId) external view returns (Case memory) {
        return cases[caseId];
    }

    /// @inheritdoc IPanelEscalation
    function panelOf(bytes32 caseId, uint8 panelIndex) external view returns (address[3] memory) {
        return panels[caseId][panelIndex];
    }

    function _active(address e) private view returns (bool) {
        return stakeOf[e] >= minStake && unstakeReadyAt[e] == 0;
    }

    function _contains(address[3] memory list, address e) private pure returns (bool) {
        return list[0] == e || list[1] == e || list[2] == e;
    }

    function _isPanelist(bytes32 id, uint8 pi, address e) private view returns (bool) {
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
        address first;
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                if (first == address(0)) first = p[i];
                ++count;
            }
        }
        uint256 each = amount / count;
        uint256 dust = amount - each * count;
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
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]]) ++count;
        }
        if (count == 0) {
            _pay(payer, amount);
            return;
        }
        uint256 each = amount / count;
        uint256 dust = amount - each * count;
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
        uint256 dust = amount - each * count;
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
                uint256 amount = stakeOf[e] * SLASH_BPS / 10_000;
                if (amount != 0) {
                    stakeOf[e] -= amount;
                    totalStaked -= amount;
                    slashedPool += amount;
                    panelSlashAmount[id][0] += amount;
                    emit EvaluatorSlashed(e, amount);
                }
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
        uint256 count;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                ++count;
            }
        }
        if (count == 0) return;
        uint256 each = amount / count;
        uint256 dust = amount - each * count;
        bool first = true;
        for (uint256 i; i < 3; ++i) {
            if (revealed[id][pi][p[i]] && answerHashes[id][pi][p[i]] == ah && payloadHashes[id][pi][p[i]] == ph) {
                usdg.safeTransfer(p[i], each + (first ? dust : 0));
                first = false;
            }
        }
    }

    function _pay(address to, uint256 amount) private {
        escrowedCaseFees -= amount;
        usdg.safeTransfer(to, amount);
    }

    function _closePanel(bytes32 id, uint8 pi) private {
        address[3] storage p = panels[id][pi];
        for (uint256 i; i < 3; ++i) {
            --openPanels[p[i]];
        }
    }
}
