import { answerHash as hashAnswer, answerJson as serializeAnswer, merkleRoot, spanLeaf, type NormalizedValue, type SchemaDef, type SeatInput, type ConsensusResult } from "@mochi/core";
import type { Hex } from "viem";

/** Builds the committed answer and evidence roots emitted with a consensus result. */
export function buildVerdictHashes(def: SchemaDef, result: ConsensusResult, seats: SeatInput[], salt: Hex): {
  answerHash: Hex;
  answerJson: string;
  evidenceRoot: Hex;
} {
  const fields: Record<string, NormalizedValue | null> = {};
  for (const field of def.fields) fields[field.name] = result.agreed[field.name] ?? null;
  const answerArgs = { salt, schemaId: def.id, schemaVersion: def.version, fields };
  const leaves = new Set<Hex>();
  for (const outcome of result.fields) {
    if (outcome.hung || outcome.value === null) continue;
    const supporting = new Set(outcome.supportingSeats);
    for (const seat of seats) {
      if (seat.timedOut || !supporting.has(seat.seat)) continue;
      for (const span of seat.answer.spans) if (span.field === outcome.field) leaves.add(spanLeaf(span));
    }
  }
  return { answerHash: hashAnswer(answerArgs), answerJson: serializeAnswer(answerArgs), evidenceRoot: merkleRoot([...leaves]) };
}
