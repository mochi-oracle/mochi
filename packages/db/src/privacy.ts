import type postgres from "postgres";

export const FORBIDDEN_COLUMN_PATTERNS = [
  /doc_?bytes/i, /doc_?text/i, /document/i, /plaintext/i, /span_?text/i, /raw_/i, /^spans$/i, /doc_hash/i,
] as const;

/** Checks every column in the current schema for names that could hold prohibited content. */
export async function assertSchemaPrivacy(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;
  const offenders = rows.filter(({ column_name }) => FORBIDDEN_COLUMN_PATTERNS.some((pattern) => pattern.test(column_name)));
  if (offenders.length) throw new Error(`Forbidden database columns: ${offenders.map((c) => `${c.table_name}.${c.column_name}`).sort().join(", ")}`);
}
