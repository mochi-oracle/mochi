#!/usr/bin/env bun
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

export interface SqliteSnapshotSummary { integrity: 'ok'; tables: Array<{ name: string; rows: number }> }

function regularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SQLite path must be a regular file');
}

function inspect(db: Database): SqliteSnapshotSummary {
  const result = db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>);
  return { integrity: 'ok', tables: tables.map(({ name }) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error('Unexpected SQLite table name');
    const row = db.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number };
    return { name, rows: row.count };
  }) };
}

function inspectFile(path: string): SqliteSnapshotSummary {
  const header = readFileSync(path).subarray(0, 16).toString('ascii');
  if (header !== 'SQLite format 3\0') throw new Error('Backup is not a SQLite database');
  const db = new Database(path, { readonly: true });
  try { return inspect(db); } finally { db.close(); }
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function privateTempDirectory(destination: string): string {
  return mkdtempSync(join(dirname(destination), '.mochi-sqlite-snapshot-'));
}

export function backupSqlite(source: string, destination: string): SqliteSnapshotSummary {
  const input = resolve(source), output = resolve(destination);
  if (input === output || existsSync(output)) throw new Error('Backup destination must be a new path separate from the source');
  regularFile(input);
  const db = new Database(input, { readonly: true });
  const tempDir = privateTempDirectory(output);
  const temporary = join(tempDir, 'snapshot.sqlite');
  try {
    inspect(db);
    // SQLite takes a consistent online snapshot, including committed WAL pages.
    db.query('VACUUM INTO ?').run(temporary);
    chmodSync(temporary, 0o600);
    syncFile(temporary);
    const summary = inspectFile(temporary);
    linkSync(temporary, output);
    const linkedSummary = inspectFile(output);
    if (JSON.stringify(linkedSummary) !== JSON.stringify(summary)) throw new Error('Backup verification mismatch');
    return summary;
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function verifySqliteBackup(backup: string): SqliteSnapshotSummary {
  const path = resolve(backup);
  regularFile(path);
  return inspectFile(path);
}

export function restoreSqliteBackup(backup: string, destination: string): SqliteSnapshotSummary {
  const input = resolve(backup), output = resolve(destination);
  if (input === output || existsSync(output)) throw new Error('Restore destination must be a new path separate from the backup');
  regularFile(input);
  const summary = inspectFile(input);
  const tempDir = privateTempDirectory(output);
  const temporary = join(tempDir, 'restored.sqlite');
  try {
    const source = new Database(input, { readonly: true });
    try { source.query('VACUUM INTO ?').run(temporary); } finally { source.close(); }
    chmodSync(temporary, 0o600);
    syncFile(temporary);
    const restored = inspectFile(temporary);
    if (JSON.stringify(restored) !== JSON.stringify(summary)) throw new Error('Restored SQLite verification mismatch');
    linkSync(temporary, output);
    const linkedSummary = inspectFile(output);
    if (JSON.stringify(linkedSummary) !== JSON.stringify(summary)) throw new Error('Restore verification mismatch');
    return restored;
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}

function main(args: string[]): number {
  try {
    const [mode, source, destination, ...extra] = args;
    if (extra.length || !source || (mode !== 'verify' && !destination) || (mode === 'verify' && destination)) {
      console.error('Usage: bun scripts/claims-sqlite-backup.ts backup <live.sqlite> <new-backup.sqlite> | verify <backup.sqlite> | restore <backup.sqlite> <new-restore.sqlite>');
      return 2;
    }
    const summary = mode === 'backup' ? backupSqlite(source, destination!) : mode === 'verify' ? verifySqliteBackup(source) : mode === 'restore' ? restoreSqliteBackup(source, destination!) : undefined;
    if (!summary) throw new Error('Unknown mode');
    console.log(JSON.stringify(summary));
    return 0;
  } catch {
    console.error('SQLite backup operation failed; inspect paths and local storage permissions. No existing destination was overwritten.');
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
