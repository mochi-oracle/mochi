// Hosts several juror seats of one operator in a single process, so a small enclave VM can run all nine seats.
// JUROR_SEATS_JSON lists each seat's own variables (port, key label, class, model, sealed store); everything else,
// including provider credentials, comes from the shared process environment. Any seat failure stops the process.
import { z } from "zod";
import { startJurorServer } from "./server.ts";

const SeatsSchema = z.array(z.record(z.string(), z.string())).min(1).max(16);
const PER_SEAT_ONLY = ["PORT", "TEE_KEY_LABEL", "SEALED_STORE_DIR"] as const;

export function parseSeats(raw: string | undefined): Array<Record<string, string>> {
  if (!raw) throw new Error("JUROR_SEATS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("JUROR_SEATS_JSON must be JSON"); }
  const seats = SeatsSchema.parse(parsed);
  for (const key of PER_SEAT_ONLY) {
    const values = seats.map((seat, i) => { const value = seat[key]; if (!value) throw new Error(`seat ${i} must set ${key}`); return value; });
    if (new Set(values).size !== values.length) throw new Error(`every seat needs a distinct ${key}`);
  }
  return seats;
}

if (import.meta.main) {
  const seats = parseSeats(process.env.JUROR_SEATS_JSON);
  const shared = { ...process.env };
  delete shared.JUROR_SEATS_JSON;
  for (const [i, seat] of seats.entries()) {
    try { await startJurorServer({ ...shared, ...seat }); }
    catch { console.error(`juror seat ${i} failed to start`); process.exit(1); }
  }
  console.info(`juror pool serving ${seats.length} seats`);
}
