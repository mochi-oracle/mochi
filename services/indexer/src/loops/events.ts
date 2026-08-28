import type { AlertPort, ChainEvent, ChainPort, StorePort } from "../ports.ts";
import { log } from "../log.ts";

export const EVENT_CURSOR = "indexer:events";
export const MAX_BLOCK_RANGE = 2_000n;

const ALERT_EVENTS = new Set(["CrosscheckFailed", "Slashed"]);

/** Poll, persist, and alert on chain events after the saved cursor. */
export async function pollEvents(input: {
  chain: ChainPort;
  store: StorePort;
  alert: AlertPort;
  alertUrl?: string;
}): Promise<number> {
  const { chain, store } = input;
  const cursor = await store.getCursor(EVENT_CURSOR);
  const firstBlock = cursor === null ? chain.startBlock : cursor + 1n;
  const latestBlock = await chain.latestBlock();
  if (firstBlock > latestBlock) return 0;

  let processedCount = 0;
  for (let rangeStart = firstBlock; rangeStart <= latestBlock;) {
    const rangeEnd = rangeStart + MAX_BLOCK_RANGE - 1n < latestBlock
      ? rangeStart + MAX_BLOCK_RANGE - 1n
      : latestBlock;
    const events = await chain.events(rangeStart, rangeEnd);
    events.sort(compareEvents);

    for (const event of events) {
      // One malformed event must not halt indexing of everything after it (poison pill): log it and continue.
      try {
        event.args = { ...event.args, ...await chain.eventSnapshot(event) };
        await store.applyEvent(event);
      } catch (error) {
        log("error", "indexer_event_failed", {
          event: event.name,
          block: String(event.blockNumber ?? ""),
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
        continue;
      }
      if (event.name === "QueryOpened") {
        const query = event.args.query as Record<string, unknown> | undefined;
        const payer = query?.payer;
        if (typeof payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(payer)) {
          await store.setQueryPayer(String(event.args.queryId), payer.toLowerCase());
        }
      }
      if (ALERT_EVENTS.has(event.name) && input.alertUrl) {
        await deliverAlert(input.alert, input.alertUrl, event);
      }
      processedCount++;
    }

    await store.setCursor(EVENT_CURSOR, rangeEnd);
    rangeStart = rangeEnd + 1n;
  }
  return processedCount;
}

/** Sort events by block and log index. */
function compareEvents(left: ChainEvent, right: ChainEvent): number {
  if (left.blockNumber === right.blockNumber) return left.logIndex - right.logIndex;
  return left.blockNumber < right.blockNumber ? -1 : 1;
}

/** Send a best-effort webhook without including request or document data. */
async function deliverAlert(
  alert: AlertPort,
  url: string,
  event: ChainEvent,
): Promise<void> {
  const payload = {
    type: event.name,
    block: event.blockNumber.toString(),
    transaction_hash: event.transactionHash,
    args: event.args,
    occurred_at: event.timestamp.toISOString(),
  };
  try {
    await alert.post(url, payload, 5_000);
  } catch (error) {
    log("warn", "alert_delivery_failed", {
      type: event.name,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
