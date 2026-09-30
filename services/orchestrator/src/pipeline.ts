import { QueryStatus, VerdictStatus } from "@mochi/core";
import { decodePayload } from "@mochi/schemas";
import { hexToBytes, type Address, type Hex } from "viem";
import type { DecisionRes, Peer } from "@mochi/protocol";
import type { OrchestratorDeps, QueryLog } from "./ports.ts";
import { ensureBeacon } from "@mochi/chain";
import { log } from "./log.ts";

const errorStatus = (e: unknown) => (e as { status?: number })?.status ?? (e as { cause?: { status?: number } })?.cause?.status;
// IRandomness errors bubble up from the randomness contract, so match either the decoded name or the raw selector.
const hasSeedWindowMissed = (e: unknown) => /SeedWindowMissed|0x76a607dd/.test(String((e as Error)?.message ?? e));
const hasSeedNotReady = (e: unknown) => /SeedNotReady|0x484e3916/.test(String((e as Error)?.message ?? e));
export class Orchestrator {
  private cursor: bigint;
  private readonly locks = new Set<Hex>();
  private lastBlock = 0n;
  constructor(private readonly deps: OrchestratorDeps) { this.cursor = BigInt(deps.chain.dep.startBlock); }
  get lastBlockProcessed() { return this.lastBlock.toString(); }

  async tick(): Promise<void> {
    const { chain, store } = this.deps;
    this.cursor = (await store.getCursor("orchestrator")) ?? this.cursor;
    if (this.cursor > 0n) this.lastBlock = this.cursor - 1n;
    const head = await chain.blockNumber();
    if (head >= this.cursor) {
      const logs = await chain.getLogs(this.cursor, head);
      for (const log of logs) await this.discover(log);
      this.cursor = head + 1n; this.lastBlock = head;
      await store.setCursor("orchestrator", this.cursor);
    }
    const ids = await store.queryIds();
    let index = 0;
    const workers = Array.from({ length: Math.min(this.deps.config.maxParallelQueries, ids.length) }, async () => {
      while (index < ids.length) { const id = ids[index++]!; await this.advance(id).catch((error: unknown) => log("error", "orchestrator.advance_failed", { queryId: id, error: String((error as Error)?.message ?? error).slice(0, 300) })); }
    });
    await Promise.all(workers);
  }

  private async discover(log: QueryLog) {
    const q = await this.deps.chain.getQuery(log.queryId);
    await this.deps.store.insertQuery({ ...q, id: log.queryId, ts: new Date(Number(q.openedAt) * 1000) });
  }

  async advance(queryId: Hex): Promise<void> {
    if (this.locks.has(queryId)) return;
    this.locks.add(queryId);
    try { await this.advanceLocked(queryId); } finally { this.locks.delete(queryId); }
  }

  private async advanceLocked(id: Hex): Promise<void> {
    const { chain, store, clock, config } = this.deps;
    let q = await chain.getQuery(id);
    // Crash recovery: a verdict may have been posted on-chain without the orchestrator persisting the decision (or
    // doing the feed update). The consensus enclave returns the stored decision for the round on a repeated close.
    if (q.status === QueryStatus.DECIDED || q.status === QueryStatus.HUNG) await this.recoverPosted(id, q);
    if (q.status === QueryStatus.DECIDED || q.status === QueryStatus.EXPIRED || q.status === QueryStatus.ESCALATED) {
      await store.updateQueryStatus(id, q.status);
      return;
    }
    // Deadlines are on-chain time: compare with the latest block's timestamp, not this machine's clock.
    if ((q.status === QueryStatus.OPEN || q.status === QueryStatus.SEALED) && (await chain.latestTimestamp()) > q.deadline) {
      await chain.expire(id); await store.updateQueryStatus(id, QueryStatus.EXPIRED); return;
    }
    if (q.status === QueryStatus.OPEN) {
      // Don't compare block numbers here: on Arbitrum chains (Robinhood Chain) block.number inside contracts is the L1
      // block number while eth_blockNumber is the L2 number. Let the randomness contract decide.
      if (chain.dep.randomness?.kind === "drand") {
        if (!this.deps.drand) throw new Error("drand deployment requires a DrandClient");
        if (await ensureBeacon(chain as never, chain.dep.contracts.randomness, q.sealBlock, this.deps.drand) === "not-published") return;
      }
      try { await chain.seal(id); }
      catch (error) {
        if (hasSeedNotReady(error)) return; // retry next tick
        if (!hasSeedWindowMissed(error)) throw error;
        await chain.reseal(id);
        return;
      }
      q = await chain.getQuery(id);
    }
    if (q.status === QueryStatus.HUNG) {
      const feed = await store.getFeedQuery(id);
      if (!feed) return;
      if (q.n < 9) { await chain.expand(id, q.n === 3 ? 5 : q.n === 5 ? 7 : 9); return; }
      const fee = await chain.panelFee(); await chain.usdgApprove(chain.dep.contracts.panel, fee); await chain.escalate(id); return;
    }
    if (q.status !== QueryStatus.SEALED) return;

    const seats = await chain.jurorsOf(id), prevN = await chain.prevNOf(id);
    const consensusDoc = await this.deps.consensus.attestation(config.consensusUrl);
    const intakeDoc = await this.deps.intake.attestation(config.intakeUrl);
    if (consensusDoc.role !== "CONSENSUS" || intakeDoc.role !== "INTAKE") throw new Error("unexpected enclave role");
    const consensusPeer: Peer = { address: consensusDoc.address, encryptionPubKey: consensusDoc.encryptionPubKey, quote: consensusDoc.quote };
    const jurorPeers = await Promise.all(seats.slice(prevN, q.n).map(async (address, offset) => {
      const url = await this.deps.directory.urlOf(address); if (!url) throw new Error("juror endpoint missing");
      const doc = await this.deps.juror.attestation(url);
      if (doc.role !== "JUROR" || doc.address.toLowerCase() !== address.toLowerCase()) throw new Error("juror attestation identity mismatch");
      return { address: doc.address, encryptionPubKey: doc.encryptionPubKey, quote: doc.quote, seat: prevN + offset };
    }));
    const dispatch = await this.deps.intake.dispatch(config.intakeUrl, { queryId: id, jurors: jurorPeers, consensus: consensusPeer });
    for (const item of dispatch.jurors) if (item.address.toLowerCase() !== seats[item.seat]?.toLowerCase()) throw new Error("intake returned an unselected juror");
    const payerResultPubKey = q.isPublic ? undefined : (await store.getPayerResultKey(q.payerCommit)) ?? undefined;
    const { deadlineMs } = await this.deps.consensus.open(config.consensusUrl, { queryId: id, round: q.round, consensusSeed: dispatch.consensusSeed, ...(payerResultPubKey ? { payerResultPubKey } : {}) });
    await Promise.all(dispatch.jurors.map(async ({ seat, docEnvelope }) => {
      const jurorAddress = seats[seat]!;
      const url = await this.deps.directory.urlOf(jurorAddress); if (!url) return;
      try {
        const answer = await this.withTimeout((signal) => this.deps.juror.answer(url, { queryId: id, seat, docEnvelope, consensus: consensusPeer, consensusUrl: config.consensusUrl, round: q.round, deadlineMs }, signal), Math.max(1, Math.min(config.jurorTimeoutMs, deadlineMs + 5000 - clock.now())));
        const vote = answer.vote, juror = await chain.getJuror(jurorAddress);
        await store.insertJurorAnswer({ queryId: id, round: q.round, seat, juror: vote.juror as Address, class: juror.jurorClass, answerHash: vote.answerHash as Hex, spansRoot: vote.spansRoot as Hex, quoteHash: vote.quoteHash as Hex, sig: hexToBytes(vote.sig as Hex), timedOut: vote.sig === "0x", ts: new Date(clock.now()) });
      } catch { /* consensus records missing seats as timeouts */ }
    }));
    const closeDeadline = Math.min(deadlineMs + 5000, clock.now() + config.closeMaxWaitMs); let decision: DecisionRes;
    for (;;) {
      try { decision = await this.deps.consensus.close(config.consensusUrl, id, Math.max(1, closeDeadline - clock.now())); break; }
      catch (error) {
        if (errorStatus(error) !== 409 || clock.now() >= closeDeadline) throw error;
        await clock.sleep(Math.min(1000, closeDeadline - clock.now()));
      }
    }
    const tx = await chain.post({ ...decision.verdictInput, queryId: decision.verdictInput.queryId as Hex, answerHash: decision.verdictInput.answerHash as Hex, payloadHash: decision.verdictInput.payloadHash as Hex, evidenceRoot: decision.verdictInput.evidenceRoot as Hex, round: Number(decision.verdictInput.round), status: decision.verdictInput.status }, decision.votes.map(v => ({ juror: v.juror as Address, answerHash: v.answerHash as Hex, spansRoot: v.spansRoot as Hex, quoteHash: v.quoteHash as Hex, sig: v.sig as Hex })), decision.consensusSig as Hex);
    await this.persistDecision(id, q, decision, tx);
  }

  private async recoverPosted(id: Hex, q: Awaited<ReturnType<OrchestratorDeps["chain"]["getQuery"]>>): Promise<void> {
    const { chain, store, config } = this.deps;
    const verdictId = await chain.latestVerdictOf(id);
    if (/^0x0+$/.test(verdictId) || (await store.hasVerdict(verdictId))) return;
    const onchain = await chain.getVerdict(verdictId);
    if (Number(onchain.round) !== q.round || onchain.escalated) return; // panel verdicts are not consensus decisions
    const tx = await chain.verdictTx(verdictId);
    if (!tx) return;
    const decision = await this.deps.consensus.close(config.consensusUrl, id);
    if (decision.verdictId !== verdictId) return;
    log("warn", "orchestrator.recovered_decision", { queryId: id, verdictId });
    await this.persistDecision(id, q, decision, tx);
  }

  private async persistDecision(id: Hex, q: Awaited<ReturnType<OrchestratorDeps["chain"]["getQuery"]>>, decision: DecisionRes, tx: Hex): Promise<void> {
    const { chain, store, clock } = this.deps;
    const verdict = await chain.getVerdict(decision.verdictId as Hex);
    const publicPart = q.isPublic && decision.public ? {
      answer: JSON.parse(decision.public.answerJson) as unknown,
      payload: hexToBytes(decision.public.payload as Hex),
      dissent: Object.fromEntries(decision.public.fields.map(f => [f.field, f.dissent])),
      fieldAgreement: decision.public.fields.map(({ field, required, agreeBps, hung }) => ({ field, required, agreeBps, hung })),
    } : undefined;
    // ts = on-chain verdict time, so the indexer's chain-only insert and this one share the (id, ts) key (idempotent).
    await store.insertVerdict({ id: decision.verdictId, ts: new Date(Number(verdict.ts) * 1000), queryId: id, round: q.round, status: decision.verdictInput.status, agreementBps: decision.verdictInput.agreementBps, dissentMask: BigInt(decision.verdictInput.dissentMask), timeoutMask: BigInt(decision.verdictInput.timeoutMask), evidenceRoot: decision.verdictInput.evidenceRoot, attestationRoot: verdict.attestationRoot, answerHash: decision.verdictInput.answerHash, payloadHash: decision.verdictInput.payloadHash, isPublic: q.isPublic, escalated: false, tx }, publicPart);
    if (!q.isPublic && decision.privateResult) await store.storePrivateResult(decision.verdictId as Hex, new TextEncoder().encode(JSON.stringify(decision.privateResult)));
    if (decision.verdictInput.status === VerdictStatus.VERDICT && publicPart) {
      const feed = await store.getFeedQuery(id);
      if (feed) {
        const payload = decision.public!.payload as Hex;
        // Schema-specific payload decoding verifies that the relayed payload is a valid typed feed payload.
        decodePayload(q.schemaId, payload as Hex);
        try { await chain.feedsUpdate(feed.feedId, feed.key, decision.verdictId as Hex, payload); } catch { /* crosscheck failure is indexed on-chain */ }
      }
    }
    // Terminal DB status last: until it is written, a restart re-runs (idempotent) persistence and the feed update.
    await store.updateQueryStatus(id, decision.verdictInput.status === VerdictStatus.VERDICT ? QueryStatus.DECIDED : QueryStatus.HUNG);
  }

  private async withTimeout<T>(action: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([action(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("juror timeout")); }, ms); })]); }
    finally { clearTimeout(timer!); controller.abort(); }
  }
}
