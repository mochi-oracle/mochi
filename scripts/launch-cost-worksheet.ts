import { readFile } from 'node:fs/promises';
import {
  LAUNCH_CLASS_PRICES,
  LAUNCH_MIN_PROTOCOL_FEE,
  LAUNCH_PROTOCOL_FEE_BPS,
} from './launch-pricing.ts';

const USDG_SCALE = 1_000_000n;
const BPS = 10_000n;
const N3_CLASSES = [0, 2, 4] as const; // Default ClassMix order: LARGE_A, DOC_SPECIALIST, DISSENTER.

export type LaunchCostInput = {
  totalReviews: number;
  completedReviews: number;
  /** Aggregate USD costs, entered as exact decimal strings to six places. Null means unknown. */
  costsUsd: {
    inferenceIncludingFailuresAndRetries: string | null;
    searchIncludingFailedRequests: string | null;
    settlementGas: string | null;
    hostingAllocation: string | null;
    otherUncovered: string | null;
  };
  /** Reconciled USDG funding actually available to the review product. Null means unknown. */
  verifiedProductFundingUsd: string | null;
};

export type LaunchCostWorksheet = {
  inputCounts: { totalReviews: number; completedReviews: number };
  costCoverageComplete: boolean;
  costsUsdMicros: Record<keyof LaunchCostInput['costsUsd'], string | null>;
  knownCostSubtotalUsdMicros: string | null;
  requiredFundingUsdMicros: string | null;
  perAttemptCostUsdMicros: string | null;
  perCompletedReviewCostUsdMicros: string | null;
  verifiedProductFundingUsdMicros: string | null;
  shortfallUsdMicros: string | null;
  customerQuote: {
    tokensK: 1;
    jurorFeesUsdGMicros: string;
    protocolFeeUsdGMicros: string;
    grossCustomerChargeUsdGMicros: string;
    panelReserveShareUsdGMicros: string;
    postPanelReviewProtocolRemainderUsdGMicros: string;
    note: string;
  };
  notes: string[];
};

const costKeys = [
  'inferenceIncludingFailuresAndRetries',
  'searchIncludingFailedRequests',
  'settlementGas',
  'hostingAllocation',
  'otherUncovered',
] as const;

function parseUsdMicros(value: unknown, field: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.test(value)) {
    throw new TypeError(`${field} must be null or a non-negative USD decimal string with at most 6 places`);
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * USDG_SCALE + BigInt(fraction.padEnd(6, '0') || '0');
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function formatUsdMicros(amount: bigint | null): string | null {
  return amount === null ? null : amount.toString();
}

function validateInput(input: LaunchCostInput): void {
  if (!Number.isSafeInteger(input.totalReviews) || input.totalReviews < 0) {
    throw new TypeError('totalReviews must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.completedReviews) || input.completedReviews < 0 || input.completedReviews > input.totalReviews) {
    throw new TypeError('completedReviews must be a non-negative safe integer no greater than totalReviews');
  }
  if (!input.costsUsd || typeof input.costsUsd !== 'object') throw new TypeError('costsUsd is required');
  for (const key of costKeys) parseUsdMicros(input.costsUsd[key], `costsUsd.${key}`);
  parseUsdMicros(input.verifiedProductFundingUsd, 'verifiedProductFundingUsd');
}

export function calculateLaunchCostWorksheet(input: LaunchCostInput): LaunchCostWorksheet {
  validateInput(input);
  const values = Object.fromEntries(costKeys.map(key => [key, parseUsdMicros(input.costsUsd[key], `costsUsd.${key}`)])) as Record<typeof costKeys[number], bigint | null>;
  const known = costKeys.reduce((sum, key) => sum + (values[key] ?? 0n), 0n);
  const hasKnownCost = costKeys.some(key => values[key] !== null);
  const complete = costKeys.every(key => values[key] !== null);
  const requiredFunding = complete ? known : null;
  const perAttempt = input.totalReviews > 0 && complete ? ceilDiv(known, BigInt(input.totalReviews)) : null;
  const perCompleted = input.completedReviews > 0 && complete ? ceilDiv(known, BigInt(input.completedReviews)) : null;
  const productFunding = parseUsdMicros(input.verifiedProductFundingUsd, 'verifiedProductFundingUsd');

  const classes = new Map(LAUNCH_CLASS_PRICES.map(([classId, base, perK]) => [classId, { base, perK }]));
  const jurorFees = N3_CLASSES.reduce((sum, classId) => {
    const price = classes.get(classId)!;
    return sum + price.base + price.perK;
  }, 0n);
  const variableProtocolFee = jurorFees * BigInt(LAUNCH_PROTOCOL_FEE_BPS) / BPS;
  const protocolFee = variableProtocolFee > LAUNCH_MIN_PROTOCOL_FEE ? variableProtocolFee : LAUNCH_MIN_PROTOCOL_FEE;
  const grossCharge = jurorFees + protocolFee;
  const panelReserveShare = protocolFee * 2_500n / BPS; // Current contract default; governance can change it.
  const postPanelRemainder = protocolFee - panelReserveShare;
  const shortfall = requiredFunding === null || productFunding === null
    ? null
    : requiredFunding > productFunding ? requiredFunding - productFunding : 0n;

  const notes = [
    'Cost inputs must cover all attempts, failed requests, retries, search failures, settlement gas, hosting allocation, and other uncovered costs; a null input keeps complete totals and shortfall unknown.',
    'Per-review values divide total aggregate cost by total reviews attempted or completed reviews and round up to one USDG atomic unit.',
    'The five-cent customer quote is juror fees plus protocol fee. At the current 25% panel-reserve setting, the one-cent protocol fee splits into 2,500 USDG units for panel reserve and 7,500 units for the configured recipient or staking. Neither share is assumed to be available review-product revenue.',
    'This worksheet estimates funding only. It does not initiate or authorize a transaction.',
  ];
  if (!complete || input.totalReviews === 0 || input.completedReviews === 0) {
    notes.push('Cost coverage cannot pass until every cost field is measured and both total and completed review counts are positive.');
  }
  if (productFunding === null) notes.push('Shortfall remains unknown until actual product-available funding is reconciled; gross customer charges and juror fees are not counted as product funding.');

  return {
    inputCounts: { totalReviews: input.totalReviews, completedReviews: input.completedReviews },
    costCoverageComplete: complete && input.totalReviews > 0 && input.completedReviews > 0,
    costsUsdMicros: Object.fromEntries(costKeys.map(key => [key, formatUsdMicros(values[key])])) as LaunchCostWorksheet['costsUsdMicros'],
    knownCostSubtotalUsdMicros: hasKnownCost ? known.toString() : null,
    requiredFundingUsdMicros: formatUsdMicros(requiredFunding),
    perAttemptCostUsdMicros: formatUsdMicros(perAttempt),
    perCompletedReviewCostUsdMicros: formatUsdMicros(perCompleted),
    verifiedProductFundingUsdMicros: formatUsdMicros(productFunding),
    shortfallUsdMicros: formatUsdMicros(shortfall),
    customerQuote: {
      tokensK: 1,
      jurorFeesUsdGMicros: jurorFees.toString(),
      protocolFeeUsdGMicros: protocolFee.toString(),
      grossCustomerChargeUsdGMicros: grossCharge.toString(),
      panelReserveShareUsdGMicros: panelReserveShare.toString(),
      postPanelReviewProtocolRemainderUsdGMicros: postPanelRemainder.toString(),
      note: 'Gross quote is not product revenue. The protocol fee is split under escrow routing; the post-panel remainder goes to the configured recipient or staking and is not assumed available for operating costs.',
    },
    notes,
  };
}

export const DISABLED_LAUNCH_COST_EXAMPLE: LaunchCostInput = {
  totalReviews: 0,
  completedReviews: 0,
  costsUsd: {
    inferenceIncludingFailuresAndRetries: null,
    searchIncludingFailedRequests: null,
    settlementGas: null,
    hostingAllocation: null,
    otherUncovered: null,
  },
  verifiedProductFundingUsd: null,
};

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: bun scripts/launch-cost-worksheet.ts <input.json>');
  let input: LaunchCostInput;
  try {
    input = JSON.parse(await readFile(path, 'utf8')) as LaunchCostInput;
  } catch {
    throw new Error('Unable to read or parse the worksheet input. Check the private JSON file and documented schema.');
  }
  process.stdout.write(`${JSON.stringify(calculateLaunchCostWorksheet(input), null, 2)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Worksheet input is invalid. Check required fields and decimal-string precision.'}\n`);
    process.exitCode = 1;
  });
}
