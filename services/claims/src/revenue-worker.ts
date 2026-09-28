import { createHash } from 'node:crypto';
import { planReviewRevenue, type RevenueObligations } from './revenue.ts';
import { MINIMUM_PURCHASE, USDG_UNITS, evaluateOperatingPolicy, type OperatingBudget } from './operating-policy.ts';
import { planOperatingReviewBatch } from './revenue-dry-run.ts';
import { reconcilePendingBuyback, runReviewBuyback, type BuybackAdapter, type BuybackConfig, type BuybackResult } from './buybacks.ts';
import { SqliteBuybackStore, type ConfirmedReviewRevenueRecord } from './buyback-sqlite-store.ts';
import { ingestReviewProtocolRevenue, type ReviewRevenueIngestionConfig, type ReviewRevenueReader } from './settlement-ingestion.ts';
import { createPublicRevenueReport, type BurnEvidence, type RevenueReportConfig, type RevenueReportReader, type RevenueReportResult } from './revenue-report.ts';

export type RevenueWorkerDependencies = {
  /** Omitted mode is fail-closed and performs no RPC, store scan, or adapter call. */
  mode?: 'disabled' | 'observe' | 'execute';
  store: SqliteBuybackStore;
  ingestion: { reader: ReviewRevenueReader; config: ReviewRevenueIngestionConfig; maxChunks?: number };
  buybackConfig: BuybackConfig;
  adapter: BuybackAdapter;
  /** Must return a fresh, approved cost snapshot. runReviewBuyback reloads it under lock before submission. */
  loadOperatingBudget: () => Promise<OperatingBudget>;
  /** Unknown values deliberately block allocation and purchase. */
  loadObligations: () => Promise<Omit<RevenueObligations, 'reserves'>>;
  report: { config: RevenueReportConfig; reader: RevenueReportReader; burnEvidence?: readonly BurnEvidence[] };
  now?: () => number;
};

export type RevenueWorkerCycle = {
  execution: 'adapter-gated';
  ingestion: Awaited<ReturnType<typeof ingestReviewProtocolRevenue>>;
  reconciliations: Array<{ batchId: string; result: BuybackResult }>;
  allocation?: { batchId: string; eventIds: string[]; grossReviewRevenue: bigint };
  purchase?: BuybackResult;
  plan?: ReturnType<typeof planReviewRevenue>;
  report: RevenueReportResult;
};
export type RevenueWorkerResult = RevenueWorkerCycle | { mode: 'disabled'; execution: 'never' };

/** One bounded cycle. Revenue is derived only from verified, unallocated event records in this store. */
export function runRevenueWorkerCycle(deps: RevenueWorkerDependencies & { mode: 'observe' | 'execute' }): Promise<RevenueWorkerCycle>;
export function runRevenueWorkerCycle(deps: RevenueWorkerDependencies): Promise<RevenueWorkerResult>;
export async function runRevenueWorkerCycle(deps: RevenueWorkerDependencies): Promise<RevenueWorkerResult> {
  if ((deps.mode ?? 'disabled') === 'disabled') return { mode: 'disabled', execution: 'never' };
  const scope = JSON.stringify([deps.ingestion.config.chainId.toString(), deps.ingestion.config.escrowAddress.toLowerCase(), deps.ingestion.config.usdgAddress.toLowerCase(), deps.ingestion.config.recipientAddress.toLowerCase()]);
  const workerLockId = `worker:${createHash('sha256').update(scope).digest('hex')}`;
  return deps.store.withBatchLock(workerLockId, () => runCycleLocked(deps));
}

async function runCycleLocked(deps: RevenueWorkerDependencies): Promise<RevenueWorkerCycle> {
  const now = deps.now ?? Date.now;
  const reconciliations: RevenueWorkerCycle['reconciliations'] = [];

  // Recover uncertain submissions before scanning or evaluating new policy inputs. This path never submits.
  const persistedEvents = new Map(deps.store.listConfirmedReviewRevenue().filter((event) => matchesScope(event, deps.ingestion.config)).map((event) => [event.eventId, event]));
  const persistedAllocations = deps.store.listAllocations().filter((item) => item.eventIds.length > 0 && item.eventIds.every((id) => persistedEvents.has(id)));
  const existingBuybacks = deps.store.listBuybacks();
  for (const record of existingBuybacks.filter((row) => (row.status === 'submitting' || row.status === 'submitted')
    && persistedAllocations.some((allocation) => allocation.batchId === row.settledBatchId) && executionMatches(row.execution, deps.buybackConfig))) {
    const result = await reconcilePendingBuyback(record.settledBatchId, {
      config: deps.buybackConfig, adapter: deps.adapter, store: deps.store,
    });
    reconciliations.push({ batchId: record.settledBatchId, result });
  }

  const ingestion = await ingestReviewProtocolRevenue(deps.store, deps.ingestion.reader, deps.ingestion.config,
    { maxChunks: deps.ingestion.maxChunks });

  let allocation: RevenueWorkerCycle['allocation'];
  let plan: RevenueWorkerCycle['plan'];
  let purchase: BuybackResult | undefined;
  const allocations = deps.store.listAllocations();
  const events = deps.store.listConfirmedReviewRevenue();
  const used = new Set(allocations.flatMap((item) => item.eventIds));
  const unallocated = events.filter((event) => !used.has(event.eventId) && matchesScope(event, deps.ingestion.config));

  // Existing immutable allocations without a reservation are retried by their persisted batch identity.
  const scopeEvents = new Map(events.filter((event) => matchesScope(event, deps.ingestion.config)).map((event) => [event.eventId, event]));
  const scopedAllocations = allocations.filter((item) => item.eventIds.length > 0 && item.eventIds.every((id) => scopeEvents.has(id)));
  const pendingAllocation = scopedAllocations.find((item) => !existingBuybacks.some((row) => row.settledBatchId === item.batchId));
  let candidate = pendingAllocation
    ? { batchId: pendingAllocation.batchId, eventIds: pendingAllocation.eventIds, gross: pendingAllocation.amount, preallocated: true }
    : undefined;

  if (!candidate && sum(unallocated.map((e) => e.amount)) >= MINIMUM_PURCHASE) {
    const ids = unallocated.map((e) => e.eventId).sort();
    candidate = { batchId: deterministicBatchId(deps.ingestion.config.chainId, ids), eventIds: ids, gross: sum(unallocated.map((e) => e.amount)), preallocated: false };
  }

  if (candidate) {
    const budgetId = deps.buybackConfig.operatingBudgetId;
    let budget: OperatingBudget | undefined;
    let obligations: Omit<RevenueObligations, 'reserves'> | undefined;
    try { budget = await deps.loadOperatingBudget(); obligations = await deps.loadObligations(); } catch { /* fail closed below */ }
    const policy = evaluateOperatingPolicy(budget, budgetId ?? '', now());
    if (policy && obligations && Object.values(obligations).every((x) => x === null || (typeof x === 'bigint' && x >= 0n))) {
      const funds = await deps.adapter.readTreasuryFunds({
        chainId: deps.buybackConfig.chainId ?? 0n,
        treasuryAddress: deps.buybackConfig.reviewTreasuryAddress ?? '',
        usdgAddress: deps.buybackConfig.usdgAddress ?? '',
      }).catch(() => null);
      if (funds && funds.chainId === deps.buybackConfig.chainId
        && funds.treasuryAddress.toLowerCase() === (deps.buybackConfig.reviewTreasuryAddress ?? '').toLowerCase()
        && funds.usdgAddress.toLowerCase() === (deps.buybackConfig.usdgAddress ?? '').toLowerCase()
        && typeof funds.usdgBalance === 'bigint' && funds.usdgBalance >= 0n
        && funds.attributableReviewFunds !== null && funds.attributableReviewFunds >= 0n) {
        const reservations = await deps.store.reservedAmount(deps.buybackConfig.reviewTreasuryAddress!.toLowerCase());
        const availableBeforeRetained = min(funds.usdgBalance, funds.attributableReviewFunds) - reservations;
        const availableBase = availableBeforeRetained > 0n ? availableBeforeRetained : 0n;
        const rawAvailable = availableBase - policy.retainedReserve;
        const available = rawAvailable > 0n ? rawAvailable : 0n;
        plan = planReviewRevenue({ grossReviewRevenue: candidate.gross, availableReviewFunds: available, usdgUnitsPerUsd: USDG_UNITS,
          obligations: { ...obligations, reserves: policy.requiredTopUp } });
        const ready = plan.eligible && plan.eligibleResidual >= MINIMUM_PURCHASE;
        if (candidate.preallocated || (ready && deps.buybackConfig.enabled === true && deps.mode === 'execute' && ingestion.complete)) {
          if (!candidate.preallocated && deps.mode === 'execute') {
            const saved = deps.store.allocateSettledReviewBatch({ batchId: candidate.batchId, eventIds: candidate.eventIds });
            if (saved.amount !== candidate.gross) throw new Error('allocation amount changed while worker was preparing the batch');
            allocation = { batchId: candidate.batchId, eventIds: saved.eventIds, grossReviewRevenue: saved.amount };
          } else if (candidate.preallocated) allocation = { batchId: candidate.batchId, eventIds: candidate.eventIds, grossReviewRevenue: candidate.gross };
          const persistedPlan = candidate.preallocated || deps.mode === 'execute' ? planOperatingReviewBatch(deps.store, candidate.batchId, {
            availableReviewFunds: availableBase, obligations, budget: budget!,
            approvedBudgetId: budgetId!, nowMs: now(),
          }) : undefined;
          if (persistedPlan && persistedPlan.plan.grossReviewRevenue !== candidate.gross) throw new Error('persisted allocation differs from worker batch');
          if (persistedPlan) plan = persistedPlan.plan;
          if (deps.mode === 'execute' && deps.buybackConfig.enabled === true && ingestion.complete && persistedPlan?.batchReady) purchase = await runReviewBuyback({ settledBatchId: candidate.batchId, grossReviewRevenue: candidate.gross,
            usdgUnitsPerUsd: USDG_UNITS, obligations: { ...obligations, reserves: policy.requiredTopUp },
            requestedAmount: persistedPlan.purchaseAmount }, {
            config: deps.buybackConfig, adapter: deps.adapter, store: deps.store, now,
            loadOperatingBudget: deps.loadOperatingBudget,
          });
        }
      }
    }
  }

  const report = await createPublicRevenueReport({ ...deps.report.config, settlementStreamId: ingestion.streamId }, deps.store, deps.report.reader, deps.report.burnEvidence);
  return { execution: 'adapter-gated', ingestion, reconciliations, ...(allocation ? { allocation } : {}), ...(purchase ? { purchase } : {}), ...(plan ? { plan } : {}), report };
}

function matchesScope(event: ConfirmedReviewRevenueRecord, config: ReviewRevenueIngestionConfig): boolean {
  return event.chainId === config.chainId && event.escrow.toLowerCase() === config.escrowAddress.toLowerCase()
    && event.usdg.toLowerCase() === config.usdgAddress.toLowerCase() && event.recipient.toLowerCase() === config.recipientAddress.toLowerCase()
    && event.verification === 'confirmed' && event.queryStatus === 'DECIDED' && event.receiptStatus === 'success'
    && event.payPath !== 'FEED';
}
function sum(values: bigint[]): bigint { return values.reduce((a, b) => a + b, 0n); }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function executionMatches(x: { chainId: bigint; treasuryAddress: string; inputToken: string; outputToken: string; recipient: string; routerAddress: string }, c: BuybackConfig): boolean {
  return x.chainId === c.chainId && x.treasuryAddress.toLowerCase() === (c.reviewTreasuryAddress ?? '').toLowerCase()
    && x.inputToken.toLowerCase() === (c.usdgAddress ?? '').toLowerCase()
    && x.outputToken.toLowerCase() === (c.tokenAddress ?? '').toLowerCase()
    && x.recipient.toLowerCase() === (c.tokenRecipientAddress ?? '').toLowerCase()
    && x.routerAddress.toLowerCase() === (c.routerAddress ?? '').toLowerCase();
}
function deterministicBatchId(chainId: bigint, ids: string[]): string {
  const h = createHash('sha256').update(JSON.stringify([chainId.toString(), ids])).digest('hex');
  return `review-chain-${h}`;
}
