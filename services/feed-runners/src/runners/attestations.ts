import { SchemaId } from "@mochi/core";
import type { FeedsConfig } from "../config.ts";
import type { FeedJob, RunnerState } from "../ports.ts";
import { alreadyDone, makeJob, subjectKey, weeklySlot } from "./common.ts";

export function planAttestations(config: FeedsConfig["attestations"], now: number, state: RunnerState, options: { weekday?: number; force?: boolean } = {}): FeedJob[] {
  if (!options.force && new Date(now).getUTCDay() !== (options.weekday ?? 1)) return [];
  const week = weeklySlot(now);
  const reserves = config.reserves.flatMap(({ assetSymbol, url }) => {
    const id = `attestations:${week}:reserve:${url}`;
    return alreadyDone(state, id) ? [] : [makeJob({ runner: "attestations", id, schemaId: SchemaId.RESERVE_ATTESTATION, n: 5, feedName: "attestations.reserve@RHC", key: subjectKey(assetSymbol), url, params: {} })];
  });
  const navs = config.navs.flatMap(({ fundId, url }) => {
    const id = `attestations:${week}:nav:${url}`;
    return alreadyDone(state, id) ? [] : [makeJob({ runner: "attestations", id, schemaId: SchemaId.NAV, n: 5, feedName: "attestations.nav@RHC", key: subjectKey(fundId), url, params: {} })];
  });
  return [...reserves, ...navs];
}
