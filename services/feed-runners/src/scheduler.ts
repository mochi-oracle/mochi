import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServiceConfig, FeedsConfig } from "./config.ts";
import type { RunnerName, FeedJob, StockTokenReader, EdgarHttp } from "./ports.ts";
import type { RunnerState } from "./runners/common.ts";
import { planCorpActions } from "./runners/corp-actions.ts";
import { planEarnings } from "./runners/earnings.ts";
import { planAttestations } from "./runners/attestations.ts";
import { makeEdgarJob, parseEdgarAtom, selectPressRelease } from "./runners/edgar.ts";
import { FeedQueryExecutor, IntakeHttpError } from "./execute.ts";
import { log } from "./log.ts";
import { SchemaId } from "@mochi/core";
import { subjectKey } from "./runners/common.ts";
import { failureReason } from "./observation.ts";

const RUNNERS: RunnerName[] = ["corp-actions", "earnings", "attestations"];
/** A multiplier change that took effect longer ago than this is history, not news. */
const STALE_MULTIPLIER_MS = 7 * 86_400_000;
/** observeMultiplier backoff after a failure (a revert fails the same way on every poll): 5 min, doubling, capped at 6 h. */
const OBSERVE_BACKOFF_BASE_MS = 5 * 60_000;
const OBSERVE_BACKOFF_MAX_MS = 6 * 3_600_000;
export class FeedScheduler {
  private state: RunnerState = { completed: [], multiplierPairs: {}, edgarSeen: [] };
  private running = false;
  private loop?: Promise<void>;
  private readonly outcomes: Record<RunnerName, { lastRunAt?: string; lastError?: string; lastJobs: number }> = {
    "corp-actions": { lastJobs: 0 }, earnings: { lastJobs: 0 }, attestations: { lastJobs: 0 },
  };
  private lastMultiplierPoll = 0;
  /** Per-ticker observeMultiplier backoff (in memory: a restart retries once, then backs off again). */
  private readonly observeRetry = new Map<string, { failures: number; retryAt: number }>();
  private lastEdgarPoll = 0;
  private lastStandardRun = 0;
  constructor(private readonly config: ServiceConfig, private readonly executor: FeedQueryExecutor, private readonly now = () => Date.now(), private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), private readonly stockTokens?: StockTokenReader, private readonly edgar?: EdgarHttp) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.config.stateFile), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.config.stateFile, "utf8")) as RunnerState;
      if (Array.isArray(saved.completed) && saved.completed.every((v) => typeof v === "string")) this.state = { completed: saved.completed,
        multiplierPairs: saved.multiplierPairs && typeof saved.multiplierPairs === "object" ? saved.multiplierPairs : {},
        edgarSeen: Array.isArray(saved.edgarSeen) ? saved.edgarSeen.filter((v): v is string => typeof v === "string") : [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  status() { return { runners: Object.fromEntries(RUNNERS.map((name) => [name, this.outcomes[name]])), completedCount: this.state.completed.length, running: this.running }; }
  private plan(name: RunnerName, now: number, force = false): FeedJob[] {
    const cfg = this.config.feeds as FeedsConfig;
    if (name === "corp-actions") return planCorpActions(cfg["corp-actions"], now, this.state, { utcHour: this.config.CORP_ACTIONS_UTC_HOUR, force });
    if (name === "earnings") return planEarnings(cfg.earnings, now, this.state);
    return planAttestations(cfg.attestations, now, this.state, { weekday: this.config.ATTESTATIONS_WEEKDAY, force });
  }
  /**
   * Runs are serialized: the scheduled loop, an admin trigger and the multiplier/EDGAR watchers can all call run().
   * Running concurrently would plan the same jobs twice before the dedupe state is saved (duplicate feed queries) and
   * send overlapping transactions from one account (nonce collisions).
   */
  private runQueue: Promise<unknown> = Promise.resolve();
  /** Runs `fn` after every previously queued run/watcher pass (one at a time). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.runQueue.then(fn);
    this.runQueue = next.catch(() => undefined);
    return next;
  }
  /** @param force admin "run now": ignore the daily/weekly schedule gate (dedupe still applies). */
  async run(name: RunnerName, force = false): Promise<{ planned: number; completed: number; retried: number }> {
    if (!RUNNERS.includes(name)) throw new Error("unknown runner");
    return this.exclusive(() => this.runExclusive(name, force));
  }
  private async runExclusive(name: RunnerName, force = false): Promise<{ planned: number; completed: number; retried: number }> {
    this.running = true;
    const outcome = this.outcomes[name]; outcome.lastRunAt = new Date(this.now()).toISOString(); outcome.lastError = undefined;
    const jobs = this.plan(name, this.now(), force); outcome.lastJobs = jobs.length;
    let completed = 0, retried = 0;
    try {
      for (const job of jobs) {
        try {
          await this.executor.execute(job);
          this.state.completed.push(job.id); await this.save(); completed++;
        } catch (error) {
          if (job.runner === "earnings" && error instanceof IntakeHttpError && error.status >= 400 && error.status < 500) { retried++; continue; }
          outcome.lastError = error instanceof Error ? error.message : "runner failed";
          log("error", "feed_runner_job_failed", { runner: name, jobId: job.id, error: outcome.lastError });
          retried++;
        }
      }
      await this.save();
      return { planned: jobs.length, completed, retried };
    } finally { this.running = false; }
  }
  async pollMultiplierChanges(): Promise<void> {
    return this.exclusive(() => this.pollMultiplierChangesExclusive());
  }
  private async pollMultiplierChangesExclusive(): Promise<void> {
    if (!this.stockTokens) return;
    for (const token of this.config.feeds["corp-actions"].tokens) {
      const pairKey = token.token.toLowerCase();
      // Every poll, before anything that can skip the ticker: an immediate multiplier change (no pending window) is
      // ratio-checked against the last observation taken before it, and a pending change gets its baseline here too.
      await this.observe(token.ticker.toUpperCase());
      try {
        const schedule = await this.stockTokens.readMultiplierSchedule(token.token);
        if (schedule.newUIMultiplier === 0n || schedule.effectiveAt === 0n) continue;
        const effectiveMs = Number(schedule.effectiveAt) * 1000;
        // Stock Tokens stop exposing the pre-change multiplier once effectiveAt passes, so record it on-chain while the
        // change is pending; a SPLIT feed update posted after the change is then still ratio-checked. observe() above
        // normally records it already; this is the fallback (no transaction once a baseline exists).
        if (effectiveMs > this.now() && this.stockTokens.recordBaseline) {
          try { await this.stockTokens.recordBaseline(subjectKey(token.ticker.toUpperCase()), schedule.effectiveAt); }
          catch (error) { log("error", "multiplier_baseline_record_failed", { ticker: token.ticker, effectiveAt: schedule.effectiveAt.toString(), error: error instanceof Error ? error.message : "record failed" }); }
        }
        // The token keeps its last schedule forever; don't judge a change that took effect long ago (e.g. first start).
        if (effectiveMs < this.now() - STALE_MULTIPLIER_MS) continue;
        const pair = { next: schedule.newUIMultiplier.toString(), effectiveAt: schedule.effectiveAt.toString() };
        const previous = this.state.multiplierPairs?.[pairKey];
        if (previous?.next !== pair.next || previous.effectiveAt !== pair.effectiveAt) {
          this.state.multiplierPairs ??= {};
          this.state.multiplierPairs[pairKey] = pair;
          await this.save();
        }
        for (const notice of token.noticeUrls) {
          const schemaId = notice.kind === "EX_DIVIDEND" ? SchemaId.EX_DIVIDEND : SchemaId.SPLIT;
          const feedName = notice.kind === "EX_DIVIDEND" ? "corp-actions.exdiv@RHC" : "corp-actions.split@RHC";
          const id = `corp-actions:multiplier:${token.ticker.toUpperCase()}:${pair.effectiveAt}:${notice.kind}:${notice.url}`;
          const job: FeedJob = { runner: "corp-actions", id, schemaId, n: 3, feedName, key: subjectKey(token.ticker.toUpperCase()), url: notice.url, params: notice.kind === "EX_DIVIDEND" ? { multiplier_token: true } : {} };
          if (this.state.completed.includes(id)) continue;
          try {
            await this.executor.execute(job);
            // Also mark today's scheduled slot for this notice done, so the daily run doesn't judge it again.
            const day = new Date(this.now()).toISOString().slice(0, 10);
            this.state.completed.push(id, `corp-actions:${day}:${notice.url}`);
            await this.save();
          }
          catch (error) { log("error", "multiplier_notice_job_failed", { ticker: token.ticker, effectiveAt: pair.effectiveAt, error: error instanceof Error ? error.message : "runner failed" }); }
        }
      } catch (error) { log("error", "multiplier_schedule_read_failed", { ticker: token.ticker, error: error instanceof Error ? error.message : "read failed" }); }
    }
  }
  /** StockTokenCrosscheck.observeMultiplier for one ticker; never throws. Failures back off per ticker instead of
   *  re-simulating (and logging) the same revert every poll. */
  private async observe(ticker: string): Promise<void> {
    if (!this.stockTokens?.observeMultiplier) return;
    const retry = this.observeRetry.get(ticker);
    if (retry && this.now() < retry.retryAt) return;
    try {
      const outcome = await this.stockTokens.observeMultiplier(subjectKey(ticker), BigInt(Math.floor(this.now() / 1000)));
      if (outcome === "unregistered") throw new Error("ticker has no token on StockTokenCrosscheck");
      if (retry) log("info", "multiplier_observe_recovered", { ticker, failures: retry.failures });
      this.observeRetry.delete(ticker);
    } catch (error) {
      const failures = (retry?.failures ?? 0) + 1;
      const backoffMs = Math.min(OBSERVE_BACKOFF_MAX_MS, OBSERVE_BACKOFF_BASE_MS * 2 ** (failures - 1));
      this.observeRetry.set(ticker, { failures, retryAt: this.now() + backoffMs });
      log("warn", "multiplier_observe_failed", { ticker, failures, backoffMs, error: failureReason(error) });
    }
  }
  async pollEdgar(): Promise<void> {
    return this.exclusive(() => this.pollEdgarExclusive());
  }
  private async pollEdgarExclusive(): Promise<void> {
    const edgarConfig = this.config.feeds.earnings.edgar;
    if (!this.edgar || !edgarConfig) return;
    for (const company of edgarConfig.companies) {
      try {
        const filings = parseEdgarAtom(await this.edgar.getAtom(company.cik));
        for (const filing of filings) {
          const seenId = `${company.cik}:${filing.accession}`;
          if (this.state.edgarSeen?.includes(seenId)) continue;
          if (!/\bItem\s*2\.02\b/i.test(filing.summary)) { this.markEdgarSeen(seenId); continue; }
          try {
            const noDashes = filing.accession.replace(/-/g, "");
            const exhibit = selectPressRelease(await this.edgar.getFilingIndex(company.cik, noDashes));
            if (!exhibit) { this.markEdgarSeen(seenId); continue; }
            const url = `https://www.sec.gov/Archives/edgar/data/${company.cik}/${noDashes}/${exhibit}`;
            const job = makeEdgarJob(company, filing, url, this.state);
            if (job) { await this.executor.execute(job); this.state.completed.push(job.id); }
            this.markEdgarSeen(seenId);
          } catch (error) { log("error", "edgar_filing_discovery_failed", { ticker: company.ticker, accession: filing.accession, error: error instanceof Error ? error.message : "discovery failed" }); }
        }
      } catch (error) { log("error", "edgar_company_poll_failed", { ticker: company.ticker, error: error instanceof Error ? error.message : "poll failed" }); }
    }
    await this.save();
  }
  private markEdgarSeen(id: string) { this.state.edgarSeen ??= []; if (!this.state.edgarSeen.includes(id)) this.state.edgarSeen.push(id); }
  private async save() { await writeFile(this.config.stateFile, JSON.stringify(this.state), { mode: 0o600 }); }
  start(): void {
    if (this.loop) return;
    this.loop = (async () => {
      while (true) {
        const now = this.now();
        if (now - this.lastStandardRun >= 30_000) { this.lastStandardRun = now; for (const name of RUNNERS) await this.run(name); }
        if (this.stockTokens && now - this.lastMultiplierPoll >= this.config.MULTIPLIER_POLL_MS) { this.lastMultiplierPoll = now; await this.pollMultiplierChanges(); }
        if (this.edgar && now - this.lastEdgarPoll >= this.config.EDGAR_POLL_MS) { this.lastEdgarPoll = now; await this.pollEdgar(); }
        await this.sleep(1_000);
      }
    })();
  }
}
