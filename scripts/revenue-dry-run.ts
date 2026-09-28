import { readFileSync } from 'node:fs';
import { SqliteBuybackStore } from '../services/claims/src/buyback-sqlite-store.ts';
import { planAllocatedReviewBatch } from '../services/claims/src/revenue-dry-run.ts';
import type { RevenueObligations } from '../services/claims/src/revenue.ts';

function usage(): never {
  throw new Error('usage: bun scripts/revenue-dry-run.ts <sqlite-path> <batch-id> <available-review-funds-atomic> <usdg-units-per-usd> <obligations.json>');
}

function amount(value: unknown, name: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new Error(`${name} must be a decimal integer string or null`);
  return BigInt(value);
}

function parseObligations(path: string): RevenueObligations {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const keys = ['modelLiabilities', 'infrastructureLiabilities', 'refunds', 'reserves'] as const;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !(key in raw))) throw new Error('obligations JSON must contain exactly modelLiabilities, infrastructureLiabilities, refunds, and reserves');
  return Object.fromEntries(keys.map((key) => [key, amount(raw[key], key)])) as RevenueObligations;
}

if (import.meta.main) {
  const [databasePath, batchId, available, scale, obligationsPath, ...extra] = process.argv.slice(2);
  if (!databasePath || !batchId || !available || !scale || !obligationsPath || extra.length) usage();
  let store: SqliteBuybackStore | undefined;
  try {
    store = new SqliteBuybackStore(databasePath);
    const result = planAllocatedReviewBatch(store, batchId, {
      availableReviewFunds: BigInt(available),
      usdgUnitsPerUsd: BigInt(scale),
      obligations: parseObligations(obligationsPath),
    });
    console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'dry-run failed');
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
