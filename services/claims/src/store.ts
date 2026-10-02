import { Database } from 'bun:sqlite';
import type { ClaimReview, ClaimCorrection, PublicClaimRecord } from './types.ts';
import type { ProviderBudgetStore } from './budget.ts';

/** Only explicitly published results and aggregate usage counters go to disk. */
export interface PublicClaimStore {
  publish(id: string, review: ClaimReview, ownerTokenHash: string): void;
  shared(id: string): PublicClaimRecord | null;
  ownerHash(id: string): string | null;
  correct(id: string, correction: ClaimCorrection): boolean;
  unpublish(id: string): boolean;
  reserve(day: string, limit: number): boolean;
}

export class SqlitePublicClaimStore implements PublicClaimStore, ProviderBudgetStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS claim_publications (id TEXT PRIMARY KEY, review TEXT NOT NULL, owner_hash TEXT, corrections TEXT NOT NULL DEFAULT \'[]\', published INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS claim_usage (day TEXT PRIMARY KEY, actions INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS claim_provider_usage (day TEXT NOT NULL, juror TEXT NOT NULL, calls INTEGER NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (day, juror));');
    const columns = this.db.query('PRAGMA table_info(claim_publications)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'owner_hash')) this.db.exec('ALTER TABLE claim_publications ADD COLUMN owner_hash TEXT');
    if (!columns.some(column => column.name === 'corrections')) this.db.exec("ALTER TABLE claim_publications ADD COLUMN corrections TEXT NOT NULL DEFAULT '[]'");
    if (!columns.some(column => column.name === 'published')) this.db.exec('ALTER TABLE claim_publications ADD COLUMN published INTEGER NOT NULL DEFAULT 1');
  }
  publish(id: string, review: ClaimReview, ownerTokenHash: string): void {
    this.db.query('INSERT INTO claim_publications (id, review, owner_hash, corrections, published) VALUES (?, ?, ?, \'[]\', 1)').run(id, JSON.stringify(review), ownerTokenHash);
  }
  shared(id: string): PublicClaimRecord | null {
    const row = this.db.query('SELECT review, corrections FROM claim_publications WHERE id = ? AND published = 1').get(id) as { review: string; corrections: string } | null;
    return row ? { review: JSON.parse(row.review) as ClaimReview, corrections: JSON.parse(row.corrections) as ClaimCorrection[] } : null;
  }
  ownerHash(id: string): string | null {
    const row = this.db.query('SELECT owner_hash FROM claim_publications WHERE id = ?').get(id) as { owner_hash: string | null } | null;
    return row?.owner_hash ?? null;
  }
  correct(id: string, correction: ClaimCorrection): boolean {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT corrections FROM claim_publications WHERE id = ? AND published = 1').get(id) as { corrections: string } | null;
      if (!row) return false;
      const corrections = JSON.parse(row.corrections) as ClaimCorrection[];
      if (corrections.length >= 100) return false;
      corrections.push(correction);
      this.db.query('UPDATE claim_publications SET corrections = ? WHERE id = ? AND published = 1').run(JSON.stringify(corrections), id);
      return true;
    })();
  }
  unpublish(id: string): boolean {
    return this.db.query('DELETE FROM claim_publications WHERE id = ? AND published = 1').run(id).changes === 1;
  }
  reserve(day: string, limit: number): boolean {
    return this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO claim_usage (day, actions) VALUES (?, 0)').run(day);
      const result = this.db.query('UPDATE claim_usage SET actions = actions + 1 WHERE day = ? AND actions < ?').run(day, limit);
      return result.changes === 1;
    })();
  }
  reserveProvider(day: string, key: string, tokens: number, limits: { calls: number; tokens: number }): boolean {
    return this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO claim_provider_usage (day, juror, calls, tokens) VALUES (?, ?, 0, 0)').run(day, key);
      const result = this.db.query('UPDATE claim_provider_usage SET calls = calls + 1, tokens = tokens + ? WHERE day = ? AND juror = ? AND calls < ? AND tokens + ? <= ?')
        .run(tokens, day, key, limits.calls, tokens, limits.tokens);
      return result.changes === 1;
    })();
  }
  settleProvider(day: string, key: string, tokenDelta: number): void {
    this.db.query('UPDATE claim_provider_usage SET tokens = MAX(0, tokens + ?) WHERE day = ? AND juror = ?').run(tokenDelta, day, key);
  }
  releaseProvider(day: string, key: string, tokens: number): void {
    this.db.query('UPDATE claim_provider_usage SET calls = MAX(0, calls - 1), tokens = MAX(0, tokens - ?) WHERE day = ? AND juror = ?').run(tokens, day, key);
  }
  providerUsage(day: string, key: string): { calls: number; tokens: number } {
    const row = this.db.query('SELECT calls, tokens FROM claim_provider_usage WHERE day = ? AND juror = ?').get(day, key) as { calls: number; tokens: number } | null;
    return row ?? { calls: 0, tokens: 0 };
  }
  close(): void { this.db.close(); }
}
