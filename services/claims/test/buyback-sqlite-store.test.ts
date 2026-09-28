import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBuybackStore } from '../src/buyback-sqlite-store.ts';
import { planAllocatedReviewBatch } from '../src/revenue-dry-run.ts';
import { runReviewBuyback, type BuybackAdapter, type BuybackConfig, type BuybackExecution, type BuybackQuote, type BuybackRequest, type PersistedBuyback, type Reconciliation } from '../src/buybacks.ts';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mochi-buyback-'));
  roots.push(root);
  return { root, path: join(root, 'ledger.sqlite') };
}
function registerBatch(store: SqliteBuybackStore, batchId: string, amount: bigint) {
  const eventId = `event-${batchId}`;
  store.recordSettledReviewEvent({ eventId, batchId, amount, source: 'settled_customer_review' });
  store.allocateSettledReviewBatch({ batchId, eventIds: [eventId] });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const record = (batchId: string): PersistedBuyback => ({
  settledBatchId: batchId, grossReviewRevenue: 123n, requestFingerprint: 'immutable-request-fingerprint', status: 'submitting',
  execution: { chainId: 4663n, routerAddress: '0x1111111111111111111111111111111111111111', treasuryAddress: '0x2222222222222222222222222222222222222222', senderAddress: '0x2222222222222222222222222222222222222222', recipient: '0x3333333333333333333333333333333333333333', inputToken: '0x4444444444444444444444444444444444444444', outputToken: '0x5555555555555555555555555555555555555555', amountIn: 123n, minAmountOut: 9n, deadlineMs: 123456 },
});

describe('SqliteBuybackStore', () => {
  test('persists atomic units and in-flight state across restart; changed inputs conflict at orchestrator fingerprint layer', async () => {
    const { path } = setup();
    let store = new SqliteBuybackStore(path);
    registerBatch(store, 'settle-a', 123n);
    await store.begin(record('settle-a'));
    await store.markSubmitted('settle-a', 'opaque-tx-ref');
    expect(await store.reservedAmount('0x2222222222222222222222222222222222222222')).toBe(123n);
    store.close();

    store = new SqliteBuybackStore(path);
    const restored = await store.get('settle-a');
    expect(restored?.status).toBe('submitted');
    expect(restored?.execution.amountIn).toBe(123n);
    expect(restored?.transactionRef).toBe('opaque-tx-ref');
    expect(store.auditTrail('settle-a').map((entry) => entry.kind)).toEqual(['reservation_created', 'submitted']);
    await expect(store.begin(record('settle-a'))).rejects.toThrow();
    await store.markPurchased('settle-a', 'opaque-tx-ref', 8n);
    await store.markPurchased('settle-a', 'opaque-tx-ref', 8n);
    await expect(store.markPurchased('settle-a', 'opaque-tx-ref', 9n)).rejects.toThrow('replay conflict');
    expect(await store.reservedAmount('0x2222222222222222222222222222222222222222')).toBe(0n);
    expect(store.auditTrail('settle-a').map((entry) => entry.kind)).toEqual(['reservation_created', 'submitted', 'purchased']);
    store.close();
  });

  test('serializes cross-instance critical sections and reserves each batch once', async () => {
    const { path } = setup();
    const one = new SqliteBuybackStore(path), two = new SqliteBuybackStore(path);
    let inside = 0, peak = 0;
    await Promise.all([one, two].map((store) => store.withTreasuryLock('treasury', async () => {
      inside++; peak = Math.max(peak, inside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside--;
    })));
    expect(peak).toBe(1);
    registerBatch(one, 'same-batch', 123n);
    await one.begin(record('same-batch'));
    await expect(two.begin(record('same-batch'))).rejects.toThrow();
    one.close(); two.close();
  });

  test('fails closed after bounded lock contention', async () => {
    const { path } = setup();
    const one = new SqliteBuybackStore(path, 25), two = new SqliteBuybackStore(path, 25);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = one.withTreasuryLock('held-lock', async () => held);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(two.withTreasuryLock('held-lock', async () => undefined)).rejects.toThrow('timed out waiting');
    release();
    await first;
    one.close(); two.close();
  });

  test('settlement events can only be allocated once and changed replay is rejected', () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    store.recordSettledReviewEvent({ eventId: 'event-1', batchId: 'batch-1', amount: 12_345n, source: 'settled_customer_review' });
    store.recordSettledReviewEvent({ eventId: 'event-1', batchId: 'batch-1', amount: 12_345n, source: 'settled_customer_review' });
    store.recordSettledReviewEvent({ eventId: 'event-2', batchId: 'batch-1', amount: 5n, source: 'settled_customer_review' });
    expect(store.allocateSettledReviewBatch({ batchId: 'batch-1', eventIds: ['event-1', 'event-2'] })).toEqual({ amount: 12_350n, eventIds: ['event-1', 'event-2'] });
    expect(store.allocateSettledReviewBatch({ batchId: 'batch-1', eventIds: ['event-2', 'event-1'] }).amount).toBe(12_350n);
    expect(() => store.allocateSettledReviewBatch({ batchId: 'batch-1', eventIds: ['event-1'] })).toThrow('replay conflict');
    expect(() => store.allocateSettledReviewBatch({ batchId: 'batch-2', eventIds: ['event-1'] })).toThrow('already allocated');
    expect(() => store.recordSettledReviewEvent({ eventId: 'event-1', batchId: 'batch-1', amount: 1n, source: 'settled_customer_review' })).toThrow();
    expect(() => store.recordSettledReviewEvent({ eventId: 'event-1', batchId: 'other-batch', amount: 12_345n, source: 'settled_customer_review' })).toThrow('replay conflict');
    expect(() => store.recordSettledReviewEvent({ eventId: 'deposit-1', batchId: 'batch-1', amount: 1n, source: 'customer_deposit' as 'settled_customer_review' })).toThrow();
    store.close();
  });

  test('buyback reservations require an allocation with matching gross review revenue', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    await expect(store.begin(record('unallocated'))).rejects.toThrow('matching persisted review allocation');
    registerBatch(store, 'allocated', 122n);
    const mismatch = record('allocated'); mismatch.grossReviewRevenue = 123n;
    await expect(store.begin(mismatch)).rejects.toThrow('matching persisted review allocation');
    const exact = record('allocated'); exact.grossReviewRevenue = 122n;
    await expect(store.begin(exact)).rejects.toThrow('invalid initial reservation');
    exact.execution.amountIn = 122n;
    await store.begin(exact);
    store.close();
  });

  test('allocation fingerprints cannot confuse delimiters with event boundaries', () => {
    const store = new SqliteBuybackStore(setup().path);
    for (const eventId of ['a\nb', 'c']) store.recordSettledReviewEvent({ eventId, batchId: 'batch', amount: 1n, source: 'settled_customer_review' });
    store.allocateSettledReviewBatch({ batchId: 'batch', eventIds: ['a\nb', 'c'] });
    expect(() => store.allocateSettledReviewBatch({ batchId: 'batch', eventIds: ['a', 'b\nc'] })).toThrow('replay conflict');
    store.close();
  });

  test('failed and cancelled terminal transitions are immutable and exact replays are no-ops', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    registerBatch(store, 'failed-batch', 123n);
    registerBatch(store, 'cancelled-batch', 123n);
    await store.begin(record('failed-batch'));
    await store.markSubmitted('failed-batch', 'tx-failed');
    await store.markFailed('failed-batch', 'tx-failed');
    const auditLength = store.auditTrail('failed-batch').length;
    await store.markFailed('failed-batch', 'tx-failed');
    expect(store.auditTrail('failed-batch')).toHaveLength(auditLength);
    await expect(store.markFailed('failed-batch', 'other-tx')).rejects.toThrow('replay conflict');
    await expect(store.markPurchased('failed-batch', 'tx-failed', 1n)).rejects.toThrow('terminal');

    await store.begin(record('cancelled-batch'));
    await store.markCancelled('cancelled-batch');
    const cancelledAuditLength = store.auditTrail('cancelled-batch').length;
    await store.markCancelled('cancelled-batch');
    expect(store.auditTrail('cancelled-batch')).toHaveLength(cancelledAuditLength);
    await expect(store.markSubmitted('cancelled-batch', 'tx-late')).rejects.toThrow('terminal');
    store.close();
  });

  test('dry-run reads allocated gross amount and reports unknown obligations as blocked without execution', () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    registerBatch(store, 'dry-batch', 123n);
    const dryRun = planAllocatedReviewBatch(store, 'dry-batch', {
      availableReviewFunds: 123n, usdgUnitsPerUsd: 1_000n,
      obligations: { modelLiabilities: null, infrastructureLiabilities: 0n, refunds: 0n, reserves: 0n },
    });
    expect(dryRun.execution).toBe('never');
    expect(dryRun.plan.grossReviewRevenue).toBe(123n);
    expect(dryRun.plan.eligible).toBe(false);
    expect(dryRun.plan.blockedReasons).toContain('incomplete_obligations');
    expect(() => planAllocatedReviewBatch(store, 'missing', { availableReviewFunds: 0n, usdgUnitsPerUsd: 1_000n,
      obligations: { modelLiabilities: 0n, infrastructureLiabilities: 0n, refunds: 0n, reserves: 0n } })).toThrow('no persisted allocation');
    store.close();
  });

  test('unknown obligations are preserved as blocked inputs by the planner and never erased from persisted requests', async () => {
    const { path } = setup();
    const store = new SqliteBuybackStore(path);
    const pending = record('unknown-costs');
    pending.grossReviewRevenue = 123n;
    pending.requestFingerprint = JSON.stringify({ modelLiabilities: null });
    registerBatch(store, 'unknown-costs', 123n);
    await store.begin(pending);
    store.close();
    const reopened = new SqliteBuybackStore(path);
    expect((await reopened.get('unknown-costs'))?.requestFingerprint).toContain('null');
    reopened.close();
  });

  test('reopened in-flight uncertain submission reconciles to confirmed without a second submit', async () => {
    const { path } = setup();
    const config: BuybackConfig = { enabled: true, reviewedPolicyId: 'test-only-policy', operatingBudgetId: 'test-budget', teamConfirmedTokenAddress: true, chainId: 4663n,
      tokenAddress: '0x5555555555555555555555555555555555555555', usdgAddress: '0x4444444444444444444444444444444444444444',
      reviewTreasuryAddress: '0x2222222222222222222222222222222222222222', tokenRecipientAddress: '0x3333333333333333333333333333333333333333',
      routerAddress: '0x1111111111111111111111111111111111111111', maxSlippageBps: 100 };
    const request: BuybackRequest = { settledBatchId: 'persistent-pending', grossReviewRevenue: 100_000_000n, usdgUnitsPerUsd: 1_000_000n,
      obligations: { modelLiabilities: 0n, infrastructureLiabilities: 0n, refunds: 0n, reserves: 0n }, requestedAmount: 25_000_000n };
    let submissions = 0;
    let reconciled: Reconciliation = { status: 'unknown' };
    const adapter: BuybackAdapter = {
      async readTreasuryFunds() { return { chainId: 4663n, treasuryAddress: config.reviewTreasuryAddress!, usdgAddress: config.usdgAddress!, usdgBalance: 100_000_000n, attributableReviewFunds: 100_000_000n }; },
      async quoteExactInput(input: BuybackExecution): Promise<BuybackQuote> { return { chainId: input.chainId, routerAddress: input.routerAddress, treasuryAddress: input.treasuryAddress, senderAddress: input.senderAddress, inputToken: input.inputToken, outputToken: input.outputToken, recipient: input.recipient, amountIn: input.amountIn, amountOut: 10n, quotedAtMs: 1_000, validUntilMs: 50_000 }; },
      async submitExactInput() { submissions++; throw new Error('submission outcome ambiguous'); },
      async reconcile() { return reconciled; },
    };
    let store = new SqliteBuybackStore(path);
    registerBatch(store, request.settledBatchId, request.grossReviewRevenue);
    const loadOperatingBudget = async () => ({ budgetId: 'test-budget', asOfMs: 1_000, uncoveredDailyOperatingCost: 0n, retainedOperatingReserve: 0n });
    const first = await runReviewBuyback(request, { config, adapter, store, now: () => 1_000, loadOperatingBudget });
    expect(first.status).toBe('pending_reconciliation');
    store.close();

    reconciled = { status: 'confirmed', receipt: { chainId: 4663n, transactionRef: 'recovered-tx', routerAddress: config.routerAddress!, treasuryAddress: config.reviewTreasuryAddress!, senderAddress: config.reviewTreasuryAddress!, recipient: config.tokenRecipientAddress!, inputToken: config.usdgAddress!, outputToken: config.tokenAddress!, amountIn: 25_000_000n, receivedTokenAmount: 9n } };
    store = new SqliteBuybackStore(path);
    const recovered = await runReviewBuyback(request, { config, adapter, store, now: () => 1_000, loadOperatingBudget });
    expect(recovered).toMatchObject({ status: 'purchased', transactionRef: 'recovered-tx', amountIn: 25_000_000n, receivedTokenAmount: 9n });
    expect(submissions).toBe(1);
    store.close();
  });
});
