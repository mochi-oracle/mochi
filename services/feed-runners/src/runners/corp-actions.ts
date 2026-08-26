import { SchemaId } from "@mochi/core";
import type { FeedsConfig } from "../config.ts";
import type { RunnerState, FeedJob } from "../ports.ts";
import { alreadyDone, makeJob, subjectKey, utcDay } from "./common.ts";

export function planCorpActions(config: FeedsConfig["corp-actions"], now: number, state: RunnerState, options: { utcHour?: number; force?: boolean } = {}): FeedJob[] {
  const date = new Date(now);
  // `force` (admin "run now") skips the schedule gate; the per-day dedupe still applies.
  if (!options.force && date.getUTCHours() < (options.utcHour ?? 13)) return [];
  const day = utcDay(now);
  return config.tokens.flatMap(({ ticker, noticeUrls }) => noticeUrls.flatMap(({ url, kind }) => {
    const schemaId = kind === "EX_DIVIDEND" ? SchemaId.EX_DIVIDEND : SchemaId.SPLIT;
    const feedName = kind === "EX_DIVIDEND" ? "corp-actions.exdiv@RHC" : "corp-actions.split@RHC";
    const id = `corp-actions:${day}:${url}`;
    return alreadyDone(state, id) ? [] : [makeJob({ runner: "corp-actions", id, schemaId, n: 3, feedName, key: subjectKey(ticker.toUpperCase()), url, params: kind === "EX_DIVIDEND" ? { multiplier_token: true } : {} })];
  }));
}
