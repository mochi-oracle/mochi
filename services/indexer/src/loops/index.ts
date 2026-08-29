import { AnchorWindow } from "@mochi/receipts";
import type { IndexerDeps } from "../ports.ts";
import { log } from "../log.ts";
import { flushAnchors, queueUnanchoredReceipts, AnchorPersistenceError } from "./anchors.ts";
import { pollEvents } from "./events.ts";
import { buildMissingReceipts } from "./receipts.ts";
import { purgePrivateResults } from "./purge.ts";

export interface LoopHandles {
  runOnce(): Promise<void>;
  start(pollMilliseconds: number, purgeIntervalMilliseconds?: number): () => void;
}

/** Create polling and receipt-anchor loop handles. */
export function createIndexerLoops(deps: IndexerDeps): LoopHandles {
  const clock = deps.clock ?? {
    now: () => new Date(),
    sleep: (milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  };
  const anchorWindow = new AnchorWindow({ now: clock.now().getTime() });
  const queuedReceiptIds = new Set<string>();
  let stopped = false;

  async function runOnce(): Promise<void> {
    try {
      await pollEvents(deps);
      await buildMissingReceipts(deps.chain, deps.store, deps.signer);
      await queueUnanchoredReceipts(deps.store, anchorWindow, queuedReceiptIds);
    } catch (error) {
      log("error", "indexer_loop_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }

    try {
      if (await flushAnchors(deps.chain, deps.store, anchorWindow, clock.now())) {
        queuedReceiptIds.clear();
      }
    } catch (error) {
      if (error instanceof AnchorPersistenceError) queuedReceiptIds.clear();
      log("error", "anchor_loop_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    runOnce,
    start(pollMilliseconds, purgeIntervalMilliseconds = 3_600_000) {
      stopped = false;
      void (async () => {
        while (!stopped) {
          await runOnce();
          if (!stopped) await clock.sleep(pollMilliseconds);
        }
      })();
      void (async () => {
        while (!stopped) {
          try {
            await purgePrivateResults(deps.store, clock.now());
          } catch (error) {
            log("error", "private_result_purge_failed", {
              error: error instanceof Error ? error.message : "unknown",
            });
          }
          if (!stopped) await clock.sleep(purgeIntervalMilliseconds);
        }
      })();
      return () => {
        stopped = true;
      };
    },
  };
}
