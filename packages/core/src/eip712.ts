// EIP-712 domains and types. Must match MochiTypes.sol typehash strings exactly (see test/core.test.ts).
import { hashStruct, type Address, type Hex } from "viem";
import type { Provenance } from "./types.ts";

export const ESCROW_DOMAIN_NAME = "MochiQueryEscrow";
export const VERDICTS_DOMAIN_NAME = "MochiVerdicts";
export const DOMAIN_VERSION = "1";
export const PANEL_ROUND = 255;

export function escrowDomain(chainId: number, verifyingContract: Address) {
  return { name: ESCROW_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract } as const;
}

export function verdictsDomain(chainId: number, verifyingContract: Address) {
  return { name: VERDICTS_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract } as const;
}

/**
 * The intake's single-use grant to open one query. The first six members describe the measured document; the rest
 * bind it to the open the document owner sealed to the intake together with the document (see MochiTypes.sol).
 */
export const PROVENANCE_TYPES = {
  Provenance: [
    { name: "docCommit", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "originId", type: "bytes32" },
    { name: "fetchedAt", type: "uint64" },
    { name: "tokensK", type: "uint32" },
    { name: "transcriptHash", type: "bytes32" },
    { name: "opener", type: "address" },
    { name: "schemaId", type: "uint32" },
    { name: "schemaVersion", type: "uint16" },
    { name: "paramsHash", type: "bytes32" },
    { name: "payerCommit", type: "bytes32" },
    { name: "isPublic", type: "bool" },
    { name: "allowPanelDisclosure", type: "bool" },
    { name: "nonce", type: "uint64" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** EIP-712 struct hash of a Provenance: what QueryEscrow stores as Query.provenanceHash. */
export function provenanceHash(prov: Provenance): Hex {
  return hashStruct({ types: PROVENANCE_TYPES, primaryType: "Provenance", data: prov });
}

export const ANONYMA_VOUCHER_TYPES = {
  AnonymaVoucher: [
    { name: "voucherId", type: "bytes32" },
    { name: "queryId", type: "bytes32" },
    { name: "schemaId", type: "uint32" },
    { name: "n", type: "uint8" },
    { name: "maxAmount", type: "uint256" },
    { name: "tier", type: "uint8" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const JUROR_ANSWER_TYPES = {
  JurorAnswer: [
    { name: "queryId", type: "bytes32" },
    { name: "docCommit", type: "bytes32" },
    { name: "schemaId", type: "uint32" },
    { name: "schemaVersion", type: "uint16" },
    { name: "answerHash", type: "bytes32" },
    { name: "spansRoot", type: "bytes32" },
    { name: "quoteHash", type: "bytes32" },
  ],
} as const;

export const VERDICT_ATTESTATION_TYPES = {
  VerdictAttestation: [
    { name: "queryId", type: "bytes32" },
    { name: "round", type: "uint8" },
    { name: "status", type: "uint8" },
    { name: "agreementBps", type: "uint16" },
    { name: "dissentMask", type: "uint32" },
    { name: "timeoutMask", type: "uint32" },
    { name: "answerHash", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "evidenceRoot", type: "bytes32" },
    { name: "votesHash", type: "bytes32" },
  ],
} as const;

/** Type strings exactly as hashed in Solidity. */
export const TYPE_STRINGS = {
  Provenance:
    "Provenance(bytes32 docCommit,uint8 kind,bytes32 originId,uint64 fetchedAt,uint32 tokensK,bytes32 transcriptHash,address opener,uint32 schemaId,uint16 schemaVersion,bytes32 paramsHash,bytes32 payerCommit,bool isPublic,bool allowPanelDisclosure,uint64 nonce,uint64 expiry)",
  AnonymaVoucher:
    "AnonymaVoucher(bytes32 voucherId,bytes32 queryId,uint32 schemaId,uint8 n,uint256 maxAmount,uint8 tier,uint64 expiry)",
  JurorAnswer:
    "JurorAnswer(bytes32 queryId,bytes32 docCommit,uint32 schemaId,uint16 schemaVersion,bytes32 answerHash,bytes32 spansRoot,bytes32 quoteHash)",
  VerdictAttestation:
    "VerdictAttestation(bytes32 queryId,uint8 round,uint8 status,uint16 agreementBps,uint32 dissentMask,uint32 timeoutMask,bytes32 answerHash,bytes32 payloadHash,bytes32 evidenceRoot,bytes32 votesHash)",
} as const;
