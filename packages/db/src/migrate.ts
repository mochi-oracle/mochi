import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies ordered SQL migrations once each, committing each migration atomically. */
export async function migrate(sql: postgres.Sql, opts: { schema?: string } = {}): Promise<void> {
  const schema = opts.schema;
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("Invalid schema name");
  if (schema) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    const contents = await readFile(join(migrationsDir, name), "utf8");
    await sql.begin(async (tx) => {
      if (schema) await tx`SET LOCAL search_path TO ${tx(schema)}, public`;
      await tx`CREATE TABLE IF NOT EXISTS _mochi_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const [existing] = await tx<{ name: string }[]>`SELECT name FROM _mochi_migrations WHERE name = ${name}`;
      if (existing) return;
      await tx.unsafe(contents);
      await tx`INSERT INTO _mochi_migrations (name) VALUES (${name})`;
    });
  }
}
