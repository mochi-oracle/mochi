import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";

export const DEFAULT_DATABASE_URL = "postgres://mochi:mochi@127.0.0.1:55432/mochi";
export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, opts: { schema?: string } = {}) {
  if (opts.schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.schema)) throw new Error("Invalid schema name");
  const sql = postgres(url, opts.schema ? { connection: { search_path: `${opts.schema},public` } } : {});
  const db = drizzle(sql, { schema });
  return { sql, db, close: () => sql.end() };
}
export type Database = ReturnType<typeof createDb>["db"];
