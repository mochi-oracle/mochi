import { Database } from 'bun:sqlite';
import type { ClaimReview } from './types.ts';

/** Only explicitly published results and aggregate usage counters go to disk. */
export interface PublicClaimStore {
  publish(id: string, review: ClaimReview): void;
  shared(id: string): ClaimReview | null;
  reserve(day: string, limit: number): boolean;
}

export class SqlitePublicClaimStore implements PublicClaimStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS claim_publications (id TEXT PRIMARY KEY, review TEXT NOT NULL); CREATE TABLE IF NOT EXISTS claim_usage (day TEXT PRIMARY KEY, actions INTEGER NOT NULL);');
  }
  publish(id: string, review: ClaimReview): void {
    this.db.query('INSERT INTO claim_publications (id, review) VALUES (?, ?)').run(id, JSON.stringify(review));
  }
  shared(id: string): ClaimReview | null {
    const row = this.db.query('SELECT review FROM claim_publications WHERE id = ?').get(id) as { review: string } | null;
    return row ? JSON.parse(row.review) as ClaimReview : null;
  }
  reserve(day: string, limit: number): boolean {
    return this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO claim_usage (day, actions) VALUES (?, 0)').run(day);
      const result = this.db.query('UPDATE claim_usage SET actions = actions + 1 WHERE day = ? AND actions < ?').run(day, limit);
      return result.changes === 1;
    })();
  }
  close(): void { this.db.close(); }
}
