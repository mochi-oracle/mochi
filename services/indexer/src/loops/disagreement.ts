import type { JurorPassport, ModelDisagreementWrite, StorePort } from "../ports.ts";
import type { Hex } from "viem";

const WINDOWS = [
  { name: "1 hour", milliseconds: 3_600_000 },
  { name: "1 day", milliseconds: 86_400_000 },
] as const;

export interface ReceiptJuror {
  seat: number;
  juror: string;
  passport?: JurorPassport;
}

interface DisagreementAggregate {
  field: string;
  jurorClass: number;
  samples: number;
  disagreeCount: number;
}

/** Build hourly and daily public disagreement aggregates for a verdict. */
export async function buildDisagreementRows(
  store: StorePort,
  verdictId: Hex,
  timestamp: Date,
  schemaId: number,
): Promise<Array<{
  bucket: Date;
  window: string;
  schemaId: number;
  field: string;
  class: number;
  samples: number;
  disagreeCount: number;
  disagreeRate: number;
}>> {
  const stored = await store.getVerdict(verdictId);
  if (!stored?.verdict || stored.verdict.isPublic !== true || !stored.publicPart) return [];

  const answer = stored.publicPart.answer;
  const disagreement = answer && typeof answer === "object"
    ? (answer as { disagreement?: unknown }).disagreement
    : undefined;
  if (!Array.isArray(disagreement) || disagreement.length === 0) return [];

  const aggregates = new Map<string, DisagreementAggregate>();
  for (const item of disagreement) {
    const record = asDisagreementRecord(item);
    if (!record) continue;
    const key = `${record.field}:${record.jurorClass}`;
    const aggregate = aggregates.get(key) ?? {
      field: record.field,
      jurorClass: record.jurorClass,
      samples: 0,
      disagreeCount: 0,
    };
    aggregate.samples++;
    if (record.disagreed) aggregate.disagreeCount++;
    aggregates.set(key, aggregate);
  }

  const rows = [];
  for (const aggregate of aggregates.values()) {
    for (const window of WINDOWS) {
      const bucketMilliseconds = Math.floor(timestamp.getTime() / window.milliseconds)
        * window.milliseconds;
      rows.push({
        bucket: new Date(bucketMilliseconds),
        window: window.name,
        schemaId,
        field: aggregate.field,
        class: aggregate.jurorClass,
        samples: aggregate.samples,
        disagreeCount: aggregate.disagreeCount,
        disagreeRate: aggregate.disagreeCount / aggregate.samples,
      });
    }
  }
  return rows;
}

/** Build the same public disagreement buckets keyed by each seated model Passport. */
export async function buildModelDisagreementRows(
  store: StorePort,
  verdictId: Hex,
  timestamp: Date,
  schemaId: number,
  jurors: ReceiptJuror[],
): Promise<ModelDisagreementWrite[]> {
  const stored = await store.getVerdict(verdictId);
  if (!stored?.verdict || stored.verdict.isPublic !== true || !stored.publicPart) return [];

  const answer = stored.publicPart.answer;
  const disagreement = answer && typeof answer === "object"
    ? (answer as { disagreement?: unknown }).disagreement
    : undefined;
  if (!Array.isArray(disagreement) || disagreement.length === 0) return [];

  const modelBySeat = new Map(jurors.flatMap((juror) => juror.passport
    ? [[juror.seat, juror.passport.modelId] as const]
    : []));
  const aggregates = new Map<
    string,
    { field: string; modelId: string; samples: number; disagreeCount: number }
  >();
  for (const item of disagreement) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const seat = Number(row.seat);
    const modelId = modelBySeat.get(seat);
    if (!modelId || typeof row.field !== "string" || typeof row.disagreed !== "boolean") continue;
    const key = `${row.field}:${modelId}`;
    const aggregate = aggregates.get(key) ?? {
      field: row.field,
      modelId,
      samples: 0,
      disagreeCount: 0,
    };
    aggregate.samples++;
    if (row.disagreed) aggregate.disagreeCount++;
    aggregates.set(key, aggregate);
  }

  const rows: ModelDisagreementWrite[] = [];
  for (const aggregate of aggregates.values()) {
    for (const window of WINDOWS) {
      const bucketMilliseconds = Math.floor(timestamp.getTime() / window.milliseconds)
        * window.milliseconds;
      rows.push({
        bucket: new Date(bucketMilliseconds),
        window: window.name,
        schemaId,
        field: aggregate.field,
        modelId: aggregate.modelId,
        samples: aggregate.samples,
        disagreeCount: aggregate.disagreeCount,
      });
    }
  }
  return rows;
}

/** Validate the public disagreement record fields used in aggregation. */
function asDisagreementRecord(value: unknown): {
  field: string;
  jurorClass: number;
  disagreed: boolean;
} | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const jurorClass = Number(record.jurorClass);
  if (typeof record.field !== "string" || record.field.length === 0) return null;
  if (!Number.isInteger(jurorClass) || jurorClass < 0 || jurorClass > 4) return null;
  if (typeof record.disagreed !== "boolean") return null;
  return { field: record.field, jurorClass, disagreed: record.disagreed };
}
