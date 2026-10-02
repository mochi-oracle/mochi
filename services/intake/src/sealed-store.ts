import { FileSealedStore, SealedStoreFullError, type SealedStoreRetention, type TeeProvider } from "@mochi/tee";
import { log } from "./log.ts";
import { decodeIntakeRecord, encodeIntakeRecord } from "./record-codec.ts";

const HOUR = 60 * 60;
const MiB = 1024 * 1024;
/**
 * Public uploads are untrusted writes to the CVM disk that Postgres and the research pilot share, so the intake store
 * bounds both kinds of record it holds, by lifetime and by disk use (whole blocks of ciphertext, see `diskBytes`):
 *
 * - Unretained: an upload no query has used. A grant must open its query within 15 minutes (PROVENANCE_TTL_SECONDS)
 *   and a query that is not sealed within QueryEscrow.queryTtl (1 hour) expires, so its first dispatch comes within
 *   about 1 h 15 min of the upload. Three hours leaves more than twice that; unopened uploads (free to make) can hold
 *   at most 512 MiB, for at most three hours.
 * - Retained: a record released to the jurors of a sealed query, or to a panel. dispatch() and dispatchPanel() retain
 *   it again on every release, which restarts its 14-day lifetime. The longest gap between two releases under the
 *   default PanelEscalation windows is the appeal panel: commit 1 d + reveal 1 d + appeal 1 d + draw 1 d = 4 days
 *   after the first panel's draw, and a first panel is drawn within drawWindow (1 d) of escalating. 14 days is over
 *   three times that, so governance can lengthen the windows without the record vanishing mid-case. A HUNG query that
 *   is escalated more than 14 days after its last dispatch finds no document. Retained records (paid for) hold at
 *   most 1.5 GiB; past that a dispatch still succeeds but leaves its record unretained (and logs it).
 *
 * Reads do not retain: intake also reads a record at upload (one record per signed grant, first write wins), so it
 * retains a record explicitly, by its provenance-hash key, only when dispatching a query that is sealed or escalated
 * on-chain with that grant.
 */
export const INTAKE_UPLOAD_RETENTION: SealedStoreRetention = {
  ttlSec: 3 * HOUR,
  retainedTtlSec: 14 * 24 * HOUR,
  maxBytes: 2048 * MiB,
  maxUnretainedBytes: 512 * MiB,
  maxRetainedBytes: 1536 * MiB,
  retainOnRead: false,
  sweepIntervalMs: 10 * 60 * 1000,
};

/** The intake's sealed store: records kept compactly (see record-codec.ts) under the upload retention policy. */
export class IntakeSealedStore extends FileSealedStore {
  override async get(key: string): Promise<Uint8Array | undefined> {
    const stored = await super.get(key);
    return stored === undefined ? undefined : decodeIntakeRecord(stored);
  }
  override async put(key: string, value: Uint8Array): Promise<void> { await super.put(key, encodeIntakeRecord(value)); }
  override async putIfAbsent(key: string, value: Uint8Array): Promise<boolean> { return super.putIfAbsent(key, encodeIntakeRecord(value)); }
  /** Never fails a paid dispatch for retention: with the retained pool full the record keeps its upload lifetime. */
  override async retain(key: string): Promise<void> {
    try { await super.retain(key); }
    catch (error) {
      if (!(error instanceof SealedStoreFullError)) throw error;
      log("warn", "intake_retention_full", { pool: error.pool });
    }
  }
}

export function createIntakeSealedStore(dir: string, tee: TeeProvider, retention: SealedStoreRetention = INTAKE_UPLOAD_RETENTION): IntakeSealedStore {
  return new IntakeSealedStore(dir, tee, retention);
}
