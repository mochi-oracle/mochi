import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { BuybackStore, PersistedBuyback } from './buybacks.ts';

/** Local durable store for a dedicated, attributable review-revenue treasury.
 * SQLite writes are atomic; cross-process locks are durable until their owner
 * exits, so a crash cannot turn an uncertain submission into a fresh submit.
 */
export class SqliteBuybackStore implements BuybackStore {
  private readonly db: Database;

  constructor(path: string, private readonly lockWaitMs = 30_000) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS buyback_records (batch_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buyback_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buyback_locks (lock_key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_settlements (
        event_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, amount TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source = 'settled_customer_review'), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_allocations (
        batch_id TEXT PRIMARY KEY, amount TEXT NOT NULL, event_ids TEXT NOT NULL,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_allocation_events (event_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL);`);
  }

  async withBatchLock<T>(id: string, action: () => Promise<T>): Promise<T> { return this.withLock(`batch:${id}`, action); }
  async withTreasuryLock<T>(address: string, action: () => Promise<T>): Promise<T> { return this.withLock(`treasury:${address.toLowerCase()}`, action); }

  async reservedAmount(treasuryAddress: string): Promise<bigint> {
    const rows = this.db.query('SELECT payload FROM buyback_records').all() as { payload: string }[];
    return rows.reduce((sum, row) => {
      const record = decodeRecord(row.payload);
      return sum + (['submitting', 'submitted'].includes(record.status)
        && record.execution.treasuryAddress.toLowerCase() === treasuryAddress.toLowerCase() ? record.execution.amountIn : 0n);
    }, 0n);
  }

  async get(id: string): Promise<PersistedBuyback | undefined> {
    const row = this.db.query('SELECT payload FROM buyback_records WHERE batch_id = ?').get(id) as { payload: string } | null;
    return row ? decodeRecord(row.payload) : undefined;
  }

  async begin(record: PersistedBuyback): Promise<void> {
    if (record.status !== 'submitting' || record.execution.amountIn <= 0n || record.grossReviewRevenue === undefined || record.execution.amountIn > record.grossReviewRevenue) throw new Error('invalid initial reservation');
    this.db.transaction(() => {
      const allocation = this.db.query('SELECT amount FROM review_allocations WHERE batch_id = ?').get(record.settledBatchId) as { amount: string } | null;
      if (!allocation || BigInt(allocation.amount) !== record.grossReviewRevenue) throw new Error('buyback requires a matching persisted review allocation');
      this.db.query('INSERT INTO buyback_records (batch_id, payload) VALUES (?, ?)').run(record.settledBatchId, encodeRecord(record));
      this.audit(record.settledBatchId, 'reservation_created', record);
    })();
  }

  async markSubmitted(id: string, transactionRef: string): Promise<PersistedBuyback> {
    if (!transactionRef) throw new Error('transaction reference required');
    return this.update(id, (record) => {
      if (record.status === 'submitted' && record.transactionRef === transactionRef) return false;
      if (record.status === 'purchased' || record.status === 'failed' || record.status === 'cancelled') throw new Error('terminal buyback cannot be submitted');
      if (record.transactionRef && record.transactionRef !== transactionRef) throw new Error('transaction reference conflict');
      record.status = 'submitted'; record.transactionRef = transactionRef;
    });
  }

  async markPurchased(id: string, transactionRef: string, receivedTokenAmount: bigint): Promise<PersistedBuyback> {
    if (!transactionRef || receivedTokenAmount <= 0n) throw new Error('invalid purchase receipt');
    return this.update(id, (record) => {
      if (record.status === 'purchased') {
        if (record.transactionRef === transactionRef && record.receivedTokenAmount === receivedTokenAmount) return false;
        throw new Error('confirmed purchase replay conflict');
      }
      if (record.status === 'failed' || record.status === 'cancelled') throw new Error('terminal buyback cannot be purchased');
      if (record.transactionRef && record.transactionRef !== transactionRef) throw new Error('transaction reference conflict');
      record.status = 'purchased'; record.transactionRef = transactionRef; record.receivedTokenAmount = receivedTokenAmount;
    });
  }

  async markFailed(id: string, transactionRef: string): Promise<PersistedBuyback> {
    if (!transactionRef) throw new Error('transaction reference required');
    return this.update(id, (record) => {
      if (record.status === 'purchased') throw new Error('confirmed purchase cannot become failed');
      if (record.status === 'failed') {
        if (record.transactionRef === transactionRef) return false;
        throw new Error('failed transaction replay conflict');
      }
      if (record.status === 'cancelled') throw new Error('cancelled buyback cannot become failed');
      if (record.transactionRef && record.transactionRef !== transactionRef) throw new Error('transaction reference conflict');
      record.status = 'failed'; record.transactionRef = transactionRef;
    });
  }

  async markCancelled(id: string): Promise<PersistedBuyback> {
    return this.update(id, (record) => {
      if (record.status === 'cancelled') return false;
      if (record.status !== 'submitting' || record.transactionRef) throw new Error('only unsubmitted reservations can be cancelled');
      record.status = 'cancelled';
    });
  }

  /** Add a settled event exactly once. Developer fees and deposits are rejected by source type. */
  recordSettledReviewEvent(input: { eventId: string; batchId: string; amount: bigint; source: 'settled_customer_review' }): void {
    if (!input.eventId || !input.batchId || input.amount <= 0n) throw new Error('invalid settled review event');
    this.db.transaction(() => {
      const prior = this.db.query('SELECT batch_id, amount, source FROM review_settlements WHERE event_id = ?').get(input.eventId) as { batch_id: string; amount: string; source: string } | null;
      if (prior) {
        if (prior.batch_id === input.batchId && prior.amount === input.amount.toString() && prior.source === input.source) return;
        throw new Error('settlement event replay conflict');
      }
      this.db.query('INSERT INTO review_settlements (event_id, batch_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.eventId, input.batchId, input.amount.toString(), input.source, new Date().toISOString());
    })();
  }

  /** Allocate whole settlement events once; event and batch uniqueness prevent replay under fresh IDs. */
  allocateSettledReviewBatch(input: { batchId: string; eventIds: string[] }): { amount: bigint; eventIds: string[] } {
    if (!input.batchId || input.eventIds.length === 0 || new Set(input.eventIds).size !== input.eventIds.length) throw new Error('invalid allocation input');
    const fingerprint = JSON.stringify([...input.eventIds].sort());
    return this.db.transaction(() => {
      const prior = this.db.query('SELECT amount, event_ids, fingerprint FROM review_allocations WHERE batch_id = ?').get(input.batchId) as { amount: string; event_ids: string; fingerprint: string } | null;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('batch allocation replay conflict');
        return { amount: BigInt(prior.amount), eventIds: JSON.parse(prior.event_ids) as string[] };
      }
      const already = this.db.query(`SELECT event_id FROM review_allocation_events WHERE event_id IN (${input.eventIds.map(() => '?').join(',')})`).all(...input.eventIds);
      if (already.length) throw new Error('settlement event already allocated');
      const rows = input.eventIds.map((id) => this.db.query('SELECT batch_id, amount FROM review_settlements WHERE event_id = ?').get(id) as { batch_id: string; amount: string } | null);
      if (rows.some((row) => !row)) throw new Error('settlement event missing');
      if (rows.some((row) => row!.batch_id !== input.batchId)) throw new Error('settlement event belongs to a different batch');
      const amount = rows.reduce((sum, row) => sum + BigInt(row!.amount), 0n);
      this.db.query('INSERT INTO review_allocations (batch_id, amount, event_ids, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.batchId, amount.toString(), JSON.stringify(input.eventIds), fingerprint, new Date().toISOString());
      const addEvent = this.db.query('INSERT INTO review_allocation_events (event_id, batch_id) VALUES (?, ?)');
      for (const eventId of input.eventIds) addEvent.run(eventId, input.batchId);
      return { amount, eventIds: [...input.eventIds] };
    })();
  }

  allocation(batchId: string): { amount: bigint; eventIds: string[] } | undefined {
    const row = this.db.query('SELECT amount, event_ids FROM review_allocations WHERE batch_id = ?').get(batchId) as { amount: string; event_ids: string } | null;
    return row ? { amount: BigInt(row.amount), eventIds: JSON.parse(row.event_ids) as string[] } : undefined;
  }

  auditTrail(batchId: string): Array<{ kind: string; record: PersistedBuyback; createdAt: string }> {
    const rows = this.db.query('SELECT kind, payload, created_at FROM buyback_audit WHERE batch_id = ? ORDER BY seq').all(batchId) as { kind: string; payload: string; created_at: string }[];
    return rows.map((row) => ({ kind: row.kind, record: decodeRecord(row.payload), createdAt: row.created_at }));
  }

  close(): void { this.db.close(); }

  private update(id: string, change: (record: PersistedBuyback) => boolean | void): PersistedBuyback {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT payload FROM buyback_records WHERE batch_id = ?').get(id) as { payload: string } | null;
      if (!row) throw new Error('buyback record not found');
      const record = decodeRecord(row.payload);
      const changed = change(record);
      if (changed === false) return record;
      this.db.query('UPDATE buyback_records SET payload = ? WHERE batch_id = ?').run(encodeRecord(record), id);
      this.audit(id, record.status, record);
      return record;
    })();
  }

  private audit(batchId: string, kind: string, record: PersistedBuyback): void {
    this.db.query('INSERT INTO buyback_audit (batch_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(batchId, kind, encodeRecord(record), new Date().toISOString());
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        this.db.query('INSERT INTO buyback_locks (lock_key, owner, pid) VALUES (?, ?, ?)').run(key, owner, process.pid);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
        const row = this.db.query('SELECT owner, pid FROM buyback_locks WHERE lock_key = ?').get(key) as { owner: string; pid: number } | null;
        if (row && processStatus(row.pid) === 'dead') {
          this.db.query('DELETE FROM buyback_locks WHERE lock_key = ? AND owner = ?').run(key, row.owner);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for durable lock ${key}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await action(); }
    finally { this.db.query('DELETE FROM buyback_locks WHERE lock_key = ? AND owner = ?').run(key, owner); }
  }
}

function processStatus(pid: number): 'alive' | 'dead' | 'uncertain' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A live PID could have been reused. Never reclaim an uncertain/live lock.
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'uncertain';
  }
}

function encodeRecord(record: PersistedBuyback): string {
  return JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value);
}

function decodeRecord(payload: string): PersistedBuyback {
  return JSON.parse(payload, (_key, value) => value && typeof value === 'object' && '$bigint' in value ? BigInt(value.$bigint as string) : value) as PersistedBuyback;
}
