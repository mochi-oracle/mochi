import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { BuybackStore, PersistedBuyback } from './buybacks.ts';

export type ConfirmedReviewRevenueRecord = {
  eventId: string;
  chainId: bigint;
  escrow: string;
  usdg: string;
  recipient: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  queryId: string;
  amount: bigint;
  payPath: 'USDG' | 'SHIELDED' | 'ANONYMA' | 'FEED';
  queryStatus: 'NONE' | 'OPEN' | 'SEALED' | 'DECIDED' | 'HUNG' | 'ESCALATED' | 'EXPIRED';
  receiptStatus: 'success' | 'reverted';
  transferFrom: string;
  transferTo: string;
  transferAmount: bigint;
  verification: 'confirmed' | 'unconfirmed';
  createdAt: string;
};

export type ReviewAllocationRecord = { batchId: string; amount: bigint; eventIds: string[] };

export type ReviewIngestionCursor = {
  streamId: string;
  configJson: string;
  startBlock: bigint;
  nextBlock: bigint;
  lastBlock: bigint;
  lastBlockHash: string;
  finalizedBlock: bigint;
  updatedAt: string;
};

type ChainSettlementRow = {
  event_id: string; chain_id: string; escrow: string; usdg: string; recipient: string; block_number: string;
  block_hash: string; transaction_hash: string; log_index: number; query_id: string; amount: string;
  pay_path: ConfirmedReviewRevenueRecord['payPath']; query_status: ConfirmedReviewRevenueRecord['queryStatus'];
  receipt_status: ConfirmedReviewRevenueRecord['receiptStatus']; transfer_from: string; transfer_to: string;
  transfer_amount: string; verification: ConfirmedReviewRevenueRecord['verification']; created_at: string;
};

type CursorRow = { stream_id: string; config_json: string; start_block: string; next_block: string; last_block: string; last_block_hash: string; finalized_block: string; updated_at: string };

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS review_chain_settlements (
        event_id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, escrow TEXT NOT NULL, usdg TEXT NOT NULL, recipient TEXT NOT NULL,
        block_number TEXT NOT NULL, block_hash TEXT NOT NULL, transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        query_id TEXT NOT NULL, amount TEXT NOT NULL, pay_path TEXT NOT NULL, query_status TEXT NOT NULL,
        receipt_status TEXT NOT NULL CHECK (receipt_status = 'success'), transfer_from TEXT NOT NULL,
        transfer_to TEXT NOT NULL, transfer_amount TEXT NOT NULL, verification TEXT NOT NULL CHECK (verification = 'confirmed'),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_ingestion_cursors (
        stream_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, start_block TEXT NOT NULL, next_block TEXT NOT NULL,
        last_block TEXT NOT NULL, last_block_hash TEXT NOT NULL, finalized_block TEXT NOT NULL, updated_at TEXT NOT NULL
      );`);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS review_chain_log_identity ON review_chain_settlements (chain_id, transaction_hash, log_index)');
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
      if (this.db.query('SELECT event_id FROM review_chain_settlements WHERE event_id = ?').get(input.eventId)) throw new Error('review event source conflict');
      const prior = this.db.query('SELECT batch_id, amount, source FROM review_settlements WHERE event_id = ?').get(input.eventId) as { batch_id: string; amount: string; source: string } | null;
      if (prior) {
        if (prior.batch_id === input.batchId && prior.amount === input.amount.toString() && prior.source === input.source) return;
        throw new Error('settlement event replay conflict');
      }
      this.db.query('INSERT INTO review_settlements (event_id, batch_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.eventId, input.batchId, input.amount.toString(), input.source, new Date().toISOString());
    })();
  }

  recordConfirmedReviewRevenue(input: ConfirmedReviewRevenueRecord): void {
    this.db.transaction(() => this.insertConfirmedReviewRevenue(input))();
  }

  private insertConfirmedReviewRevenue(input: ConfirmedReviewRevenueRecord): void {
    if (!input.eventId || input.chainId <= 0n || input.blockNumber < 0n || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0
      || !validAddress(input.escrow) || !validAddress(input.usdg) || !validAddress(input.recipient)
      || !validHash(input.blockHash) || !validHash(input.transactionHash) || !validHash(input.queryId)
      || input.eventId !== `chain:${input.chainId}:${input.transactionHash.toLowerCase()}:${input.logIndex}`
      || input.verification !== 'confirmed' || input.receiptStatus !== 'success'
      || !['USDG', 'SHIELDED', 'ANONYMA'].includes(input.payPath)
      || input.queryStatus !== 'DECIDED' || input.amount <= 0n || input.transferAmount !== input.amount
      || !validAddress(input.transferFrom) || !validAddress(input.transferTo)
      || input.transferFrom.toLowerCase() !== input.escrow.toLowerCase()
      || input.transferTo.toLowerCase() !== input.recipient.toLowerCase()) throw new Error('invalid confirmed review revenue evidence');
    if (this.db.query('SELECT event_id FROM review_settlements WHERE event_id = ?').get(input.eventId)) throw new Error('review event source conflict');
    const row = this.db.query('SELECT * FROM review_chain_settlements WHERE event_id = ?').get(input.eventId) as ChainSettlementRow | null;
    if (row) {
      if (sameChainSettlement(row, input)) return;
      throw new Error('confirmed review event replay conflict');
    }
    this.db.query(`INSERT INTO review_chain_settlements (
        event_id, chain_id, escrow, usdg, recipient, block_number, block_hash, transaction_hash, log_index,
        query_id, amount, pay_path, query_status, receipt_status, transfer_from, transfer_to, transfer_amount, verification, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.eventId, input.chainId.toString(), input.escrow.toLowerCase(), input.usdg.toLowerCase(), input.recipient.toLowerCase(),
        input.blockNumber.toString(), input.blockHash.toLowerCase(), input.transactionHash.toLowerCase(), input.logIndex,
        input.queryId.toLowerCase(), input.amount.toString(), input.payPath, input.queryStatus, input.receiptStatus,
        input.transferFrom.toLowerCase(), input.transferTo.toLowerCase(), input.transferAmount.toString(), input.verification, input.createdAt);
  }

  ingestionCursor(streamId: string): ReviewIngestionCursor | undefined {
    const row = this.db.query('SELECT * FROM review_ingestion_cursors WHERE stream_id = ?').get(streamId) as CursorRow | null;
    return row ? decodeCursor(row) : undefined;
  }

  /** Atomically persists a verified chunk and its canonical end-of-chunk checkpoint. */
  commitReviewIngestionChunk(input: { cursor: ReviewIngestionCursor; events: ConfirmedReviewRevenueRecord[] }): void {
    this.db.transaction(() => {
      if (input.cursor.nextBlock !== input.cursor.lastBlock + 1n) throw new Error('invalid ingestion cursor range');
      const prior = this.db.query('SELECT * FROM review_ingestion_cursors WHERE stream_id = ?').get(input.cursor.streamId) as CursorRow | null;
      if (prior && prior.config_json !== input.cursor.configJson) throw new Error('ingestion cursor configuration conflict');
      if (prior && BigInt(input.cursor.lastBlock) < BigInt(prior.last_block)) throw new Error('ingestion cursor cannot move backwards');
      if (prior && BigInt(input.cursor.lastBlock) === BigInt(prior.last_block)
        && prior.last_block_hash.toLowerCase() !== input.cursor.lastBlockHash.toLowerCase()) throw new Error('ingestion cursor reorg conflict');
      for (const event of input.events) this.insertConfirmedReviewRevenue(event);
      this.db.query(`INSERT INTO review_ingestion_cursors (stream_id, config_json, start_block, next_block, last_block, last_block_hash, finalized_block, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stream_id) DO UPDATE SET
        next_block = excluded.next_block, last_block = excluded.last_block, last_block_hash = excluded.last_block_hash,
        finalized_block = excluded.finalized_block, updated_at = excluded.updated_at`)
        .run(input.cursor.streamId, input.cursor.configJson, input.cursor.startBlock.toString(), input.cursor.nextBlock.toString(),
          input.cursor.lastBlock.toString(), input.cursor.lastBlockHash.toLowerCase(), input.cursor.finalizedBlock.toString(), input.cursor.updatedAt);
    })();
  }

  listConfirmedReviewRevenue(): ConfirmedReviewRevenueRecord[] {
    const rows = this.db.query('SELECT * FROM review_chain_settlements ORDER BY chain_id, block_number, log_index').all() as ChainSettlementRow[];
    return rows.map(decodeChainSettlement).sort((a, b) => a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1
      : a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
  }

  listAllocations(): ReviewAllocationRecord[] {
    const rows = this.db.query('SELECT batch_id, amount, event_ids FROM review_allocations ORDER BY created_at, batch_id').all() as { batch_id: string; amount: string; event_ids: string }[];
    return rows.map((row) => ({ batchId: row.batch_id, amount: BigInt(row.amount), eventIds: JSON.parse(row.event_ids) as string[] }));
  }

  listIngestionCursors(): ReviewIngestionCursor[] {
    const rows = this.db.query('SELECT * FROM review_ingestion_cursors ORDER BY stream_id').all() as CursorRow[];
    return rows.map(decodeCursor);
  }

  listBuybacks(): PersistedBuyback[] {
    const rows = this.db.query('SELECT payload FROM buyback_records ORDER BY batch_id').all() as { payload: string }[];
    return rows.map((row) => decodeRecord(row.payload));
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
      const rows = input.eventIds.map((id) => {
        const manual = this.db.query('SELECT batch_id, amount FROM review_settlements WHERE event_id = ?').get(id) as { batch_id: string; amount: string } | null;
        if (manual) {
          if (manual.batch_id !== input.batchId) throw new Error('settlement event belongs to a different batch');
          return manual;
        }
        const chain = this.db.query('SELECT amount FROM review_chain_settlements WHERE event_id = ?').get(id) as { amount: string } | null;
        return chain ? { batch_id: input.batchId, amount: chain.amount } : null;
      });
      if (rows.some((row) => !row)) throw new Error('settlement event missing');
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

function decodeChainSettlement(row: ChainSettlementRow): ConfirmedReviewRevenueRecord {
  return { eventId: row.event_id, chainId: BigInt(row.chain_id), escrow: row.escrow, usdg: row.usdg, recipient: row.recipient,
    blockNumber: BigInt(row.block_number), blockHash: row.block_hash, transactionHash: row.transaction_hash, logIndex: row.log_index,
    queryId: row.query_id, amount: BigInt(row.amount), payPath: row.pay_path, queryStatus: row.query_status,
    receiptStatus: row.receipt_status, transferFrom: row.transfer_from, transferTo: row.transfer_to,
    transferAmount: BigInt(row.transfer_amount), verification: row.verification, createdAt: row.created_at };
}

function sameChainSettlement(row: ChainSettlementRow, input: ConfirmedReviewRevenueRecord): boolean {
  return row.chain_id === input.chainId.toString() && row.escrow === input.escrow.toLowerCase() && row.usdg === input.usdg.toLowerCase()
    && row.recipient === input.recipient.toLowerCase() && row.block_number === input.blockNumber.toString()
    && row.block_hash === input.blockHash.toLowerCase() && row.transaction_hash === input.transactionHash.toLowerCase()
    && row.log_index === input.logIndex && row.query_id === input.queryId.toLowerCase() && row.amount === input.amount.toString()
    && row.pay_path === input.payPath && row.query_status === input.queryStatus && row.receipt_status === input.receiptStatus
    && row.transfer_from === input.transferFrom.toLowerCase() && row.transfer_to === input.transferTo.toLowerCase()
    && row.transfer_amount === input.transferAmount.toString() && row.verification === input.verification;
}

function decodeCursor(row: CursorRow): ReviewIngestionCursor {
  return { streamId: row.stream_id, configJson: row.config_json, startBlock: BigInt(row.start_block), nextBlock: BigInt(row.next_block),
    lastBlock: BigInt(row.last_block), lastBlockHash: row.last_block_hash, finalizedBlock: BigInt(row.finalized_block), updatedAt: row.updated_at };
}

function validAddress(value: string): boolean { return /^0x[0-9a-fA-F]{40}$/u.test(value) && !/^0x0{40}$/iu.test(value); }
function validHash(value: string): boolean { return /^0x[0-9a-fA-F]{64}$/u.test(value); }
