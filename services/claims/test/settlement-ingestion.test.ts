import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBuybackStore } from '../src/buyback-sqlite-store.ts';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex, type PublicClient } from 'viem';
import { createViemReviewRevenueReader, ingestReviewProtocolRevenue, ReviewRevenueReorgError, type ReviewRevenueEventLog, type ReviewRevenueReader, type ReviewRevenueReceipt } from '../src/settlement-ingestion.ts';

const escrow = '0x1111111111111111111111111111111111111111';
const usdg = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const queryId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const revenueAbi = parseAbiItem('event ReviewProtocolRevenueSettled(bytes32 indexed queryId,address indexed recipient,uint256 amount)');
const transferAbi = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mochi-ingestion-'));
  roots.push(root);
  return { path: join(root, 'ledger.sqlite') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const config = { chainId: 4663n, escrowAddress: escrow, usdgAddress: usdg, recipientAddress: recipient, startBlock: 5n, chunkSize: 2 };

class MockReader implements ReviewRevenueReader {
  head = 8n;
  finalizedHash = tx(8);
  blockHashes = new Map<bigint, string>([[5n, tx(5)], [6n, tx(6)], [7n, tx(7)], [8n, tx(8)]]);
  logs: ReviewRevenueEventLog[] = [];
  queries = new Map<string, { payPath: number; status: number }>();
  receipts = new Map<string, ReviewRevenueReceipt>();
  ranges: Array<[bigint, bigint]> = [];
  failFromBlock?: bigint;
  includeOutOfRange = false;
  async chainId() { return 4663n; }
  async finalizedBlock() { return { number: this.head, hash: this.finalizedHash }; }
  async blockHash(block: bigint) { const result = this.blockHashes.get(block); if (!result) throw new Error('missing test block'); return result; }
  async reviewRevenueLogs(input: { escrow: string; recipient: string; fromBlock: bigint; toBlock: bigint }) {
    this.ranges.push([input.fromBlock, input.toBlock]);
    if (this.failFromBlock === input.fromBlock) { this.failFromBlock = undefined; throw new Error('simulated interruption'); }
    return this.logs.filter((log) => log.blockNumber !== null && (this.includeOutOfRange || (log.blockNumber >= input.fromBlock && log.blockNumber <= input.toBlock)));
  }
  async escrowUsdgAt() { return usdg; }
  async reviewRecipientAt() { return recipient; }
  async queryAt(_escrow: string, id: string) { const query = this.queries.get(id); if (!query) throw new Error('missing query'); return query; }
  async receipt(hash: string) { const receipt = this.receipts.get(hash); if (!receipt) throw new Error('missing receipt'); return receipt; }
}

function addEvent(reader: MockReader, index: number, block: bigint, amount: bigint, payPath = 0, overrides: Partial<ReviewRevenueEventLog> = {}) {
  const hash = tx(index + 100);
  const log: ReviewRevenueEventLog = { address: escrow, blockNumber: block, blockHash: reader.blockHashes.get(block)!, transactionHash: hash,
    logIndex: index + 1, queryId: queryId(index), recipient, amount, ...overrides };
  reader.logs.push(log);
  reader.queries.set(log.queryId, { payPath, status: 3 });
  reader.receipts.set(hash, { transactionHash: hash, blockNumber: block, blockHash: log.blockHash!, status: 'success',
    revenueEvents: [{ address: escrow, queryId: log.queryId, recipient, amount, logIndex: index + 1 }],
    transfers: [{ token: usdg, from: escrow, to: recipient, amount, logIndex: index }] });
  return log;
}

describe('ingestReviewProtocolRevenue', () => {
  test('scans bounded finalized chunks, persists provenance, resumes after restart, and allocates multiple events together', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const reader = new MockReader();
    addEvent(reader, 0, 6n, 20_000n);
    addEvent(reader, 1, 8n, 30_000n, 2);
    const first = await ingestReviewProtocolRevenue(store, reader, config);
    expect(first).toMatchObject({ scannedThrough: 8n, recordedEvents: 2, excludedFeedEvents: 0 });
    expect(reader.ranges).toEqual([[5n, 6n], [7n, 8n]]);
    expect(store.listConfirmedReviewRevenue().map((event) => event.amount)).toEqual([20_000n, 30_000n]);
    expect(store.listConfirmedReviewRevenue()[0]).toMatchObject({ blockHash: tx(6), transactionHash: tx(100), verification: 'confirmed', queryStatus: 'DECIDED' });
    expect(store.ingestionCursor(first.streamId)?.nextBlock).toBe(9n);
    store.close();

    const restarted = new SqliteBuybackStore(path);
    const again = await ingestReviewProtocolRevenue(restarted, reader, config);
    expect(again.recordedEvents).toBe(0);
    expect(restarted.listConfirmedReviewRevenue()).toHaveLength(2);
    const allocation = restarted.allocateSettledReviewBatch({ batchId: 'review-batch-a', eventIds: [`chain:4663:${tx(100)}:1`, `chain:4663:${tx(101)}:2`] });
    expect(allocation.amount).toBe(50_000n);
    expect(restarted.listAllocations()).toEqual([{ batchId: 'review-batch-a', amount: 50_000n, eventIds: [`chain:4663:${tx(100)}:1`, `chain:4663:${tx(101)}:2`] }]);
    restarted.close();
  });

  test('excludes subsidized FEED revenue but advances the cursor after verifying its source', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const reader = new MockReader();
    addEvent(reader, 0, 6n, 42n, 3);
    const result = await ingestReviewProtocolRevenue(store, reader, config);
    expect(result.excludedFeedEvents).toBe(1);
    expect(result.recordedEvents).toBe(0);
    expect(store.listConfirmedReviewRevenue()).toEqual([]);
    expect(store.ingestionCursor(result.streamId)?.nextBlock).toBe(9n);
    store.close();
  });

  test('limits each poll to a bounded number of block chunks and resumes from its cursor', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const reader = new MockReader();
    addEvent(reader, 0, 6n, 4n);
    addEvent(reader, 1, 8n, 6n);
    const partial = await ingestReviewProtocolRevenue(store, reader, config, { maxChunks: 1 });
    expect(partial).toMatchObject({ scannedThrough: 6n, complete: false, recordedEvents: 1 });
    expect(reader.ranges).toEqual([[5n, 6n]]);
    const resumed = await ingestReviewProtocolRevenue(store, reader, config, { maxChunks: 1 });
    expect(resumed).toMatchObject({ scannedThrough: 8n, complete: true, recordedEvents: 1 });
    expect(reader.ranges).toEqual([[5n, 6n], [7n, 8n]]);
    store.close();
  });

  test('rejects immature, removed, wrong-address, wrong-query, and unproven transfer logs without advancing chunk cursor', async () => {
    const cases: Array<[string, Partial<ReviewRevenueEventLog>, (reader: MockReader, log: ReviewRevenueEventLog) => void]> = [
      ['removed', { removed: true }, () => undefined],
      ['wrong escrow', { address: usdg }, () => undefined],
      ['wrong recipient', { recipient: usdg }, () => undefined],
      ['immature', { blockNumber: 9n }, (reader) => { reader.includeOutOfRange = true; }],
      ['wrong pay path', {}, (reader, log) => reader.queries.set(log.queryId, { payPath: 9, status: 3 })],
      ['wrong status', {}, (reader, log) => reader.queries.set(log.queryId, { payPath: 0, status: 4 })],
      ['missing transfer', {}, (reader, log) => reader.receipts.set(log.transactionHash!, { ...reader.receipts.get(log.transactionHash!)!, transfers: [] })],
      ['unconfirmed receipt', {}, (reader, log) => reader.receipts.set(log.transactionHash!, { ...reader.receipts.get(log.transactionHash!)!, status: 'reverted' })],
      ['missing matching receipt event', {}, (reader, log) => reader.receipts.set(log.transactionHash!, { ...reader.receipts.get(log.transactionHash!)!, revenueEvents: [] })],
    ];
    for (const [name, override, adjust] of cases) {
      const { path } = setup();
      const store = new SqliteBuybackStore(path);
      const reader = new MockReader();
      const log = addEvent(reader, 0, 6n, 10n, 0, override);
      adjust(reader, log);
      await expect(ingestReviewProtocolRevenue(store, reader, config), name).rejects.toThrow();
      expect(store.listIngestionCursors()).toHaveLength(0);
      expect(store.listConfirmedReviewRevenue()).toEqual([]);
      store.close();
    }
  });

  test('detects checkpoint reorgs and fails closed', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const reader = new MockReader();
    addEvent(reader, 0, 6n, 10n);
    const first = await ingestReviewProtocolRevenue(store, reader, config);
    reader.blockHashes.set(8n, tx(88));
    reader.finalizedHash = tx(88);
    await expect(ingestReviewProtocolRevenue(store, reader, config)).rejects.toBeInstanceOf(ReviewRevenueReorgError);
    expect(store.listConfirmedReviewRevenue()).toHaveLength(1);
    expect(store.ingestionCursor(first.streamId)?.lastBlockHash).toBe(tx(8));
    store.close();
  });

  test('recovers from interrupted ingestion at the next atomically committed chunk', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const reader = new MockReader();
    addEvent(reader, 0, 6n, 11n);
    addEvent(reader, 1, 8n, 13n);
    reader.failFromBlock = 7n;
    await expect(ingestReviewProtocolRevenue(store, reader, config)).rejects.toThrow('simulated interruption');
    expect(store.listIngestionCursors()[0]?.nextBlock).toBe(7n);
    expect(store.listConfirmedReviewRevenue()).toHaveLength(1);
    const resumed = await ingestReviewProtocolRevenue(store, reader, config);
    expect(resumed.recordedEvents).toBe(1);
    expect(store.listConfirmedReviewRevenue()).toHaveLength(2);
    store.close();
  });

  test('viem reader decodes the contract event and receipt logs and queries historical state at the event block', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const blockHash = tx(6), txHash = tx(500), id = queryId(500), amount = 88n;
    const revenueTopics = encodeEventTopics({ abi: [revenueAbi], args: { queryId: id as Hex, recipient } });
    const revenueData = encodeAbiParameters([{ type: 'uint256' }], [amount]);
    const transferTopics = encodeEventTopics({ abi: [transferAbi], args: { from: escrow, to: recipient } });
    const transferData = encodeAbiParameters([{ type: 'uint256' }], [amount]);
    const revenueLog = { address: escrow, blockNumber: 6n, blockHash, transactionHash: txHash, logIndex: 1, removed: false,
      topics: revenueTopics, data: revenueData, args: { queryId: id, recipient, amount } };
    const transferLog = { address: usdg, blockNumber: 6n, blockHash, transactionHash: txHash, logIndex: 0, removed: false,
      topics: transferTopics, data: transferData };
    const readArgs: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      async getChainId() { return 4663; },
      async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        const number = input.blockNumber ?? 8n;
        return { number, hash: number === 6n ? blockHash : tx(Number(number)) };
      },
      async getLogs(input: { fromBlock: bigint; toBlock: bigint }) { return revenueLog.blockNumber >= input.fromBlock && revenueLog.blockNumber <= input.toBlock ? [revenueLog] : []; },
      async readContract(input: { functionName: string; blockNumber?: bigint }) {
        readArgs.push(input);
        if (input.functionName === 'usdg') return usdg;
        if (input.functionName === 'reviewProtocolRecipient') return recipient;
        if (input.functionName === 'getQuery') return { payPath: 1, status: 3 };
        throw new Error(`unexpected read ${input.functionName}`);
      },
      async getTransactionReceipt() { return { transactionHash: txHash, blockNumber: 6n, blockHash, status: 'success', logs: [transferLog, revenueLog] }; },
    };
    const reader = createViemReviewRevenueReader(client as unknown as PublicClient);
    const result = await ingestReviewProtocolRevenue(store, reader, config);
    expect(result.recordedEvents).toBe(1);
    expect(store.listConfirmedReviewRevenue()[0]).toMatchObject({ transactionHash: txHash, queryId: id, amount, payPath: 'SHIELDED' });
    expect(readArgs.filter((arg) => arg.functionName === 'getQuery').map((arg) => arg.blockNumber)).toEqual([6n]);
    store.close();
  });
});
