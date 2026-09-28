import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { SqliteBuybackStore } from '../services/claims/src/buyback-sqlite-store.ts';
import { createViemReviewRevenueReader, ingestReviewProtocolRevenue } from '../services/claims/src/settlement-ingestion.ts';

/** Bounded one-shot worker. Schedule externally only after production routing is approved. */
export async function ingestFromManifest(path: string) {
  const input = JSON.parse(readFileSync(path, 'utf8'));
  if (input.enabled !== true) return { status: 'disabled', execution: 'never' };
  if (typeof input.databasePath !== 'string' || !input.databasePath || typeof input.rpcUrl !== 'string') throw new Error('configuration required');
  const endpoint = new URL(input.rpcUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('HTTP RPC required');
  if (!/^\d+$/u.test(input.chainId) || !/^\d+$/u.test(input.startBlock)) throw new Error('integer configuration required');
  const client = createPublicClient({ transport: http(input.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  const store = new SqliteBuybackStore(input.databasePath);
  try {
    const result = await store.withTreasuryLock('settlement-ingestion', () => ingestReviewProtocolRevenue(store, createViemReviewRevenueReader(client), {
      chainId: BigInt(input.chainId), startBlock: BigInt(input.startBlock),
      escrowAddress: input.escrowAddress, usdgAddress: input.usdgAddress, recipientAddress: input.recipientAddress,
      chunkSize: 1_000,
    }));
    return { status: 'scanned', execution: 'never', ...result };
  } finally { store.close(); }
}

if (import.meta.main) {
  try {
    const [manifest, ...extra] = process.argv.slice(2);
    if (!manifest || extra.length) throw new Error('manifest required');
    console.log(JSON.stringify(await ingestFromManifest(manifest), (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch {
    // RPC errors may contain credential-bearing URLs. Never print provider exceptions.
    console.error('Settlement ingestion failed; check the private manifest and canonical chain data. No transaction was sent.');
    process.exitCode = 1;
  }
}
