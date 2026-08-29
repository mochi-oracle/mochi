import { describe, expect, test } from "bun:test";
import {
  AnchorWindow,
  createReceiptSigner,
  merkleProof,
  receiptLeaf,
  verifyReceipt,
  type VerdictReceipt,
} from "@mochi/receipts";
import { attestationRoot } from "@mochi/core";
import type { Address, Hex } from "viem";
import type {
  ChainEvent,
  ChainPort,
  ChainQuery,
  ChainVerdict,
  ChainVote,
  PublicVerdictPart,
  ReceiptRow,
  StorePort,
} from "../src/ports.ts";
import { createIndexerApp } from "../src/app.ts";
import { flushAnchors, queueUnanchoredReceipts } from "../src/loops/anchors.ts";
import { pollEvents } from "../src/loops/events.ts";
import { buildMissingReceipts } from "../src/loops/receipts.ts";
import { purgePrivateResults } from "../src/loops/purge.ts";

const HASH = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;
const ZERO32 = HASH("0");
const FIRST_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const SECOND_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const THIRD_ADDRESS = "0x3333333333333333333333333333333333333333" as Address;
const FOURTH_ADDRESS = "0x4444444444444444444444444444444444444444" as Address;
const FIFTH_ADDRESS = "0x5555555555555555555555555555555555555555" as Address;
type ModelDisagreementFixture = {
  window: string;
  modelId: string;
  field: string;
  samples: number;
  disagreeCount: number;
};
const Q: ChainQuery = {
  schemaId: 3,
  schemaVersion: 1,
  n: 3,
  round: 0,
  isPublic: true,
  payPath: 0,
  payerCommit: HASH("0"),
  paramsHash: HASH("1"),
  provenanceKind: 1,
  originId: HASH("2"),
  tokensK: 1,
  status: 3,
  docCommit: HASH("3"),
  payer: "0x1111111111111111111111111111111111111111" as Address,
};

/** Create a representative complete on-chain verdict value. */
function makeVerdict(
  id = HASH("4"),
  queryId = HASH("5"),
  options: Partial<ChainVerdict> = {},
): ChainVerdict {
  return {
    id,
    queryId,
    ...Q,
    isPublic: true,
    status: 1,
    escalated: false,
    agreementBps: 10_000,
    dissentMask: 0,
    timeoutMask: 0,
    ts: 1_800_000_000n,
    modelSetHash: HASH("6"),
    evidenceRoot: HASH("7"),
    attestationRoot: HASH("8"),
    answerHash: HASH("9"),
    payloadHash: HASH("a"),
    docCommit: HASH("3"),
    provenanceHash: HASH("b"),
    tx: HASH("c"),
    ...options,
  };
}

class FakeStore implements StorePort {
  cursors = new Map<string, bigint>();
  events: ChainEvent[] = [];
  receipts = new Map<string, ReceiptRow>();
  verdicts = new Map<string, { verdict: Record<string, unknown>; publicPart: PublicVerdictPart | null }>();
  pending: ChainVerdict[] = [];
  anchors = new Map<string, { root: Hex; tx: Hex; count: number; ts: Date }>();
  disagreements: Array<{ window: string; disagreeRate: number }> = [];
  modelDisagreements: ModelDisagreementFixture[] = [];
  passports = new Map<string, unknown>();
  payers = new Map<string, string>();
  subscriptions: Array<{ feedId: string; consumer: string; until: Date; paid: bigint }> = [];
  purgedAt: Date[] = [];
  statuses = new Map<string, number>();

  async getCursor(name: string) {
    return this.cursors.get(name) ?? null;
  }

  async setCursor(name: string, block: bigint) {
    this.cursors.set(name, block);
  }

  async applyEvent(event: ChainEvent) {
    this.events.push(event);
    const args = event.args;
    if (event.name === "Subscribed") {
      await this.upsertFeedSubscription(
        String(args.feedId),
        String(args.consumer).toLowerCase(),
        new Date(Number(args.until) * 1_000),
        BigInt(String(args.paid)),
      );
    }
    if (event.name.startsWith("Query")) {
      const query = args.query as Record<string, unknown> | undefined;
      this.statuses.set(String(args.queryId), Number(args.status ?? query?.status ?? 2));
    }
    if (event.name === "VerdictPosted" && !this.verdicts.has(String(args.verdictId))) {
      this.verdicts.set(String(args.verdictId), {
        verdict: (args.verdict as Record<string, unknown> | undefined) ?? {},
        publicPart: null,
      });
    }
  }

  async getVerdict(id: string) {
    return this.verdicts.get(id) ?? null;
  }

  async listUnreceiptedVerdicts() {
    return this.pending.filter((verdict) => !this.receipts.has(verdict.id));
  }

  async insertReceipt(receipt: ReceiptRow, disagreementRows = []) {
    if (this.receipts.has(receipt.verdictId)) return;
    this.receipts.set(receipt.verdictId, receipt);
    this.disagreements.push(...disagreementRows);
  }

  async getReceipt(id: string) {
    return this.receipts.get(id) ?? null;
  }

  async insertAnchor(anchor: { root: Hex; ts: Date; count: number; tx: Hex }) {
    this.anchors.set(anchor.root, anchor);
  }

  async updateReceiptAnchor(root: Hex, entries: Array<{ verdictId: string; index: number }>) {
    for (const entry of entries) {
      const receipt = this.receipts.get(entry.verdictId);
      if (receipt) {
        this.receipts.set(entry.verdictId, {
          ...receipt,
          anchorRoot: root,
          anchorIndex: entry.index,
        });
      }
    }
  }

  async recordDisagreement(rows: Array<{ window: string; disagreeRate: number }>) {
    this.disagreements.push(...rows);
  }

  async getJurorPassports(keys: string[]) {
    return keys.flatMap((key) => this.passports.has(key.toLowerCase())
      ? [{ key: key.toLowerCase(), passport: this.passports.get(key.toLowerCase()) }]
      : []);
  }

  async recordModelDisagreement(rows: ModelDisagreementFixture[]) {
    this.modelDisagreements.push(...rows);
  }

  async purgeExpiredPrivateResults(now: Date) {
    this.purgedAt.push(now);
    return 2;
  }

  async setQueryPayer(queryId: string, payer: string) {
    this.payers.set(queryId.toLowerCase(), payer);
  }

  async upsertFeedSubscription(feedId: string, consumer: string, until: Date, paid: bigint) {
    this.subscriptions.push({ feedId, consumer, until, paid });
  }

  async status() {
    return Object.fromEntries([...this.cursors].map(([key, value]) => [key, value.toString()]));
  }

  async listUnanchoredReceipts() {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.anchorIndex < 0)
      .map((receipt) => ({ verdictId: receipt.verdictId, payload: receipt.payload }));
  }

  async getReceiptAnchor(verdictId: string) {
    const receipt = this.receipts.get(verdictId);
    if (!receipt || receipt.anchorIndex < 0) return null;
    const anchor = this.anchors.get(receipt.anchorRoot);
    if (!anchor) return null;
    const leaves = [...this.receipts.values()]
      .filter((candidate) => candidate.anchorRoot === receipt.anchorRoot)
      .sort((left, right) => left.anchorIndex - right.anchorIndex)
      .map((candidate) => receiptLeaf(candidate.payload));
    return {
      root: receipt.anchorRoot as Hex,
      tx: anchor.tx,
      proof: merkleProof(leaves, receiptLeaf(receipt.payload)),
    };
  }
}

class FakeChain implements ChainPort {
  startBlock = 1n;
  chainId = 4_663;
  verdictContract = "0x2222222222222222222222222222222222222222";
  head = 0n;
  logs: ChainEvent[] = [];
  verdicts = new Map<string, ChainVerdict>();
  queries = new Map<string, ChainQuery>();
  votes = new Map<string, ChainVote[]>();
  seats: Address[] = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS];
  anchors: Array<{ root: Hex; count: number; tx: Hex }> = [];
  classReads = new Map<string, number>();

  async latestBlock() {
    return this.head;
  }

  async events(fromBlock: bigint, toBlock: bigint) {
    return this.logs.filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock);
  }

  async verdict(id: Hex) {
    return this.verdicts.get(id)!;
  }

  async query(id: Hex) {
    return this.queries.get(id) ?? Q;
  }

  async seatJurors() {
    return this.seats;
  }

  async jurorClass(address: string) {
    this.classReads.set(address, (this.classReads.get(address) ?? 0) + 1);
    const classes = new Map<string, number>([
      [FIRST_ADDRESS, 0],
      [SECOND_ADDRESS, 2],
      [THIRD_ADDRESS, 4],
      [FOURTH_ADDRESS, 1],
      [FIFTH_ADDRESS, 3],
    ]);
    return classes.get(address as Address) ?? 0;
  }

  async votesOfPostTx(transactionHash: Hex) {
    return this.votes.get(transactionHash) ?? [];
  }

  async eventSnapshot() {
    return {};
  }

  async anchor(root: Hex, count: number) {
    this.anchors.push({ root, count, tx: HASH("d") });
    return HASH("d");
  }

  async blockTimestamp() {
    return new Date(1_800_000_000_000);
  }
}

/** Create a chain event fixture for polling tests. */
function makeEvent(
  name: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex = 0,
): ChainEvent {
  return {
    name,
    address: FIRST_ADDRESS,
    args,
    blockNumber,
    timestamp: new Date(1_800_000_000_000),
    transactionHash: HASH("e"),
    logIndex,
  };
}

/** Add a verdict, query, transaction votes, and public receipt payload to fakes. */
function addPendingVerdict(
  chain: FakeChain,
  store: FakeStore,
  verdict: ChainVerdict,
  votes: ChainVote[],
  answer: unknown = { fields: { value: 1 } },
): void {
  chain.verdicts.set(verdict.id, verdict);
  chain.votes.set(verdict.tx, votes);
  chain.queries.set(verdict.queryId, { ...Q, isPublic: verdict.isPublic });
  store.pending.push(verdict);
  store.verdicts.set(verdict.id, {
    verdict: { isPublic: verdict.isPublic },
    publicPart: verdict.isPublic
      ? { answer, payload: new Uint8Array([1, 2]), dissent: {}, fieldAgreement: {} }
      : null,
  });
}

const signer = createReceiptSigner();
const alerts = {
  posted: [] as unknown[],
  async post(_url: string, payload: unknown, timeoutMilliseconds: number) {
    expect(timeoutMilliseconds).toBe(5_000);
    this.posted.push(payload);
  },
};

describe("indexer", () => {
  test("resumes event cursor without duplicates and applies query status transitions", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    chain.head = 4n;
    chain.logs = [
      makeEvent("QueryOpened", { queryId: HASH("1"), status: 1 }, 1n),
      makeEvent("QuerySealed", { queryId: HASH("1"), status: 2 }, 2n),
      makeEvent("QuerySettled", { queryId: HASH("1"), status: 3 }, 3n),
    ];

    await pollEvents({ chain, store, alert: alerts });
    expect(store.events).toHaveLength(3);
    expect(store.cursors.get("indexer:events")).toBe(4n);
    expect(store.statuses.get(HASH("1"))).toBe(3);
    await pollEvents({ chain, store, alert: alerts });
    expect(store.events).toHaveLength(3);
  });

  test("indexes QueryOpened payer and Feeds Subscribed events", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    chain.head = 2n;
    chain.logs = [
      makeEvent("QueryOpened", {
        queryId: HASH("1"),
        query: { payer: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      }, 1n),
      makeEvent("Subscribed", {
        feedId: HASH("2"),
        consumer: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        until: 1_900_000_000n,
        paid: 123n,
      }, 2n),
    ];

    await pollEvents({ chain, store, alert: alerts });
    expect(store.payers.get(HASH("1"))).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(store.subscriptions).toEqual([{
      feedId: HASH("2"),
      consumer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      until: new Date(1_900_000_000_000),
      paid: 123n,
    }]);
  });

  test("chain-only verdict event preserves an existing public part", async () => {
    const store = new FakeStore();
    const verdict = makeVerdict();
    const publicPart: PublicVerdictPart = {
      answer: { publicField: "preserved" },
      payload: new Uint8Array([1]),
      dissent: {},
      fieldAgreement: {},
    };
    store.verdicts.set(verdict.id, { verdict: { isPublic: true }, publicPart });

    await store.applyEvent(makeEvent("VerdictPosted", {
      verdictId: verdict.id,
      verdict: { chainOnly: true },
    }, 1n));
    expect((await store.getVerdict(verdict.id))?.publicPart).toBe(publicPart);
  });

  test("receipts are signed once and private receipts reveal no public result", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const publicVerdict = makeVerdict();
    const privateVerdict = makeVerdict(HASH("f"), HASH("a"), {
      isPublic: false,
      tx: HASH("d"),
    });
    const baseVotes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: HASH(String(index + 1)),
    }));
    const privateVotes = baseVotes.map((vote) => ({ ...vote }));
    publicVerdict.attestationRoot = attestationRoot(baseVotes.map((vote) => vote.quoteHash));
    privateVerdict.attestationRoot = attestationRoot(privateVotes.map((vote) => vote.quoteHash));
    addPendingVerdict(chain, store, publicVerdict, baseVotes, {
      fields: { eps: 2.1 },
      disagreement: [
        { field: "eps", jurorClass: 0, disagreed: true },
        { field: "eps", jurorClass: 0, disagreed: false },
        { field: "eps", jurorClass: 0, disagreed: false },
        { field: "eps", jurorClass: 0, disagreed: false },
        { field: "eps", jurorClass: 2, disagreed: true },
        { field: "eps", jurorClass: 2, disagreed: true },
      ],
    });
    addPendingVerdict(chain, store, privateVerdict, privateVotes);

    expect(await buildMissingReceipts(chain, store, signer)).toBe(2);
    expect(await buildMissingReceipts(chain, store, signer)).toBe(0);
    const publicReceipt = store.receipts.get(publicVerdict.id)!;
    const privateReceipt = store.receipts.get(privateVerdict.id)!;
    expect(verifyStoredReceipt(publicReceipt).valid).toBe(true);
    expect((publicReceipt.payload as VerdictReceipt).public?.answer_json).toContain("eps");
    expect((privateReceipt.payload as VerdictReceipt).public).toBeUndefined();
    expect(store.disagreements).toHaveLength(4);
    expect(store.disagreements.filter((row) => row.window === "1 hour")
      .map((row) => row.disagreeRate)).toEqual([0.25, 1]);
    expect(store.disagreements.filter((row) => row.window === "1 day")).toHaveLength(2);
  });

  test("receipt Passports verify and public model disagreement follows the juror seat", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const verdict = makeVerdict();
    const votes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: HASH(String(index + 1)),
    }));
    verdict.attestationRoot = attestationRoot(votes.map((vote) => vote.quoteHash));
    const passport = (modelId: string) => ({
      modelId,
      lineage: "lineage",
      weightsSha256: HASH("a"),
      openWeights: true,
      provider: "provider",
      zdr: true,
      tee: "tdx",
    });
    store.passports.set(FIRST_ADDRESS, passport("model-a"));
    store.passports.set(SECOND_ADDRESS, passport("model-b"));
    store.passports.set(THIRD_ADDRESS, passport("model-c"));
    addPendingVerdict(chain, store, verdict, votes, {
      fields: { value: 1 },
      disagreement: [
        { field: "value", jurorClass: 0, seat: 0, disagreed: true, timedOut: false },
        { field: "value", jurorClass: 2, seat: 1, disagreed: false, timedOut: false },
        { field: "value", jurorClass: 4, seat: 2, disagreed: false, timedOut: false },
      ],
    });

    expect(await buildMissingReceipts(chain, store, signer)).toBe(1);
    const receipt = store.receipts.get(verdict.id)!;
    expect((receipt.payload as VerdictReceipt).jurors[0]?.passport).toEqual(passport("model-a"));
    expect(verifyStoredReceipt(receipt).valid).toBe(true);
    expect(store.modelDisagreements).toHaveLength(6);
    expect(store.modelDisagreements.filter((row) => row.modelId === "model-a").map((row) => [
      row.window,
      row.field,
      row.samples,
      row.disagreeCount,
    ])).toEqual([["1 hour", "value", 1, 1], ["1 day", "value", 1, 1]]);
  });

  test("receipt creation proceeds when Passport storage is unavailable", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const verdict = makeVerdict();
    const votes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: HASH(String(index + 1)),
    }));
    verdict.attestationRoot = attestationRoot(votes.map((vote) => vote.quoteHash));
    addPendingVerdict(chain, store, verdict, votes);
    store.getJurorPassports = async () => { throw new Error("passport store unavailable"); };

    expect(await buildMissingReceipts(chain, store, signer)).toBe(1);
    const receipt = store.receipts.get(verdict.id)!;
    expect((receipt.payload as VerdictReceipt).jurors.every((juror) => juror.passport === undefined)).toBe(true);
    expect(verifyStoredReceipt(receipt).valid).toBe(true);
  });

  test("private-result purge delegates current time and reports deleted rows", async () => {
    const store = new FakeStore();
    const now = new Date("2026-09-26T00:00:00.000Z");
    expect(await purgePrivateResults(store, now)).toBe(2);
    expect(store.purgedAt).toEqual([now]);
  });

  test("expansion verdict uses every vote and the matching seat classes", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    chain.seats = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS, FOURTH_ADDRESS, FIFTH_ADDRESS];
    const quoteHashes = [HASH("1"), HASH("2"), HASH("3"), HASH("4"), HASH("5")];
    const verdict = makeVerdict(HASH("4"), HASH("5"), {
      round: 1,
      n: 5,
      attestationRoot: attestationRoot(quoteHashes),
    });
    addPendingVerdict(chain, store, verdict, chain.seats.map((juror, index) => ({
      juror,
      quoteHash: quoteHashes[index]!,
    })));

    expect(await buildMissingReceipts(chain, store, signer)).toBe(1);
    const receipt = store.receipts.get(verdict.id)!.payload as VerdictReceipt;
    expect(receipt.jurors).toHaveLength(5);
    expect(receipt.jurors.map((juror) => juror.quote_hash)).toEqual(quoteHashes);
    expect(receipt.jurors.map((juror) => juror.class)).toEqual([
      "LARGE_A",
      "DOC_SPECIALIST",
      "DISSENTER",
      "LARGE_B",
      "SMALL_FAST",
    ]);
  });

  test("timed-out seats remain in the receipt with a zero quote hash", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const quoteHashes = [HASH("1"), ZERO32, HASH("3")];
    const verdict = makeVerdict(HASH("4"), HASH("5"), {
      timeoutMask: 2,
      attestationRoot: attestationRoot(quoteHashes),
    });
    const votes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: quoteHashes[index]!,
    }));
    addPendingVerdict(chain, store, verdict, votes);

    expect(await buildMissingReceipts(chain, store, signer)).toBe(1);
    const receipt = store.receipts.get(verdict.id)!.payload as VerdictReceipt;
    expect(receipt.jurors).toHaveLength(3);
    expect(receipt.jurors[1]?.quote_hash).toBe(ZERO32);
  });

  test("panel verdict uses jurorsOf with zero quote hashes", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    chain.seats = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS];
    const verdict = makeVerdict(HASH("4"), HASH("5"), {
      round: 255,
      escalated: true,
      attestationRoot: attestationRoot([ZERO32, ZERO32, ZERO32]),
    });
    addPendingVerdict(chain, store, verdict, []);

    expect(await buildMissingReceipts(chain, store, signer)).toBe(1);
    const receipt = store.receipts.get(verdict.id)!.payload as VerdictReceipt;
    expect(receipt.escalated).toBe(true);
    expect(receipt.jurors.map((juror) => juror.juror)).toEqual(chain.seats);
    expect(receipt.jurors.map((juror) => juror.quote_hash)).toEqual([ZERO32, ZERO32, ZERO32]);
  });

  test("attestation root mismatch skips receipt and logs an error", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const verdict = makeVerdict();
    addPendingVerdict(chain, store, verdict, [{ juror: FIRST_ADDRESS, quoteHash: HASH("1") }]);
    const logLines: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logLines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await buildMissingReceipts(chain, store, signer)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(store.receipts.size).toBe(0);
    expect(logLines.join("")).toContain("receipt_attestation_root_mismatch");
  });

  test("anchor flush posts once with batch root and proof verifies", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const verdict = makeVerdict();
    const votes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: HASH(String(index + 1)),
    }));
    verdict.attestationRoot = attestationRoot(votes.map((vote) => vote.quoteHash));
    addPendingVerdict(chain, store, verdict, votes);
    await buildMissingReceipts(chain, store, signer);

    const window = new AnchorWindow({ intervalMs: 100, maxLeaves: 10, now: 0 });
    const queued = new Set<string>();
    await queueUnanchoredReceipts(store, window, queued);
    expect(await flushAnchors(chain, store, window, new Date(200))).toBe(true);
    expect(chain.anchors).toHaveLength(1);
    expect(chain.anchors[0]?.count).toBe(1);
    const receipt = store.receipts.get(verdict.id)!;
    const anchor = await store.getReceiptAnchor(verdict.id);
    expect(anchor).not.toBeNull();
    expect(verifyStoredReceipt(receipt, {
      root: anchor!.root,
      proof: anchor!.proof,
    }).valid).toBe(true);
    expect(await flushAnchors(chain, store, window, new Date(300))).toBe(false);
  });

  test("alerts are sent for failed crosschecks and slashes", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    chain.head = 2n;
    chain.logs = [
      makeEvent("CrosscheckFailed", { reason: HASH("1") }, 1n),
      makeEvent("Slashed", { amount: 2n }, 2n),
    ];
    alerts.posted = [];

    await pollEvents({ chain, store, alert: alerts, alertUrl: "https://alerts.example/hook" });
    expect(alerts.posted.map((payload) => (payload as { type: string }).type))
      .toEqual(["CrosscheckFailed", "Slashed"]);
  });

  test("receipt endpoints and well-known key document return JSON", async () => {
    const chain = new FakeChain();
    const store = new FakeStore();
    const verdict = makeVerdict();
    const votes = [FIRST_ADDRESS, SECOND_ADDRESS, THIRD_ADDRESS].map((juror, index) => ({
      juror,
      quoteHash: HASH(String(index + 1)),
    }));
    verdict.attestationRoot = attestationRoot(votes.map((vote) => vote.quoteHash));
    addPendingVerdict(chain, store, verdict, votes, { ok: true });
    await buildMissingReceipts(chain, store, signer);
    const anchorWindow = new AnchorWindow({ intervalMs: 100, maxLeaves: 10, now: 0 });
    await queueUnanchoredReceipts(store, anchorWindow, new Set());
    await flushAnchors(chain, store, anchorWindow, new Date(200));

    const { app } = createIndexerApp({ chain, store, signer, alert: alerts });
    const receiptResponse = await app.request(`/v1/receipts/${verdict.id}`);
    expect(receiptResponse.status).toBe(200);
    const receiptBody = await receiptResponse.json() as {
      receipt: VerdictReceipt;
      anchor: { tx: string; proof: string[] };
    };
    expect(receiptBody.receipt.id).toBe(verdict.id);
    expect(receiptBody.anchor.tx).toBe(HASH("d"));
    expect(Array.isArray(receiptBody.anchor.proof)).toBe(true);

    const keyResponse = await app.request("/.well-known/mochi-receipts.json");
    const keyBody = await keyResponse.json() as {
      key_id: string;
      algorithm: string;
      jwk: { kid: string };
    };
    expect(keyBody.key_id).toBe(signer.keyId);
    expect(keyBody.algorithm).toBe("Ed25519");
    expect(keyBody.jwk.kid).toBe(signer.keyId);
    const statusResponse = await app.request("/v1/indexer/status");
    expect(statusResponse.status).toBe(200);
  });
});

/** Verify a stored receipt and optional anchor proof with the test key. */
function verifyStoredReceipt(
  receipt: ReceiptRow,
  anchor?: { root: Hex; proof: Hex[] },
) {
  return verifyReceipt({
    receipt: receipt.payload,
    signature: Buffer.from(receipt.sig as Uint8Array).toString("base64"),
    publicKeys: { [signer.keyId]: signer.publicKeyPem },
    ...(anchor ? { anchor } : {}),
  });
}
