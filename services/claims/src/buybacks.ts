import { planReviewRevenue, type RevenueObligations, type RevenuePlanBlockReason, type ReviewRevenuePlan } from './revenue.ts';

const MAX_SLIPPAGE_BPS = 1_000;
const MAX_QUOTE_AGE_MS = 30_000;
const MAX_DEADLINE_MS = 120_000;

export type BuybackConfig = {
  /** Omitted/false means the future purchase path stays disabled. */
  enabled?: boolean;
  /** Human-auditable policy approval identifier; execution stays blocked without it. */
  reviewedPolicyId?: string;
  /** Explicit team confirmation that tokenAddress is the intended MOCHI contract. */
  teamConfirmedTokenAddress?: boolean;
  chainId?: bigint;
  /** Team-issued MOCHI token; this project must not deploy or guess it. */
  tokenAddress?: string;
  usdgAddress?: string;
  /** Dedicated review-funds treasury with attributable review accounting. */
  reviewTreasuryAddress?: string;
  /** Explicit purchase destination; burn remains a separate manual action. */
  tokenRecipientAddress?: string;
  /** Must identify the approved adapter route; no router is inferred here. */
  routerAddress?: string;
  maxSlippageBps?: number;
};

export type BuybackRequest = {
  /** Stable ID for a settled review-revenue batch; also the adapter idempotency key. */
  settledBatchId: string;
  grossReviewRevenue: bigint;
  usdgUnitsPerUsd: bigint;
  obligations: RevenueObligations;
  requestedAmount: bigint;
};

export type TreasuryFunds = {
  chainId: bigint;
  treasuryAddress: string;
  usdgAddress: string;
  usdgBalance: bigint;
  /** Null when the adapter cannot prove this balance is settled review revenue. */
  attributableReviewFunds: bigint | null;
};

export type BuybackQuote = {
  chainId: bigint;
  routerAddress: string;
  treasuryAddress: string;
  senderAddress: string;
  inputToken: string;
  outputToken: string;
  recipient: string;
  amountIn: bigint;
  amountOut: bigint;
  quotedAtMs: number;
  validUntilMs: number;
};

export type BuybackExecution = {
  chainId: bigint;
  routerAddress: string;
  treasuryAddress: string;
  senderAddress: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadlineMs: number;
};

export type BuybackReceipt = {
  chainId: bigint;
  transactionRef: string;
  routerAddress: string;
  treasuryAddress: string;
  senderAddress: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  amountIn: bigint;
  receivedTokenAmount: bigint;
};

export type Reconciliation =
  | { status: 'unknown' }
  | { status: 'pending' }
  | { status: 'submitted'; transactionRef: string }
  | { status: 'confirmed'; receipt: BuybackReceipt }
  | { status: 'failed'; transactionRef: string };

/** Adapter is deliberately injected: it must use the explicitly approved route and chain. */
export interface BuybackAdapter {
  readTreasuryFunds(input: { chainId: bigint; treasuryAddress: string; usdgAddress: string }): Promise<TreasuryFunds>;
  quoteExactInput(input: BuybackExecution): Promise<BuybackQuote>;
  /** Submit exactly once for this idempotency key; a thrown error is treated as uncertain. */
  submitExactInput(input: BuybackExecution & { idempotencyKey: string }): Promise<{ transactionRef: string }>;
  /** Reconcile a known transaction or search by batch ID when submission outcome was uncertain. */
  reconcile(input: { idempotencyKey: string; transactionRef?: string }): Promise<Reconciliation>;
}

export type PersistedBuyback = {
  settledBatchId: string;
  /** Immutable gross settled-review allocation, required by durable stores. */
  grossReviewRevenue?: bigint;
  requestFingerprint: string;
  status: 'submitting' | 'submitted' | 'purchased' | 'failed' | 'cancelled';
  execution: BuybackExecution;
  transactionRef?: string;
  receivedTokenAmount?: bigint;
};

/** Locks and reservation accounting must be durable and atomic across all processes sharing this store. */
export interface BuybackStore {
  withBatchLock<T>(settledBatchId: string, action: () => Promise<T>): Promise<T>;
  withTreasuryLock<T>(treasuryAddress: string, action: () => Promise<T>): Promise<T>;
  /** Sum active `submitting` and `submitted` reservations for this dedicated review treasury. */
  reservedAmount(treasuryAddress: string): Promise<bigint>;
  get(settledBatchId: string): Promise<PersistedBuyback | undefined>;
  /** Atomically persist a pre-submit reservation before any adapter call can broadcast. */
  begin(record: PersistedBuyback): Promise<void>;
  markSubmitted(settledBatchId: string, transactionRef: string): Promise<PersistedBuyback>;
  /** Atomically store the confirmed transaction reference and received amount while marking purchased. */
  markPurchased(settledBatchId: string, transactionRef: string, receivedTokenAmount: bigint): Promise<PersistedBuyback>;
  markFailed(settledBatchId: string, transactionRef: string): Promise<PersistedBuyback>;
  markCancelled(settledBatchId: string): Promise<PersistedBuyback>;
}

export type BuybackBlockedReason =
  | 'disabled'
  | 'invalid_configuration'
  | 'invalid_request'
  | 'incomplete_review_fund_attribution'
  | 'revenue_not_eligible'
  | 'gross_revenue_does_not_cover_obligations'
  | 'available_review_funds_do_not_cover_obligations'
  | 'requested_amount_exceeds_eligible_residual'
  | 'insufficient_treasury_balance'
  | 'invalid_quote'
  | 'stale_or_expired_quote'
  | 'invalid_deadline'
  | 'batch_id_conflict';

export type BuybackResult =
  | { status: 'disabled'; reason: 'disabled' }
  | { status: 'blocked'; reasons: BuybackBlockedReason[]; revenuePlan?: ReviewRevenuePlan }
  | { status: 'submitted'; transactionRef: string; amountIn: bigint; minAmountOut: bigint; revenuePlan?: ReviewRevenuePlan }
  | { status: 'pending_reconciliation'; transactionRef?: string; reason: 'submission_uncertain' | 'receipt_pending' }
  | { status: 'failed'; transactionRef: string }
  | { status: 'purchased'; transactionRef: string; amountIn: bigint; receivedTokenAmount: bigint }
  | { status: 'already_purchased'; transactionRef: string; amountIn: bigint; receivedTokenAmount: bigint };

export type BuybackDependencies = {
  config?: BuybackConfig;
  adapter: BuybackAdapter;
  store: BuybackStore;
  now?: () => number;
};

/**
 * Plan and reconcile one settled review batch. This function never signs,
 * broadcasts directly, or burns. A missing/misconfigured deployment remains
 * disabled. Returned block reasons are safe for callers to log without secrets.
 */
export async function runReviewBuyback(request: BuybackRequest, deps: BuybackDependencies): Promise<BuybackResult> {
  if (deps.config?.enabled !== true) return { status: 'disabled', reason: 'disabled' };
  const config = deps.config;
  if (!validConfig(config)) return { status: 'blocked', reasons: ['invalid_configuration'] };
  if (!validRequest(request)) return { status: 'blocked', reasons: ['invalid_request'] };
  const batchId = request.settledBatchId;
  const requestFingerprint = fingerprint(request, config);
  const now = deps.now ?? Date.now;

  return deps.store.withTreasuryLock(config.reviewTreasuryAddress!.toLowerCase(), () => deps.store.withBatchLock(batchId, async () => {
    let record = await deps.store.get(batchId);
    if (record) {
      if (record.requestFingerprint !== requestFingerprint) return { status: 'blocked', reasons: ['batch_id_conflict'] };
      if (record.status === 'purchased') {
        return { status: 'already_purchased', transactionRef: record.transactionRef!, amountIn: record.execution.amountIn, receivedTokenAmount: record.receivedTokenAmount! };
      }
      if (record.status === 'failed') return { status: 'failed', transactionRef: record.transactionRef! };
      if (record.status === 'cancelled') return { status: 'blocked', reasons: ['stale_or_expired_quote'] };
      return reconcileExisting(record, deps.store, deps.adapter);
    }

    const funds = await deps.adapter.readTreasuryFunds({ chainId: config.chainId!, treasuryAddress: config.reviewTreasuryAddress!, usdgAddress: config.usdgAddress! }).catch(() => null);
    if (!funds || funds.chainId !== config.chainId || !sameAddress(funds.treasuryAddress, config.reviewTreasuryAddress!)
      || !sameAddress(funds.usdgAddress, config.usdgAddress!) || funds.attributableReviewFunds === null) {
      return { status: 'blocked', reasons: ['incomplete_review_fund_attribution'] };
    }
    if (typeof funds.usdgBalance !== 'bigint' || typeof funds.attributableReviewFunds !== 'bigint'
      || funds.usdgBalance < 0n || funds.attributableReviewFunds < 0n) return { status: 'blocked', reasons: ['incomplete_review_fund_attribution'] };
    const reservations = await deps.store.reservedAmount(config.reviewTreasuryAddress!.toLowerCase());
    if (reservations < 0n) return { status: 'blocked', reasons: ['incomplete_review_fund_attribution'] };
    const unreservedBalance = maxZero(funds.usdgBalance - reservations);
    const unreservedReviewFunds = maxZero(funds.attributableReviewFunds - reservations);
    const actualAvailable = min(unreservedBalance, unreservedReviewFunds);
    const revenuePlan = planReviewRevenue({
      grossReviewRevenue: request.grossReviewRevenue,
      availableReviewFunds: actualAvailable,
      usdgUnitsPerUsd: request.usdgUnitsPerUsd,
      obligations: request.obligations,
    });
    if (!revenuePlan.eligible) {
      return { status: 'blocked', reasons: revenuePlan.blockedReasons.map(mapRevenueBlockReason), revenuePlan };
    }
    if (request.requestedAmount === 0n || request.requestedAmount > revenuePlan.eligibleResidual) {
      return { status: 'blocked', reasons: ['requested_amount_exceeds_eligible_residual'], revenuePlan };
    }
    if (request.requestedAmount > unreservedBalance || request.requestedAmount > unreservedReviewFunds) {
      return { status: 'blocked', reasons: ['insufficient_treasury_balance'], revenuePlan };
    }

    const execution: BuybackExecution = {
      chainId: config.chainId!, routerAddress: config.routerAddress!, treasuryAddress: config.reviewTreasuryAddress!, senderAddress: config.reviewTreasuryAddress!,
      recipient: config.tokenRecipientAddress!, inputToken: config.usdgAddress!, outputToken: config.tokenAddress!,
      amountIn: request.requestedAmount, minAmountOut: 0n, deadlineMs: 0,
    };
    const quote = await deps.adapter.quoteExactInput(execution).catch(() => null);
    if (!quote || !validQuote(quote, execution) || quote.amountOut === 0n) {
      return { status: 'blocked', reasons: ['invalid_quote'], revenuePlan };
    }
    const quoteReceivedAt = now();
    if (!Number.isSafeInteger(quoteReceivedAt) || quote.quotedAtMs > quoteReceivedAt || quoteReceivedAt - quote.quotedAtMs > MAX_QUOTE_AGE_MS || quote.validUntilMs <= quoteReceivedAt) {
      return { status: 'blocked', reasons: ['stale_or_expired_quote'], revenuePlan };
    }
    const deadlineMs = Math.min(quote.validUntilMs, quoteReceivedAt + MAX_DEADLINE_MS);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= quoteReceivedAt || deadlineMs > quoteReceivedAt + MAX_DEADLINE_MS) {
      return { status: 'blocked', reasons: ['invalid_deadline'], revenuePlan };
    }
    const minAmountOut = quote.amountOut * BigInt(10_000 - config.maxSlippageBps!) / 10_000n;
    if (minAmountOut <= 0n) return { status: 'blocked', reasons: ['invalid_quote'], revenuePlan };
    execution.minAmountOut = minAmountOut;
    execution.deadlineMs = deadlineMs;

    // Persist before adapter submission. If submit times out/crashes, retries reconcile this marker and never resubmit blindly.
    await deps.store.begin({ settledBatchId: batchId, grossReviewRevenue: request.grossReviewRevenue, requestFingerprint, status: 'submitting', execution });
    const submitAt = now();
    if (!Number.isSafeInteger(submitAt) || submitAt < quote.quotedAtMs || submitAt - quote.quotedAtMs > MAX_QUOTE_AGE_MS || submitAt >= deadlineMs || submitAt >= quote.validUntilMs) {
      await deps.store.markCancelled(batchId);
      return { status: 'blocked', reasons: ['stale_or_expired_quote'], revenuePlan };
    }
    let submitted: { transactionRef: string };
    try {
      submitted = await deps.adapter.submitExactInput({ ...execution, idempotencyKey: batchId });
      if (!submitted.transactionRef) throw new Error('missing transaction reference');
    } catch {
      return { status: 'pending_reconciliation', reason: 'submission_uncertain' };
    }
    record = await deps.store.markSubmitted(batchId, submitted.transactionRef);
    return reconcileExisting(record, deps.store, deps.adapter, revenuePlan);
  }));
}

async function reconcileExisting(
  record: PersistedBuyback,
  store: BuybackStore,
  adapter: BuybackAdapter,
  revenuePlan?: ReviewRevenuePlan,
): Promise<BuybackResult> {
  let state: Reconciliation;
  try {
    state = await adapter.reconcile({ idempotencyKey: record.settledBatchId, ...(record.transactionRef ? { transactionRef: record.transactionRef } : {}) });
  } catch {
    return { status: 'pending_reconciliation', ...(record.transactionRef ? { transactionRef: record.transactionRef } : {}), reason: 'receipt_pending' };
  }
  if (state.status === 'unknown' || state.status === 'pending') {
    return { status: 'pending_reconciliation', ...(record.transactionRef ? { transactionRef: record.transactionRef } : {}), reason: 'receipt_pending' };
  }
  if (state.status === 'failed') {
    if (record.transactionRef && state.transactionRef !== record.transactionRef) return { status: 'pending_reconciliation', transactionRef: record.transactionRef, reason: 'receipt_pending' };
    const failed = await store.markFailed(record.settledBatchId, state.transactionRef);
    return { status: 'failed', transactionRef: failed.transactionRef! };
  }
  if (state.status === 'submitted') {
    if (record.transactionRef && record.transactionRef !== state.transactionRef) return { status: 'pending_reconciliation', transactionRef: record.transactionRef, reason: 'receipt_pending' };
    const submitted = record.transactionRef ? record : await store.markSubmitted(record.settledBatchId, state.transactionRef);
    return { status: 'submitted', transactionRef: submitted.transactionRef!, amountIn: submitted.execution.amountIn, minAmountOut: submitted.execution.minAmountOut, ...(revenuePlan ? { revenuePlan } : {}) };
  }
  const receipt = state.receipt;
  if (!validReceipt(receipt, record.execution) || (record.transactionRef && receipt.transactionRef !== record.transactionRef)) {
    return { status: 'pending_reconciliation', ...(record.transactionRef ? { transactionRef: record.transactionRef } : {}), reason: 'receipt_pending' };
  }
  const purchased = await store.markPurchased(record.settledBatchId, receipt.transactionRef, receipt.receivedTokenAmount);
  return { status: 'purchased', transactionRef: receipt.transactionRef, amountIn: purchased.execution.amountIn, receivedTokenAmount: purchased.receivedTokenAmount! };
}

function validConfig(config: BuybackConfig): boolean {
  return typeof config.reviewedPolicyId === 'string' && config.reviewedPolicyId.trim().length > 0
    && config.teamConfirmedTokenAddress === true
    && typeof config.chainId === 'bigint' && config.chainId > 0n
    && isAddress(config.tokenAddress) && isAddress(config.usdgAddress)
    && isAddress(config.reviewTreasuryAddress) && isAddress(config.tokenRecipientAddress)
    && isAddress(config.routerAddress)
    && Number.isInteger(config.maxSlippageBps) && config.maxSlippageBps! >= 0 && config.maxSlippageBps! <= MAX_SLIPPAGE_BPS;
}

function validRequest(request: BuybackRequest): boolean {
  return request.settledBatchId.length > 0 && request.settledBatchId.length <= 200
    && request.grossReviewRevenue >= 0n && request.requestedAmount > 0n
    && request.usdgUnitsPerUsd > 0n && request.usdgUnitsPerUsd % 100n === 0n
    && Object.values(request.obligations).every((value) => value === null || (typeof value === 'bigint' && value >= 0n));
}

function validQuote(quote: BuybackQuote, expected: BuybackExecution): boolean {
  return quote.chainId === expected.chainId && typeof quote.amountIn === 'bigint' && typeof quote.amountOut === 'bigint'
    && sameAddress(quote.routerAddress, expected.routerAddress)
    && sameAddress(quote.treasuryAddress, expected.treasuryAddress) && sameAddress(quote.senderAddress, expected.senderAddress)
    && sameAddress(quote.inputToken, expected.inputToken) && sameAddress(quote.outputToken, expected.outputToken)
    && sameAddress(quote.recipient, expected.recipient) && quote.amountIn === expected.amountIn
    && quote.amountOut > 0n && Number.isSafeInteger(quote.quotedAtMs) && Number.isSafeInteger(quote.validUntilMs);
}

function validReceipt(receipt: BuybackReceipt, expected: BuybackExecution): boolean {
  return receipt.chainId === expected.chainId && typeof receipt.transactionRef === 'string' && receipt.transactionRef.length > 0
    && typeof receipt.amountIn === 'bigint' && typeof receipt.receivedTokenAmount === 'bigint'
    && sameAddress(receipt.routerAddress, expected.routerAddress)
    && sameAddress(receipt.treasuryAddress, expected.treasuryAddress)
    && sameAddress(receipt.senderAddress, expected.senderAddress)
    && sameAddress(receipt.recipient, expected.recipient) && sameAddress(receipt.inputToken, expected.inputToken)
    && sameAddress(receipt.outputToken, expected.outputToken) && receipt.amountIn === expected.amountIn
    && receipt.receivedTokenAmount >= expected.minAmountOut && receipt.receivedTokenAmount > 0n;
}

function isAddress(value: string | undefined): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(value) && !/^0x0{40}$/iu.test(value);
}

function sameAddress(left: string, right: string): boolean {
  return isAddress(left) && isAddress(right) && left.toLowerCase() === right.toLowerCase();
}

function fingerprint(request: BuybackRequest, config: BuybackConfig): string {
  const { obligations } = request;
  return JSON.stringify({
    batch: request.settledBatchId,
    grossReviewRevenue: String(request.grossReviewRevenue),
    usdgUnitsPerUsd: String(request.usdgUnitsPerUsd),
    requestedAmount: String(request.requestedAmount),
    obligations: Object.fromEntries(Object.entries(obligations).map(([key, value]) => [key, value === null ? null : String(value)])),
    config: {
      chainId: String(config.chainId),
      tokenAddress: config.tokenAddress!.toLowerCase(),
      usdgAddress: config.usdgAddress!.toLowerCase(),
      reviewTreasuryAddress: config.reviewTreasuryAddress!.toLowerCase(),
      tokenRecipientAddress: config.tokenRecipientAddress!.toLowerCase(),
      routerAddress: config.routerAddress!.toLowerCase(),
      maxSlippageBps: config.maxSlippageBps,
      reviewedPolicyId: config.reviewedPolicyId,
      teamConfirmedTokenAddress: config.teamConfirmedTokenAddress,
    },
  });
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function mapRevenueBlockReason(reason: RevenuePlanBlockReason): BuybackBlockedReason {
  switch (reason) {
    case 'incomplete_obligations': return 'revenue_not_eligible';
    case 'gross_revenue_does_not_cover_obligations': return 'gross_revenue_does_not_cover_obligations';
    case 'available_review_funds_do_not_cover_obligations': return 'available_review_funds_do_not_cover_obligations';
  }
}
