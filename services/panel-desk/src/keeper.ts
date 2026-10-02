import { BaseError, ContractFunctionRevertedError, keccak256, toFunctionSelector, type Hex } from "viem";
import { PANEL_ROUND, verdictId } from "@mochi/core";
import type { PanelDeps } from "./ports.ts";
import { ensureBeacon } from "@mochi/chain";
import { log } from "./log.ts";

const ZERO32 = `0x${"00".repeat(32)}`;
/** Feeds.update reverts that no retry of the same verdict can fix: it is already the feed's value, a newer verdict for
 *  the same asOf is (StaleCorrection), the feed has moved to a later asOf, the asOf lies further past the verdict's own
 *  on-chain time than the feed's lead allows (AsOfTooFarAhead: the bound is verdict.ts + maxLead, so waiting never
 *  admits it), or the verdict was barred from the feed (cleared by governance or replaced in a same-second tie). */
const SETTLED_FEED_ERRORS = ["VerdictAlreadyApplied", "StaleCorrection", "StaleAsOf", "AsOfTooFarAhead", "VerdictBarred"] as const;
const FEED_ERROR_SIGNATURES: Record<string, string> = {
  VerdictAlreadyApplied: "VerdictAlreadyApplied(bytes32)", StaleCorrection: "StaleCorrection(uint64,uint64)",
  StaleAsOf: "StaleAsOf(uint64,uint64)", AsOfTooFarAhead: "AsOfTooFarAhead(uint64,uint64)", VerdictBarred: "VerdictBarred(bytes32)",
};
/** A draw tries a bounded number of positions per call and keeps its progress; the keeper continues it this many times
 *  per tick (each call is its own transaction). */
const MAX_DRAW_CALLS_PER_TICK = 8;
/** Kept pool positions examined per prune transaction. */
const PRUNE_BATCH = 64n;
const DRAWING = 1, FINAL = 7, DRAW_EXPIRED = 8;

export type FeedRejection = { name: string; args: readonly unknown[] };
/** The Feeds.update custom error behind a failed write (decoded by viem, or found by name/selector in the message). */
export function feedRejection(error: unknown): FeedRejection | null {
  const names = [...SETTLED_FEED_ERRORS] as string[];
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    if (name && names.includes(name)) return { name, args: reverted.data?.args ?? [] };
  }
  const message = String((error as Error)?.message ?? error);
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(message) || message.includes(toFunctionSelector(FEED_ERROR_SIGNATURES[name]!))) return { name, args: [] };
  }
  return null;
}

export class PanelKeeper {
  /** Open cases, plus FINAL cases whose feed update is still to do. Terminal cases leave the set (an escalation
   *  again after DRAW_EXPIRED emits a new event and brings the case back), so a tick only reads live cases. */
  private readonly cases = new Set<Hex>();
  private cursor: bigint | null = null;
  private rebuilt = false;
  constructor(private readonly deps: PanelDeps) {}

  /** Cases the keeper still reads each tick. */
  get openCases(): number { return this.cases.size; }

  async tick(): Promise<void> {
    await this.indexEvents();
    const [block, now] = await Promise.all([this.deps.chain.blockNumber(), this.deps.chain.timestamp()]);
    for (const caseId of [...this.cases]) {
      try { if (await this.advance(caseId, block, now)) this.done(caseId); }
      catch (error) { log("warn", "panel_keeper_action_failed", { caseId, error: error instanceof Error ? error.name : "unknown" }); }
    }
    try { await this.pruneIfUseful(); }
    catch (error) { log("warn", "panel_keeper_prune_failed", { error: error instanceof Error ? error.name : "unknown" }); }
  }

  /** Removes kept pool positions that no pending draw can pick (prune is permissionless and safe at any time). */
  private async pruneIfUseful() {
    if (await this.deps.chain.simulatePrune(PRUNE_BATCH) === 0n) return;
    await this.deps.chain.prune(PRUNE_BATCH);
  }

  private done(caseId: Hex) {
    this.cases.delete(caseId);
  }

  async run(): Promise<void> {
    while (true) {
      try { await this.tick(); }
      catch (error) { log("error", "panel_keeper_tick_failed", { error: error instanceof Error ? error.name : "unknown" }); }
      await this.deps.clock.sleep(this.deps.config.pollMs);
    }
  }

  private async indexEvents() {
    if (this.cursor === null) this.cursor = await this.deps.store.getCursor("panel-desk");
    const head = await this.deps.chain.blockNumber();
    const start = BigInt(this.deps.chain.dep.startBlock);
    // The cursor is only an indexing position. Replay historical events on startup to rebuild the open-case set.
    if (!this.rebuilt) {
      let from = start;
      const stop = this.cursor ?? head;
      while (from <= stop) {
        const to = stop < from + 1999n ? stop : from + 1999n;
        for (const id of await this.deps.chain.getPanelEvents(from, to)) this.cases.add(id.toLowerCase() as Hex);
        from = to + 1n;
      }
      this.rebuilt = true;
      if (this.cursor === null) this.cursor = start - 1n;
    }
    if (this.cursor === null) this.cursor = start - 1n;
    const from = this.cursor + 1n;
    if (head < from) return;
    const to = head < from + 1999n ? head : from + 1999n;
    const found = await this.deps.chain.getPanelEvents(from, to);
    for (const caseId of found) this.cases.add(caseId.toLowerCase() as Hex);
    await this.deps.store.setCursor("panel-desk", to);
    this.cursor = to;
  }

  /** Advances one case; true when the keeper has nothing more to do for it. */
  private async advance(caseId: Hex, block: bigint, now: bigint): Promise<boolean> {
    const panel = await this.deps.chain.getCase(caseId);
    if (panel.status === 0) return false;
    if (panel.status === DRAW_EXPIRED) return true;
    if (panel.status === DRAWING) {
      // Don't compare `block` with sealBlock: on Arbitrum chains (Robinhood Chain) block.number inside contracts is
      // the L1 block number while eth_blockNumber is the L2 number. Try to draw and classify the randomness error.
      void block;
      const draw = await this.deps.chain.drawState(caseId);
      // Past its expiry, or impossible from the seal (fewer than three eligible), the draw only ends: expireDraw
      // refunds the first panel or lapses the appeal once the draw deadline passed, without needing a seed.
      if (now > draw.expiry || draw.eligible < 3) {
        if (now > panel.drawDeadline) await this.deps.chain.expireDraw(caseId);
        return false;
      }
      if (this.deps.chain.dep.randomness?.kind === "drand") {
        if (!this.deps.drand) throw new Error("drand deployment requires a DrandClient");
        if (await ensureBeacon(this.deps.chain.beaconChain, this.deps.chain.dep.contracts.randomness, panel.sealBlock, this.deps.drand) === "not-published") return false;
      }
      // A draw over many ineligible positions spans several calls; each continues where the last stopped. Past the
      // draw deadline expireDraw does the same (it only ends a draw that can no longer seat a panel).
      for (let call = 0; call < MAX_DRAW_CALLS_PER_TICK; call++) {
        if (now > panel.drawDeadline) {
          await this.deps.chain.expireDraw(caseId);
        } else {
          try {
            await this.deps.chain.draw(caseId);
          } catch (error) {
            const message = String((error as Error)?.message ?? error);
            if (/SeedNotReady|0x484e3916/.test(message)) return false; // wait for the seal block
            if (/SeedWindowMissed|0x76a607dd/.test(message)) { await this.deps.chain.reseal(caseId); return false; }
            throw error;
          }
        }
        if ((await this.deps.chain.getCase(caseId)).status !== DRAWING) break;
      }
      return false;
    }
    if (panel.status === 2 || panel.status === 3) {
      if (now > panel.revealDeadline || await this.deps.chain.simulateResolve(caseId)) await this.deps.chain.resolve(caseId);
      return false;
    }
    const canFinalize = (panel.status === 4 && panel.panelIndex === 0 && now > panel.appealDeadline)
      || ((panel.status === 4 || panel.status === 5) && panel.panelIndex === 1)
      || (panel.status === 5 && panel.panelIndex === 0);
    if (canFinalize) {
      await this.deps.chain.finalize(caseId);
      return false;
    }
    if (panel.status === FINAL) return this.updateFeedIfPosted(caseId, panel.queryId, panel.outcomePayloadHash);
    return false;
  }

  /** Pushes a FINAL panel verdict into its feed; true once there is nothing left to do for the case. */
  private async updateFeedIfPosted(caseId: Hex, queryId: Hex, outcomePayloadHash: Hex): Promise<boolean> {
    // A final HUNG posts nothing.
    if (outcomePayloadHash.toLowerCase() === ZERO32) return true;
    const query = await this.deps.chain.getQuery(queryId);
    // Feeds are public; a private outcome is a salted hash that no stored payload is matched against.
    if (!query.isPublic) return true;
    const panelVerdictId = verdictId(queryId, PANEL_ROUND);
    if (query.status !== 3 || (await this.deps.chain.latestVerdictOf(queryId)).toLowerCase() !== panelVerdictId.toLowerCase()) return true;
    const feedQuery = await this.deps.store.getFeedQuery(queryId);
    if (!feedQuery) return true;
    const current = await this.deps.chain.feedLatest(feedQuery.feedId as Hex, feedQuery.key as Hex);
    if (current && current.verdictId.toLowerCase() === panelVerdictId.toLowerCase()) return true;
    const record = await this.deps.store.getPanelPayloadByHash(caseId, outcomePayloadHash);
    if (!record || keccak256(record.payload).toLowerCase() !== outcomePayloadHash.toLowerCase()) {
      // Evaluators submit the public payload after their reveal; retried next tick.
      log("warn", "panel_payload_missing", { caseId, payloadHash: outcomePayloadHash });
      return false;
    }
    try {
      await this.deps.chain.feedsUpdate(feedQuery.feedId as Hex, feedQuery.key as Hex, panelVerdictId, `0x${Buffer.from(record.payload).toString("hex")}` as Hex);
    } catch (error) {
      const rejection = feedRejection(error);
      if (!rejection) throw error; // RPC or other failure: retried next tick
      // Content-free: ids and the error name only, never the payload or its decoded values.
      log("warn", "panel_feed_update_rejected", { caseId, verdictId: panelVerdictId, reason: rejection.name });
      return true;
    }
    log("info", "panel_feed_updated", { caseId, verdictId: panelVerdictId });
    return true;
  }
}
