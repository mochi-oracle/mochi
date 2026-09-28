import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { backupSqlite, restoreSqliteBackup, verifySqliteBackup } from './claims-sqlite-backup.ts';

const roots: string[] = [];
const openDatabases: Database[] = [];
function fixtureDb(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'mochi-sqlite-recovery-'));
  roots.push(root);
  const path = join(root, 'fixture.sqlite');
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE claim_usage(day TEXT PRIMARY KEY, actions INTEGER NOT NULL);
    CREATE TABLE review_allocations(batch_id TEXT PRIMARY KEY, amount TEXT NOT NULL);
    INSERT INTO claim_usage VALUES ('synthetic-day', 7);
    INSERT INTO review_allocations VALUES ('synthetic-batch', '12345678901234567890');`);
  openDatabases.push(db);
  return { root, path };
}
afterEach(() => { for (const db of openDatabases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('backs up, verifies, restores, and checks a synthetic claims/accounting SQLite fixture', () => {
  const { root, path } = fixtureDb();
  const backup = join(root, 'verified-backup.sqlite');
  const restored = join(root, 'restored.sqlite');
  const writer = openDatabases[0]!;
  writer.query('INSERT INTO claim_usage VALUES (?, ?)').run('live-wal-day', 9);
  const expected = backupSqlite(path, backup);
  expect(expected).toEqual({ integrity: 'ok', tables: [{ name: 'claim_usage', rows: 2 }, { name: 'review_allocations', rows: 1 }] });
  expect(verifySqliteBackup(backup)).toEqual(expected);
  expect(restoreSqliteBackup(backup, restored)).toEqual(expected);
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  expect(statSync(restored).mode & 0o777).toBe(0o600);
  const db = new Database(restored, { readonly: true });
  try {
    expect(db.query('SELECT actions FROM claim_usage').get()).toEqual({ actions: 7 });
    expect(db.query('SELECT actions FROM claim_usage WHERE day = ?').get('live-wal-day')).toEqual({ actions: 9 });
    expect(db.query('SELECT amount FROM review_allocations').get()).toEqual({ amount: '12345678901234567890' });
  } finally { db.close(); }
  const writable = new Database(restored);
  try { writable.query('INSERT INTO claim_usage VALUES (?, ?)').run('post-restore-write', 1); }
  finally { writable.close(); }
  expect(verifySqliteBackup(restored).tables.find((table) => table.name === 'claim_usage')?.rows).toBe(3);
});

test('refuses to overwrite sources, backups, or restore destinations and rejects corrupt files', () => {
  const { root, path } = fixtureDb();
  const backup = join(root, 'backup.sqlite');
  backupSqlite(path, backup);
  expect(() => backupSqlite(path, path)).toThrow();
  expect(() => backupSqlite(path, backup)).toThrow();
  expect(() => restoreSqliteBackup(backup, backup)).toThrow();
  expect(() => restoreSqliteBackup(backup, path)).toThrow();
  const corrupt = join(root, 'corrupt.sqlite');
  writeFileSync(corrupt, 'synthetic-corrupt-fixture');
  expect(() => verifySqliteBackup(corrupt)).toThrow();
});
