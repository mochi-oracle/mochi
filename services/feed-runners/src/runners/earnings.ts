import { SchemaId } from "@mochi/core";
import type { FeedsConfig } from "../config.ts";
import type { RunnerState, FeedJob } from "../ports.ts";
import { alreadyDone, makeJob, subjectKey } from "./common.ts";

export function planEarnings(config: FeedsConfig["earnings"], now: number, state: RunnerState): FeedJob[] {
  return config.releases.flatMap((release) => {
    const start = Date.parse(release.releaseAt);
    if (!Number.isFinite(start) || now < start || now >= start + 30 * 60_000) return [];
    const id = `earnings:${release.ticker.toUpperCase()}:${release.releaseAt}:${release.url}`;
    if (alreadyDone(state, id)) return [];
    const params: Record<string, unknown> = {};
    if (release.consensus_eps !== undefined) params.consensus_eps = release.consensus_eps;
    if (release.consensus_revenue !== undefined) params.consensus_revenue = release.consensus_revenue;
    if (release.consensus_eps_basis !== undefined) params.consensus_eps_basis = release.consensus_eps_basis;
    return [makeJob({ runner: "earnings", id, schemaId: SchemaId.EARNINGS, n: 7, feedName: "earnings@RHC", key: subjectKey(release.ticker.toUpperCase()), url: release.url, params })];
  });
}
