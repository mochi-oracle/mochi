import { AnchorWindow, receiptLeaf } from "@mochi/receipts";
import type { Hex } from "viem";
import type { ChainPort, StorePort } from "../ports.ts";

export class AnchorPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Anchor was posted but local persistence failed", { cause });
    this.name = "AnchorPersistenceError";
  }
}

/** Flush an eligible receipt batch to chain and persist its proofs. */
export async function flushAnchors(
  chain: ChainPort,
  store: StorePort,
  window: AnchorWindow,
  now: Date,
): Promise<boolean> {
  if (!window.shouldFlush(now.getTime())) return false;
  const candidates = await store.listUnanchoredReceipts();
  let chainWriteCompleted = false;

  try {
    const batch = await window.flush(async (root, count) => {
      const transactionHash = await chain.anchor(root, count);
      chainWriteCompleted = true;
      return transactionHash;
    });
    const selected = candidates.slice(0, batch.count);
    await store.insertAnchor({
      root: batch.root,
      ts: now,
      count: batch.count,
      tx: batch.txHash,
    });
    const ordered = [...selected].sort((left, right) =>
      receiptLeaf(left.payload).localeCompare(receiptLeaf(right.payload)));
    await store.updateReceiptAnchor(batch.root, ordered.map((receipt, index) => ({
      verdictId: receipt.verdictId,
      index,
    })));
    return true;
  } catch (error) {
    if (chainWriteCompleted) throw new AnchorPersistenceError(error);
    throw error;
  }
}

/** Restore unanchored receipt leaves after a process restart. */
export async function queueUnanchoredReceipts(
  store: StorePort,
  window: AnchorWindow,
  queued: Set<string>,
): Promise<void> {
  for (const receipt of await store.listUnanchoredReceipts()) {
    if (queued.has(receipt.verdictId)) continue;
    window.add(receipt.payload);
    queued.add(receipt.verdictId);
  }
}
