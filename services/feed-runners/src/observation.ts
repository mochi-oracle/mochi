import { BaseError, ContractFunctionRevertedError } from "viem";

/** StockTokenCrosscheck.observationOf(ticker): the multiplier in force at observedAt and the token's effectiveAt then. */
export interface MultiplierObservation { observedAt: bigint; scheduledAt: bigint; multiplier: bigint }

/**
 * True when the crosscheck's last observation already records what observeMultiplier() would record now (the multiplier
 * in force and the token's effectiveAt), so a new observation would only move observedAt. The contract's baseline rule
 * (_observedBaseline) gives such an observation the same result whatever its observedAt, with one exception handled
 * here: an observation taken while a change was pending only counts for that change, so once the change has taken
 * effect it is refreshed even if the multiplier did not move.
 */
export function observationIsCurrent(observation: MultiplierObservation, token: { uiMultiplier: bigint; effectiveAt: bigint }, nowSec: bigint): boolean {
  if (observation.observedAt === 0n) return false;
  if (observation.multiplier !== token.uiMultiplier || observation.scheduledAt !== token.effectiveAt) return false;
  if (observation.scheduledAt > observation.observedAt && nowSec >= observation.scheduledAt) return false;
  return true;
}

/** Short, content-free reason for a failed chain call: the custom error name when the contract reverted with one. */
export function failureReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName) return reverted.data.errorName;
    return error.shortMessage.split("\n")[0]!.slice(0, 160);
  }
  return error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : "unknown error";
}
