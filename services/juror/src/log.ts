export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, string | number | boolean> = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}
