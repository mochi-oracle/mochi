import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

const amount = z.string().regex(/^\d{1,78}$/u);
const hash = z.string().regex(/^0x[\da-f]{64}$/iu);
const address = z.string().regex(/^0x[\da-f]{40}$/iu);
const count = z.number().int().nonnegative();
const asset = z.object({ address, decimals: count.max(36) });
// Reconstruct a public allowlist. Unknown/private fields in an operator file never reach the browser.
const reportSchema = z.object({
  schema: z.literal('mochi-public-revenue-report-v1'), status: z.literal('complete'),
  asOf: z.object({ generatedAt: z.string(), chainId: count.positive(), blockNumber: amount, blockHash: hash, confirmations: count.positive() }),
  assets: z.object({ reviewRevenue: asset, purchasedToken: asset }),
  treasury: z.object({ address }),
  accounting: z.object({
    source: z.literal('verified-post-panel-review-protocol-remainder'), checkpointBlock: amount,
    purchaseEvidence: z.literal('receipt-verified'), settlementEventCount: count,
    allocatedReviewRevenueAtomic: amount, unallocatedReviewRevenueAtomic: amount, totalVerifiedSettledReviewRevenueAtomic: amount,
    reservedOrInFlightReviewFundsAtomic: amount, purchasedReviewFundsAtomic: amount, remainingAttributedReviewRevenueAtomic: amount,
    buybackCount: z.object({ reservedOrInFlight: count, purchased: count }),
    purchases: z.array(z.object({ transactionHash: hash, blockNumber: amount, amountInAtomic: amount, receivedTokenAtomic: amount })).max(10_000),
    settlements: z.array(z.object({ transactionHash: hash, logIndex: count, blockNumber: amount, blockHash: hash, amountAtomic: amount })).max(10_000),
    operatingPolicy: z.object({ asOfMs: count, reserveTargetAtomic: amount, retainedReserveSnapshotAtomic: amount, requiredTopUpAtomic: amount }).nullable(),
  }),
  purchasedToken: z.object({
    purchaseRecipient: address, purchasedAtomic: amount, ledgerReportedPurchasedAtomic: amount,
    manualBurnEvidence: z.object({ status: z.literal('verified'), nativeSupplyBurnAtomic: amount, deadAddressTransferAtomic: amount,
      awaitingManualBurnAtomic: amount, records: z.array(z.object({ kind: z.enum(['native-supply-burn', 'dead-address-transfer']), transactionHash: hash, logIndex: count, blockNumber: amount, amountAtomic: amount })).max(10_000) }),
  }),
  integrity: z.object({ rejectedRecordCount: z.literal(0), incompleteReasons: z.array(z.string()).max(0) }),
});
export type PublicRevenueStatus = { status: 'awaiting_token' | 'unavailable' | 'stale' } | { status: 'ready'; report: z.infer<typeof reportSchema> };

export function validatePublicRevenueReport(value: unknown, now = Date.now()): PublicRevenueStatus {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) return { status: 'unavailable' };
  const report = parsed.data;
  const generated = Date.parse(report.asOf.generatedAt);
  if (!Number.isSafeInteger(generated) || generated > now + 60_000) return { status: 'unavailable' };
  if (now - generated > 24 * 60 * 60 * 1000) return { status: 'stale' };
  const a = report.accounting, b = report.purchasedToken.manualBurnEvidence;
  // Reject inconsistent artifacts even if their field types look valid.
  if (report.assets.reviewRevenue.decimals !== 6
    || BigInt(a.allocatedReviewRevenueAtomic) + BigInt(a.unallocatedReviewRevenueAtomic) !== BigInt(a.totalVerifiedSettledReviewRevenueAtomic)
    || BigInt(a.purchasedReviewFundsAtomic) + BigInt(a.reservedOrInFlightReviewFundsAtomic) + BigInt(a.remainingAttributedReviewRevenueAtomic) !== BigInt(a.totalVerifiedSettledReviewRevenueAtomic)
    || BigInt(b.nativeSupplyBurnAtomic) + BigInt(b.deadAddressTransferAtomic) + BigInt(b.awaitingManualBurnAtomic) !== BigInt(report.purchasedToken.purchasedAtomic)
    || report.purchasedToken.purchasedAtomic !== report.purchasedToken.ledgerReportedPurchasedAtomic) return { status: 'unavailable' };
  return { status: 'ready', report };
}

export function createRevenueStatusReader(options: { reportPath?: string; upstream?: string; tokenConfigured?: boolean; now?: () => number; fetcher?: typeof fetch } = {}) {
  return async (): Promise<PublicRevenueStatus> => {
    if (!options.reportPath && options.upstream) {
      try {
        const url = new URL(options.upstream);
        if (url.protocol !== 'https:' || url.username || url.password) return { status: 'unavailable' };
        url.pathname = '/api/tokenomics/report'; url.search = ''; url.hash = '';
        const response = await (options.fetcher ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
        if (!response.ok || !response.body) return { status: 'unavailable' };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) { await reader.cancel(); return { status: 'unavailable' }; }
          chunks.push(value);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (['awaiting_token', 'unavailable', 'stale'].includes(input?.status)) return { status: input.status };
        return input?.status === 'ready' ? validatePublicRevenueReport(input.report, (options.now ?? Date.now)()) : { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    }
    if (!options.reportPath) return { status: options.tokenConfigured ? 'unavailable' : 'awaiting_token' };
    try {
      if ((await stat(options.reportPath)).size > 2_000_000) return { status: 'unavailable' };
      return validatePublicRevenueReport(JSON.parse(await readFile(options.reportPath, 'utf8')), (options.now ?? Date.now)());
    } catch { return { status: 'unavailable' }; }
  };
}
