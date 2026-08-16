import type { ConsensusResult, SeatInput } from "@mochi/core";

export interface DisagreementRecord {
  field: string;
  jurorClass: SeatInput["jurorClass"];
  seat: number;
  disagreed: boolean;
  timedOut: boolean;
}

/** Returns one public index record for each field and jury seat. */
export function disagreementRecords(result: ConsensusResult, seats: SeatInput[]): DisagreementRecord[] {
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  return result.fields.flatMap((field) => {
    const supporters = new Set(field.supportingSeats);
    return ordered.map((seat) => ({ field: field.field, jurorClass: seat.jurorClass, seat: seat.seat, disagreed: !supporters.has(seat.seat), timedOut: seat.timedOut }));
  });
}
