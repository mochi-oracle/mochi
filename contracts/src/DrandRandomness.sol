// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity ^0.8.28;

import {IRandomness} from "@mochi/interfaces/IRandomness.sol";

/// @title DrandRandomness
/// @notice Verifies quicknet-style BLS12-381 beacons with the EIP-2537 precompiles.
/// @dev A ticket is fixed at open from block.timestamp and lookaheadRounds, so its beacon has not been published.
///      Residual trust: the sequencer does not back-date timestamps by more than lookaheadRounds * period
///      (back-dating is publicly visible), and fewer than the drand threshold of League of Entropy nodes collude.
contract DrandRandomness is IRandomness {
    bytes private constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
    bytes private constant NEG_G2_GENERATOR = hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed";

    error InvalidBeacon(uint64 round);
    error InvalidPublicKeyLength(uint256 length);
    error InvalidPeriod();
    error InvalidLookahead();
    error PrecompileFailure(address precompile);

    uint64 public immutable genesisTime;
    uint64 public immutable period;
    uint64 public immutable lookaheadRounds;
    // aderyn-fp-next-line(state-variable-could-be-immutable) a bytes value cannot be immutable
    bytes private _publicKeyG2;
    mapping(uint64 round => bytes32 value) private _beacons;

    event BeaconPosted(uint64 indexed round, bytes32 value);

    /// @param publicKeyG2_ BLS public key in the 256-byte EIP-2537 G2 encoding.
    /// @param genesisTime_ Unix timestamp of the first beacon.
    /// @param period_ Seconds between beacons.
    /// @param lookaheadRounds_ Future rounds reserved when callers open a selection request.
    constructor(bytes memory publicKeyG2_, uint64 genesisTime_, uint64 period_, uint64 lookaheadRounds_) {
        if (publicKeyG2_.length != 256) revert InvalidPublicKeyLength(publicKeyG2_.length);
        if (period_ == 0) revert InvalidPeriod();
        if (lookaheadRounds_ == 0) revert InvalidLookahead();
        _publicKeyG2 = publicKeyG2_;
        genesisTime = genesisTime_;
        period = period_;
        lookaheadRounds = lookaheadRounds_;
    }

    /// @notice Returns the drand round corresponding to the current timestamp, or zero before genesis.
    function currentRound() public view returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < genesisTime) return 0;
        return uint64((block.timestamp - genesisTime) / period + 1);
    }

    /// @inheritdoc IRandomness
    function nextTicket() external view override returns (uint64) {
        return currentRound() + lookaheadRounds;
    }

    /// @inheritdoc IRandomness
    function isExpired(uint64) external pure override returns (bool) {
        return false;
    }

    /// @notice Returns the posted beacon value for a round, or zero when absent.
    function beaconOf(uint64 round) external view returns (bytes32) {
        return _beacons[round];
    }

    /// @notice Permissionlessly verify and store a beacon signature.
    function postBeacon(uint64 round, bytes calldata signatureG1) external {
        if (_beacons[round] != bytes32(0)) return;
        if (signatureG1.length != 128) revert InvalidBeacon(round);
        bytes32 message = sha256(abi.encodePacked(round));
        bytes memory h = _hashToG1(message);
        bytes memory input = bytes.concat(signatureG1, NEG_G2_GENERATOR, h, _publicKeyG2);
        (bool ok, bytes memory result) = address(0x0f).staticcall(input);
        if (!ok || result.length != 32 || abi.decode(result, (uint256)) != 1) revert InvalidBeacon(round);
        bytes32 value = keccak256(signatureG1);
        _beacons[round] = value;
        emit BeaconPosted(round, value);
    }

    /// @inheritdoc IRandomness
    function seed(bytes32 context, uint64 round) external view override returns (bytes32) {
        bytes32 value = _beacons[round];
        if (value == bytes32(0)) revert SeedNotReady(round, currentRound());
        return keccak256(abi.encode(context, value));
    }

    /// @notice Hash a 32-byte message to G1 using RFC 9380 hash_to_curve and EIP-2537.
    function hashToG1(bytes32 message) external view returns (bytes memory) {
        return _hashToG1(message);
    }

    function _hashToG1(bytes32 message) private view returns (bytes memory) {
        bytes memory dstPrime = bytes.concat(DST, bytes1(uint8(DST.length)));
        // aderyn-fp-next-line(abi-encode-packed-hash-collision) RFC 9380 xmd layout; dynamic parts are fixed-length
        bytes32 b0 = sha256(abi.encodePacked(new bytes(64), message, uint16(128), bytes1(0), dstPrime));
        bytes32 b1 = sha256(abi.encodePacked(b0, bytes1(uint8(1)), dstPrime));
        bytes32 b2 = sha256(abi.encodePacked(_xor(b0, b1), bytes1(uint8(2)), dstPrime));
        bytes32 b3 = sha256(abi.encodePacked(_xor(b0, b2), bytes1(uint8(3)), dstPrime));
        bytes32 b4 = sha256(abi.encodePacked(_xor(b0, b3), bytes1(uint8(4)), dstPrime));
        bytes memory u0 = _reduce(bytes.concat(b1, b2));
        bytes memory u1 = _reduce(bytes.concat(b3, b4));
        bytes memory q0 = _mapToG1(u0);
        bytes memory q1 = _mapToG1(u1);
        (bool ok, bytes memory sum) = address(0x0b).staticcall(bytes.concat(q0, q1));
        if (!ok || sum.length != 128) revert PrecompileFailure(address(0x0b));
        return sum;
    }

    function _reduce(bytes memory value) private view returns (bytes memory result) {
        // aderyn-fp-next-line(abi-encode-packed-hash-collision) EIP-198 MODEXP input for a precompile, not hashed
        bytes memory input = abi.encodePacked(
            uint256(64), uint256(1), uint256(64), value, bytes1(uint8(1)),
            hex"000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab"
        );
        bool ok;
        (ok, result) = address(0x05).staticcall(input);
        if (!ok || result.length != 64) revert PrecompileFailure(address(0x05));
    }

    function _mapToG1(bytes memory fp) private view returns (bytes memory point) {
        bool ok;
        (ok, point) = address(0x10).staticcall(fp);
        if (!ok || point.length != 128) revert PrecompileFailure(address(0x10));
    }

    function _xor(bytes32 a, bytes32 b) private pure returns (bytes32 c) {
        c = a ^ b;
    }
}
