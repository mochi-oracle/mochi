import type { StorePort } from "../ports.ts";
import { log } from "../log.ts";

/** Remove expired private ciphertext and report the deleted row count. */
export async function purgePrivateResults(store: StorePort, now: Date): Promise<number> {
  const deleted = await store.purgeExpiredPrivateResults(now);
  log("info", "private_results_purged", { count: deleted });
  return deleted;
}
