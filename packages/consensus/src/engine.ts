import {
  agreeBps as calculateAgreeBps,
  canonicalJson,
  isValidN,
  requiredAgree,
  type ConsensusResult,
  type FieldOutcome,
  type FieldSpec,
  type NormalizedValue,
  type SchemaDef,
  type SeatInput,
  type Tolerance,
  VerdictStatus,
} from "@mochi/core";

export class ConsensusInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsensusInputError";
  }
}

type Classification =
  | { kind: "TIMEOUT" }
  | { kind: "INVALID" }
  | { kind: "NULL" }
  | { kind: "VALUE"; value: NormalizedValue };
type Candidate = { kind: "NULL" } | { kind: "VALUE"; value: NormalizedValue };

function sameValue(a: NormalizedValue, b: NormalizedValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "num" && b.t === "num") return a.e8 === b.e8;
  return "v" in a && "v" in b && a.v === b.v;
}

function supports(anchor: Candidate, item: Candidate, tolerance: Tolerance): boolean {
  if (anchor.kind === "NULL" || item.kind === "NULL") return anchor.kind === item.kind;
  const a = anchor.value;
  const x = item.value;
  if (a.t !== x.t) return false;
  if (a.t === "num" && x.t === "num") {
    const distance = x.e8 >= a.e8 ? x.e8 - a.e8 : a.e8 - x.e8;
    if (tolerance.kind === "rel") return distance * 10000n <= BigInt(tolerance.bps) * (a.e8 < 0n ? -a.e8 : a.e8);
    if (tolerance.kind === "abs") return distance <= tolerance.e8;
  }
  return sameValue(a, x);
}

function medianTwiceDistance(value: NormalizedValue, middleSum: bigint): bigint {
  if (value.t !== "num") return 0n;
  const twice = value.e8 * 2n;
  return twice >= middleSum ? twice - middleSum : middleSum - twice;
}

function compareCandidates(a: Candidate, b: Candidate, middleSum: bigint): number {
  if (a.kind !== b.kind) return a.kind === "VALUE" ? -1 : 1;
  if (a.kind === "VALUE" && b.kind === "VALUE" && a.value.t === "num" && b.value.t === "num") {
    const da = medianTwiceDistance(a.value, middleSum);
    const db = medianTwiceDistance(b.value, middleSum);
    if (da !== db) return da < db ? -1 : 1;
  }
  const as = a.kind === "NULL" ? "null" : canonicalJson(a.value);
  const bs = b.kind === "NULL" ? "null" : canonicalJson(b.value);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function fieldOutcome(field: FieldSpec, seats: SeatInput[], n: number, k: number): FieldOutcome {
  const classified: Classification[] = seats.map((seat) => {
    if (seat.timedOut) return { kind: "TIMEOUT" };
    const answer = seat.answer;
    const value = answer.fields[field.name];
    if (answer.invalid.includes(field.name)) return { kind: "INVALID" };
    if (value === null) return { kind: "NULL" };
    if (value === undefined || !answer.spans.some((span) => span.field === field.name) || value.t !== field.kind) {
      return { kind: "INVALID" };
    }
    return { kind: "VALUE", value };
  });

  const candidates: Candidate[] = [];
  for (const c of classified) {
    if (c.kind === "VALUE") candidates.push({ kind: "VALUE", value: c.value });
    else if (!field.required && c.kind === "NULL") candidates.push({ kind: "NULL" });
  }
  const numericValues = classified.flatMap((c) => c.kind === "VALUE" && c.value.t === "num" ? [c.value.e8] : []).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const middleSum = numericValues.length === 0 ? 0n : numericValues[Math.floor((numericValues.length - 1) / 2)]! + numericValues[Math.floor(numericValues.length / 2)]!;

  let anchor: Candidate | undefined;
  let anchorSeats: number[] = [];
  for (const candidate of candidates) {
    const supported = classified.flatMap((c, seat) => {
      if (c.kind === "VALUE") return supports(candidate, { kind: "VALUE", value: c.value }, field.tolerance) ? [seat] : [];
      if (c.kind === "NULL") return supports(candidate, { kind: "NULL" }, field.tolerance) ? [seat] : [];
      return [];
    });
    if (anchor === undefined || supported.length > anchorSeats.length || (supported.length === anchorSeats.length && compareCandidates(candidate, anchor, middleSum) < 0)) {
      anchor = candidate;
      anchorSeats = supported;
    }
  }

  const agreeCount = anchor === undefined ? 0 : anchorSeats.length;
  const hung = agreeCount < k;
  const value = !hung && anchor?.kind === "VALUE" ? anchor.value : null;
  const supportingSeats = anchor === undefined ? [] : anchorSeats;
  const supportSet = new Set(supportingSeats);
  const dissent: FieldOutcome["dissent"] = {};
  classified.forEach((c, seat) => {
    if (supportSet.has(seat)) return;
    dissent[seat] = c.kind === "VALUE" ? c.value : c.kind === "NULL" ? null : c.kind;
  });
  return { field: field.name, required: field.required, value, agreeCount, agreeBps: calculateAgreeBps(agreeCount, n), hung, dissent, supportingSeats };
}

/** Computes deterministic field consensus for one complete jury round. */
export function runConsensus(def: SchemaDef, inputSeats: SeatInput[]): ConsensusResult {
  const n = inputSeats.length;
  if (!isValidN(n)) throw new ConsensusInputError(`invalid jury size: ${n}`);
  const seats = [...inputSeats].sort((a, b) => a.seat - b.seat);
  for (let i = 0; i < n; i++) {
    if (seats[i]!.seat !== i) throw new ConsensusInputError("seat numbers must be exactly 0..n-1");
  }
  for (const seat of seats) {
    if (!seat.timedOut && (seat.answer.schemaId !== def.id || seat.answer.schemaVersion !== def.version)) {
      throw new ConsensusInputError(`schema mismatch at seat ${seat.seat}`);
    }
  }

  const k = requiredAgree(n);
  const fields = def.fields.map((field) => fieldOutcome(field, seats, n, k));
  const requiredFields = fields.filter((field) => field.required);
  const status = requiredFields.some((field) => field.hung) ? VerdictStatus.HUNG : VerdictStatus.VERDICT;
  const agreementBps = requiredFields.length ? Math.min(...requiredFields.map((field) => field.agreeBps)) : 10000;
  let timeoutMask = 0;
  seats.forEach((seat) => { if (seat.timedOut) timeoutMask |= 1 << seat.seat; });
  let dissentMask = timeoutMask;
  for (const field of requiredFields) {
    const supportsSet = new Set(field.supportingSeats);
    for (let seat = 0; seat < n; seat++) if (!supportsSet.has(seat)) dissentMask |= 1 << seat;
  }

  const agreed: Record<string, NormalizedValue | null> = {};
  const hungFields: string[] = [];
  for (const field of fields) {
    if (field.hung) {
      hungFields.push(field.field);
      if (!field.required) agreed[field.field] = null;
    } else agreed[field.field] = field.value;
  }
  return { status, n, k, agreementBps, dissentMask, timeoutMask, fields, agreed, hungFields };
}
