import { describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toBytes, toHex } from "viem";
import { StockTokenCrosscheckAbi } from "@mochi/chain";
import { aad, provenanceFromJson, type AttestationDoc, type IntakeResult, type OpenBinding } from "@mochi/protocol";
import { SchemaId, toBytes32String, ZERO32 } from "@mochi/core";
import { MockQuoteVerifier, MockTeeProvider } from "@mochi/tee";
import { FeedsConfigSchema, ServiceEnvSchema } from "../src/config.ts";
import type { ChainPort, ExecuteDeps, FeedJob, FeedQueryRepo, HttpPort } from "../src/ports.ts";
import { FeedQueryExecutor, IntakeHttpError, randomGrantNonce } from "../src/execute.ts";
import { planCorpActions } from "../src/runners/corp-actions.ts";
import { planEarnings } from "../src/runners/earnings.ts";
import { planAttestations } from "../src/runners/attestations.ts";
import { createFeedRunnersApp } from "../src/app.ts";
import { FeedScheduler } from "../src/scheduler.ts";
import { parseEdgarAtom, selectPressRelease } from "../src/runners/edgar.ts";
import { EdgarHttpClient } from "../src/adapters/http.ts";
import { failureReason, observationIsCurrent } from "../src/observation.ts";

const root = privateKeyToAccount(`0x${"01".repeat(32)}`);
const intakeMeasurement = `0x${"03".repeat(32)}` as const;
const intake = new MockTeeProvider({ seed: `0x${"02".repeat(32)}`, measurement: intakeMeasurement, mockRoot: root });
const signedQuote = await intake.quote();
const feeds = FeedsConfigSchema.parse({
  "corp-actions": { tokens: [{ ticker: "NVDA", token: `0x${"04".repeat(20)}`, noticeUrls: [{ url: "https://sec.gov/a", kind: "EX_DIVIDEND" }, { url: "https://sec.gov/b", kind: "SPLIT" }] }] },
  earnings: { releases: [{ ticker: "NVDA", releaseAt: "2026-09-26T13:00:00Z", url: "https://sec.gov/earnings", consensus_eps: "2.05", consensus_revenue: "40000000000", consensus_eps_basis: "GAAP" }] },
  attestations: { reserves: [{ assetSymbol: "USDC", url: "https://issuer.test/reserve" }], navs: [{ fundId: "A".repeat(40), url: "https://fund.test/nav" }] },
});
const emptyState = () => ({ completed: [] as string[] });

describe("feed runner planners", () => {
  it("plans daily corp actions after the UTC boundary with schema, params, key and per-URL/day dedupe", () => {
    const before = Date.parse("2026-09-26T12:59:59Z");
    expect(planCorpActions(feeds["corp-actions"], before, emptyState())).toHaveLength(0);
    const jobs = planCorpActions(feeds["corp-actions"], Date.parse("2026-09-26T13:00:00Z"), emptyState());
    expect(jobs.map((job) => job.schemaId)).toEqual([SchemaId.EX_DIVIDEND, SchemaId.SPLIT]);
    expect(jobs[0]?.params).toEqual({ multiplier_token: true });
    expect(jobs[1]?.params).toEqual({});
    expect(jobs[0]?.n).toBe(3);
    expect(jobs[0]?.key).toBe(toBytes32String("NVDA"));
    expect(planCorpActions(feeds["corp-actions"], before + 1000, { completed: [jobs[0]!.id] })).toHaveLength(1);
  });
  it("plans earnings only in its 30 minute window, preserving consensus params and key", () => {
    expect(planEarnings(feeds.earnings, Date.parse("2026-09-26T12:59:59Z"), emptyState())).toHaveLength(0);
    const job = planEarnings(feeds.earnings, Date.parse("2026-09-26T13:00:00Z"), emptyState())[0]!;
    expect(job.n).toBe(7);
    expect(job.key).toBe(toBytes32String("NVDA"));
    expect(job.params).toEqual({ consensus_eps: "2.05", consensus_revenue: "40000000000", consensus_eps_basis: "GAAP" });
    expect(planEarnings(feeds.earnings, Date.parse("2026-09-26T13:30:00Z"), emptyState())).toHaveLength(0);
  });
  it("plans the configured weekday and hashes NAV identifiers over 32 UTF-8 bytes", () => {
    const monday = Date.parse("2026-09-28T00:00:00Z");
    expect(planAttestations(feeds.attestations, monday + 24 * 60 * 60_000, emptyState())).toHaveLength(0);
    const jobs = planAttestations(feeds.attestations, monday, emptyState());
    expect(jobs.map((job) => job.schemaId)).toEqual([SchemaId.RESERVE_ATTESTATION, SchemaId.NAV]);
    expect(jobs[0]?.n).toBe(5);
    expect(jobs[1]?.key).toBe(keccak256(toBytes("A".repeat(40))));
    expect(planAttestations(feeds.attestations, monday, { completed: jobs.map((job) => job.id) })).toHaveLength(0);
  });
});

/** What the intake returns for a sealed URL request: a FETCHED grant signing the sealed open binding. */
const intakeResultFor = (open: OpenBinding): IntakeResult => ({
  provenance: {
    docCommit: `0x${"11".repeat(32)}`, kind: 1, originId: `0x${"12".repeat(32)}`, fetchedAt: "1790427600", tokensK: 1, transcriptHash: `0x${"13".repeat(32)}`,
    schemaId: SchemaId.EX_DIVIDEND, schemaVersion: 1, paramsHash: `0x${"14".repeat(32)}`, expiry: "1790428500", ...open,
  },
  intakeSig: "0x1234", intake: intake.signer().address.toLowerCase(), docCommit: `0x${"11".repeat(32)}`, paramsHash: `0x${"14".repeat(32)}`, schemaId: SchemaId.EX_DIVIDEND, tokensK: 1,
});
let intakeResult: IntakeResult | undefined;
function makeExecutor(options: { active?: boolean; budget?: bigint; autoFund?: boolean; onOpen?: () => void; registeredMeasurement?: `0x${string}` } = {}) {
  const order: string[] = [];
  const attestation: AttestationDoc = { role: "INTAKE", address: intake.signer().address.toLowerCase() as `0x${string}`, encryptionPubKey: intake.encryptionPublicKey(), measurement: intake.measurement(), quote: signedQuote };
  let submitted: { envelope: { v: 1; epk: `0x${string}`; nonce: `0x${string}`; ct: `0x${string}` } } | undefined;
  const http: HttpPort = {
    getAttestation: async () => attestation,
    postIntake: async (_url, envelope) => {
      submitted = { envelope };
      intakeResult = intakeResultFor(JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake()))).open);
      return intakeResult;
    },
  };
  const chainCalls: Record<string, unknown> = {};
  let currentBudget = options.budget ?? 0n;
  const chain: ChainPort = {
    isActive: async (_address, role) => { chainCalls.role = role; return options.active ?? true; },
    getJuror: async () => ({ measurement: options.registeredMeasurement ?? intakeMeasurement }),
    computeQueryId: async () => `0x${"21".repeat(32)}`,
    openFeed: async (params, provenance, sig) => { order.push("open"); options.onOpen?.(); chainCalls.open = { params, provenance, sig }; return `0x${"22".repeat(32)}`; },
    feedBudget: async () => currentBudget,
    fundFeedBudget: async (amount) => { order.push("fund"); currentBudget += amount; chainCalls.funded = amount; },
    usdgBalance: async () => 100n,
    approveUsdg: async (amount) => { order.push("approve"); chainCalls.approved = amount; },
  };
  const repo: FeedQueryRepo = { insertFeedQuery: async (...args) => { order.push("insert"); chainCalls.insert = args; } };
  const deps: ExecuteDeps = { http, chain, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), repo,
    clock: { now: () => Date.now(), sleep: async () => {} }, intakeUrl: "http://intake", feedRunnerAddress: `0x${"31".repeat(20)}`,
    refundTo: `0x${"32".repeat(20)}`, feedRunnerKey: `0x${"33".repeat(32)}`, autoFund: options.autoFund ?? false, feedBudgetMin: 10n, feedBudgetTarget: 50n };
  return { executor: new FeedQueryExecutor(deps), order, chainCalls, submitted: () => submitted, attestation, currentBudget: () => currentBudget };
}
async function withSignedAttestation() { return makeExecutor(); }
const job: FeedJob = { runner: "corp-actions", id: "test", schemaId: SchemaId.EX_DIVIDEND, n: 3, feedName: "corp-actions.exdiv@RHC", key: toBytes32String("NVDA"), url: "https://sec.gov/a", params: { multiplier_token: true } };

describe("feed query execution", () => {
  it("blocks sealing and chain writes when attestation fails", async () => {
    const fixture = await withSignedAttestation();
    fixture.attestation.quote = { ...fixture.attestation.quote, raw: "0x1234" };
    await expect(fixture.executor.execute(job)).rejects.toThrow("intake quote verification failed");
    expect(fixture.submitted()).toBeUndefined();
    expect(fixture.order).toEqual([]);
  });
  it("seals the expected URL plaintext, inserts the mapping before openFeed, and tops up budget when enabled", async () => {
    const fixture = makeExecutor({ autoFund: true });
    const out = await fixture.executor.execute(job);
    expect(out.queryId).toBe(`0x${"21".repeat(32)}`);
    expect(fixture.order).toEqual(["approve", "fund", "insert", "open"]);
    expect(fixture.chainCalls.approved).toBe(50n);
    expect(fixture.chainCalls.funded).toBe(50n);
    expect(fixture.chainCalls.role).toBe(2);
    expect(fixture.chainCalls.open).toEqual({
      params: { n: 3, refundTo: `0x${"32".repeat(20)}` },
      provenance: provenanceFromJson(intakeResult!.provenance),
      sig: intakeResult!.intakeSig,
    });
    // The grant names this feed runner as opener, public, with the nonce the queryId was computed from.
    expect(intakeResult!.provenance).toMatchObject({ opener: `0x${"31".repeat(20)}`, payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: true });
    expect(fixture.chainCalls.insert).toEqual([out.queryId, keccak256(toBytes(job.feedName)), job.key]);
    const envelope = fixture.submitted()!.envelope;
    const plaintext = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
    expect(plaintext).toEqual({ v: 1, schemaId: SchemaId.EX_DIVIDEND, salt: ZERO32, params: { multiplier_token: true }, url: job.url, open: { opener: `0x${"31".repeat(20)}`, payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: true, nonce: expect.any(String) } });
  });
  it("uses a fresh random 64-bit grant nonce, not the clock, and computes the queryId from it", async () => {
    const fixture = await withSignedAttestation();
    const nonces: string[] = [];
    for (let i = 0; i < 4; i++) {
      await fixture.executor.execute(job);
      const plain = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(fixture.submitted()!.envelope, aad.intake())));
      nonces.push(plain.open.nonce);
      expect(intakeResult!.provenance.nonce).toBe(plain.open.nonce);
    }
    expect(new Set(nonces).size).toBe(4);
    const draws = Array.from({ length: 256 }, () => randomGrantNonce());
    expect(draws.every((n) => n >= 0n && n < 1n << 64n)).toBe(true);
    expect(new Set(draws).size).toBe(256);
    expect(draws.some((n) => n >= 1n << 63n)).toBe(true); // all 64 bits are used
    // The executor takes the nonce from its source, never from the clock, and computes the queryId from it.
    const seen: bigint[] = [];
    const injected = makeExecutor();
    const executor = new FeedQueryExecutor((injected.executor as unknown as { deps: ExecuteDeps }).deps, () => 0xfedcba9876543210n);
    (injected.executor as unknown as { deps: ExecuteDeps }).deps.chain.computeQueryId = async (_sender, _doc, nonce) => { seen.push(nonce); return `0x${"21".repeat(32)}`; };
    await executor.execute(job);
    expect(seen).toEqual([0xfedcba9876543210n]);
    expect(intakeResult!.provenance.nonce).toBe(0xfedcba9876543210n.toString());
  });
  it("requires active intake and maps intake caller errors for retry", async () => {
    const fixture = await withSignedAttestation();
    const inactive = makeExecutor({ active: false });
    inactive.attestation.quote = fixture.attestation.quote;
    await expect(inactive.executor.execute(job)).rejects.toThrow("not active");
    expect(inactive.submitted()).toBeUndefined();
    expect(new IntakeHttpError(404).status).toBe(404);
  });
  it("rejects an intake quote whose measurement differs from the on-chain registration", async () => {
    const fixture = await withSignedAttestation();
    const wrong = makeExecutor({ registeredMeasurement: `0x${"09".repeat(32)}` });
    wrong.attestation.quote = fixture.attestation.quote;
    await expect(wrong.executor.execute(job)).rejects.toThrow("quote verification failed");
    expect(wrong.submitted()).toBeUndefined();
  });
});

describe("earnings polling", () => {
  it("retries intake 4xx every poll until it succeeds, then records completion", async () => {
    let now = Date.parse("2026-09-26T13:00:00Z");
    let calls = 0;
    const stateFile = `/tmp/feed-runners-success-${process.pid}.json`;
    const config = { feeds, stateFile, CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1 } as import("../src/config.ts").ServiceConfig;
    const scheduler = new FeedScheduler(config, { execute: async () => { calls++; if (calls === 1) throw new IntakeHttpError(404); return { queryId: ZERO32, txHash: ZERO32 }; } } as unknown as FeedQueryExecutor, () => now);
    expect(await scheduler.run("earnings")).toEqual({ planned: 1, completed: 0, retried: 1 });
    now += 30_000;
    expect(await scheduler.run("earnings")).toEqual({ planned: 1, completed: 1, retried: 0 });
    expect(await scheduler.run("earnings")).toEqual({ planned: 0, completed: 0, retried: 0 });
    expect(calls).toBe(2);
    await rm(stateFile, { force: true });
  });
  it("gives up at the 30 minute boundary using the fake clock", async () => {
    let now = Date.parse("2026-09-26T13:00:00Z");
    const stateFile = `/tmp/feed-runners-giveup-${process.pid}.json`;
    const config = { feeds, stateFile, CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1 } as import("../src/config.ts").ServiceConfig;
    const scheduler = new FeedScheduler(config, { execute: async () => { throw new IntakeHttpError(404); } } as unknown as FeedQueryExecutor, () => now);
    expect((await scheduler.run("earnings")).retried).toBe(1);
    now += 30 * 60_000;
    expect(await scheduler.run("earnings")).toEqual({ planned: 0, completed: 0, retried: 0 });
    await rm(stateFile, { force: true });
  });
});

describe("multiplier polling", () => {
  const makeConfig = (stateFile: string) => ({ feeds: { ...feeds, earnings: { ...feeds.earnings, releases: [], edgar: undefined } }, stateFile,
    CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1, MULTIPLIER_POLL_MS: 60_000, EDGAR_POLL_MS: 60_000 }) as unknown as import("../src/config.ts").ServiceConfig;
  it("serializes concurrent runs: each job executes once (no duplicate feed queries / nonce collisions)", async () => {
    const stateFile = `/tmp/feed-serial-${process.pid}.json`;
    const executed: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const executor = { execute: async (job: FeedJob) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      executed.push(job.id); inFlight--;
      return { queryId: ZERO32, txHash: ZERO32 };
    } } as unknown as FeedQueryExecutor;
    const noon = Date.parse("2026-09-26T14:00:00Z");
    const scheduler = new FeedScheduler(makeConfig(stateFile), executor, () => noon);
    await scheduler.init();
    await Promise.all([scheduler.run("corp-actions"), scheduler.run("corp-actions")]);
    expect(maxInFlight).toBe(1);
    expect(new Set(executed).size).toBe(executed.length);
    await rm(stateFile, { force: true });
  });
  it("schedules a new pending pair once and keeps it deduped after restart", async () => {
    const stateFile = `/tmp/feed-multiplier-${process.pid}.json`;
    const scheduled: FeedJob[] = [];
    const executor = { execute: async (job: FeedJob) => { scheduled.push(job); return { queryId: ZERO32, txHash: ZERO32 }; } } as unknown as FeedQueryExecutor;
    const reader = { readMultiplierSchedule: async () => ({ uiMultiplier: 1n, newUIMultiplier: 2n, effectiveAt: 1_800_000_000n }) };
    const first = new FeedScheduler(makeConfig(stateFile), executor, Date.now, undefined, reader);
    await first.init(); await first.pollMultiplierChanges();
    expect(scheduled.map((j) => j.id)).toHaveLength(2);
    expect(scheduled.every((j) => j.id.includes(":1800000000:"))).toBe(true);
    await first.pollMultiplierChanges();
    expect(scheduled).toHaveLength(2);
    const restarted = new FeedScheduler(makeConfig(stateFile), executor, Date.now, undefined, reader);
    await restarted.init(); await restarted.pollMultiplierChanges();
    expect(scheduled).toHaveLength(2);
    await rm(stateFile, { force: true });
  });
  it("tolerates read errors and retries failed notice submissions", async () => {
    const stateFile = `/tmp/feed-multiplier-errors-${process.pid}.json`;
    let reads = 0, attempts = 0;
    const reader = { readMultiplierSchedule: async () => { reads++; if (reads === 1) throw new Error("rpc unavailable"); return { uiMultiplier: 1n, newUIMultiplier: 3n, effectiveAt: 1_800_000_001n }; } };
    const executor = { execute: async () => { attempts++; throw new Error("temporary"); } } as unknown as FeedQueryExecutor;
    const scheduler = new FeedScheduler(makeConfig(stateFile), executor, Date.now, undefined, reader);
    await scheduler.init(); await expect(scheduler.pollMultiplierChanges()).resolves.toBeUndefined();
    await expect(scheduler.pollMultiplierChanges()).resolves.toBeUndefined();
    expect(reads).toBe(2); expect(attempts).toBe(2);
    await rm(stateFile, { force: true });
  });
});

describe("multiplier baseline (real Stock Token semantics)", () => {
  const makeConfig = (stateFile: string) => ({ feeds: { ...feeds, earnings: { ...feeds.earnings, releases: [], edgar: undefined } }, stateFile,
    CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1, MULTIPLIER_POLL_MS: 60_000, EDGAR_POLL_MS: 60_000 }) as unknown as import("../src/config.ts").ServiceConfig;
  const now = Date.parse("2026-09-26T14:00:00Z");
  const sec = (ms: number) => BigInt(Math.floor(ms / 1000));
  const run = async (effectiveAt: bigint, recordFails = false) => {
    const stateFile = `/tmp/feed-baseline-${process.pid}-${effectiveAt}.json`;
    const jobs: FeedJob[] = [];
    const recorded: [string, bigint][] = [];
    const executor = { execute: async (job: FeedJob) => { jobs.push(job); return { queryId: ZERO32, txHash: ZERO32 }; } } as unknown as FeedQueryExecutor;
    const reader = {
      readMultiplierSchedule: async () => ({ uiMultiplier: 10n ** 18n, newUIMultiplier: 2n * 10n ** 18n, effectiveAt }),
      recordBaseline: async (key: `0x${string}`, at: bigint) => { if (recordFails) throw new Error("rpc down"); recorded.push([key, at]); return true; },
    };
    const scheduler = new FeedScheduler(makeConfig(stateFile), executor, () => now, undefined, reader);
    await scheduler.init(); await scheduler.pollMultiplierChanges();
    await rm(stateFile, { force: true });
    return { jobs, recorded };
  };
  it("records the pre-change multiplier while the change is pending", async () => {
    const at = sec(now + 3 * 86_400_000);
    const { jobs, recorded } = await run(at);
    expect(recorded).toEqual([[toBytes32String("NVDA"), at]]);
    expect(jobs).toHaveLength(2);
  });
  it("does not record once the change is effective, but still judges a recent change", async () => {
    const { jobs, recorded } = await run(sec(now - 86_400_000));
    expect(recorded).toHaveLength(0);
    expect(jobs).toHaveLength(2);
  });
  it("skips a change that took effect long ago (the token keeps its last schedule forever)", async () => {
    const { jobs, recorded } = await run(sec(now - 30 * 86_400_000));
    expect(recorded).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });
  it("a failed baseline record does not block the notice jobs", async () => {
    const { jobs } = await run(sec(now + 86_400_000), true);
    expect(jobs).toHaveLength(2);
  });
});

describe("multiplier observations (StockTokenCrosscheck.observeMultiplier)", () => {
  const tokens = [
    { ticker: "NVDA", token: `0x${"04".repeat(20)}`, noticeUrls: [{ url: "https://sec.gov/a", kind: "EX_DIVIDEND" }] },
    { ticker: "aapl", token: `0x${"05".repeat(20)}`, noticeUrls: [] },
  ];
  const makeConfig = (stateFile: string) => ({ feeds: { ...feeds, "corp-actions": { tokens }, earnings: { ...feeds.earnings, releases: [], edgar: undefined } }, stateFile,
    CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1, MULTIPLIER_POLL_MS: 60_000, EDGAR_POLL_MS: 60_000 }) as unknown as import("../src/config.ts").ServiceConfig;
  const start = Date.parse("2026-09-26T14:00:00Z");
  const executor = { execute: async () => ({ queryId: ZERO32, txHash: ZERO32 }) } as unknown as FeedQueryExecutor;
  const captureLogs = async (fn: () => Promise<void>) => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await fn(); } finally { process.stdout.write = write; }
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("observes every configured ticker on every poll, with or without a pending change, before the baseline fallback", async () => {
    const stateFile = `/tmp/feed-observe-${process.pid}.json`;
    const calls: string[] = [];
    let now = start;
    const reader = {
      // No change pending on either token: the poll used to stop here without touching the crosscheck.
      readMultiplierSchedule: async () => { calls.push("read"); return { uiMultiplier: 10n ** 18n, newUIMultiplier: 0n, effectiveAt: 0n }; },
      recordBaseline: async () => { calls.push("recordBaseline"); return false; },
      observeMultiplier: async (key: `0x${string}`, nowSec: bigint) => { calls.push(`observe:${key}:${nowSec}`); return "current" as const; },
    };
    const scheduler = new FeedScheduler(makeConfig(stateFile), executor, () => now, undefined, reader);
    await scheduler.init(); await scheduler.pollMultiplierChanges();
    const sec = BigInt(start / 1000);
    expect(calls).toEqual([`observe:${toBytes32String("NVDA")}:${sec}`, "read", `observe:${toBytes32String("AAPL")}:${sec}`, "read"]);
    now += 60_000; calls.length = 0;
    await scheduler.pollMultiplierChanges();
    expect(calls.filter((c) => c.startsWith("observe:"))).toHaveLength(2);
    // A pending change: observe first (it records the baseline), then the recordBaseline fallback.
    reader.readMultiplierSchedule = async () => { calls.push("read"); return { uiMultiplier: 10n ** 18n, newUIMultiplier: 2n * 10n ** 18n, effectiveAt: BigInt(start / 1000) + 86_400n }; };
    calls.length = 0;
    await scheduler.pollMultiplierChanges();
    expect(calls.slice(0, 3)).toEqual([`observe:${toBytes32String("NVDA")}:${sec + 60n}`, "read", "recordBaseline"]);
    await rm(stateFile, { force: true });
  });

  it("an observe failure never blocks the poll, backs off per ticker (no retry every poll) and recovers", async () => {
    const stateFile = `/tmp/feed-observe-backoff-${process.pid}.json`;
    let now = start;
    const attempts: Record<string, number> = {};
    let failNvda = true;
    const jobs: FeedJob[] = [];
    const jobExecutor = { execute: async (job: FeedJob) => { jobs.push(job); return { queryId: ZERO32, txHash: ZERO32 }; } } as unknown as FeedQueryExecutor;
    const reader = {
      readMultiplierSchedule: async () => ({ uiMultiplier: 10n ** 18n, newUIMultiplier: 2n * 10n ** 18n, effectiveAt: BigInt(start / 1000) + 86_400n }),
      observeMultiplier: async (key: `0x${string}`) => {
        attempts[key] = (attempts[key] ?? 0) + 1;
        if (key === toBytes32String("NVDA") && failNvda) throw new Error("execution reverted: SafeCastOverflowedUintDowncast(64, 1)\nlong viem detail");
        return "observed" as const;
      },
    };
    const scheduler = new FeedScheduler(makeConfig(stateFile), jobExecutor, () => now, undefined, reader);
    await scheduler.init();
    const nvda = toBytes32String("NVDA"), aapl = toBytes32String("AAPL");
    const logs = await captureLogs(() => scheduler.pollMultiplierChanges());
    expect(attempts).toEqual({ [nvda]: 1, [aapl]: 1 });
    expect(jobs).toHaveLength(1); // NVDA's notice job still ran
    const failed = logs.filter((l) => l.event === "multiplier_observe_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: "warn", ticker: "NVDA", failures: 1, backoffMs: 5 * 60_000, error: "execution reverted: SafeCastOverflowedUintDowncast(64, 1)" });
    // Within the backoff: the failing ticker is skipped, the healthy one is still observed every poll.
    for (let i = 0; i < 4; i++) { now += 60_000; await scheduler.pollMultiplierChanges(); }
    expect(attempts).toEqual({ [nvda]: 1, [aapl]: 5 });
    // After 5 minutes it retries once, fails again and doubles the backoff to 10 minutes.
    now += 60_000;
    const second = await captureLogs(() => scheduler.pollMultiplierChanges());
    expect(attempts[nvda]).toBe(2);
    expect(second.find((l) => l.event === "multiplier_observe_failed")).toMatchObject({ failures: 2, backoffMs: 10 * 60_000 });
    now += 9 * 60_000; await scheduler.pollMultiplierChanges();
    expect(attempts[nvda]).toBe(2);
    failNvda = false; now += 60_000;
    const recovered = await captureLogs(() => scheduler.pollMultiplierChanges());
    expect(attempts[nvda]).toBe(3);
    expect(recovered.some((l) => l.event === "multiplier_observe_recovered" && l.ticker === "NVDA")).toBe(true);
    now += 60_000; await scheduler.pollMultiplierChanges();
    expect(attempts[nvda]).toBe(4); // back to every poll
    await rm(stateFile, { force: true });
  });

  it("a ticker the crosscheck does not know backs off like a revert", async () => {
    const stateFile = `/tmp/feed-observe-unregistered-${process.pid}.json`;
    let now = start, attempts = 0;
    const reader = {
      readMultiplierSchedule: async () => ({ uiMultiplier: 1n, newUIMultiplier: 0n, effectiveAt: 0n }),
      observeMultiplier: async (key: `0x${string}`) => { if (key === toBytes32String("AAPL")) { attempts++; return "unregistered" as const; } return "current" as const; },
    };
    const scheduler = new FeedScheduler(makeConfig(stateFile), executor, () => now, undefined, reader);
    await scheduler.init();
    const logs = await captureLogs(() => scheduler.pollMultiplierChanges());
    expect(logs.find((l) => l.event === "multiplier_observe_failed")).toMatchObject({ ticker: "AAPL", error: "ticker has no token on StockTokenCrosscheck" });
    now += 60_000; await scheduler.pollMultiplierChanges();
    expect(attempts).toBe(1);
    await rm(stateFile, { force: true });
  });

  it("reports the contract's custom error name for a reverted simulation", () => {
    const data = encodeErrorResult({ abi: StockTokenCrosscheckAbi, errorName: "UnknownTicker", args: [toBytes32String("NVDA")] });
    const reverted = new ContractFunctionRevertedError({ abi: StockTokenCrosscheckAbi, data, functionName: "observeMultiplier" });
    const error = new ContractFunctionExecutionError(reverted, { abi: StockTokenCrosscheckAbi, functionName: "observeMultiplier", args: [toBytes32String("NVDA")], contractAddress: `0x${"07".repeat(20)}` });
    expect(failureReason(error)).toBe("UnknownTicker");
    expect(failureReason(new Error("rpc down\nstack"))).toBe("rpc down");
  });

  it("only re-observes when the on-chain observation is out of date", () => {
    const m = 10n ** 18n;
    const t = (uiMultiplier: bigint, effectiveAt: bigint) => ({ uiMultiplier, effectiveAt });
    // Never observed.
    expect(observationIsCurrent({ observedAt: 0n, scheduledAt: 0n, multiplier: 0n }, t(m, 0n), 1_000n)).toBe(false);
    // Same multiplier and schedule, nothing pending when observed: a new observation would only move observedAt.
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 500n, multiplier: m }, t(m, 500n), 1_000n)).toBe(true);
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 0n, multiplier: m }, t(m, 0n), 1_000n)).toBe(true);
    // The multiplier moved (an immediate change, or a pending one took effect) or a new change was scheduled.
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 500n, multiplier: m }, t(2n * m, 950n), 1_000n)).toBe(false);
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 500n, multiplier: m }, t(m, 2_000n), 1_000n)).toBe(false);
    // Observed while a change was pending: still current while it is pending, refreshed once it has taken effect.
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 2_000n, multiplier: m }, t(m, 2_000n), 1_999n)).toBe(true);
    expect(observationIsCurrent({ observedAt: 900n, scheduledAt: 2_000n, multiplier: m }, t(m, 2_000n), 2_000n)).toBe(false);
  });
});

describe("EDGAR discovery", () => {
  it("defaults poll intervals to 60 seconds and rejects values under the 10 second floor", () => {
    const env = { ADMIN_TOKEN: "admin", FEED_RUNNER_ADDRESS: `0x${"31".repeat(20)}`, FEED_RUNNER_KEY: `0x${"33".repeat(32)}`, QUOTE_VERIFIER: "dcap" };
    expect(ServiceEnvSchema.parse(env).MULTIPLIER_POLL_MS).toBe(60_000);
    expect(ServiceEnvSchema.parse(env).EDGAR_POLL_MS).toBe(60_000);
    expect(ServiceEnvSchema.safeParse({ ...env, EDGAR_POLL_MS: "9999" }).success).toBe(false);
  });
  it("requires an explicit QUOTE_VERIFIER: no configuration defaults to mock quote verification", () => {
    const env = { ADMIN_TOKEN: "admin", FEED_RUNNER_ADDRESS: `0x${"31".repeat(20)}`, FEED_RUNNER_KEY: `0x${"33".repeat(32)}` };
    for (const QUOTE_VERIFIER of [undefined, "", "MOCK", "nras"]) {
      const parsed = ServiceEnvSchema.safeParse({ ...env, QUOTE_VERIFIER });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain("QUOTE_VERIFIER must be set explicitly");
    }
    expect(ServiceEnvSchema.parse({ ...env, QUOTE_VERIFIER: "dcap" }).QUOTE_VERIFIER).toBe("dcap");
    expect(ServiceEnvSchema.parse({ ...env, QUOTE_VERIFIER: "mock" }).QUOTE_VERIFIER).toBe("mock");
  });
  const atomPromise = readFile(new URL("./fixtures/edgar-atom.xml", import.meta.url), "utf8");
  const indexPromise = readFile(new URL("./fixtures/edgar-index.htm", import.meta.url), "utf8");
  it("parses Atom filings and selects EX-99.1 ahead of other press exhibits", async () => {
    const filings = parseEdgarAtom(await atomPromise);
    expect(filings).toHaveLength(2);
    expect(filings[0]?.accession).toBe("0001234567-26-000001");
    expect(filings[0]?.summary).toContain("Item 2.02");
    // Real SEC index page (NVIDIA 8-K 2026-08-26): EX-99.1 is the press release, EX-99.2 the CFO commentary.
    expect(selectPressRelease(await indexPromise)).toBe("q2fy27pr.htm");
  });
  it("filters non-2.02 filings, submits earnings jobs with consensus strings, and persists seen filings", async () => {
    const atom = await atomPromise;
    const index = await indexPromise;
    const stateFile = `/tmp/feed-edgar-${process.pid}.json`;
    const edgarConfig = { userAgent: "Mochi ops@example.com", companies: [{ ticker: "NVDA", cik: "1234567890", consensus_eps: "2.05", consensus_revenue: "40000000000", consensus_eps_basis: "GAAP" }] };
    const edgarFeeds = FeedsConfigSchema.parse({ ...feeds, earnings: { releases: [], edgar: edgarConfig } });
    const config = { feeds: edgarFeeds, stateFile, CORP_ACTIONS_UTC_HOUR: 13, ATTESTATIONS_WEEKDAY: 1, MULTIPLIER_POLL_MS: 60_000, EDGAR_POLL_MS: 60_000 } as import("../src/config.ts").ServiceConfig;
    const submitted: FeedJob[] = [];
    const executor = { execute: async (job: FeedJob) => { submitted.push(job); return { queryId: ZERO32, txHash: ZERO32 }; } } as unknown as FeedQueryExecutor;
    let indexCalls = 0;
    const edgar = { getAtom: async () => atom, getFilingIndex: async () => { indexCalls++; return index; } };
    const scheduler = new FeedScheduler(config, executor, Date.now, undefined, undefined, edgar);
    await scheduler.init(); await scheduler.pollEdgar(); await scheduler.pollEdgar();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ n: 7, feedName: "earnings@RHC", key: toBytes32String("NVDA"), url: "https://www.sec.gov/Archives/edgar/data/1234567890/000123456726000001/q2fy27pr.htm", params: { consensus_eps: "2.05", consensus_revenue: "40000000000", consensus_eps_basis: "GAAP" } });
    expect(indexCalls).toBe(1);
    const restarted = new FeedScheduler(config, executor, Date.now, undefined, undefined, edgar);
    await restarted.init(); await restarted.pollEdgar();
    expect(submitted).toHaveLength(1);
    expect(indexCalls).toBe(1);
    await rm(stateFile, { force: true });
  });
  it("parses the real SEC Atom feed (NVIDIA, fetched 2026-09-26): 10 8-Ks, 2 earnings (Item 2.02)", async () => {
    const real = await readFile(new URL("./fixtures/edgar-atom-nvda-real.xml", import.meta.url), "utf8");
    const filings = parseEdgarAtom(real);
    expect(filings).toHaveLength(10);
    expect(filings.filter((f) => /Item 2\.02/i.test(f.summary)).map((f) => f.accession)).toContain("0001045810-26-000073");
  });
  it("sends the configured User-Agent on every SEC request", async () => {
    const originalFetch = globalThis.fetch;
    const headers: string[] = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => { headers.push(new Headers(init?.headers).get("User-Agent") ?? ""); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      const client = new EdgarHttpClient("Mochi ops@example.com", 10_000, () => 1000, async () => {});
      await client.getAtom("0000000001"); await client.getFilingIndex("0000000001", "000000000126000001");
      expect(headers).toEqual(["Mochi ops@example.com", "Mochi ops@example.com"]);
    } finally { globalThis.fetch = originalFetch; }
  });
});

it("exposes health/status and protects immediate runs with the admin token", async () => {
  const calls: string[] = [];
  const scheduler = {
    status: () => ({ running: false, completedCount: 0 }),
    run: async (name: string) => { calls.push(name); return { planned: 0, completed: 0, retried: 0 }; },
  } as unknown as FeedScheduler;
  const app = createFeedRunnersApp({ scheduler, adminToken: "admin-secret" }).app;
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/v1/feed-runners/status")).status).toBe(200);
  expect((await app.request("/v1/feed-runners/run/earnings", { method: "POST" })).status).toBe(401);
  expect((await app.request("/v1/feed-runners/run/unknown", { method: "POST", headers: { authorization: "Bearer admin-secret" } })).status).toBe(400);
  expect((await app.request("/v1/feed-runners/run/earnings", { method: "POST", headers: { authorization: "Bearer admin-secret" } })).status).toBe(202);
  expect(calls).toEqual(["earnings"]);
});

describe("admin run-now", () => {
  it("force skips the schedule gate but keeps the per-day dedupe", async () => {
    const { planCorpActions } = await import("../src/runners/corp-actions.ts");
    const early = Date.parse("2026-09-26T05:00:00Z");
    const cfg = { tokens: [{ ticker: "ACME", token: `0x${"11".repeat(20)}` as `0x${string}`, noticeUrls: [{ url: "https://docs.example/a", kind: "SPLIT" as const }] }] };
    const state = { completed: [] as string[], multiplierPairs: {}, edgarSeen: [] };
    expect(planCorpActions(cfg, early, state, { utcHour: 13 })).toHaveLength(0);
    const forced = planCorpActions(cfg, early, state, { utcHour: 13, force: true });
    expect(forced).toHaveLength(1);
    state.completed.push(forced[0]!.id);
    expect(planCorpActions(cfg, early, state, { utcHour: 13, force: true })).toHaveLength(0);
  });
});
