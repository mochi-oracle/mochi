import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, constants as fsConstants, openSync } from 'node:fs';
import {
  decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex,
  type PublicClient, type WalletClient,
} from 'viem';
import type {
  BuybackAdapter, BuybackExecution, BuybackQuote, BuybackReceipt, Reconciliation, TreasuryFunds,
} from './buybacks.ts';

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)',
]);
const router02SwapAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const router02MulticallAbi = parseAbi([
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));

export type UniswapBuybackConfig = {
  chainId: bigint;
  routerAddress: Address;
  /** The pinned Router ABI: classic deadline-bearing SwapRouter or Router02. */
  routerVariant: 'swap-router' | 'router02';
  /** Refuse any signed swap whose worst-case native gas cost exceeds this reviewed cap. */
  maxGasCostWei: bigint;
  routerCodeHash: Hex;
  quoterAddress: Address;
  quoterCodeHash: Hex;
  usdgAddress: Address;
  mochiAddress: Address;
  /** The reviewed fee tier for the sole direct USDG/MOCHI pool. */
  fee: number;
  /** Attribution comes from durable settlement accounting, never from RPC token balance. */
  readAttributableReviewFunds: (input: { chainId: bigint; treasuryAddress: Address; usdgAddress: Address }) => Promise<bigint | null>;
  /** Approved decimals are fixed by current token policy: USDG=6 and MOCHI=18. */
  requireTokenDecimals?: boolean;
};

/**
 * V3 SwapRouter (deadline-bearing exactInputSingle ABI), with a private durable
 * journal. The caller must provide explicitly approved addresses and code hashes.
 * Signing is local; the raw signed transaction is persisted before broadcast.
 */
export class UniswapV3BuybackAdapter implements BuybackAdapter {
  private readonly db: Database;

  constructor(
    private readonly config: UniswapBuybackConfig,
    private readonly client: PublicClient,
    private readonly wallet: WalletClient,
    private readonly journalPath: string,
  ) {
    if (config.chainId <= 0n || !validAddress(config.routerAddress) || !validAddress(config.quoterAddress)
      || !validAddress(config.usdgAddress) || !validAddress(config.mochiAddress)
      || !validHash(config.routerCodeHash) || !validHash(config.quoterCodeHash)
      || !['router02', 'swap-router'].includes(config.routerVariant)
      || typeof config.maxGasCostWei !== 'bigint' || config.maxGasCostWei <= 0n
      || !Number.isInteger(config.fee) || config.fee < 0 || config.fee > 1_000_000) throw new Error('invalid approved Uniswap route configuration');
    const fd = openSync(journalPath, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
    closeSync(fd);
    chmodSync(journalPath, 0o600);
    this.db = new Database(journalPath, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS uniswap_buyback_submissions (
        idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tx_hash TEXT NOT NULL,
        raw_tx TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','broadcast')),
        created_at TEXT NOT NULL
      )`);
    chmodSync(journalPath, 0o600);
    try { chmodSync(`${journalPath}-wal`, 0o600); chmodSync(`${journalPath}-shm`, 0o600); } catch { /* SQLite may not create sidecars until the first write. */ }
  }

  async readTreasuryFunds(input: { chainId: bigint; treasuryAddress: string; usdgAddress: string }): Promise<TreasuryFunds> {
    this.assertChain(input.chainId);
    if (BigInt(await this.client.getChainId()) !== input.chainId) throw new Error('RPC chain does not match approved chain');
    const treasury = address(input.treasuryAddress), usdg = address(input.usdgAddress);
    if (!sameAddress(usdg, this.config.usdgAddress)) throw new Error('USDG address differs from approved token');
    const [usdgBalance, attributableReviewFunds] = await Promise.all([
      this.client.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] }),
      this.config.readAttributableReviewFunds({ chainId: input.chainId, treasuryAddress: treasury, usdgAddress: usdg }),
    ]);
    return { chainId: input.chainId, treasuryAddress: treasury, usdgAddress: usdg, usdgBalance, attributableReviewFunds };
  }

  async quoteExactInput(input: BuybackExecution): Promise<BuybackQuote> {
    await this.assertExecution(input);
    const [decimalsIn, decimalsOut, allowance, amountOut] = await Promise.all([
      this.client.readContract({ address: address(input.inputToken), abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: address(input.outputToken), abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: address(input.inputToken), abi: erc20Abi, functionName: 'allowance', args: [address(input.treasuryAddress), address(input.routerAddress)] }),
      this.client.readContract({ address: address(this.config.quoterAddress), abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: address(input.inputToken), tokenOut: address(input.outputToken), amountIn: input.amountIn, fee: this.config.fee, sqrtPriceLimitX96: 0n }] }),
    ]);
    if (this.config.requireTokenDecimals !== false && (decimalsIn !== 6 || decimalsOut !== 18)) throw new Error('token decimal policy mismatch');
    if (allowance < input.amountIn) throw new Error('insufficient router allowance; explicit approval transaction required');
    const now = Date.now();
    return {
      chainId: input.chainId, routerAddress: input.routerAddress, treasuryAddress: input.treasuryAddress,
      senderAddress: input.senderAddress, inputToken: input.inputToken, outputToken: input.outputToken,
      recipient: input.recipient, amountIn: input.amountIn, amountOut: amountOut[0], quotedAtMs: now, validUntilMs: now + 30_000,
    };
  }

  async submitExactInput(input: BuybackExecution & { idempotencyKey: string }): Promise<{ transactionRef: string }> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('invalid idempotency key');
    await this.assertExecution(input);
    if (input.deadlineMs <= Date.now() || input.minAmountOut <= 0n) throw new Error('swap deadline and minimum output must be set');
    const fingerprint = executionFingerprint(input);
    const prior = this.getSubmission(input.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('idempotency key execution conflict');
      // A durable prepared row means the broadcast outcome could be uncertain. Never resend it.
      return { transactionRef: prior.tx_hash };
    }
    const account = this.wallet.account;
    if (!account || account.type !== 'local' || !sameAddress(account.address, input.senderAddress)) throw new Error('signer does not match approved treasury sender');
    const data = this.encodeSwapCalldata(input);
    // Reject a stale route immediately before signing and verify allowance again.
    await this.assertExecution(input);
    const allowance = await this.client.readContract({ address: address(input.inputToken), abi: erc20Abi, functionName: 'allowance', args: [address(input.treasuryAddress), address(input.routerAddress)] });
    if (allowance < input.amountIn) throw new Error('insufficient router allowance; explicit approval transaction required');
    const request = await this.client.prepareTransactionRequest({ account, to: address(input.routerAddress), data, value: 0n, chain: this.client.chain ?? undefined });
    if (request.to?.toLowerCase() !== input.routerAddress.toLowerCase() || request.value !== 0n || request.data?.toLowerCase() !== data.toLowerCase()) throw new Error('prepared transaction differs from approved swap');
    const preparedGasPrice = request.maxFeePerGas ?? request.gasPrice;
    if (request.chainId !== Number(this.config.chainId) || request.gas === undefined || preparedGasPrice === undefined
      || request.gas * preparedGasPrice > this.config.maxGasCostWei) throw new Error('prepared transaction chain or gas ceiling check failed');
    const rawTransaction = await this.wallet.signTransaction({ ...request, account, chain: this.wallet.chain ?? undefined });
    const txHash = keccak256(rawTransaction);
    const signed = parseTransaction(rawTransaction);
    const recovered = await recoverTransactionAddress({ serializedTransaction: rawTransaction });
    if (!signed.to || signed.to.toLowerCase() !== input.routerAddress.toLowerCase() || signed.chainId !== Number(this.config.chainId)
      || (signed.value ?? 0n) !== 0n || signed.data?.toLowerCase() !== data.toLowerCase() || !sameAddress(recovered, input.senderAddress)
      || signed.gas === undefined || (signed.maxFeePerGas ?? signed.gasPrice) === undefined
      || signed.gas * (signed.maxFeePerGas ?? signed.gasPrice)! > this.config.maxGasCostWei) throw new Error('signed transaction validation failed');
    if (Date.now() >= input.deadlineMs) throw new Error('swap expired before journal persistence');
    // One synchronous SQLite transaction durably records raw signed bytes before network broadcast.
    this.db.transaction(() => this.db.query(`INSERT INTO uniswap_buyback_submissions (idempotency_key,fingerprint,tx_hash,raw_tx,state,created_at)
      VALUES (?,?,?,?, 'prepared',?)`).run(input.idempotencyKey, fingerprint, txHash, rawTransaction, new Date().toISOString()))();
    try {
      if (Date.now() >= input.deadlineMs) throw new Error('swap expired before broadcast');
      const returned = await this.client.sendRawTransaction({ serializedTransaction: rawTransaction });
      if (returned.toLowerCase() !== txHash.toLowerCase()) throw new Error('broadcast transaction hash mismatch');
      this.db.query("UPDATE uniswap_buyback_submissions SET state='broadcast' WHERE idempotency_key=?").run(input.idempotencyKey);
    } catch (error) {
      // Keep durable raw transaction + deterministic hash. Caller reconciles; retries never rebroadcast.
      throw error;
    }
    return { transactionRef: txHash };
  }

  async reconcile(input: { idempotencyKey: string; transactionRef?: string }): Promise<Reconciliation> {
    const row = this.getSubmission(input.idempotencyKey);
    if (!row) return { status: 'unknown' };
    if (input.transactionRef && input.transactionRef.toLowerCase() !== row.tx_hash.toLowerCase()) return { status: 'unknown' };
    try { await this.assertApprovedCode(); } catch { return { status: 'pending' }; }
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: row.tx_hash as Hex }); }
    catch (error) {
      // A not-found tx after a crash remains uncertain; deliberately do not rebroadcast or call it unknown.
      return { status: 'pending' };
    }
    const tx = await this.client.getTransaction({ hash: row.tx_hash as Hex });
    const signed = parseTransaction(row.raw_tx as Hex);
    if (keccak256(row.raw_tx as Hex).toLowerCase() !== row.tx_hash.toLowerCase()) return { status: 'pending' };
    if (!tx || tx.hash.toLowerCase() !== row.tx_hash.toLowerCase() || tx.input.toLowerCase() !== signed.data?.toLowerCase() || !tx.to || tx.to.toLowerCase() !== this.config.routerAddress.toLowerCase()
      || tx.from.toLowerCase() !== row.fingerprint.split(':')[3]?.toLowerCase()
      || (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId) !== this.config.chainId) || tx.value !== 0n) return { status: 'pending' };
    const parsed = decodeSwapCalldata(tx.input, this.config.routerVariant);
    if (!parsed || receipt.transactionHash.toLowerCase() !== row.tx_hash.toLowerCase()) return { status: 'pending' };
    const fingerprint = row.fingerprint.split(':');
    if (parsed.inputToken.toLowerCase() !== this.config.usdgAddress.toLowerCase()
      || parsed.outputToken.toLowerCase() !== this.config.mochiAddress.toLowerCase()
      || parsed.recipient.toLowerCase() !== fingerprint[4]?.toLowerCase()
      || parsed.amountIn !== BigInt(fingerprint[7] ?? '-1') || parsed.amountOutMinimum !== BigInt(fingerprint[8] ?? '-1')
      || parsed.fee !== this.config.fee || parsed.deadlineSeconds !== BigInt(Math.floor(Number(fingerprint[9]) / 1000))) return { status: 'pending' };
    const [canonical, anchor] = await Promise.all([this.client.getBlock({ blockNumber: receipt.blockNumber }), this.client.getBlock({ blockTag: 'finalized' })]);
    if (anchor.number === null || !anchor.hash || receipt.blockNumber > anchor.number
      || canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'pending' };
    const anchorCheck = await this.client.getBlock({ blockNumber: anchor.number });
    if (anchorCheck.hash?.toLowerCase() !== anchor.hash.toLowerCase()) return { status: 'pending' };
    if (receipt.status === 'reverted') return { status: 'failed', transactionRef: row.tx_hash };
    let spent = 0n, refunded = 0n, received = 0n, sentBack = 0n;
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== transferTopic.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', topics: log.topics, data: log.data });
        if (log.address.toLowerCase() === parsed.inputToken.toLowerCase()) {
          if (event.args.from.toLowerCase() === tx.from.toLowerCase()) spent += event.args.value;
          if (event.args.to.toLowerCase() === tx.from.toLowerCase()) refunded += event.args.value;
        }
        if (log.address.toLowerCase() === parsed.outputToken.toLowerCase()) {
          if (event.args.to.toLowerCase() === parsed.recipient.toLowerCase()) received += event.args.value;
          if (event.args.from.toLowerCase() === parsed.recipient.toLowerCase()) sentBack += event.args.value;
        }
      } catch { /* Ignore unrelated/malformed logs; required amounts are checked below. */ }
    }
    const netInput = spent - refunded, netOutput = received - sentBack;
    if (netInput !== parsed.amountIn || netOutput < parsed.amountOutMinimum || netOutput <= 0n) return { status: 'pending' };
    const result: BuybackReceipt = {
      chainId: this.config.chainId, transactionRef: row.tx_hash, routerAddress: this.config.routerAddress,
      treasuryAddress: tx.from, senderAddress: tx.from, recipient: parsed.recipient,
      inputToken: parsed.inputToken, outputToken: parsed.outputToken,
      amountIn: netInput, receivedTokenAmount: netOutput,
    };
    return { status: 'confirmed', receipt: result };
  }

  close(): void { this.db.close(); }

  private async assertExecution(input: BuybackExecution): Promise<void> {
    this.assertChain(input.chainId);
    for (const value of [input.routerAddress,input.treasuryAddress,input.senderAddress,input.recipient,input.inputToken,input.outputToken]) address(value);
    if (!sameAddress(input.routerAddress, this.config.routerAddress) || input.treasuryAddress.toLowerCase() !== input.senderAddress.toLowerCase()
      || !sameAddress(input.inputToken, this.config.usdgAddress) || !sameAddress(input.outputToken, this.config.mochiAddress)

      || input.inputToken.toLowerCase() === input.outputToken.toLowerCase() || input.amountIn <= 0n || input.minAmountOut < 0n
      || !Number.isSafeInteger(input.deadlineMs) || (input.deadlineMs > 0 && input.deadlineMs <= Date.now())) throw new Error('swap execution violates approved route policy');
    await this.assertApprovedCode();
  }

  private async assertApprovedCode(): Promise<void> {
    const [chainId, routerCode, quoterCode] = await Promise.all([this.client.getChainId(), this.client.getCode({ address: address(this.config.routerAddress) }), this.client.getCode({ address: address(this.config.quoterAddress) })]);
    if (BigInt(chainId) !== this.config.chainId) throw new Error('RPC chain does not match approved chain');
    if (!routerCode || routerCode === '0x' || keccak256(routerCode).toLowerCase() !== this.config.routerCodeHash.toLowerCase()) throw new Error('router bytecode integrity check failed');
    if (!quoterCode || quoterCode === '0x' || keccak256(quoterCode).toLowerCase() !== this.config.quoterCodeHash.toLowerCase()) throw new Error('quoter bytecode integrity check failed');
  }

  private encodeSwapCalldata(input: BuybackExecution): Hex {
    const tokenIn = address(input.inputToken), tokenOut = address(input.outputToken), recipient = address(input.recipient);
    if (this.config.routerVariant === 'swap-router') return encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{
      tokenIn, tokenOut, fee: this.config.fee, recipient, deadline: BigInt(Math.floor(input.deadlineMs / 1000)),
      amountIn: input.amountIn, amountOutMinimum: input.minAmountOut, sqrtPriceLimitX96: 0n,
    }] });
    const swap = encodeFunctionData({ abi: router02SwapAbi, functionName: 'exactInputSingle', args: [{
      tokenIn, tokenOut, fee: this.config.fee, recipient, amountIn: input.amountIn,
      amountOutMinimum: input.minAmountOut, sqrtPriceLimitX96: 0n,
    }] });
    return encodeFunctionData({ abi: router02MulticallAbi, functionName: 'multicall', args: [BigInt(Math.floor(input.deadlineMs / 1000)), [swap]] });
  }

  private assertChain(chainId: bigint): void { if (chainId !== this.config.chainId) throw new Error('wrong configured chain'); }
  private getSubmission(key: string): { fingerprint: string; tx_hash: string; raw_tx: string } | null {
    return this.db.query('SELECT fingerprint,tx_hash,raw_tx FROM uniswap_buyback_submissions WHERE idempotency_key=?').get(key) as { fingerprint: string; tx_hash: string; raw_tx: string } | null;
  }
}

function decodeSwapCalldata(data: Hex, variant: UniswapBuybackConfig['routerVariant']): { recipient: Address; inputToken: Address; outputToken: Address; amountIn: bigint; amountOutMinimum: bigint; fee: number; deadlineSeconds: bigint } | null {
  try {
    let swapData = data;
    if (variant === 'router02') {
      const outer = decodeFunctionData({ abi: router02MulticallAbi, data });
      if (outer.functionName !== 'multicall' || outer.args[1].length !== 1) return null;
      swapData = outer.args[1][0]!;
      const exact = decodeFunctionData({ abi: router02SwapAbi, data: swapData });
      if (exact.functionName !== 'exactInputSingle') return null;
      const p = exact.args[0];
      return { inputToken: p.tokenIn, outputToken: p.tokenOut, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, fee: p.fee, deadlineSeconds: outer.args[0] };
    }
    const exact = decodeFunctionData({ abi: routerAbi, data: swapData });
    if (exact.functionName !== 'exactInputSingle') return null;
    const p = exact.args[0];
    return { inputToken: p.tokenIn, outputToken: p.tokenOut, recipient: p.recipient, fee: p.fee,
      deadlineSeconds: p.deadline, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum };
  } catch { return null; }
}

function executionFingerprint(x: BuybackExecution): string { return [x.chainId,x.routerAddress.toLowerCase(),x.treasuryAddress.toLowerCase(),x.senderAddress.toLowerCase(),x.recipient.toLowerCase(),x.inputToken.toLowerCase(),x.outputToken.toLowerCase(),x.amountIn,x.minAmountOut,x.deadlineMs].join(':'); }
function address(value: string): Address { if (!/^0x[0-9a-fA-F]{40}$/u.test(value) || /^0x0{40}$/iu.test(value)) throw new Error('invalid approved address'); return getAddress(value); }
function validAddress(value: string): boolean { try { address(value); return true; } catch { return false; } }
function validHash(value: string): boolean { return /^0x[0-9a-fA-F]{64}$/u.test(value); }
function sameAddress(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
