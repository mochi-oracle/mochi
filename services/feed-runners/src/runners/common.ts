import { keccak256, toBytes, type Hex } from "viem";
import { toBytes32String, type SchemaId } from "@mochi/core";
import type { FeedJob, RunnerName, RunnerState } from "../ports.ts";

export function subjectKey(value: string): Hex {
  return new TextEncoder().encode(value).length > 32 ? keccak256(toBytes(value)) : toBytes32String(value);
}
export function makeJob(input: Omit<FeedJob, "id"> & { id?: string }): FeedJob {
  return { ...input, id: input.id ?? `${input.runner}:${input.feedName}:${input.key}:${input.url}` };
}
export function utcDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }
export function weeklySlot(now: number): string {
  const date = new Date(now); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); return date.toISOString().slice(0, 10);
}
export function alreadyDone(state: RunnerState, id: string): boolean { return state.completed.includes(id); }
export type { RunnerState } from "../ports.ts";
export type Planner = (config: unknown, now: number, state: RunnerState, options?: Record<string, number>) => FeedJob[];
