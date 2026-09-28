import { createHash } from 'node:crypto';
import { decodeEventLog, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { QueryEscrowAbi } from '@mochi/chain';
import {
  type ConfirmedReviewRevenueRecord,
  type ReviewIngestionCursor,
  SqliteBuybackStore,
} from './buyback-sqlite-store.ts';

const REVIEW_REVENUE_EVENT = parseAbiItem('event ReviewProtocolRevenueSettled(bytes32 indexed queryId,address indexed recipient,uint256 amount)');
const TOKEN_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const ZERO_ADDRESS = /^0x0{40}$/iu;

export type ReviewRevenueIngestionConfig = {
  chainId: bigint;
  escrowAddress: string;
  usdgAddress: string;
  recipientAddress: string;
  startBlock: bigint;
  /** The reader must provide a finalized block. There is deliberately no latest-block fallback. */
  chunkSize: number;
};

export type ReviewRevenueEventLog = {
  address: string;
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  removed?: boolean;
  queryId: string;
  recipient: string;
  amount: bigint;
};

export type ReviewRevenueQueryState = { payPath: number; status: number };
export type ReviewRevenueTransfer = { token: string; from: string; to: string; amount: bigint };
export type ReviewRevenueReceipt = {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  status: 'success' | 'reverted';
  revenueEvents: Array<{ address: string; queryId: string; recipient: string; amount: bigint; logIndex: number }>;
  transfers: Array<ReviewRevenueTransfer & { logIndex: number }>;
};

/** Read-only RPC surface. Implementations must use historical state at the supplied block. */
export interface ReviewRevenueReader {
  chainId(): Promise<bigint>;
  finalizedBlock(): Promise<{ number: bigint; hash: string }>;
  blockHash(blockNumber: bigint): Promise<string>;
  reviewRevenueLogs(input: { escrow: string; recipient: string; fromBlock: bigint; toBlock: bigint }): Promise<ReviewRevenueEventLog[]>;
  escrowUsdgAt(escrow: string, blockNumber: bigint): Promise<string>;
  reviewRecipientAt(escrow: string, blockNumber: bigint): Promise<string>;
  queryAt(escrow: string, queryId: string, blockNumber: bigint): Promise<ReviewRevenueQueryState>;
  receipt(transactionHash: string): Promise<ReviewRevenueReceipt>;
}

export type ReviewRevenueIngestionResult = {
  streamId: string;
  scannedThrough: bigint;
  finalizedBlock: bigint;
  complete: boolean;
  recordedEvents: number;
  excludedFeedEvents: number;
  lastBlockHash?: string;
};

export class ReviewRevenueReorgError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewRevenueReorgError'; }
}

/** Scan confirmed/finalized logs once. No wallet client, signer, or transaction method is used. */
export async function ingestReviewProtocolRevenue(
  store: SqliteBuybackStore,
  reader: ReviewRevenueReader,
  config: ReviewRevenueIngestionConfig,
  options: { maxChunks?: number } = {},
): Promise<ReviewRevenueIngestionResult> {
  validateConfig(config);
  const maxChunks = options.maxChunks ?? 10;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) throw new Error('maxChunks must be an integer from 1 to 100');
  const actualChainId = await reader.chainId();
  if (actualChainId !== config.chainId) throw new Error('RPC chain ID does not match configured chain');
  // This must fail if the RPC does not support the finalized tag. Falling back to latest is unsafe.
  const finalized = await reader.finalizedBlock();
  if (finalized.number < 0n || !isHash(finalized.hash)) throw new Error('RPC returned an invalid finalized block');
  const canonicalFinalizedHash = await reader.blockHash(finalized.number);
  if (!sameHash(canonicalFinalizedHash, finalized.hash)) throw new ReviewRevenueReorgError('finalized block hash changed during scan');

  const configJson = canonicalConfig(config);
  const streamId = createHash('sha256').update(configJson).digest('hex');
  let cursor = store.ingestionCursor(streamId);
  if (cursor) {
    if (cursor.configJson !== configJson) throw new Error('persisted cursor configuration mismatch');
    const checkpointHash = await reader.blockHash(cursor.lastBlock);
    if (!sameHash(checkpointHash, cursor.lastBlockHash)) {
      throw new ReviewRevenueReorgError(`canonical block hash differs at persisted checkpoint ${cursor.lastBlock}`);
    }
    if (finalized.number < cursor.lastBlock) throw new ReviewRevenueReorgError('finalized RPC head is behind the persisted checkpoint');
  }

  let nextBlock = cursor?.nextBlock ?? config.startBlock;
  if (nextBlock <= config.startBlock) nextBlock = config.startBlock;
  let recordedEvents = 0;
  let excludedFeedEvents = 0;
  let scannedThrough = cursor?.lastBlock ?? config.startBlock - 1n;
  let lastBlockHash = cursor?.lastBlockHash;
  let chunks = 0;
  while (nextBlock <= finalized.number && chunks < maxChunks) {
    const endBlock = min(nextBlock + BigInt(config.chunkSize) - 1n, finalized.number);
    const logs = await reader.reviewRevenueLogs({ escrow: config.escrowAddress, recipient: config.recipientAddress, fromBlock: nextBlock, toBlock: endBlock });
    const events: ConfirmedReviewRevenueRecord[] = [];
    const seen = new Set<string>();
    const blockHashes = new Map<string, string>();
    const stateCache = new Map<string, Promise<ReviewRevenueQueryState>>();
    const receiptCache = new Map<string, Promise<ReviewRevenueReceipt>>();

    for (const log of [...logs].sort(compareLogs)) {
      validateLogIdentity(log, config, nextBlock, endBlock, finalized.number);
      const eventId = `chain:${config.chainId}:${log.transactionHash!.toLowerCase()}:${log.logIndex}`;
      if (seen.has(eventId)) throw new Error('duplicate revenue event returned by RPC');
      seen.add(eventId);

      const eventBlockKey = log.blockNumber!.toString();
      let eventBlockHash = blockHashes.get(eventBlockKey);
      if (!eventBlockHash) {
        eventBlockHash = await reader.blockHash(log.blockNumber!);
        blockHashes.set(eventBlockKey, eventBlockHash);
      }
      if (!sameHash(eventBlockHash, log.blockHash!)) throw new ReviewRevenueReorgError(`event block hash mismatch at ${log.blockNumber}`);

      const [tokenAtBlock, recipientAtBlock, query, receipt] = await Promise.all([
        reader.escrowUsdgAt(config.escrowAddress, log.blockNumber!),
        reader.reviewRecipientAt(config.escrowAddress, log.blockNumber!),
        cached(stateCache, `${log.blockNumber}:${log.queryId.toLowerCase()}`, () => reader.queryAt(config.escrowAddress, log.queryId, log.blockNumber!)),
        cached(receiptCache, log.transactionHash!.toLowerCase(), () => reader.receipt(log.transactionHash!)),
      ]);
      if (!sameAddress(tokenAtBlock, config.usdgAddress)) throw new Error('configured USDG does not match QueryEscrow at event block');
      if (!sameAddress(recipientAtBlock, config.recipientAddress) || !sameAddress(log.recipient, config.recipientAddress)) {
        throw new Error('event recipient does not match configured QueryEscrow recipient');
      }
      const payPath = payPathName(query.payPath);
      if (query.status !== 3) throw new Error('revenue event query was not DECIDED at event block');
      validateReceipt(receipt, log, config);
      const matchingTransfers = receipt.transfers.filter((transfer) => sameAddress(transfer.token, config.usdgAddress)
        && sameAddress(transfer.from, config.escrowAddress) && sameAddress(transfer.to, config.recipientAddress)
        && transfer.amount === log.amount && transfer.logIndex < log.logIndex!);
      if (matchingTransfers.length !== 1) throw new Error('successful receipt lacks exactly one matching escrow-to-recipient USDG transfer');
      if (payPath === 'FEED') { excludedFeedEvents++; continue; }
      events.push({
        eventId,
        chainId: config.chainId,
        escrow: config.escrowAddress,
        usdg: config.usdgAddress,
        recipient: config.recipientAddress,
        blockNumber: log.blockNumber!,
        blockHash: log.blockHash!,
        transactionHash: log.transactionHash!,
        logIndex: log.logIndex!,
        queryId: log.queryId,
        amount: log.amount,
        payPath,
        queryStatus: 'DECIDED',
        receiptStatus: receipt.status,
        transferFrom: config.escrowAddress,
        transferTo: config.recipientAddress,
        transferAmount: log.amount,
        verification: 'confirmed',
        createdAt: new Date().toISOString(),
      });
    }

    let endHash = blockHashes.get(endBlock.toString());
    if (!endHash) endHash = await reader.blockHash(endBlock);
    if (!isHash(endHash)) throw new Error('RPC returned an invalid chunk checkpoint hash');
    if (!sameHash(await reader.blockHash(finalized.number), finalized.hash)) throw new ReviewRevenueReorgError('finalized block hash changed during scan');
    const chunkCursor: ReviewIngestionCursor = {
      streamId, configJson, startBlock: config.startBlock, nextBlock: endBlock + 1n,
      lastBlock: endBlock, lastBlockHash: endHash, finalizedBlock: finalized.number, updatedAt: new Date().toISOString(),
    };
    store.commitReviewIngestionChunk({ cursor: chunkCursor, events });
    recordedEvents += events.length;
    scannedThrough = endBlock;
    lastBlockHash = endHash;
    nextBlock = endBlock + 1n;
    chunks++;
  }

  return { streamId, scannedThrough, finalizedBlock: finalized.number, complete: nextBlock > finalized.number,
    recordedEvents, excludedFeedEvents, ...(lastBlockHash ? { lastBlockHash } : {}) };
}

/** Viem adapter backed by a PublicClient only; unsupported finalized tags fail closed. */
export function createViemReviewRevenueReader(client: PublicClient): ReviewRevenueReader {
  return {
    async chainId() { return BigInt(await client.getChainId()); },
    async finalizedBlock() {
      const block = await client.getBlock({ blockTag: 'finalized' });
      if (block.number === null || !block.hash) throw new Error('RPC did not return a finalized block');
      return { number: block.number, hash: block.hash };
    },
    async blockHash(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      if (!block.hash) throw new Error(`RPC returned no hash for block ${blockNumber}`);
      return block.hash;
    },
    async reviewRevenueLogs({ escrow, recipient, fromBlock, toBlock }) {
      const logs = await client.getLogs({ address: escrow as Address, event: REVIEW_REVENUE_EVENT, args: { recipient: recipient as Address }, fromBlock, toBlock });
      return logs.map((log) => ({
        address: log.address, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
        logIndex: log.logIndex, removed: log.removed, queryId: log.args.queryId!, recipient: log.args.recipient!, amount: log.args.amount!,
      }));
    },
    async escrowUsdgAt(escrow, blockNumber) {
      return await client.readContract({ address: escrow as Address, abi: QueryEscrowAbi, functionName: 'usdg', blockNumber } as never) as string;
    },
    async reviewRecipientAt(escrow, blockNumber) {
      return await client.readContract({ address: escrow as Address, abi: QueryEscrowAbi, functionName: 'reviewProtocolRecipient', blockNumber } as never) as string;
    },
    async queryAt(escrow, queryId, blockNumber) {
      const query = await client.readContract({ address: escrow as Address, abi: QueryEscrowAbi, functionName: 'getQuery', args: [queryId as Hex], blockNumber } as never) as { payPath: number; status: number };
      return { payPath: Number(query.payPath), status: Number(query.status) };
    },
    async receipt(transactionHash) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex });
      const revenueEvents: ReviewRevenueReceipt['revenueEvents'] = [];
      const transfers: ReviewRevenueReceipt['transfers'] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = decodeEventLog({ abi: [REVIEW_REVENUE_EVENT], data: log.data, topics: log.topics, strict: true });
          if (parsed.eventName === 'ReviewProtocolRevenueSettled') revenueEvents.push({ address: log.address, queryId: parsed.args.queryId, recipient: parsed.args.recipient, amount: parsed.args.amount, logIndex: log.logIndex });
        } catch { /* other event */ }
        try {
          const parsed = decodeEventLog({ abi: [TOKEN_TRANSFER_EVENT], data: log.data, topics: log.topics, strict: true });
          if (parsed.eventName === 'Transfer') transfers.push({ token: log.address, from: parsed.args.from, to: parsed.args.to, amount: parsed.args.value, logIndex: log.logIndex });
        } catch { /* other event */ }
      }
      return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        status: receipt.status, revenueEvents, transfers };
    },
  };
}

function validateReceipt(receipt: ReviewRevenueReceipt, log: ReviewRevenueEventLog, config: ReviewRevenueIngestionConfig): void {
  const matchingEvents = receipt.revenueEvents.filter((event) => sameAddress(event.address, config.escrowAddress)
    && event.queryId.toLowerCase() === log.queryId.toLowerCase() && sameAddress(event.recipient, config.recipientAddress)
    && event.amount === log.amount && event.logIndex === log.logIndex);
  if (receipt.status !== 'success' || matchingEvents.length !== 1 || receipt.revenueEvents.length !== 1
    || !sameHash(receipt.transactionHash, log.transactionHash!)
    || receipt.blockNumber !== log.blockNumber || !sameHash(receipt.blockHash, log.blockHash!)) {
    throw new Error('revenue event is not in a successful canonical transaction receipt');
  }
  if (!isAddress(config.escrowAddress) || !isAddress(config.usdgAddress) || !isAddress(config.recipientAddress)) throw new Error('invalid configured addresses');
}

function validateLogIdentity(log: ReviewRevenueEventLog, config: ReviewRevenueIngestionConfig, from: bigint, to: bigint, finalized: bigint): void {
  if (log.removed) throw new ReviewRevenueReorgError('RPC returned a removed revenue event log');
  if (!sameAddress(log.address, config.escrowAddress)) throw new Error('revenue event came from the wrong escrow address');
  if (!sameAddress(log.recipient, config.recipientAddress)) throw new Error('revenue event has the wrong recipient');
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null
    || log.blockNumber < from || log.blockNumber > to || log.blockNumber > finalized) throw new Error('revenue event is unconfirmed or missing canonical provenance');
  if (!isHash(log.blockHash) || !isHash(log.transactionHash) || !/^0x[0-9a-fA-F]{64}$/u.test(log.queryId)
    || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.amount <= 0n) throw new Error('revenue event fields are invalid');
}

function validateConfig(config: ReviewRevenueIngestionConfig): void {
  if (config.chainId <= 0n || config.startBlock < 0n || !Number.isInteger(config.chunkSize) || config.chunkSize < 1 || config.chunkSize > 2_000
    || !isAddress(config.escrowAddress) || !isAddress(config.usdgAddress) || !isAddress(config.recipientAddress)) throw new Error('invalid review revenue ingestion configuration');
}

function isAddress(value: string): boolean { return /^0x[0-9a-fA-F]{40}$/u.test(value) && !ZERO_ADDRESS.test(value); }
function isHash(value: string): boolean { return /^0x[0-9a-fA-F]{64}$/u.test(value); }
function sameAddress(left: string, right: string): boolean { return isAddress(left) && isAddress(right) && left.toLowerCase() === right.toLowerCase(); }
function sameHash(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function payPathName(value: number): ConfirmedReviewRevenueRecord['payPath'] {
  switch (value) {
    case 0: return 'USDG';
    case 1: return 'SHIELDED';
    case 2: return 'ANONYMA';
    case 3: return 'FEED';
    default: throw new Error(`unsupported QueryEscrow pay path ${value}`);
  }
}
function compareLogs(a: ReviewRevenueEventLog, b: ReviewRevenueEventLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1;
  return a.logIndex! - b.logIndex!;
}
function canonicalConfig(config: ReviewRevenueIngestionConfig): string {
  return JSON.stringify({ chainId: config.chainId.toString(), escrow: config.escrowAddress.toLowerCase(), usdg: config.usdgAddress.toLowerCase(), recipient: config.recipientAddress.toLowerCase(), startBlock: config.startBlock.toString(), chunkSize: config.chunkSize, finality: 'finalized' });
}
async function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let promise = map.get(key);
  if (!promise) { promise = load(); map.set(key, promise); }
  return promise;
}
