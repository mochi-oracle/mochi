// Core end-to-end on anvil WITHOUT the HTTP services: proves every TS encoding (EIP-712 provenance / juror answers /
// verdict attestation, answerHash, votesHash, payload ABI, enrollment proof-of-possession) matches the contracts,
// that an intake provenance grant is bound to its opener (a copied grant is rejected), that the SDK's local queryId
// (core computeQueryId) and the SUBMITTED and salted private FETCHED transcriptHash grant hashes match the escrow, and that a private query's
// on-chain payloadHash is salted while public/feed payload hashes stay keccak256(payload). It also checks the Feeds
// revert rules (re-post, superseded correction, asOf beyond the feed's lead from the verdict's own time, the governor's
// clearEntry barring the removed verdict), the verdictTs in Feeds.latest(), and the
// service adapters that read them (feed-runner multiplier observer, panel-desk feed entry, orchestrator panel wiring).
// The split notice's effective date is two weeks after chain time, so the run does not depend on the calendar.
// Prereq: anvil running + `bun scripts/deploy-local.ts`. Usage: bun scripts/e2e-core.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEventLogs, toHex, type Abi, type Address, type Hex } from "viem";
import { x25519 } from "@noble/curves/ed25519.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  JurorClass,
  ProvenanceKind,
  Role,
  SchemaId,
  VerdictStatus,
  ZERO32,
  answerHash,
  computeQueryId,
  docCommit,
  docHash,
  privatePayloadHash,
  toBytes32String,
  provenanceHash,
  fetchedTranscriptHash,
  submittedTranscriptHash,
  tlsTranscriptHash,
  seatClass,
  spansRoot,
  votesHash,
  verdictId as computeVerdictId,
  type Provenance,
  type SeatInput,
} from "@mochi/core";
import { buildPayload, getSchema, normalizeAnswer, normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { payerCommit, privateResultMismatch } from "@mochi/protocol";
import { buildVerdictHashes, runConsensus } from "@mochi/consensus";
import { MockTeeProvider, quoteHash, signJurorAnswer, signProvenance, signVerdictAttestation } from "@mochi/tee";
import * as A from "@mochi/chain";
import { chainFor, type Deployment } from "@mochi/chain";
import { DEV_KEYS } from "./deploy-local.ts";
import { DrandClient, DRAND_QUICKNET, ensureBeacon } from "@mochi/chain";
import { AspTree, StateTreeSync, STATE_ABI, buildWithdrawalProof, depositUSDG, generateNote, openShieldedPaymentFor } from "@mochi/privacy";
import { POSTMAN_ABI, PLACEHOLDER_ASP_CID } from "@mochi/privacy/postman";
import { createStockTokenReader } from "../services/feed-runners/src/adapters/chain.ts";
import { feedEntry } from "../services/panel-desk/src/adapters/chain.ts";
import { createChainAdapter } from "../services/orchestrator/src/adapters/chain.ts";

// Keys: on anvil the well-known dev accounts; on any other network every role uses the key file given by
// MOCHI_KEY_FILE (e.g. ~/.config/mochi/testnet-deployer.json), which the deploy script also used for all roles.
const KEY_FILE = process.env.MOCHI_KEY_FILE;
const fileKey: Hex | undefined = KEY_FILE ? (JSON.parse(readFileSync(KEY_FILE, "utf8")) as { privateKey: Hex }).privateKey : undefined;
const K = {
  deployer: fileKey ?? DEV_KEYS.deployer,
  attestor: fileKey ?? DEV_KEYS.attestor,
  orchestrator: fileKey ?? DEV_KEYS.orchestrator,
  feedRunner: fileKey ?? DEV_KEYS.feedRunner,
};
const PAYER_KEY: Hex = fileKey ?? "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5
const ATTACKER_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // anvil #6 (anvil only)
const MEASUREMENT = keccak256(toHex("mochi-mock-enclave-v1"));
const mockRoot = privateKeyToAccount(keccak256(toHex("mochi-mock-root")));

const DEPLOYMENT_PATH = process.env.MOCHI_DEPLOYMENT ?? "deployments/local.json";
const dep = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
const chain = chainFor(dep);
const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
const wallet = (pk: Hex) => createWalletClient({ chain, transport: http(dep.rpcUrl), account: privateKeyToAccount(pk) });
const admin = wallet(K.deployer);
const attestor = wallet(K.attestor);
const orchestrator = wallet(K.orchestrator);
const payer = wallet(PAYER_KEY);
const C = dep.contracts;
const drand = dep.randomness?.kind === "drand" ? new DrandClient({ relays: dep.randomness.relays, chainHash: dep.randomness.chainHash, info: { ...DRAND_QUICKNET, ...dep.randomness }, currentTime: async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp) }) : undefined;

async function send(w: ReturnType<typeof wallet>, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args } as never);
  const hash = await w.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const isAnvil = dep.chainId === 31337;
const mine = (blocks = 1) => pub.request({ method: "anvil_mine" as never, params: [toHex(blocks)] as never });
/** Anvil only: move chain time forward (block timestamps can repeat within one wall-clock second otherwise). */
const advance = async (seconds: number) => { await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never }); await mine(1); };
/** The revert text of a failed write ("applied" when it went through). */
const outcome = (write: Promise<unknown>) => write.then(() => "applied", (e: unknown) => String(e));
/** Seal once the randomness seed is available. On anvil: mine. Elsewhere (Arbitrum/RHC: block.number is the L1 block
 *  number, ~12s): retry until the seal tx stops reverting with SeedNotReady. */
async function sealWhenReady(queryId: Hex) {
  if (dep.randomness?.kind === "drand") {
    if (!drand) throw new Error("drand client missing");
    const query = await read<{ sealBlock: bigint }>(C.queryEscrow, A.QueryEscrowAbi as Abi, "getQuery", [queryId]);
    for (;;) {
      const result = await ensureBeacon({ publicClient: pub, walletClient: orchestrator, account: orchestrator.account } as never, C.randomness, query.sealBlock, drand);
      if (result !== "not-published") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return send(orchestrator, C.queryEscrow, A.QueryEscrowAbi as Abi, "seal", [queryId]);
  }
  if (isAnvil) {
    await mine(2);
    return send(orchestrator, C.queryEscrow, A.QueryEscrowAbi as Abi, "seal", [queryId]);
  }
  for (let i = 0; i < 60; i++) {
    try {
      return await send(orchestrator, C.queryEscrow, A.QueryEscrowAbi as Abi, "seal", [queryId]);
    } catch (e) {
      if (!/SeedNotReady|0x484e3916/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw new Error("seal: seed never became ready");
}
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

async function main() {
  console.log("1. Enclave keys (mock TEE) → registry");
  const provider = (seed: string) => new MockTeeProvider({ seed: keccak256(toHex(seed)), measurement: MEASUREMENT, mockRoot });
  const intake = provider("e2e-intake");
  const consensus = provider("e2e-consensus");
  const jurors = new Map<Address, { tee: MockTeeProvider; cls: JurorClass }>();
  for (const cls of [0, 1, 2, 3, 4] as JurorClass[]) {
    for (let i = 0; i < 2; i++) {
      const tee = provider(`e2e-juror-${cls}-${i}`);
      jurors.set(tee.signer().address.toLowerCase() as Address, { tee, cls });
    }
  }
  const R = A.JurorRegistryAbi as Abi;
  const already = await read<boolean>(C.jurorRegistry, R, "isActive", [intake.signer().address, Role.INTAKE]);
  if (!already) {
    for (const role of [Role.JUROR, Role.INTAKE, Role.CONSENSUS]) await send(admin, C.jurorRegistry, R, "setMeasurement", [MEASUREMENT, role, true]);
    await send(admin, C.jurorRegistry, R, "registerServiceKey", [intake.signer().address, admin.account.address, MEASUREMENT, Role.INTAKE]);
    await send(admin, C.jurorRegistry, R, "registerServiceKey", [consensus.signer().address, admin.account.address, MEASUREMENT, Role.CONSENSUS]);
    await send(admin, C.mochiToken, A.MochiTokenAbi as Abi, "approve", [C.jurorRegistry, 2n ** 255n]);
    for (const { tee, cls } of jurors.values()) {
      const digest = await read<Hex>(C.jurorRegistry, R, "enrollmentDigest", [admin.account.address, tee.signer().address, MEASUREMENT, cls]);
      const keySig = await tee.signer().signMessage({ message: { raw: digest } });
      await send(admin, C.jurorRegistry, R, "enrollJuror", [tee.signer().address, MEASUREMENT, cls, 25_000n * 10n ** 18n, keySig]);
    }
  }
  const allKeys = [intake.signer().address, consensus.signer().address, ...[...jurors.values()].map((j) => j.tee.signer().address)];
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send(attestor, C.jurorRegistry, R, "refreshAttestation", [allKeys, now + 3600n * 24n]);
  ok(await read(C.jurorRegistry, R, "isActive", [intake.signer().address, Role.INTAKE]), "intake key active (INTAKE)");
  ok(await read(C.jurorRegistry, R, "isActive", [consensus.signer().address, Role.CONSENSUS]), "consensus key active (CONSENSUS)");

  console.log("2. Intake: document → docCommit, provenance grant signed by the intake enclave key for one opener");
  // 00:00 UTC two weeks after chain time: the change is still pending when the feed is updated (the crosscheck reads
  // the token's live multiplier) and the asOf is well inside the SPLIT feed's lead.
  const effectiveAt = ((await pub.getBlock({ blockTag: "latest" })).timestamp / 86_400n + 14n) * 86_400n;
  const effectiveDate = new Date(Number(effectiveAt) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  const text = `Acme Corp (NASDAQ: ACME) today announced a 2-for-1 stock split, effective ${effectiveDate}.`;
  const bytes = new TextEncoder().encode(text);
  const salt = ZERO32;
  const dc = docCommit(salt, docHash(bytes));
  const chainNow = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const schemaVersion = async (schemaId: number) => Number(await read<number>(C.schemaRegistry, A.SchemaRegistryAbi as Abi, "latest", [schemaId]));
  /** What the intake enclave signs after the document owner sealed { opener, payerCommit, consent, nonce } to it. */
  const grant = async (g: Pick<Provenance, "docCommit" | "opener" | "schemaId" | "nonce"> & Partial<Provenance>): Promise<Provenance> => ({
    kind: ProvenanceKind.SUBMITTED, originId: ZERO32, fetchedAt: 0n, tokensK: 1, transcriptHash: ZERO32, schemaVersion: await schemaVersion(g.schemaId),
    paramsHash: ZERO32, payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: false, expiry: (await chainNow()) + 900n, ...g,
  });
  const nonce = BigInt(Date.now());
  // A SUBMITTED grant signs the intake's reading of the upload (salted content type, text and raw params).
  const prov = await grant({ docCommit: dc, opener: payer.account.address, schemaId: SchemaId.SPLIT, nonce, transcriptHash: submittedTranscriptHash({ salt, contentType: "text/plain", text, params: {} }) });
  const intakeSig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, prov);

  console.log("3. Payer opens a public SPLIT query (N=3) with USDG");
  const E = A.QueryEscrowAbi as Abi;
  await send(admin, C.usdg, A.MockUSDGAbi as Abi, "mint", [payer.account.address, 1_000n * 10n ** 6n]);
  await send(payer, C.usdg, A.MockUSDGAbi as Abi, "approve", [C.queryEscrow, 2n ** 255n]);
  const params = { n: 3, refundTo: payer.account.address };
  await send(payer, C.queryEscrow, E, "openWithUSDG", [params, prov, intakeSig]);
  const queryId = await read<Hex>(C.queryEscrow, E, "computeQueryId", [payer.account.address, dc, nonce]);
  ok(true, `query opened ${queryId.slice(0, 18)}… (escrow accepted the TS-signed EIP-712 Provenance)`);
  ok(queryId === computeQueryId({ chainId: dep.chainId, escrow: C.queryEscrow, opener: payer.account.address, docCommit: dc, nonce }), "queryId derived locally (core computeQueryId, as the SDK does) equals QueryEscrow.computeQueryId");
  const opened = await read<{ provenanceHash: Hex }>(C.queryEscrow, E, "getQuery", [queryId]);
  ok(opened.provenanceHash === provenanceHash(prov), "escrow's provenanceHash (the intake record key) equals the TS struct hash of the SUBMITTED grant");
  const reuse = await send(payer, C.queryEscrow, E, "openWithUSDG", [params, prov, intakeSig]).then(() => "opened", (e) => String(e));
  ok(reuse.includes("QueryExists"), "the same provenance grant cannot open a second query (QueryExists)");

  console.log("4. Seal (seed from a future block) → selected seats");
  await sealWhenReady(queryId);
  const seats = (await read<Address[]>(C.queryEscrow, E, "jurorsOf", [queryId])).map((a) => a.toLowerCase() as Address);
  const q = await read<{ schemaVersion: number; openedAt: bigint }>(C.queryEscrow, E, "getQuery", [queryId]);
  ok(seats.length === 3 && seats.every((s, i) => jurors.get(s)?.cls === seatClass(i)), "3 seats, each of the right class");

  console.log("5. Jurors (mock enclaves) extract, normalize, sign");
  const def = getSchema(SchemaId.SPLIT);
  const raw = {
    fields: { ticker: "ACME", ratio_num: "2", ratio_den: "1", effective_date: effectiveDate },
    evidence: { ticker: "NASDAQ: ACME", ratio_num: "2-for-1", ratio_den: "2-for-1", effective_date: effectiveDate },
    confidence: { ticker: 0.99, ratio_num: 0.99, ratio_den: 0.99, effective_date: 0.98 },
  };
  const seatInputs: SeatInput[] = [];
  const votes: { juror: Address; answerHash: Hex; spansRoot: Hex; quoteHash: Hex; sig: Hex }[] = [];
  for (const [seat, addr] of seats.entries()) {
    const { tee, cls } = jurors.get(addr)!;
    const body = normalizeAnswer(def, raw, text);
    const ah = answerHash({ salt, schemaId: def.id, schemaVersion: Number(q.schemaVersion), fields: body.fields });
    const sr = spansRoot(body.spans);
    const qh = quoteHash(await tee.quote());
    const sig = await signJurorAnswer(tee.signer(), dep.chainId, C.verdicts, {
      queryId, docCommit: dc, schemaId: def.id, schemaVersion: Number(q.schemaVersion), answerHash: ah, spansRoot: sr, quoteHash: qh,
    });
    votes.push({ juror: addr, answerHash: ah, spansRoot: sr, quoteHash: qh, sig });
    seatInputs.push({ seat, juror: addr, jurorClass: cls, timedOut: false, answer: body });
  }

  console.log("6. Consensus enclave: runConsensus → hashes → payload → VerdictAttestation");
  const result = runConsensus(def, seatInputs);
  ok(result.status === VerdictStatus.VERDICT && result.agreementBps === 10000, "unanimous VERDICT at 10000 bps");
  const { answerHash: vah, answerJson, evidenceRoot } = buildVerdictHashes(def, result, seatInputs, salt);
  const payload = buildPayload(def, result.agreed, {}, { openedAt: BigInt(q.openedAt) });
  const verdictInput = {
    queryId, round: 0, status: result.status, agreementBps: result.agreementBps,
    dissentMask: result.dissentMask, timeoutMask: result.timeoutMask,
    answerHash: vah, payloadHash: payload.payloadHash, evidenceRoot,
  };
  const consensusSig = await signVerdictAttestation(consensus.signer(), dep.chainId, C.verdicts, verdictInput, votesHash(votes));

  console.log("7. Untrusted relay posts; the contract re-verifies everything");
  const V = A.MochiVerdictsAbi as Abi;
  await send(orchestrator, C.verdicts, V, "post", [verdictInput, votes, consensusSig]);
  const vid = computeVerdictId(queryId, 0);
  const onchain = await read<{ status: number; answerHash: Hex; payloadHash: Hex; agreementBps: number }>(C.verdicts, V, "getVerdict", [vid]);
  ok(Number(onchain.status) === 1, "verdict stored on-chain as VERDICT");
  ok(onchain.payloadHash === payload.payloadHash, "payloadHash matches the TS ABI-encoded SplitBody payload");
  ok(await read(C.verdicts, V, "verify", [vid, toHex(answerJson)]), "MochiVerdicts.verify(answerJson) === true");
  const qAfter = await read<{ status: number }>(C.queryEscrow, E, "getQuery", [queryId]);
  ok(Number(qAfter.status) === 3, "query DECIDED; escrow settled");
  const claim = await read<bigint>(C.queryEscrow, E, "claimable", [admin.account.address]);
  ok(claim > 0n, `juror operator claimable = ${claim} (µUSDG)`);

  console.log("8. Feed: FETCHED split notice → openFeed → post → Feeds.update with on-chain StockTokenCrosscheck");
  const feedRunner = wallet(K.feedRunner);
  await send(admin, C.usdg, A.MockUSDGAbi as Abi, "mint", [feedRunner.account.address, 1_000n * 10n ** 6n]);
  await send(feedRunner, C.usdg, A.MockUSDGAbi as Abi, "approve", [C.queryEscrow, 2n ** 255n]);
  await send(feedRunner, C.queryEscrow, E, "fundFeedBudget", [100n * 10n ** 6n]);
  const token = await (async () => {
    const hash = await admin.deployContract({ abi: A.MockStockTokenAbi as Abi, bytecode: A.MockStockTokenBytecode, args: [] as never });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  })();
  await send(admin, token, A.MockStockTokenAbi as Abi, "setSchedule", [10n ** 18n, 2n * 10n ** 18n, effectiveAt]);
  const tickerKey = payload.subjectKey;
  await send(admin, C.stockTokenCrosscheck, A.StockTokenCrosscheckAbi as Abi, "setToken", [tickerKey, token]);
  const { originId } = await import("@mochi/core");
  /** One standing feed query on the split notice: intake grant → openFeed → seal → jurors → consensus → post. */
  const feedVerdict = async (fnonce: bigint) => {
    const fprov = await grant({ docCommit: dc, opener: feedRunner.account.address, schemaId: SchemaId.SPLIT, nonce: fnonce, kind: ProvenanceKind.FETCHED, originId: originId("127.0.0.1"), fetchedAt: now, transcriptHash: keccak256(toHex("tls-transcript")) });
    const fsig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, fprov);
    await send(feedRunner, C.queryEscrow, E, "openFeed", [{ n: 3, refundTo: feedRunner.account.address }, fprov, fsig]);
    const fq = await read<Hex>(C.queryEscrow, E, "computeQueryId", [feedRunner.account.address, dc, fnonce]);
    await sealWhenReady(fq);
    const fseats = (await read<Address[]>(C.queryEscrow, E, "jurorsOf", [fq])).map((a) => a.toLowerCase() as Address);
    const fq0 = await read<{ schemaVersion: number; openedAt: bigint }>(C.queryEscrow, E, "getQuery", [fq]);
    const fInputs: SeatInput[] = [];
    const fVotes: typeof votes = [];
    for (const [seat, addr] of fseats.entries()) {
      const { tee, cls } = jurors.get(addr)!;
      const body = normalizeAnswer(def, raw, text);
      const ah = answerHash({ salt, schemaId: def.id, schemaVersion: Number(fq0.schemaVersion), fields: body.fields });
      const sr = spansRoot(body.spans);
      const qh = quoteHash(await tee.quote());
      const sig = await signJurorAnswer(tee.signer(), dep.chainId, C.verdicts, {
        queryId: fq, docCommit: dc, schemaId: def.id, schemaVersion: Number(fq0.schemaVersion), answerHash: ah, spansRoot: sr, quoteHash: qh,
      });
      fVotes.push({ juror: addr, answerHash: ah, spansRoot: sr, quoteHash: qh, sig });
      fInputs.push({ seat, juror: addr, jurorClass: cls, timedOut: false, answer: body });
    }
    const fres = runConsensus(def, fInputs);
    const fh = buildVerdictHashes(def, fres, fInputs, salt);
    const fpay = buildPayload(def, fres.agreed, {}, { openedAt: BigInt(fq0.openedAt) });
    const fin = { queryId: fq, round: 0, status: fres.status, agreementBps: fres.agreementBps, dissentMask: fres.dissentMask,
      timeoutMask: fres.timeoutMask, answerHash: fh.answerHash, payloadHash: fpay.payloadHash, evidenceRoot: fh.evidenceRoot };
    const fsigC = await signVerdictAttestation(consensus.signer(), dep.chainId, C.verdicts, fin, votesHash(fVotes));
    await send(orchestrator, C.verdicts, V, "post", [fin, fVotes, fsigC]);
    return { vid: computeVerdictId(fq, 0), payload: fpay.payload, payloadHash: fpay.payloadHash };
  };
  const fnonce = nonce + 1n;
  const first = await feedVerdict(fnonce);
  const fvid = first.vid, fpay = first;
  ok(fpay.payloadHash === keccak256(fpay.payload), "public/feed payloadHash stays keccak256(payload)");
  const splitFeed = keccak256(toHex("corp-actions.split@RHC"));
  const F = A.FeedsAbi as Abi;
  type FeedEntry = { verdictId: Hex; asOf: bigint; updatedAt: bigint; verdictTs: bigint; payload: Hex };
  await send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, fvid, fpay.payload]);
  const entry = await read<FeedEntry>(C.feeds, F, "latest", [splitFeed, tickerKey]);
  ok(entry.verdictId === fvid, "corp-actions.split@RHC updated — Solidity crosscheck decoded the TS SplitBody and matched the token's multiplier schedule");
  ok(entry.asOf === effectiveAt, `feed asOf = effective date (${new Date(Number(effectiveAt) * 1000).toISOString().slice(0, 10)})`);
  const fv = await read<{ ts: bigint }>(C.verdicts, V, "getVerdict", [fvid]);
  ok(entry.verdictTs === BigInt(fv.ts) && entry.verdictTs <= entry.updatedAt && entry.payload === fpay.payload,
    "Feeds.latest() carries verdictTs = the verdict's on-chain time (readers age the value from min(asOf, verdictTs))");
  const decoded = feedEntry(entry);
  ok(decoded?.verdictId === fvid && decoded.verdictTs === entry.verdictTs && decoded.asOf === entry.asOf, "panel-desk adapter decodes the new Feeds.latest() entry");

  console.log("8b. Feeds.update revert rules: re-post, superseded correction, asOf beyond the feed's lead");
  ok((await outcome(send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, fvid, fpay.payload]))).includes("VerdictAlreadyApplied"),
    "re-posting the verdict already in the feed reverts VerdictAlreadyApplied");
  if (isAnvil) {
    // A correction: a second feed query on the same notice gives a newer verdict for the same asOf, which replaces the
    // entry; replaying the superseded one would roll the correction back and reverts.
    await advance(2);
    const second = await feedVerdict(fnonce + 1_000n);
    await send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, second.vid, second.payload]);
    ok((await read<FeedEntry>(C.feeds, F, "latest", [splitFeed, tickerKey])).verdictId === second.vid, "a newer verdict for the same asOf replaces the entry (correction)");
    ok((await outcome(send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, fvid, fpay.payload]))).includes("StaleCorrection"),
      "replaying the superseded verdict reverts StaleCorrection (no rollback)");
    // With the feed's lead cut to one day, the two-week-ahead asOf is too far ahead (checked before any other rule).
    const lead = await read<bigint>(C.feeds, F, "maxLeadOf", [splitFeed]);
    await send(admin, C.feeds, F, "setMaxLead", [splitFeed, 86_400n]);
    ok((await outcome(send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, second.vid, second.payload]))).includes("AsOfTooFarAhead"),
      "an asOf beyond verdict.ts + maxLeadOf(feed) reverts AsOfTooFarAhead");
    await send(admin, C.feeds, F, "setMaxLead", [splitFeed, lead]);
    // The governor (timelock) can remove a wrong entry: its verdict is barred for good, so the key takes any eligible
    // verdict again, including one with a lower asOf.
    await send(admin, C.feeds, F, "clearEntry", [splitFeed, tickerKey]);
    ok((await read<FeedEntry>(C.feeds, F, "latest", [splitFeed, tickerKey])).verdictId === ZERO32, "the governor's clearEntry removes the entry");
    ok(await read<boolean>(C.feeds, F, "isBarred", [splitFeed, second.vid]), "the cleared verdict is barred from the feed");
    ok((await outcome(send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, second.vid, second.payload]))).includes("VerdictBarred"),
      "pushing the cleared verdict again reverts VerdictBarred");
    await send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, fvid, fpay.payload]);
    ok((await read<FeedEntry>(C.feeds, F, "latest", [splitFeed, tickerKey])).verdictId === fvid, "after clearEntry another eligible verdict applies");

    console.log("8c. Service adapters: feed-runner multiplier observer and orchestrator panel wiring");
    const obsToken = await (async () => {
      const hash = await admin.deployContract({ abi: A.MockStockTokenAbi as Abi, bytecode: A.MockStockTokenBytecode, args: [] as never });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    })();
    const obsKey = toBytes32String(`OBSV-${nonce}`); // unique per run: the script can run again on the same chain
    const X = A.StockTokenCrosscheckAbi as Abi;
    const observer = createStockTokenReader(DEPLOYMENT_PATH, K.feedRunner);
    const nowSec = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
    ok(await observer.observeMultiplier!(obsKey, await nowSec()) === "unregistered", "observer: a ticker without a token on the crosscheck is reported, nothing sent");
    // send() leaves the gas limit to eth_estimateGas. setToken takes the first observation itself and reverts if it
    // cannot, so a successful registration always carries it, whatever limit the estimate produced.
    const setTokenHash = await send(admin, C.stockTokenCrosscheck, X, "setToken", [obsKey, obsToken]);
    const setTokenLogs = parseEventLogs({ abi: X, eventName: "MultiplierObserved", logs: (await pub.getTransactionReceipt({ hash: setTokenHash })).logs });
    const registered = await read<{ observedAt: bigint; scheduledAt: bigint; multiplier: bigint }>(C.stockTokenCrosscheck, X, "observationOf", [obsKey]);
    ok(setTokenLogs.length === 1 && registered.observedAt > 0n && registered.multiplier === 10n ** 18n && registered.scheduledAt === 0n,
      "setToken (estimated gas) took the first observation: MultiplierObserved emitted, observationOf(ticker) recorded");
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    ok(await observer.observeMultiplier!(obsKey, await nowSec()) === "current" && await pub.getBlockNumber({ cacheTime: 0 }) === head,
      "observer: the registration observation is current, so its first pass sends nothing");
    // The issuer's immediate change: effective at once, never pending, so recordBaseline() cannot see it.
    const changeAt = (await nowSec()) + 1n;
    await send(admin, obsToken, A.MockStockTokenAbi as Abi, "setSchedule", [10n ** 18n, 3n * 10n ** 18n, changeAt]);
    await advance(2);
    ok(await observer.observeMultiplier!(obsKey, await nowSec()) === "observed", "observer: the changed multiplier is observed (one transaction)");
    const observation = await read<{ multiplier: bigint; scheduledAt: bigint }>(C.stockTokenCrosscheck, X, "observationOf", [obsKey]);
    ok(observation.multiplier === 3n * 10n ** 18n && observation.scheduledAt === changeAt, "observationOf(ticker) records the new multiplier and schedule");
    ok(await read<bigint>(C.stockTokenCrosscheck, X, "baselineOf", [obsKey, changeAt]) === 10n ** 18n,
      "the immediate change's baseline came from the observation taken before it (a SPLIT verdict can be ratio-checked)");
    ok(await observer.observeMultiplier!(obsKey, await nowSec()) === "current", "observer: current again afterwards");
    const orchestratorChain = createChainAdapter(dep, K.orchestrator, K.feedRunner);
    const wired = await orchestratorChain.escrowPanel();
    const expected = (dep as Deployment & { panelEscalation?: string }).panelEscalation === "off" ? `0x${"00".repeat(20)}` : C.panel.toLowerCase();
    ok(wired.toLowerCase() === expected && typeof await orchestratorChain.usdgAllowance(C.panel) === "bigint",
      `orchestrator adapter reads QueryEscrow.panel() (${wired === `0x${"00".repeat(20)}` ? "escalation off" : "PanelEscalation"}) and the feed runner's allowance`);
  }

  console.log("9. Feed poisoning attempt: the public (non-feed) verdict for the same document is rejected");
  ok((await outcome(send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, vid, payload.payload]))).includes("VerdictNotEligible"),
    "Feeds.update rejects a verdict from a non-FEED query (VerdictNotEligible)");

  console.log("9b. Private FREEFORM claim check: bound grant, copied-grant replay rejected, salted payloadHash on-chain");
  const claimText = "Claim: the bridge reopened on 3 March. Source: the city notice says the bridge reopened on 3 March.";
  const claimParams = { question: "Is the claim supported by the source?", answer_type: "STRING" };
  const pdef = resolveSchema(SchemaId.FREEFORM_FACT, claimParams);
  const pnorm = normalizeParams(pdef, claimParams);
  if (!pnorm.ok) throw new Error("FREEFORM params invalid");
  const psalt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const pdc = docCommit(psalt, docHash(new TextEncoder().encode(claimText)));
  const resultKey = x25519.keygen();
  const pnonce = nonce + 2n;
  const pprov = await grant({
    docCommit: pdc, opener: payer.account.address, schemaId: SchemaId.FREEFORM_FACT, nonce: pnonce, paramsHash: paramsHash(pnorm.params),
    payerCommit: payerCommit(toHex(resultKey.publicKey)), isPublic: false,
  });
  const psig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, pprov);
  await send(payer, C.queryEscrow, E, "openWithUSDG", [{ n: 3, refundTo: payer.account.address }, pprov, psig]);
  const pq = await read<Hex>(C.queryEscrow, E, "computeQueryId", [payer.account.address, pdc, pnonce]);
  if (isAnvil) {
    // An observer copies (prov, intakeSig) from the payer's public open transaction and tries to open their own query.
    const attacker = wallet(ATTACKER_KEY);
    await send(admin, C.usdg, A.MockUSDGAbi as Abi, "mint", [attacker.account.address, 1_000n * 10n ** 6n]);
    await send(attacker, C.usdg, A.MockUSDGAbi as Abi, "approve", [C.queryEscrow, 2n ** 255n]);
    const replay = await send(attacker, C.queryEscrow, E, "openWithUSDG", [{ n: 3, refundTo: attacker.account.address }, pprov, psig]).then(() => "opened", (e) => String(e));
    ok(replay.includes("NotAuthorized"), "a copied private provenance grant cannot be used by another opener (NotAuthorized)");
  }
  await sealWhenReady(pq);
  const pseats = (await read<Address[]>(C.queryEscrow, E, "jurorsOf", [pq])).map((a) => a.toLowerCase() as Address);
  const pq0 = await read<{ schemaVersion: number; openedAt: bigint; payerCommit: Hex; isPublic: boolean }>(C.queryEscrow, E, "getQuery", [pq]);
  ok(!pq0.isPublic && pq0.payerCommit === payerCommit(toHex(resultKey.publicKey)), "query took isPublic=false and the payer's key commitment from the signed grant");
  const pInputs: SeatInput[] = [];
  const pVotes: typeof votes = [];
  const praw = { fields: { answer: "supported" }, evidence: { answer: "the bridge reopened on 3 March" }, confidence: { answer: 0.9 } };
  for (const [seat, addr] of pseats.entries()) {
    const { tee, cls } = jurors.get(addr)!;
    const body = normalizeAnswer(pdef, praw, claimText);
    const ah = answerHash({ salt: psalt, schemaId: pdef.id, schemaVersion: Number(pq0.schemaVersion), fields: body.fields });
    const sr = spansRoot(body.spans);
    const qh = quoteHash(await tee.quote());
    const sig = await signJurorAnswer(tee.signer(), dep.chainId, C.verdicts, { queryId: pq, docCommit: pdc, schemaId: pdef.id, schemaVersion: Number(pq0.schemaVersion), answerHash: ah, spansRoot: sr, quoteHash: qh });
    pVotes.push({ juror: addr, answerHash: ah, spansRoot: sr, quoteHash: qh, sig });
    pInputs.push({ seat, juror: addr, jurorClass: cls, timedOut: false, answer: body });
  }
  const pres = runConsensus(pdef, pInputs);
  const ph = buildVerdictHashes(pdef, pres, pInputs, psalt);
  const ppay = buildPayload(pdef, pres.agreed, pnorm.params, { openedAt: BigInt(pq0.openedAt), privateSalt: psalt });
  const pin = { queryId: pq, round: 0, status: pres.status, agreementBps: pres.agreementBps, dissentMask: pres.dissentMask,
    timeoutMask: pres.timeoutMask, answerHash: ph.answerHash, payloadHash: ppay.payloadHash, evidenceRoot: ph.evidenceRoot };
  await send(orchestrator, C.verdicts, V, "post", [pin, pVotes, await signVerdictAttestation(consensus.signer(), dep.chainId, C.verdicts, pin, votesHash(pVotes))]);
  const pv = await read<{ status: number; answerHash: Hex; payloadHash: Hex }>(C.verdicts, V, "getVerdict", [computeVerdictId(pq, 0)]);
  ok(Number(pv.status) === 1 && pv.payloadHash === privatePayloadHash(psalt, ppay.payload), "private verdict on-chain with payloadHash = H(tag ‖ salt ‖ keccak256(payload))");
  const candidates = ["supported", "contradicted", "missing_context", "insufficient_evidence"].map((answer) =>
    keccak256(buildPayload(pdef, { answer: { t: "str", v: answer } }, pnorm.params, { openedAt: BigInt(pq0.openedAt) }).payload));
  ok(!candidates.includes(pv.payloadHash), "hashing the four candidate answers no longer reveals the private outcome");
  ok(privateResultMismatch({ salt: psalt, answerJson: ph.answerJson, payload: ppay.payload }, pv) === undefined, "payer-side check (answerHash + salted payloadHash) accepts the decrypted result");

  console.log("9c. Private URL grant: FETCHED transcriptHash salted with the query salt, accepted by the escrow");
  const fetchedBytes = new TextEncoder().encode(claimText);
  const tls = tlsTranscriptHash({ host: "127.0.0.1", finalUrl: "https://127.0.0.1/claim-notice", status: 200, contentType: "text/plain", docHash: docHash(fetchedBytes), certFingerprints: [] });
  const fsalt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const fpdc = docCommit(fsalt, docHash(fetchedBytes));
  const fpnonce = nonce + 3n;
  const fpprov = await grant({
    docCommit: fpdc, opener: payer.account.address, schemaId: SchemaId.FREEFORM_FACT, nonce: fpnonce, paramsHash: paramsHash(pnorm.params),
    kind: ProvenanceKind.FETCHED, originId: originId("127.0.0.1"), fetchedAt: now, transcriptHash: fetchedTranscriptHash({ salt: fsalt, tlsTranscriptHash: tls }),
    payerCommit: payerCommit(toHex(x25519.keygen().publicKey)), isPublic: false,
  });
  ok(fpprov.transcriptHash !== tls, "the private FETCHED grant carries H(tag, salt, tls), not the TLS transcript a guesser could rebuild");
  await send(payer, C.queryEscrow, E, "openWithUSDG", [{ n: 3, refundTo: payer.account.address }, fpprov, await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, fpprov)]);
  const fpq = computeQueryId({ chainId: dep.chainId, escrow: C.queryEscrow, opener: payer.account.address, docCommit: fpdc, nonce: fpnonce });
  const fpOpened = await read<{ provenanceHash: Hex; provenanceKind: number; isPublic: boolean }>(C.queryEscrow, E, "getQuery", [fpq]);
  ok(fpOpened.provenanceHash === provenanceHash(fpprov) && Number(fpOpened.provenanceKind) === ProvenanceKind.FETCHED && !fpOpened.isPublic,
    "escrow opened the private FETCHED query; its provenanceHash equals the TS struct hash of the salted-transcript grant");

  if (dep.privacy) {
    console.log("10. Privacy pool: deposit USDG → deployer approves ASP root → Groth16 proof → openShielded");
    const P = dep.privacy;
    const relayFile = process.env.MOCHI_RELAYER_KEY_FILE;
    const relayKey: Hex = relayFile ? (JSON.parse(readFileSync(relayFile, "utf8")) as { privateKey: Hex }).privateKey : K.deployer;
    // The payer deposits from its own (public) address; a DIFFERENT key (the relayer) later submits openShielded, so the
    // payment cannot be linked to the deposit on-chain. The relayer never holds or touches the deposited funds.
    const relayer = wallet(relayKey);
    if (!relayFile || relayer.account.address.toLowerCase() === admin.account.address.toLowerCase()) {
      console.warn("WARNING: privacy-pool test is using the deployer key as relayer; this mode is not unlinkable.");
    }
    const fees = await read<[bigint, bigint]>(C.queryEscrow, A.QueryEscrowAbi as Abi, "quote", [SchemaId.SPLIT, 3, 1]);
    const amount = fees[0] + fees[1];
    const note = generateNote();
    await send(admin, C.usdg, A.MockUSDGAbi as Abi, "mint", [admin.account.address, amount + 1_000_000n]);
    const deposit = await depositUSDG({ publicClient: pub as never, walletClient: admin as never }, P.entrypoint, C.usdg, amount + 1_000_000n, note, P.pool);
    const deposits = await pub.getLogs({ address: P.pool, event: STATE_ABI[1], fromBlock: BigInt(dep.startBlock) });
    const asp = new AspTree();
    for (const item of deposits) if (item.args._label !== undefined) asp.add(item.args._label);
    await send(admin, P.entrypoint, POSTMAN_ABI as Abi, "updateRoot", [asp.root, PLACEHOLDER_ASP_CID]);
    asp.assertRoot(await read<bigint>(P.entrypoint, POSTMAN_ABI as Abi, "latestRoot"));
    const nonce = BigInt(Date.now());
    const queryId = await read<Hex>(C.queryEscrow, A.QueryEscrowAbi as Abi, "computeQueryId", [relayer.account.address, dc, nonce]);
    const proofBinding = openShieldedPaymentFor(P.adapter, C.queryEscrow, queryId, { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n], pubSignals: Array(8).fill(0n) }).withdrawal;
    const state = await new StateTreeSync().rebuild(pub as never, P.pool, BigInt(dep.startBlock));
    state.assertRoot(await read<bigint>(P.pool, parseAbi(["function currentRoot() view returns (uint256)"]) as Abi, "currentRoot"));
    const built = await buildWithdrawalProof({ note, deposit, stateTree: state, aspTree: asp, withdrawal: proofBinding, scope: BigInt(P.scope), withdrawnValue: amount });
    const payment = openShieldedPaymentFor(P.adapter, C.queryEscrow, queryId, built.proof);
    // The relayer submits openShielded, so the intake grant names the relayer as its opener.
    const relayProv = await grant({ docCommit: dc, opener: relayer.account.address, schemaId: SchemaId.SPLIT, nonce });
    const relaySig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, relayProv);
    const params = { n: 3, refundTo: relayer.account.address };
    const beforePoolPayment = await read<bigint>(C.usdg, parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi, "balanceOf", [C.queryEscrow]);
    const openHash = await send(relayer, C.queryEscrow, E, "openShielded", [params, relayProv, relaySig, payment.nullifier, payment.proof]);
    const openTx = await pub.getTransaction({ hash: openHash });
    ok(openTx.from.toLowerCase() === relayer.account.address.toLowerCase() && (!relayFile || openTx.from.toLowerCase() !== admin.account.address.toLowerCase()),
      `openShielded sent by the relayer ${relayer.account.address.slice(0, 10)}…, not the depositor`);
    const opened = await read<{ paid: bigint }>(C.queryEscrow, E, "getQuery", [queryId]);
    const afterPoolPayment = await read<bigint>(C.usdg, parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi, "balanceOf", [C.queryEscrow]);
    ok(opened.paid === amount && afterPoolPayment - beforePoolPayment === amount, `openShielded credited exactly ${amount} USDG units`);
  }

  console.log("\nE2E-CORE PASSED: first verdict on-chain + first AI oracle feed update, from TS-built enclave artifacts.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
