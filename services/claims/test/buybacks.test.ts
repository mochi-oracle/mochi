import { describe, expect, test } from 'bun:test';
import {
  runReviewBuyback,
  type BuybackAdapter,
  type BuybackConfig,
  type BuybackExecution,
  type BuybackQuote,
  type BuybackReceipt,
  type BuybackRequest,
  type BuybackStore,
  type PersistedBuyback,
  type Reconciliation,
} from '../src/buybacks.ts';

const address = (n: string) => `0x${n.repeat(40)}`;
const config: BuybackConfig = {
  enabled: true,
  reviewedPolicyId: 'test-only-reviewed-policy',
  operatingBudgetId: 'test-budget',
  teamConfirmedTokenAddress: true,
  chainId: 4663n,
  tokenAddress: address('1'),
  usdgAddress: address('2'),
  reviewTreasuryAddress: address('3'),
  tokenRecipientAddress: address('4'),
  routerAddress: address('5'),
  maxSlippageBps: 100,
};
const request: BuybackRequest = {
  settledBatchId: 'settled-reviews-2026-09-28-a',
  grossReviewRevenue: 150000000n,
  usdgUnitsPerUsd: 1_000_000n,
  obligations: { modelLiabilities: 60000000n, infrastructureLiabilities: 15000000n, refunds: 15000000n, reserves: 30000000n },
  requestedAmount: 30000000n,
};
const makeQuote = (execution: BuybackExecution): BuybackQuote => ({
  chainId: execution.chainId,
  routerAddress: execution.routerAddress,
  treasuryAddress: execution.treasuryAddress,
  senderAddress: execution.senderAddress,
  inputToken: execution.inputToken,
  outputToken: execution.outputToken,
  recipient: execution.recipient,
  amountIn: execution.amountIn,
  amountOut: 1_000n,
  quotedAtMs: 1_000_000,
  validUntilMs: 1_090_000,
});

class MemoryStore implements BuybackStore {
  records = new Map<string, PersistedBuyback>();
  private locks = new Map<string, Promise<void>>();
  withBatchLock<T>(id: string, action: () => Promise<T>) { return this.withLock(`batch:${id}`, action); }
  withTreasuryLock<T>(address: string, action: () => Promise<T>) { return this.withLock(`treasury:${address.toLowerCase()}`, action); }
  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  async reservedAmount(treasuryAddress: string) {
    return [...this.records.values()]
      .filter((record) => ['submitting', 'submitted'].includes(record.status) && record.execution.treasuryAddress.toLowerCase() === treasuryAddress.toLowerCase())
      .reduce((total, record) => total + record.execution.amountIn, 0n);
  }
  async get(id: string) { return this.records.get(id); }
  async begin(record: PersistedBuyback) {
    if (this.records.has(record.settledBatchId)) throw new Error('batch already exists');
    this.records.set(record.settledBatchId, { ...record, execution: { ...record.execution } });
  }
  async markSubmitted(id: string, transactionRef: string) {
    const record = this.records.get(id)!;
    record.status = 'submitted'; record.transactionRef = transactionRef;
    return record;
  }
  async markPurchased(id: string, transactionRef: string, receivedTokenAmount: bigint) {
    const record = this.records.get(id)!;
    record.status = 'purchased'; record.transactionRef = transactionRef; record.receivedTokenAmount = receivedTokenAmount;
    return record;
  }
  async markFailed(id: string, transactionRef: string) {
    const record = this.records.get(id)!;
    record.status = 'failed'; record.transactionRef = transactionRef;
    return record;
  }
  async markCancelled(id: string) {
    const record = this.records.get(id)!;
    record.status = 'cancelled';
    return record;
  }
}

class MockAdapter implements BuybackAdapter {
  submissions = 0;
  reconciliations = 0;
  funds = { chainId: 4663n, treasuryAddress: config.reviewTreasuryAddress!, usdgAddress: config.usdgAddress!, usdgBalance: 150000000n, attributableReviewFunds: 150000000n as bigint | null };
  quote: (execution: BuybackExecution) => BuybackQuote = makeQuote;
  reconcileState: Reconciliation = { status: 'submitted', transactionRef: 'tx-1' };
  submit: () => Promise<{ transactionRef: string }> = async () => ({ transactionRef: 'tx-1' });
  async readTreasuryFunds() { return this.funds; }
  async quoteExactInput(execution: BuybackExecution) { return this.quote(execution); }
  async submitExactInput() { this.submissions++; return this.submit(); }
  async reconcile(): Promise<Reconciliation> { this.reconciliations++; return this.reconcileState; }
}

function dependencies(adapter = new MockAdapter(), store = new MemoryStore()) {
  return { deps: { config, adapter, store, now: () => 1_000_000, loadOperatingBudget: async () => ({budgetId:'test-budget',asOfMs:1_000_000,uncoveredDailyOperatingCost:1_000_000n,retainedOperatingReserve:0n}) }, adapter, store };
}

describe('runReviewBuyback', () => {
  test('new purchases cannot bypass the budget reader, reserve rule or $25 threshold', async () => {
    const { deps, adapter } = dependencies();
    expect(await runReviewBuyback(request, { ...deps, loadOperatingBudget: undefined })).toMatchObject({ status: 'blocked', reasons: ['operating_budget_unavailable'] });
    expect(await runReviewBuyback({ ...request, obligations: { ...request.obligations, reserves: 0n } }, deps)).toMatchObject({ status: 'blocked', reasons: ['reserve_top_up_mismatch'] });
    expect(await runReviewBuyback({ ...request, requestedAmount: 24_999_999n }, deps)).toMatchObject({ status: 'blocked', reasons: ['below_minimum_batch'] });
    expect(await runReviewBuyback({ ...request, usdgUnitsPerUsd: 100n }, deps)).toMatchObject({ status: 'blocked', reasons: ['invalid_request'] });
    expect(adapter.submissions).toBe(0);
    expect(await runReviewBuyback({ ...request, requestedAmount: 25_000_000n }, deps)).toMatchObject({ status: 'submitted', amountIn: 25_000_000n });
    expect(adapter.submissions).toBe(1);
  });

  test('existing reserves cannot be spent again, and policy evidence persists with the reservation', async () => {
    const { deps, adapter, store } = dependencies();
    const loadOperatingBudget = async () => ({ budgetId: 'test-budget', asOfMs: 1_000_000, uncoveredDailyOperatingCost: 1_000_000n, retainedOperatingReserve: 30_000_000n });
    const funded = { ...request, obligations: { ...request.obligations, reserves: 0n }, requestedAmount: 30_000_000n };
    expect(await runReviewBuyback({ ...funded, requestedAmount: 30_000_001n }, { ...deps, loadOperatingBudget })).toMatchObject({ status: 'blocked', reasons: ['requested_amount_exceeds_eligible_residual'] });
    expect(adapter.submissions).toBe(0);
    expect(await runReviewBuyback(funded, { ...deps, loadOperatingBudget })).toMatchObject({ status: 'submitted' });
    expect(store.records.get(request.settledBatchId)?.operatingPolicy).toMatchObject({ retainedReserve: 30_000_000n, requiredTopUp: 0n, reserveTarget: 30_000_000n });
  });

  test('an expired budget never prevents reconciliation of an already uncertain transaction', async () => {
    const { deps, adapter } = dependencies();
    await runReviewBuyback(request, deps);
    const result = await runReviewBuyback(request, { ...deps, loadOperatingBudget: undefined });
    expect(result.status).toBe('submitted');
    expect(adapter.submissions).toBe(1);
  });
  test('disabled by default and requires explicit nonzero team/route addresses', async () => {
    const { deps, adapter } = dependencies();
    expect(await runReviewBuyback(request, { ...deps, config: undefined })).toEqual({ status: 'disabled', reason: 'disabled' });
    expect(adapter.submissions).toBe(0);
    const invalid = await runReviewBuyback(request, { ...deps, config: { ...config, tokenAddress: address('0') } });
    expect(invalid).toEqual({ status: 'blocked', reasons: ['invalid_configuration'] });
    const unreviewed = await runReviewBuyback(request, { ...deps, config: { ...config, reviewedPolicyId: undefined } });
    expect(unreviewed).toEqual({ status: 'blocked', reasons: ['invalid_configuration'] });
    const unconfirmedToken = await runReviewBuyback(request, { ...deps, config: { ...config, teamConfirmedTokenAddress: false } });
    expect(unconfirmedToken).toEqual({ status: 'blocked', reasons: ['invalid_configuration'] });
  });

  test('serializes duplicate concurrent batches and does not submit twice', async () => {
    const { deps, adapter } = dependencies();
    const [first, second] = await Promise.all([runReviewBuyback(request, deps), runReviewBuyback(request, deps)]);
    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    expect(adapter.submissions).toBe(1);
    expect(adapter.reconciliations).toBe(2);
    expect(adapter).not.toHaveProperty('burn');
  });

  test('uncertain submit is persisted and retries reconcile without resubmitting', async () => {
    const adapter = new MockAdapter();
    adapter.submit = async () => { throw new Error('timeout after broadcast may have happened'); };
    adapter.reconcileState = { status: 'unknown' };
    const { deps, store } = dependencies(adapter);
    const first = await runReviewBuyback(request, deps);
    expect(first).toEqual({ status: 'pending_reconciliation', reason: 'submission_uncertain' });
    expect(store.records.get(request.settledBatchId)?.status).toBe('submitting');
    const retry = await runReviewBuyback(request, deps);
    expect(retry).toEqual({ status: 'pending_reconciliation', reason: 'receipt_pending' });
    expect(adapter.submissions).toBe(1);

    adapter.reconcileState = { status: 'confirmed', receipt: {
      chainId: 4663n,
      transactionRef: 'tx-recovered',
      routerAddress: config.routerAddress!,
      treasuryAddress: config.reviewTreasuryAddress!,
      senderAddress: config.reviewTreasuryAddress!,
      recipient: config.tokenRecipientAddress!,
      inputToken: config.usdgAddress!,
      outputToken: config.tokenAddress!,
      amountIn: request.requestedAmount,
      receivedTokenAmount: 990n,
    } };
    const recovered = await runReviewBuyback(request, deps);
    expect(recovered).toEqual({ status: 'purchased', transactionRef: 'tx-recovered', amountIn: 30000000n, receivedTokenAmount: 990n });
    const repeated = await runReviewBuyback(request, deps);
    expect(repeated).toEqual({ status: 'already_purchased', transactionRef: 'tx-recovered', amountIn: 30000000n, receivedTokenAmount: 990n });
    expect(store.records.get(request.settledBatchId)?.transactionRef).toBe('tx-recovered');
    expect(adapter.submissions).toBe(1);
  });

  test('cancels durably when the quote expires after begin and before submit', async () => {
    const adapter = new MockAdapter();
    adapter.quote = (execution) => ({ ...makeQuote(execution), validUntilMs: 1_000_010 });
    const store = new MemoryStore();
    let clockReads = 0;
    const deps = { ...dependencies(adapter, store).deps, now: () => ++clockReads <= 2 ? 1_000_000 : 1_000_011 };
    const result = await runReviewBuyback({ ...request, settledBatchId: 'expires-at-submit' }, deps);
    expect(result).toMatchObject({ status: 'blocked', reasons: ['stale_or_expired_quote'] });
    expect(store.records.get('expires-at-submit')?.status).toBe('cancelled');
    expect(adapter.submissions).toBe(0);
    const retry = await runReviewBuyback({ ...request, settledBatchId: 'expires-at-submit' }, deps);
    expect(retry).toMatchObject({ status: 'blocked', reasons: ['stale_or_expired_quote'] });
    expect(adapter.submissions).toBe(0);
  });

  test('rejects a quote that becomes stale while the durable reservation is saved', async () => {
    const { deps, adapter, store } = dependencies();
    let reads = 0;
    const result = await runReviewBuyback({ ...request, settledBatchId: 'stale-during-save' }, { ...deps, now: () => ++reads <= 2 ? 1_000_000 : 1_030_001 });
    expect(result).toMatchObject({ status: 'blocked', reasons: ['stale_or_expired_quote'] });
    expect(store.records.get('stale-during-save')?.status).toBe('cancelled');
    expect(adapter.submissions).toBe(0);
  });

  test('cancels before submission when the approved operating budget expires during persistence', async () => {
    const { deps, adapter, store } = dependencies();
    let reads = 0;
    adapter.quote = (execution) => ({ ...makeQuote(execution), quotedAtMs: 86_400_000, validUntilMs: 86_430_000 });
    const boundary = await runReviewBuyback(request, { ...deps,
      now: () => ++reads <= 2 ? 86_400_000 : 86_400_001,
      loadOperatingBudget: async () => ({ budgetId: 'test-budget', asOfMs: 0, uncoveredDailyOperatingCost: 1_000_000n, retainedOperatingReserve: 0n }),
    });
    expect(boundary).toMatchObject({ status: 'blocked', reasons: ['operating_budget_unavailable'] });
    expect(store.records.get(request.settledBatchId)?.status).toBe('cancelled');
    expect(adapter.submissions).toBe(0);
  });

  test('rejects mismatched quotes and never submits them', async () => {
    const adapter = new MockAdapter();
    adapter.quote = (execution) => ({ ...makeQuote(execution), amountIn: execution.amountIn + 1n });
    const { deps, store } = dependencies(adapter);
    const result = await runReviewBuyback(request, deps);
    expect(result).toEqual({ status: 'blocked', reasons: ['invalid_quote'], revenuePlan: expect.any(Object) });
    expect(adapter.submissions).toBe(0);
    expect(store.records.size).toBe(0);

    adapter.quote = (execution) => ({ ...makeQuote(execution), quotedAtMs: 900_000 });
    const stale = await runReviewBuyback({ ...request, settledBatchId: 'stale-quote' }, deps);
    expect(stale).toMatchObject({ status: 'blocked', reasons: ['stale_or_expired_quote'] });
    expect(adapter.submissions).toBe(0);
  });

  test('unknown liabilities or unproven fund attribution block purchase amount', async () => {
    const adapter = new MockAdapter();
    const { deps } = dependencies(adapter);
    const unknown = await runReviewBuyback({ ...request, settledBatchId: 'unknown-costs', obligations: { ...request.obligations, modelLiabilities: null } }, deps);
    expect(unknown.status).toBe('blocked');
    expect(adapter.submissions).toBe(0);
    adapter.funds = { ...adapter.funds, attributableReviewFunds: null };
    const unattributed = await runReviewBuyback({ ...request, settledBatchId: 'unattributed' }, deps);
    expect(unattributed).toEqual({ status: 'blocked', reasons: ['incomplete_review_fund_attribution'] });
    expect(adapter.submissions).toBe(0);
  });

  test('checks treasury chain, address, and USDG contract before using balance', async () => {
    const adapter = new MockAdapter();
    adapter.funds = { ...adapter.funds, usdgAddress: address('8') };
    const result = await runReviewBuyback(request, dependencies(adapter).deps);
    expect(result).toEqual({ status: 'blocked', reasons: ['incomplete_review_fund_attribution'] });
    expect(adapter.submissions).toBe(0);
  });

  test('caps requested amount at eligible review funds and marks purchased only after matching confirmed receipt', async () => {
    const adapter = new MockAdapter();
    adapter.funds = { ...adapter.funds, usdgBalance: 150000000n, attributableReviewFunds: 150000000n };
    const tooMuch = await runReviewBuyback({ ...request, settledBatchId: 'over-cap', requestedAmount: 36003000n }, dependencies(adapter).deps);
    expect(tooMuch.status).toBe('blocked');
    expect(adapter.submissions).toBe(0);

    const confirmed = new MockAdapter();
    confirmed.quote = (execution) => ({ ...makeQuote(execution), validUntilMs: 2_000_000 });
    confirmed.reconcileState = { status: 'confirmed', receipt: {
      chainId: 4663n,
      transactionRef: 'tx-1',
      routerAddress: config.routerAddress!,
      treasuryAddress: config.reviewTreasuryAddress!,
      senderAddress: config.reviewTreasuryAddress!,
      recipient: config.tokenRecipientAddress!,
      inputToken: config.usdgAddress!,
      outputToken: config.tokenAddress!,
      amountIn: request.requestedAmount,
      receivedTokenAmount: 990n,
    } satisfies BuybackReceipt };
    const successful = dependencies(confirmed);
    const result = await runReviewBuyback(request, successful.deps);
    expect(result).toEqual({ status: 'purchased', transactionRef: 'tx-1', amountIn: 30000000n, receivedTokenAmount: 990n });
    expect(successful.store.records.get(request.settledBatchId)?.status).toBe('purchased');
    expect(successful.store.records.get(request.settledBatchId)?.execution.minAmountOut).toBe(990n);
    expect(successful.store.records.get(request.settledBatchId)?.execution.deadlineMs).toBe(1_120_000);
    expect(confirmed).not.toHaveProperty('burn');
  });

  test('does not mark purchase complete for a confirmed receipt with wrong token or too little output', async () => {
    const adapter = new MockAdapter();
    adapter.reconcileState = { status: 'confirmed', receipt: {
      chainId: 4663n,
      transactionRef: 'tx-1',
      routerAddress: config.routerAddress!,
      treasuryAddress: config.reviewTreasuryAddress!,
      senderAddress: config.reviewTreasuryAddress!,
      recipient: config.tokenRecipientAddress!,
      inputToken: config.usdgAddress!,
      outputToken: address('6'),
      amountIn: request.requestedAmount,
      receivedTokenAmount: 989n,
    } };
    const { deps, store } = dependencies(adapter);
    const result = await runReviewBuyback(request, deps);
    expect(result.status).toBe('pending_reconciliation');
    expect(store.records.get(request.settledBatchId)?.status).toBe('submitted');

    const validReceipt: BuybackReceipt = {
      chainId: 4663n,
      transactionRef: 'tx-1',
      routerAddress: config.routerAddress!,
      treasuryAddress: config.reviewTreasuryAddress!,
      senderAddress: config.reviewTreasuryAddress!,
      recipient: config.tokenRecipientAddress!,
      inputToken: config.usdgAddress!,
      outputToken: config.tokenAddress!,
      amountIn: request.requestedAmount,
      receivedTokenAmount: 990n,
    };
    for (const [batch, change] of [
      ['wrong-router', { routerAddress: address('6') }],
      ['wrong-treasury', { treasuryAddress: address('6') }],
      ['wrong-sender', { senderAddress: address('6') }],
    ] as const) {
      const routeAdapter = new MockAdapter();
      routeAdapter.reconcileState = { status: 'confirmed', receipt: { ...validReceipt, ...change } };
      const routeStore = new MemoryStore();
      const routeResult = await runReviewBuyback({ ...request, settledBatchId: batch }, { ...dependencies(routeAdapter, routeStore).deps });
      expect(routeResult.status).toBe('pending_reconciliation');
      expect(routeStore.records.get(batch)?.status).toBe('submitted');
    }
  });

  test('conflicting retry inputs cannot reuse an already claimed batch ID', async () => {
    const { deps, adapter } = dependencies();
    await runReviewBuyback(request, deps);
    const conflict = await runReviewBuyback({ ...request, requestedAmount: 29997000n }, deps);
    expect(conflict).toEqual({ status: 'blocked', reasons: ['batch_id_conflict'] });
    expect(adapter.submissions).toBe(1);
    const changedRoute = await runReviewBuyback(request, { ...deps, config: { ...config, routerAddress: address('6') } });
    expect(changedRoute).toEqual({ status: 'blocked', reasons: ['batch_id_conflict'] });
    expect(adapter.submissions).toBe(1);
  });

  test('treasury-scoped reservations prevent distinct concurrent batches overspending shared funds', async () => {
    const { deps, adapter, store } = dependencies();
    const [first, second] = await Promise.all([
      runReviewBuyback({ ...request, settledBatchId: 'shared-a' }, deps),
      runReviewBuyback({ ...request, settledBatchId: 'shared-b' }, deps),
    ]);
    expect(first.status).toBe('submitted');
    expect(second.status).toBe('blocked');
    expect(adapter.submissions).toBe(1);
    expect(await store.reservedAmount(config.reviewTreasuryAddress!)).toBe(30000000n);
  });
});
