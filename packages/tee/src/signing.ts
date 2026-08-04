import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";
import type { AnonymaVoucher, Provenance, VerdictInput } from "@mochi/core";
import { ANONYMA_VOUCHER_TYPES, escrowDomain, JUROR_ANSWER_TYPES, PROVENANCE_TYPES, verdictsDomain, VERDICT_ATTESTATION_TYPES } from "@mochi/core";

type Signed = { account: LocalAccount; signature: Hex };
const escrowTypes = PROVENANCE_TYPES;
const voucherTypes = ANONYMA_VOUCHER_TYPES;
const jurorTypes = JUROR_ANSWER_TYPES;
const verdictTypes = VERDICT_ATTESTATION_TYPES;

export async function signProvenance(account: LocalAccount, chainId: number, escrow: Address, prov: Provenance): Promise<Hex> {
  return account.signTypedData({ domain: escrowDomain(chainId, escrow), types: escrowTypes, primaryType: "Provenance", message: prov });
}
export async function recoverProvenance(chainId: number, escrow: Address, prov: Provenance, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain: escrowDomain(chainId, escrow), types: escrowTypes, primaryType: "Provenance", message: prov, signature });
}
export async function signAnonymaVoucher(account: LocalAccount, chainId: number, escrow: Address, voucher: AnonymaVoucher): Promise<Hex> {
  return account.signTypedData({ domain: escrowDomain(chainId, escrow), types: voucherTypes, primaryType: "AnonymaVoucher", message: voucher });
}
export async function recoverAnonymaVoucher(chainId: number, escrow: Address, voucher: AnonymaVoucher, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain: escrowDomain(chainId, escrow), types: voucherTypes, primaryType: "AnonymaVoucher", message: voucher, signature });
}
export type JurorAnswerSigningInput = { queryId: Hex; docCommit: Hex; schemaId: number; schemaVersion: number; answerHash: Hex; spansRoot: Hex; quoteHash: Hex };
export async function signJurorAnswer(account: LocalAccount, chainId: number, verdicts: Address, answer: JurorAnswerSigningInput): Promise<Hex> {
  return account.signTypedData({ domain: verdictsDomain(chainId, verdicts), types: jurorTypes, primaryType: "JurorAnswer", message: answer });
}
export async function recoverJurorAnswer(chainId: number, verdicts: Address, answer: JurorAnswerSigningInput, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain: verdictsDomain(chainId, verdicts), types: jurorTypes, primaryType: "JurorAnswer", message: answer, signature });
}
export async function signVerdictAttestation(account: LocalAccount, chainId: number, verdicts: Address, verdictInput: VerdictInput, votesHash: Hex): Promise<Hex> {
  return account.signTypedData({ domain: verdictsDomain(chainId, verdicts), types: verdictTypes, primaryType: "VerdictAttestation", message: { ...verdictInput, votesHash } });
}
export async function recoverVerdictAttestation(chainId: number, verdicts: Address, verdictInput: VerdictInput, votesHash: Hex, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain: verdictsDomain(chainId, verdicts), types: verdictTypes, primaryType: "VerdictAttestation", message: { ...verdictInput, votesHash }, signature });
}
