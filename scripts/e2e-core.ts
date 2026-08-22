// Core end-to-end on anvil WITHOUT the HTTP services: proves every TS encoding (EIP-712 provenance / juror answers /
// verdict attestation, answerHash, votesHash, payload ABI, enrollment proof-of-possession) matches the contracts.
// Prereq: anvil running + `bun scripts/deploy-local.ts`. Usage: bun scripts/e2e-core.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  JurorClass,
  ProvenanceKind,
  Role,
  SchemaId,
  VerdictStatus,
  ZERO32,
  answerHash,
  docCommit,
  docHash,
  seatClass,
  spansRoot,
  votesHash,
  verdictId as computeVerdictId,
  type SeatInput,
} from "@mochi/core";
import { buildPayload, getSchema, normalizeAnswer } from "@mochi/schemas";
import { buildVerdictHashes, runConsensus } from "@mochi/consensus";
import { MockTeeProvider, quoteHash, signJurorAnswer, signProvenance, signVerdictAttestation } from "@mochi/tee";
import * as A from "@mochi/chain";
import { chainFor, type Deployment } from "@mochi/chain";
import { DEV_KEYS } from "./deploy-local.ts";
import { DrandClient, DRAND_QUICKNET, ensureBeacon } from "@mochi/chain";
import { AspTree, StateTreeSync, STATE_ABI, buildWithdrawalProof, depositUSDG, generateNote, openShieldedPaymentFor } from "@mochi/privacy";
import { POSTMAN_ABI, PLACEHOLDER_ASP_CID } from "@mochi/privacy/postman";

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
const MEASUREMENT = keccak256(toHex("mochi-mock-enclave-v1"));
const mockRoot = privateKeyToAccount(keccak256(toHex("mochi-mock-root")));

const dep = JSON.parse(readFileSync(process.env.MOCHI_DEPLOYMENT ?? "deployments/local.json", "utf8")) as Deployment;
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

  console.log("2. Intake: document → docCommit, provenance signed by the intake enclave key");
  const text = "Acme Corp (NASDAQ: ACME) today announced a 2-for-1 stock split, effective October 15, 2026.";
  const bytes = new TextEncoder().encode(text);
  const salt = ZERO32;
  const dc = docCommit(salt, docHash(bytes));
  const prov = { docCommit: dc, kind: ProvenanceKind.SUBMITTED, originId: ZERO32, fetchedAt: 0n, tokensK: 1, transcriptHash: ZERO32 };
  const intakeSig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, prov);

  console.log("3. Payer opens a public SPLIT query (N=3) with USDG");
  const E = A.QueryEscrowAbi as Abi;
  await send(admin, C.usdg, A.MockUSDGAbi as Abi, "mint", [payer.account.address, 1_000n * 10n ** 6n]);
  await send(payer, C.usdg, A.MockUSDGAbi as Abi, "approve", [C.queryEscrow, 2n ** 255n]);
  const nonce = BigInt(Date.now());
  const params = {
    schemaId: SchemaId.SPLIT, n: 3, isPublic: true, allowPanelDisclosure: false,
    paramsHash: ZERO32, payerCommit: ZERO32, refundTo: payer.account.address, nonce,
  };
  await send(payer, C.queryEscrow, E, "openWithUSDG", [params, prov, intakeSig]);
  const queryId = await read<Hex>(C.queryEscrow, E, "computeQueryId", [payer.account.address, dc, nonce]);
  ok(true, `query opened ${queryId.slice(0, 18)}… (escrow accepted the TS-signed EIP-712 Provenance)`);

  console.log("4. Seal (seed from a future block) → selected seats");
  await sealWhenReady(queryId);
  const seats = (await read<Address[]>(C.queryEscrow, E, "jurorsOf", [queryId])).map((a) => a.toLowerCase() as Address);
  const q = await read<{ schemaVersion: number; openedAt: bigint }>(C.queryEscrow, E, "getQuery", [queryId]);
  ok(seats.length === 3 && seats.every((s, i) => jurors.get(s)?.cls === seatClass(i)), "3 seats, each of the right class");

  console.log("5. Jurors (mock enclaves) extract, normalize, sign");
  const def = getSchema(SchemaId.SPLIT);
  const raw = {
    fields: { ticker: "ACME", ratio_num: "2", ratio_den: "1", effective_date: "October 15, 2026" },
    evidence: { ticker: "NASDAQ: ACME", ratio_num: "2-for-1", ratio_den: "2-for-1", effective_date: "October 15, 2026" },
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
  const effectiveAt = BigInt(Date.parse("2026-10-15T00:00:00Z") / 1000);
  await send(admin, token, A.MockStockTokenAbi as Abi, "setSchedule", [10n ** 18n, 2n * 10n ** 18n, effectiveAt]);
  const tickerKey = payload.subjectKey;
  await send(admin, C.stockTokenCrosscheck, A.StockTokenCrosscheckAbi as Abi, "setToken", [tickerKey, token]);
  const { originId } = await import("@mochi/core");
  const fprov = { docCommit: dc, kind: ProvenanceKind.FETCHED, originId: originId("127.0.0.1"), fetchedAt: now, tokensK: 1, transcriptHash: keccak256(toHex("tls-transcript")) };
  const fsig = await signProvenance(intake.signer(), dep.chainId, C.queryEscrow, fprov);
  const fnonce = nonce + 1n;
  await send(feedRunner, C.queryEscrow, E, "openFeed", [{ ...params, nonce: fnonce, refundTo: feedRunner.account.address }, fprov, fsig]);
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
  const fvid = computeVerdictId(fq, 0);
  const splitFeed = keccak256(toHex("corp-actions.split@RHC"));
  const F = A.FeedsAbi as Abi;
  await send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, fvid, fpay.payload]);
  const entry = await read<{ verdictId: Hex; asOf: bigint }>(C.feeds, F, "latest", [splitFeed, tickerKey]);
  ok(entry.verdictId === fvid, "corp-actions.split@RHC updated — Solidity crosscheck decoded the TS SplitBody and matched the token's multiplier schedule");
  ok(entry.asOf === effectiveAt, "feed asOf = effective date (2026-10-15)");

  console.log("9. Feed poisoning attempt: the public (non-feed) verdict for the same document is rejected");
  let rejected = false;
  try {
    await send(orchestrator, C.feeds, F, "update", [splitFeed, tickerKey, vid, payload.payload]);
  } catch {
    rejected = true;
  }
  ok(rejected, "Feeds.update rejects a verdict from a non-FEED query");

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
    const params = { schemaId: SchemaId.SPLIT, n: 3, isPublic: true, allowPanelDisclosure: false, paramsHash: ZERO32, payerCommit: ZERO32, refundTo: relayer.account.address, nonce };
    const beforePoolPayment = await read<bigint>(C.usdg, parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi, "balanceOf", [C.queryEscrow]);
    const openHash = await send(relayer, C.queryEscrow, E, "openShielded", [params, prov, intakeSig, payment.nullifier, payment.proof]);
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
