import { keccak256, type Hex } from "viem";
import { PANEL_ROUND, verdictId } from "@mochi/core";
import type { PanelDeps } from "./ports.ts";
import { ensureBeacon } from "@mochi/chain";
import { log } from "./log.ts";

const ZERO32 = `0x${"00".repeat(32)}`;
export class PanelKeeper {
  private readonly cases = new Set<Hex>();
  private cursor: bigint | null = null;
  private rebuilt = false;
  constructor(private readonly deps: PanelDeps) {}

  async tick(): Promise<void> {
    await this.indexEvents();
    const [block, now] = await Promise.all([this.deps.chain.blockNumber(), this.deps.chain.timestamp()]);
    for (const caseId of this.cases) {
      try { await this.advance(caseId, block, now); }
      catch (error) { log("warn", "panel_keeper_action_failed", { caseId, error: error instanceof Error ? error.name : "unknown" }); }
    }
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

  private async advance(caseId: Hex, block: bigint, now: bigint) {
    const panel = await this.deps.chain.getCase(caseId);
    if (panel.status === 0) return;
    if (panel.status === 1) {
      // Don't compare `block` with sealBlock: on Arbitrum chains (Robinhood Chain) block.number inside contracts is
      // the L1 block number while eth_blockNumber is the L2 number. Try to draw and classify the randomness error.
      void block;
      if (this.deps.chain.dep.randomness?.kind === "drand") {
        if (!this.deps.drand) throw new Error("drand deployment requires a DrandClient");
        if (await ensureBeacon(this.deps.chain.beaconChain, this.deps.chain.dep.contracts.randomness, panel.sealBlock, this.deps.drand) === "not-published") return;
      }
      try {
        await this.deps.chain.draw(caseId);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/SeedNotReady|0x484e3916/.test(message)) return; // wait for the seal block
        if (/SeedWindowMissed|0x76a607dd/.test(message)) { await this.deps.chain.reseal(caseId); return; }
        throw error;
      }
      return;
    }
    if (panel.status === 2 || panel.status === 3) {
      if (now > panel.revealDeadline || await this.deps.chain.simulateResolve(caseId)) await this.deps.chain.resolve(caseId);
      return;
    }
    const canFinalize = (panel.status === 4 && panel.panelIndex === 0 && now > panel.appealDeadline)
      || ((panel.status === 4 || panel.status === 5) && panel.panelIndex === 1)
      || (panel.status === 5 && panel.panelIndex === 0);
    if (canFinalize) {
      await this.deps.chain.finalize(caseId);
      return;
    }
    if (panel.status === 7) await this.updateFeedIfPosted(caseId, panel.queryId, panel.outcomePayloadHash);
  }

  private async updateFeedIfPosted(caseId: Hex, queryId: Hex, outcomePayloadHash: Hex) {
    const query = await this.deps.chain.getQuery(queryId);
    const panelVerdictId = verdictId(queryId, PANEL_ROUND);
    if (query.status !== 3 || (await this.deps.chain.latestVerdictOf(queryId)).toLowerCase() !== panelVerdictId.toLowerCase()) return;
    const feedQuery = await this.deps.store.getFeedQuery(queryId);
    if (!feedQuery) return;
    const current = await this.deps.chain.feedLatest(feedQuery.feedId as Hex, feedQuery.key as Hex);
    if (current && current.verdictId.toLowerCase() === panelVerdictId.toLowerCase()) return;
    if (outcomePayloadHash.toLowerCase() === ZERO32) {
      log("warn", "panel_payload_missing", { caseId, payloadHash: outcomePayloadHash });
      return;
    }
    const record = await this.deps.store.getPanelPayloadByHash(caseId, outcomePayloadHash);
    if (!record || keccak256(record.payload).toLowerCase() !== outcomePayloadHash.toLowerCase()) {
      log("warn", "panel_payload_missing", { caseId, payloadHash: outcomePayloadHash });
      return;
    }
    await this.deps.chain.feedsUpdate(feedQuery.feedId as Hex, feedQuery.key as Hex, panelVerdictId, `0x${Buffer.from(record.payload).toString("hex")}` as Hex);
    log("info", "panel_feed_updated", { caseId, verdictId: panelVerdictId });
  }
}
