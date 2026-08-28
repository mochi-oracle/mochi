/** Write one JSON log line with no document or private result values. */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(`${JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  })}\n`);
}
