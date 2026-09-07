export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}
