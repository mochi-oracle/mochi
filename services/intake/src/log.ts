export type LogLevel = "info" | "warn" | "error";
/** Emit a single structured line. Callers must pass only non-sensitive metadata. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}
