// Full end-to-end with every service running as a real process (bun src/main.ts), on anvil + TimescaleDB.
// Flows: (A) public query via the gateway, (B) private FREEFORM query with a sealed result, (C) a standing feed query
// fetched by the intake enclave that HANGs at N=3, is auto-expanded to N=5, reaches a VERDICT and updates
// corp-actions.split@RHC through the on-chain crosscheck.
// Prereqs: anvil on :8545, TimescaleDB on :55432 (see README). Usage: bun scripts/e2e.ts
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import postgres from "postgres";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEventLogs, recoverMessageAddress, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Role, SchemaId, ZERO32, docCommit as computeDocCommit, docHash, toBytes32String, verdictId as verdictIdOf } from "@mochi/core";
import { createDb, migrate, upsertEndpoint } from "@mochi/db";
import { MockQuoteVerifier, MockTeeProvider, keyBinding, open, recoverProvenance, seal, type Quote } from "@mochi/tee";
import { PrivateResultPlainSchema, aad, payerCommit, privateResultMismatch, provenanceFromJson, provenanceMatchesBinding, type OpenBinding, type ProvenanceJson } from "@mochi/protocol";
import { verifyReceipt } from "@mochi/receipts";
import { MochiClient } from "@mochi/sdk";
import { StateTreeSync, commitment as noteCommitment, depositUSDG, generateNote, precommitment as notePrecommitment, type Note } from "@mochi/privacy";
import { POSTMAN_ABI, runPostman } from "@mochi/privacy/postman";
import { signAnonymaVoucher } from "@mochi/tee";
import { signAnonyma } from "../services/gateway/src/hmac.ts";
import { bindKey, buildAnswer, commitment, generateEvaluatorKey, openMaterials, payloadSig } from "../services/panel-desk/src/evaluator.ts";
import * as A from "@mochi/chain";
import { chainFor, drandRoundMessage, type Deployment } from "@mochi/chain";
import { DEV_KEYS } from "./deploy-local.ts";

const ROOT = join(import.meta.dir, "..");
const RUN = process.env.MOCHI_E2E_RUN_DIR ?? join(ROOT, ".e2e");
// The harness runs its own anvil (fresh chain + clock every run) on a dedicated port.
// MOCHI_E2E_ANVIL_PORT moves it off the default when another local node (e.g. a Hardhat node) already uses that port.
const ANVIL_PORT = Number(process.env.MOCHI_E2E_ANVIL_PORT ?? 18545);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PG_ADMIN = process.env.MOCHI_E2E_PG_ADMIN ?? "postgres://mochi:mochi@127.0.0.1:55432/mochi";
const DB_URL = process.env.MOCHI_E2E_DATABASE_URL ?? "postgres://mochi:mochi@127.0.0.1:55432/mochi_e2e";
const DEPLOYMENT = join(RUN, "deployment.json");
const SERVICE_BUILD_DIR = process.env.E2E_SERVICE_BUILD_DIR;
const PAYER_KEY: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5
const MEASUREMENT = keccak256(toHex("mochi-mock-enclave-v1"));
const ROOT_KEY = keccak256(toHex("mochi-mock-root"));
const root = privateKeyToAccount(ROOT_KEY);
const ADMIN_TOKEN = "e2e-admin";
const PORTS = { intake: 18001, consensus: 18002, gateway: 18003, orchestrator: 18004, attestor: 18005, feeds: 18006, indexer: 18007, panel: 18008, model: 18100, docs: 18101, drand: 18102, jurorBase: 18010 };
// Model Passports per class. DISSENTER must be a different training family from LARGE_A and not llama/qwen.
const LINEAGE = ["qwen", "llama", "mistral", "phi", "deepseek"];
const ANONYMA_SECRET = "e2e-anonyma-hmac-secret";
// MOCHI_E2E_MODE=load runs the §7 load targets instead of the functional flows (same stack).
const MODE = process.env.MOCHI_E2E_MODE ?? "flows";
const STARTED_AT = Date.now();
// Split effective dates are 00:00 UTC a fixed number of days after the run starts (the harness anvil starts on this
// machine's clock), so the multiplier change is still pending when the feed is updated (the crosscheck reads the token's
// live multiplier) and the asOf stays inside the SPLIT feed's lead, on any calendar date.
const DAY_SEC = 86_400;
const utcMidnightAfter = (days: number) => (Math.floor(STARTED_AT / 1000 / DAY_SEC) + days) * DAY_SEC;
const longDate = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
const isoDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const ACME_EFFECTIVE = utcMidnightAfter(13);
const PNL_EFFECTIVE = utcMidnightAfter(49);
const RANDOMNESS_MODE = process.env.MOCHI_E2E_RANDOMNESS === "drand" ? "drand" : "blockhash";
const DRAND_GENESIS = 1;
const DRAND_PERIOD = 3;
const DRAND_CHAIN_HASH = keccak256(toHex("mochi-e2e-fake-drand")).slice(2);
const DRAND_SEED = sha512(new TextEncoder().encode("mochi-e2e-dr-and-signing-seed-v1")).slice(0, 48);
const DRAND_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const drandKeys = bls12_381.shortSignatures.keygen(DRAND_SEED);
const drandPublicKey = drandKeys.publicKey.toHex();
const DRAND_RELAY = `http://127.0.0.1:${PORTS.drand}`;
const LOAD_TICKERS = Number(process.env.LOAD_TICKERS ?? 200);
const LOAD_EARNINGS = Number(process.env.LOAD_EARNINGS ?? 20);
const letters = (i: number) => { let s = ""; do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
const loadTicker = (i: number) => `LD${letters(i)}`;
const LOAD_DOCS: Record<string, string> = Object.fromEntries(Array.from({ length: LOAD_TICKERS }, (_, i) => [
  `/load/${loadTicker(i)}.txt`,
  `${loadTicker(i)} Holdings (NASDAQ: ${loadTicker(i)}) today announced a 2-for-1 stock split, effective ${longDate(ACME_EFFECTIVE)}.`,
]));
const CLASS_NAMES = ["LARGE_A", "LARGE_B", "DOC_SPECIALIST", "SMALL_FAST", "DISSENTER"];

const procs: Subprocess[] = [];
const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* retry */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(500);
  }
}

// ───────────────────────── fake model server (OpenAI-compatible) ─────────────────────────
// Each juror process calls it with MODEL_NAME = "juror-<class>". Extraction is regex-based on the document; a
// "[DISSENTER-DISAGREES]" marker makes the DISSENTER class read a different split ratio, to force a HUNG round.
function startModelServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: PORTS.model,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
      const user = body.messages.find((m) => m.role === "user")!.content;
      const doc = user.slice(user.indexOf("<document>") + 10, user.lastIndexOf("</document>")).trim();
      const cls = Number(body.model.match(/(\d+)$/)?.[1]); // "juror-4" or "model-class-4"
      let out: unknown;
      if (user.includes("eps_gaap_diluted")) {
        const ticker = /NASDAQ: ([A-Z]+)/.exec(doc)!;
        const eps = /EPS of (\$[\d.]+)/.exec(doc)!;
        const revenue = /revenue of (\$[\d.,]+ (?:billion|million))/.exec(doc)!;
        const period = /(\w+ quarter of fiscal \d{4})/.exec(doc)!;
        out = {
          fields: { ticker: ticker[1], period: period[1], eps_gaap_diluted: eps[1], eps_non_gaap_diluted: null, revenue: revenue[1], currency: "USD", release_ts: null },
          evidence: { ticker: ticker[0], period: period[1], eps_gaap_diluted: eps[1], revenue: revenue[1], currency: eps[1] },
          confidence: { ticker: 0.99, period: 0.9, eps_gaap_diluted: 0.97, revenue: 0.96, currency: 0.9 },
        };
      } else if (user.includes("ratio_num")) {
        const ratio = /(\d+)-for-(\d+)/.exec(doc)!;
        const ticker = /NASDAQ: ([A-Z]+)/.exec(doc)!;
        const date = /effective ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(doc)!;
        const dissent = (doc.includes("[DISSENTER-DISAGREES]") && cls === 4) || (doc.includes("[PANEL-SPLIT]") && cls >= 2);
        out = {
          fields: { ticker: ticker[1], ratio_num: dissent ? "3" : ratio[1], ratio_den: ratio[2], effective_date: date[1] },
          evidence: { ticker: ticker[0], ratio_num: ratio[0], ratio_den: ratio[0], effective_date: date[1] },
          confidence: { ticker: 0.99, ratio_num: 0.95, ratio_den: 0.95, effective_date: 0.97 },
        };
      } else {
        const sentence = doc.split(".")[0]!;
        out = { fields: { answer: true }, evidence: { answer: sentence }, confidence: { answer: 0.9 } };
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(out) } }] });
    },
  });
}

const SPLIT_NOTICE =
  `Acme Corp (NASDAQ: ACME) today announced a 2-for-1 stock split, effective ${longDate(ACME_EFFECTIVE)}. [DISSENTER-DISAGREES]`;
// LARGE_A/LARGE_B read 2-for-1, every other class reads 3-for-1: no value reaches k(N) at N=3,5,7 or 9, so the feed
// query escalates to the human panel.
const PANEL_NOTICE =
  `Panel Co (NASDAQ: PNL) today announced a 2-for-1 stock split, effective ${longDate(PNL_EFFECTIVE)}. [PANEL-SPLIT]`;
function startDocServer() {
  const docs: Record<string, string> = { "/split-notice.txt": SPLIT_NOTICE, "/panel-notice.txt": PANEL_NOTICE, ...LOAD_DOCS };
  return Bun.serve({
    hostname: "127.0.0.1",
    port: PORTS.docs,
    fetch: (req) => {
      const body = docs[new URL(req.url).pathname];
      return body ? new Response(body, { headers: { "content-type": "text/plain" } }) : new Response("not found", { status: 404 });
    },
  });
}

function service(name: string, dir: string, env: Record<string, string>) {
  const bundledServices = new Set(["intake", "consensus", "juror", "gateway", "indexer", "attestor", "orchestrator"]);
  const bundle = SERVICE_BUILD_DIR && join(SERVICE_BUILD_DIR, "services", `${dir}.mjs`);
  if (SERVICE_BUILD_DIR && bundledServices.has(dir) && !existsSync(bundle!)) throw new Error(`missing bundled service: ${bundle}`);
  const entry = bundle && existsSync(bundle) ? bundle : "src/main.ts";
  const p = spawn(["bun", entry], {
    cwd: join(ROOT, "services", dir),
    env: { ...process.env, HOST: "127.0.0.1", MOCHI_DEPLOYMENT: DEPLOYMENT, ...env },
    stdout: Bun.file(join(RUN, `${name}.log`)),
    stderr: Bun.file(join(RUN, `${name}.err.log`)),
  });
  procs.push(p);
  return p;
}

async function main() {
  if (process.env.MOCHI_E2E_RUN_DIR) {
    if (existsSync(RUN) && readdirSync(RUN).length > 0) throw new Error(`MOCHI_E2E_RUN_DIR must be empty: ${RUN}`);
    mkdirSync(RUN, { recursive: true });
  } else {
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(RUN, { recursive: true });
  }

  // Preflight: the harness owns these ports; fail fast (instead of timing out) if a stale run still holds one.
  for (const port of [ANVIL_PORT, ...Object.values(PORTS).filter((p) => p !== PORTS.jurorBase), ...Array.from({ length: 10 }, (_, i) => PORTS.jurorBase + i)]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} is in use — stale e2e processes? (pkill -f "bun src/main.ts")`);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { for (const p of procs) p.kill(); process.exit(130); });
  console.log(`0. Fresh anvil, deploy contracts, fresh database (randomness: ${RANDOMNESS_MODE})`);
  procs.push(spawn(["anvil", "--silent", "--host", "127.0.0.1", "--port", String(ANVIL_PORT), "--hardfork", "prague"], { stdout: "ignore", stderr: "ignore" }));
  await until("anvil up", async () => (await createPublicClient({ transport: http(RPC) }).getChainId()) === 31337, 20_000);
  // Never deploy to or send through a node this harness did not start: a Hardhat node also reports chain id 31337.
  const client = String(await createPublicClient({ transport: http(RPC) }).request({ method: "web3_clientVersion" as never }));
  if (!client.toLowerCase().startsWith("anvil")) throw new Error(`the node on port ${ANVIL_PORT} is not the harness's anvil`);
  if (RANDOMNESS_MODE === "drand") {
    const fakePub = createPublicClient({ transport: http(RPC) });
    const relay = Bun.serve({ hostname: "127.0.0.1", port: PORTS.drand, async fetch(request) {
      const match = new URL(request.url).pathname.match(/^\/([^/]+)\/public\/(\d+)$/);
      if (!match || match[1] !== DRAND_CHAIN_HASH) return new Response("not found", { status: 404 });
      const round = Number(match[2]);
      const publishedAt = DRAND_GENESIS + (round - 1) * DRAND_PERIOD;
      try { if (Number((await fakePub.getBlock({ blockTag: "latest" })).timestamp) < publishedAt) return new Response("not published", { status: 404 }); }
      catch { return new Response("chain unavailable", { status: 503 }); }
      const hashed = bls12_381.shortSignatures.hash(drandRoundMessage(round), DRAND_DST);
      const signature = bls12_381.shortSignatures.sign(hashed, drandKeys.secretKey).toHex();
      return Response.json({ round, randomness: Buffer.from(sha256(Buffer.from(signature, "hex"))).toString("hex"), signature, publishedAt });
    } });
    void relay;
  }
  const deployArgs = ["bun", "scripts/deploy-local.ts", "--rpc", RPC, "--out", DEPLOYMENT];
  deployArgs.push("--shielded", "privacy-pools");
  if (RANDOMNESS_MODE === "drand") deployArgs.push("--randomness", "drand", "--drand-lookahead", "2", "--drand-public-key", drandPublicKey, "--drand-genesis", String(DRAND_GENESIS), "--drand-period", String(DRAND_PERIOD), "--drand-chain-hash", DRAND_CHAIN_HASH, "--drand-relays", DRAND_RELAY);
  const dep$ = spawn(deployArgs, { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  if ((await dep$.exited) !== 0) throw new Error("deploy failed");
  const dep = JSON.parse(await Bun.file(DEPLOYMENT).text()) as Deployment;
  const admin = postgres(PG_ADMIN, { max: 1 });
  await admin.unsafe("DROP DATABASE IF EXISTS mochi_e2e WITH (FORCE)");
  await admin.unsafe("CREATE DATABASE mochi_e2e");
  await admin.end();
  const db = createDb(DB_URL);
  await migrate(db.sql);
  ok(true, `deployed to chain ${dep.chainId}; database migrated`);

  const chain = chainFor(dep);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = (pk: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(pk) });
  const send = async (pk: Hex, address: Address, abi: unknown, functionName: string, args: unknown[]) => {
    const w = wallet(pk);
    const { request } = await pub.simulateContract({ account: w.account, address, abi: abi as Abi, functionName, args } as never);
    const hash = await w.writeContract(request as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  };
  const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: abi as Abi, functionName, args } as never) as Promise<T>;
  const C = dep.contracts;

  console.log("1. Enclave identities (mock TEE seeds) → on-chain registration with proof of possession");
  const tee = (seed: string) => new MockTeeProvider({ seed: keccak256(toHex(seed)), measurement: MEASUREMENT, mockRoot: root });
  const intakeTee = tee("e2e-intake");
  const consensusTee = tee("e2e-consensus");
  const jurorDefs = [0, 1, 2, 3, 4].flatMap((cls) => [0, 1].map((i) => ({ cls, i, seed: `e2e-juror-${cls}-${i}` })));
  const R = A.JurorRegistryAbi;
  for (const role of [Role.JUROR, Role.INTAKE, Role.CONSENSUS]) await send(DEV_KEYS.deployer, C.jurorRegistry, R, "setMeasurement", [MEASUREMENT, role, true]);
  const deployer = privateKeyToAccount(DEV_KEYS.deployer).address;
  await send(DEV_KEYS.deployer, C.jurorRegistry, R, "registerServiceKey", [intakeTee.signer().address, deployer, MEASUREMENT, Role.INTAKE]);
  await send(DEV_KEYS.deployer, C.jurorRegistry, R, "registerServiceKey", [consensusTee.signer().address, deployer, MEASUREMENT, Role.CONSENSUS]);
  await send(DEV_KEYS.deployer, C.mochiToken, A.MochiTokenAbi, "approve", [C.jurorRegistry, 2n ** 255n]);
  for (const j of jurorDefs) {
    const t = tee(j.seed);
    const digest = await read<Hex>(C.jurorRegistry, R, "enrollmentDigest", [deployer, t.signer().address, MEASUREMENT, j.cls]);
    const keySig = await t.signer().signMessage({ message: { raw: digest } });
    await send(DEV_KEYS.deployer, C.jurorRegistry, R, "enrollJuror", [t.signer().address, MEASUREMENT, j.cls, 25_000n * 10n ** 18n, keySig]);
  }
  ok(true, `registered intake, consensus and ${jurorDefs.length} jurors (2 per class)`);

  console.log("2. Start model server, document server and all services");
  startModelServer();
  startDocServer();
  const common = { DATABASE_URL: DB_URL };
  const teeEnv = (seed: string) => ({
    TEE_MODE: "mock", QUOTE_VERIFIER: "mock", TEE_MOCK_SEED: keccak256(toHex(seed)), TEE_MOCK_MEASUREMENT: MEASUREMENT, TEE_MOCK_ROOT_PRIVATE_KEY: ROOT_KEY,
  });
  service("intake", "intake", {
    PORT: String(PORTS.intake), TEE_MODE: "mock", QUOTE_VERIFIER: "mock", MOCK_TEE_SEED: keccak256(toHex("e2e-intake")), MOCK_TEE_MEASUREMENT: MEASUREMENT,
    MOCK_ROOT_KEY: ROOT_KEY, MOCK_ROOT_ADDRESS: root.address, SEALED_STORE_DIR: join(RUN, "sealed-intake"),
    FETCH_ORIGINS: JSON.stringify([{ host: "127.0.0.1" }]), ALLOW_HTTP_HOSTS: "127.0.0.1",
  });
  service("consensus", "consensus", { PORT: String(PORTS.consensus), ROUND_TIMEOUT_MS: "8000", SEALED_STORE_DIR: join(RUN, "sealed-consensus"), ...teeEnv("e2e-consensus") });
  for (const [idx, j] of jurorDefs.entries()) {
    const port = PORTS.jurorBase + idx;
    service(`juror-${CLASS_NAMES[j.cls]}-${j.i}`, "juror", {
      PORT: String(port), JUROR_CLASS: String(j.cls), JUROR_OPERATOR: deployer, RUNNER: "openai", MODEL_BASE_URL: `http://127.0.0.1:${PORTS.model}`,
      MODEL_NAME: `juror-${j.cls}`, SEALED_STORE_DIR: join(RUN, `sealed-juror-${idx}`), ...teeEnv(j.seed),
      MODEL_ID: `model-class-${j.cls}`, MODEL_LINEAGE: LINEAGE[j.cls]!, MODEL_WEIGHTS_SHA256: keccak256(toHex(`weights-${j.cls}`)),
      MODEL_PROVIDER: "mochi-e2e", MODEL_OPEN_WEIGHTS: "true",
    });
    await upsertEndpoint(db.db, tee(j.seed).signer().address.toLowerCase(), Role.JUROR, `http://127.0.0.1:${port}`);
  }
  await upsertEndpoint(db.db, intakeTee.signer().address.toLowerCase(), Role.INTAKE, `http://127.0.0.1:${PORTS.intake}`);
  await upsertEndpoint(db.db, consensusTee.signer().address.toLowerCase(), Role.CONSENSUS, `http://127.0.0.1:${PORTS.consensus}`);
  service("attestor", "attestor", {
    ...common, PORT: String(PORTS.attestor), ATTESTOR_KEY: DEV_KEYS.attestor, INTERVAL_MS: "3000", VALIDITY_SEC: "3600",
    QUOTE_VERIFIER: "mock", MOCK_ROOT_ADDRESS: root.address, ADMIN_TOKEN,
  });
  // Fresh funded keys for the gateway relayer (Anonyma path), the panel keeper, and three human evaluators.
  const fresh = () => keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex;
  const RELAYER_KEY = fresh(), KEEPER_KEY = fresh();
  const EVALUATOR_KEYS = [fresh(), fresh(), fresh()];
  for (const k of [RELAYER_KEY, KEEPER_KEY, ...EVALUATOR_KEYS]) {
    const hash = await wallet(DEV_KEYS.deployer).sendTransaction({ to: privateKeyToAccount(k).address, value: 10n ** 18n });
    await pub.waitForTransactionReceipt({ hash });
  }
  const feedRunnerAddr = privateKeyToAccount(DEV_KEYS.feedRunner).address.toLowerCase();
  service("gateway", "gateway", {
    ...common, PORT: String(PORTS.gateway), INTAKE_URL: `http://127.0.0.1:${PORTS.intake}`,
    ANONYMA_HMAC_SECRET: ANONYMA_SECRET, RELAYER_KEY, INTERNAL_PAYERS: feedRunnerAddr,
  });
  service("panel-desk", "panel-desk", {
    ...common, PORT: String(PORTS.panel), RPC_URL: RPC, KEEPER_KEY, INTAKE_URL: `http://127.0.0.1:${PORTS.intake}`, POLL_MS: "500", ...(RANDOMNESS_MODE === "drand" ? { DRAND_RELAYS: DRAND_RELAY } : {}),
  });
  service("indexer", "indexer", { ...common, PORT: String(PORTS.indexer), POLL_MS: "500", ANCHORER_KEY: DEV_KEYS.orchestrator });
  // ACME Stock Token whose multiplier schedule matches the notice (2-for-1 effective ACME_EFFECTIVE).
  const tokenHash = await wallet(DEV_KEYS.deployer).deployContract({ abi: A.MockStockTokenAbi as Abi, bytecode: A.MockStockTokenBytecode, args: [] as never });
  const token = (await pub.waitForTransactionReceipt({ hash: tokenHash })).contractAddress!;
  await send(DEV_KEYS.deployer, token, A.MockStockTokenAbi, "setSchedule", [10n ** 18n, 2n * 10n ** 18n, BigInt(ACME_EFFECTIVE)]);
  await send(DEV_KEYS.deployer, C.stockTokenCrosscheck, A.StockTokenCrosscheckAbi, "setToken", [toBytes32String("ACME"), token]);
  const pnlHash = await wallet(DEV_KEYS.deployer).deployContract({ abi: A.MockStockTokenAbi as Abi, bytecode: A.MockStockTokenBytecode, args: [] as never });
  const pnlToken = (await pub.waitForTransactionReceipt({ hash: pnlHash })).contractAddress!;
  await send(DEV_KEYS.deployer, pnlToken, A.MockStockTokenAbi, "setSchedule", [10n ** 18n, 2n * 10n ** 18n, BigInt(PNL_EFFECTIVE)]);
  await send(DEV_KEYS.deployer, C.stockTokenCrosscheck, A.StockTokenCrosscheckAbi, "setToken", [toBytes32String("PNL"), pnlToken]);
  const feedsConfig = join(RUN, "feeds.json");
  const corpTokens = [
    { ticker: "ACME", token, noticeUrls: [{ url: `http://127.0.0.1:${PORTS.docs}/split-notice.txt`, kind: "SPLIT" }] },
    { ticker: "PNL", token: pnlToken, noticeUrls: [{ url: `http://127.0.0.1:${PORTS.docs}/panel-notice.txt`, kind: "SPLIT" }] },
  ];
  const loadTokens = Array.from({ length: LOAD_TICKERS }, (_, i) => ({
    ticker: loadTicker(i), token: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    noticeUrls: [{ url: `http://127.0.0.1:${PORTS.docs}/load/${loadTicker(i)}.txt`, kind: "SPLIT" }],
  }));
  writeFileSync(feedsConfig, JSON.stringify({
    "corp-actions": { tokens: MODE === "load" ? loadTokens : corpTokens },
    earnings: { releases: [] },
    attestations: { reserves: [], navs: [] },
  }));
  const feedRunner = privateKeyToAccount(DEV_KEYS.feedRunner).address;
  service("feed-runners", "feed-runners", {
    ...common, PORT: String(PORTS.feeds), ADMIN_TOKEN, FEEDS_CONFIG: feedsConfig, STATE_DIR: join(RUN, "feed-state"),
    INTAKE_URL: `http://127.0.0.1:${PORTS.intake}`, FEED_RUNNER_KEY: DEV_KEYS.feedRunner, FEED_RUNNER_ADDRESS: feedRunner,
    QUOTE_VERIFIER: "mock", MOCK_QUOTE_ROOT: root.address,
    // Load mode: no scheduled run or multiplier watcher — the measured run is triggered explicitly.
    CORP_ACTIONS_UTC_HOUR: MODE === "load" ? "23" : "0", // load: the measured run is the admin run-now (force)
    ...(MODE === "load" ? { MULTIPLIER_POLL_MS: "86400000" } : {}),
  });

  console.log("3. Attestor verifies every enclave's quote and refreshes attestations on-chain");
  const keys = [intakeTee, consensusTee, ...jurorDefs.map((j) => tee(j.seed))].map((t) => t.signer().address);
  const roles = [Role.INTAKE, Role.CONSENSUS, ...jurorDefs.map(() => Role.JUROR)];
  await until("all enclave keys active", async () => {
    const act = await Promise.all(keys.map((k, i) => read<boolean>(C.jurorRegistry, R, "isActive", [k, roles[i]])));
    return act.every(Boolean);
  }, 90_000);
  ok(true, "all 12 enclave keys active on-chain (attestor → refreshAttestation)");
  const enrollment = await (await fetch(`http://127.0.0.1:${PORTS.jurorBase}/v1/enrollment`)).json() as { key: Address; digest: Hex; signature: Hex };
  const enrollmentDigest = await read<Hex>(C.jurorRegistry, R, "enrollmentDigest", [deployer, enrollment.key, MEASUREMENT, jurorDefs[0]!.cls]);
  ok(enrollment.digest === enrollmentDigest && (await recoverMessageAddress({ message: { raw: enrollmentDigest }, signature: enrollment.signature })).toLowerCase() === tee(jurorDefs[0]!.seed).signer().address.toLowerCase(), "juror enrollment endpoint signs the registry's exact enrollment digest without exporting its key");

  // payer funds
  const payer = privateKeyToAccount(PAYER_KEY).address;
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [payer, 1_000n * 10n ** 6n]);
  await send(PAYER_KEY, C.usdg, A.MockUSDGAbi, "approve", [C.queryEscrow, 2n ** 255n]);
  const gw = `http://127.0.0.1:${PORTS.gateway}`;
  const verifier = new MockQuoteVerifier({ mockRootAddress: root.address });
  const intakeAtt = await until("gateway up", async () => (await fetch(`${gw}/v1/intake/attestation`)).json() as Promise<{ address: Address; encryptionPubKey: Hex; quote: Quote }>);
  const attOk = await verifier.verify(intakeAtt.quote, { measurement: MEASUREMENT, reportData: keyBinding(intakeAtt.address, intakeAtt.encryptionPubKey) });
  ok(attOk.ok, "client verified the intake enclave quote before sealing anything to it");

  async function submit(opts: { schemaId: number; text: string; params?: Record<string, unknown>; isPublic: boolean }) {
    const salt: Hex = opts.isPublic ? ZERO32 : toHex(crypto.getRandomValues(new Uint8Array(32)));
    const resultPriv = x25519.utils.randomSecretKey();
    const resultPub = toHex(x25519.getPublicKey(resultPriv));
    // Sealed with the document: the intake signs this into the provenance, so only the payer can open this query.
    const open: OpenBinding = { opener: payer.toLowerCase(), payerCommit: opts.isPublic ? ZERO32 : payerCommit(resultPub), isPublic: opts.isPublic, allowPanelDisclosure: false, nonce: BigInt(toHex(crypto.getRandomValues(new Uint8Array(8)))).toString() };
    const plain = { v: 1, schemaId: opts.schemaId, salt, params: opts.params ?? {}, contentType: "text/plain", docB64: Buffer.from(opts.text).toString("base64"), open };
    const envelope = seal(intakeAtt.encryptionPubKey, new TextEncoder().encode(JSON.stringify(plain)), aad.intake());
    const intakeRes = await (await fetch(`${gw}/v1/intake/upload?n=3`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) })).json() as { docCommit: Hex; quote: unknown; intake: Address; intakeSig: Hex; provenance: ProvenanceJson };
    const provenance = provenanceFromJson(intakeRes.provenance);
    const signer = await recoverProvenance(dep.chainId, C.queryEscrow, provenance, intakeRes.intakeSig);
    ok(signer.toLowerCase() === intakeRes.intake.toLowerCase(), "intake response signature recovers its declared enclave identity");
    ok(provenanceMatchesBinding(intakeRes.provenance, open), "intake signed exactly the sealed open binding (opener, payerCommit, consent, nonce)");
    await until("intake response signer active", async () => await read<boolean>(C.jurorRegistry, R, "isActive", [signer, Role.INTAKE]) || undefined, 20_000);
    ok(true, "intake response signer is active in the on-chain registry");
    ok(intakeRes.docCommit === computeDocCommit(salt, docHash(new TextEncoder().encode(opts.text))), `intake docCommit = keccak(salt ‖ sha256(doc))${opts.isPublic ? "" : " (salted)"}`);
    const prep = await (await fetch(`${gw}/v1/query`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intake: intakeRes, n: 3, refundTo: payer.toLowerCase(), pay: { path: "usdg" }, ...(opts.isPublic ? {} : { payerResultPubKey: resultPub }),
      }),
    })).json() as { queryId: Hex; to: Address; data: Hex };
    const w = wallet(PAYER_KEY);
    const hash = await w.sendTransaction({ to: prep.to, data: prep.data });
    ok((await pub.waitForTransactionReceipt({ hash })).status === "success", `payer sent the gateway-prepared openWithUSDG tx (query ${prep.queryId.slice(0, 12)}…)`);
    return { queryId: prep.queryId, resultPriv, salt };
  }
  const waitVerdict = (queryId: Hex, label: string) => (async () => {
    const started = Date.now();
    const verdictId = await until(`${label} verdict`, async () => {
      const q = await (await fetch(`${gw}/v1/queries/${queryId}`)).json() as { latestVerdictId?: Hex; latestVerdict?: Hex; query?: { status: number } };
      const vid = (q.latestVerdictId ?? q.latestVerdict) as Hex | undefined;
      return vid && !/^0x0+$/.test(vid) ? vid : undefined;
    }, 120_000);
    console.log(`  ⏱ ${label} verdict: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return verdictId;
  })();

  console.log("3b. Public USDG payment expires before orchestration and refunds the payer in full");
  const refundBefore = await read<bigint>(C.usdg, A.MockUSDGAbi, "balanceOf", [payer]);
  await send(DEV_KEYS.deployer, C.queryEscrow, A.QueryEscrowAbi, "setQueryTtl", [2n]);
  const expired = await submit({ schemaId: SchemaId.SPLIT, text: "Refund Co (NASDAQ: RFND) announced a test split.", isPublic: true });
  const openForRefund = await read<{ paid: bigint; deadline: bigint; status: number }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [expired.queryId]);
  ok(openForRefund.paid > 0n && Number(openForRefund.status) === 1, `public query opened and paid ${openForRefund.paid} USDG units`);
  const latestTimestamp = BigInt((await pub.getBlock({ blockTag: "latest" })).timestamp);
  await pub.request({ method: "evm_increaseTime" as never, params: [Number(openForRefund.deadline - latestTimestamp + 2n)] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
  await send(DEV_KEYS.deployer, C.queryEscrow, A.QueryEscrowAbi, "expire", [expired.queryId]);
  const expiredQuery = await read<{ status: number }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [expired.queryId]);
  const refundAfter = await read<bigint>(C.usdg, A.MockUSDGAbi, "balanceOf", [payer]);
  ok(Number(expiredQuery.status) === 6 && refundAfter === refundBefore, "expired USDG query refunded its full payment to refundTo");
  await send(DEV_KEYS.deployer, C.queryEscrow, A.QueryEscrowAbi, "setQueryTtl", [3600n]);

  service("orchestrator", "orchestrator", {
    ...common, PORT: String(PORTS.orchestrator), ORCHESTRATOR_KEY: DEV_KEYS.orchestrator, FEED_RUNNER_KEY: DEV_KEYS.orchestrator,
    MAX_PARALLEL_QUERIES: MODE === "load" ? "32" : "8",
    INTAKE_URL: `http://127.0.0.1:${PORTS.intake}`, CONSENSUS_URL: `http://127.0.0.1:${PORTS.consensus}`, POLL_MS: "500",
    ...(RANDOMNESS_MODE === "drand" ? { DRAND_RELAYS: DRAND_RELAY } : {}),
    JUROR_TIMEOUT_MS: "20000", ROUND_CLOSE_MAX_WAIT_MS: "20000",
  });
  await until("orchestrator health", async () => (await fetch(`http://127.0.0.1:${PORTS.orchestrator}/health`)).ok || undefined);

  if (MODE === "load") {
    await runLoad({ gw, feedRunner, payer, send, read, submit, waitVerdict, C, db });
    return;
  }

  console.log("4. (A) Public SPLIT query through the gateway → orchestrator → jurors → consensus → chain");
  const A1 = await submit({ schemaId: SchemaId.SPLIT, text: "Acme Corp (NASDAQ: ACME) today announced a 2-for-1 stock split, effective October 15, 2026.", isPublic: true });
  const vidA = await waitVerdict(A1.queryId, "public");
  const vA = await until("public verdict row", async () => {
    const r = await fetch(`${gw}/v1/verdict/${vidA}`);
    return r.ok ? (await r.json()) as Record<string, unknown> : undefined;
  });
  const onchainA = await read<{ status: number; agreementBps: number }>(C.verdicts, A.MochiVerdictsAbi, "getVerdict", [vidA]);
  ok(Number(onchainA.status) === 1 && Number(onchainA.agreementBps) === 10000, "public verdict on-chain: VERDICT at 10000 bps");
  const settledA = await read<{ status: number; paid: bigint }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [A1.queryId]);
  ok(Number(settledA.status) === 3 && settledA.paid > 0n, "public USDG payment settled after the on-chain verdict");
  ok(JSON.stringify(vA).includes("ACME"), "gateway serves the public answer (ticker ACME)");

  console.log("5. (B) Private FREEFORM query: salted commitments on-chain, result sealed to the payer's key");
  const B = await submit({
    schemaId: SchemaId.FREEFORM_FACT, isPublic: false,
    text: "The trust's reserves were fully backed as of September 30, 2026. Auditor signed the report.",
    params: { question: "Were the reserves fully backed?", answer_type: "BOOL" },
  });
  const vidB = await waitVerdict(B.queryId, "private");
  const vB = await until("private verdict row", async () => {
    const r = await fetch(`${gw}/v1/verdict/${vidB}`);
    const j = r.ok ? (await r.json()) as { ciphertext?: Hex; answer?: unknown } : undefined;
    return j?.ciphertext && j.ciphertext !== "0x" ? j : undefined;
  });
  ok(vB.answer === undefined && !JSON.stringify(vB).includes("backed"), "gateway returns ciphertext only for the private verdict");
  const env = JSON.parse(Buffer.from(vB.ciphertext!.slice(2), "hex").toString("utf8"));
  const plain = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(B.resultPriv, env, aad.result(vidB)))));
  ok(plain.answerJson.includes('"answer":{"t":"bool","v":true}'), "payer decrypted the private result: answer = true");
  const onchainB = await read<{ answerHash: Hex; payloadHash: Hex }>(C.verdicts, A.MochiVerdictsAbi, "getVerdict", [vidB]);
  ok(privateResultMismatch(plain, onchainB) === undefined && onchainB.payloadHash !== keccak256(plain.payload as Hex), "decrypted result matches the on-chain answerHash and the salted private payloadHash (not keccak256(payload))");
  const qB = await read<{ payerCommit: Hex; docCommit: Hex }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [B.queryId]);
  ok(qB.payerCommit !== ZERO32 && qB.docCommit !== computeDocCommit(ZERO32, docHash(new TextEncoder().encode("x"))), "on-chain docCommit is salted and payerCommit binds the result key");

  console.log("6. (H) Private payment through the real Privacy Pool: SDK proof → relayer → sealed verdict");
  if (!dep.privacy) throw new Error("privacy-pools deployment missing from e2e deployment JSON");
  const privacy = dep.privacy;
  const privatePoolKey = PAYER_KEY;
  const poolNote = generateNote();
  const poolDeposit = await depositUSDG({ publicClient: pub as never, walletClient: wallet(privatePoolKey) as never }, privacy.entrypoint, C.usdg, 20n * 10n ** 6n, poolNote, privacy.pool);
  const stopPostman = new AbortController();
  const postmanDone = runPostman({ client: pub, wallet: wallet(DEV_KEYS.deployer), entrypoint: privacy.entrypoint, pool: privacy.pool, fromBlock: BigInt(dep.startBlock), pollMs: 50, signal: stopPostman.signal }).catch((error) => { throw error; });
  await until("ASP postman approves the private deposit", async () => {
    // latestRoot() reverts (NoRootsAvailable) until the postman posts the first root: treat that as "not yet".
    const value = await pub.readContract({ address: privacy.entrypoint, abi: POSTMAN_ABI, functionName: "latestRoot" }).catch(() => 0n);
    return value !== 0n ? value : undefined;
  }, 60_000);
  stopPostman.abort();
  await postmanDone;
  const privateSdk = new MochiClient({ gatewayUrl: gw, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(input);
    if (requestUrl.endsWith("/v1/relay/open-shielded")) lastPrivateRelayBody = String(init?.body);
    return fetch(input, init);
  }) as typeof fetch, quoteVerifier: verifier, intakeMeasurement: MEASUREMENT, chain: { deployment: dep, publicClient: pub } });
  let lastPrivateRelayBody = "";
  const sdkPrivate = await privateSdk.ask({
    schema: SchemaId.FREEFORM_FACT,
    document: { bytes: new TextEncoder().encode("Pool Co reserves were fully backed on September 30, 2026."), contentType: "text/plain" },
    params: { question: "Were reserves fully backed?", answer_type: "BOOL" }, n: 3, isPublic: false,
    sender: payer.toLowerCase() as Address,
    pay: { path: "shielded-pool", note: poolNote, depositInfo: { deposit: poolDeposit, pool: privacy.pool, fromBlock: BigInt(dep.startBlock) } },
  }, wallet(PAYER_KEY)) as { queryId: Hex; txHash: Hex; secrets: { salt: Hex; resultPrivateKey?: Hex }; quote: { jurorFees: string; protocolFee: string }; changeNote: Note };
  const relayTx = await pub.getTransaction({ hash: sdkPrivate.txHash });
  const relayerAddress = (await (await fetch(`${gw}/v1/relayer`)).json() as { address: Address }).address;
  ok(relayTx.from.toLowerCase() === relayerAddress.toLowerCase() && relayTx.from.toLowerCase() !== payer.toLowerCase(), "openShielded transaction is sent by the gateway relayer, not the payer");
  const privateQuote = sdkPrivate.quote;
  const privateTotal = BigInt(privateQuote.jurorFees) + BigInt(privateQuote.protocolFee);
  const privateQuery = await read<{ paid: bigint }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [sdkPrivate.queryId]);
  const privateReceipt = await pub.getTransactionReceipt({ hash: sdkPrivate.txHash });
  const shieldedSpends = parseEventLogs({ abi: A.PrivacyPoolShieldedPaymentsAbi, logs: privateReceipt.logs, eventName: "ShieldedSpend" });
  const shieldedSpend = shieldedSpends.find((event) => event.address.toLowerCase() === privacy.adapter.toLowerCase() && event.args.context.toLowerCase() === sdkPrivate.queryId.toLowerCase());
  ok(privateQuery.paid === privateTotal && shieldedSpend?.args.amount === privateTotal, `shielded adapter transferred exactly the private quote (${privateTotal} USDG units)`);
  const privateVerdictId = await waitVerdict(sdkPrivate.queryId, "shielded-pool private");
  await until("shielded private ciphertext", async () => {
    const response = await fetch(`${gw}/v1/verdict/${privateVerdictId}`);
    if (!response.ok) return undefined;
    const verdict = await response.json() as { ciphertext?: Hex };
    return verdict.ciphertext && verdict.ciphertext !== "0x" ? true : undefined;
  });
  const privatePlain = await privateSdk.decryptPrivateResult(privateVerdictId, { queryId: sdkPrivate.queryId, ...sdkPrivate.secrets });
  ok(privatePlain.verdictId.toLowerCase() === privateVerdictId.toLowerCase() && privatePlain.answerJson.includes('"answer"'), "payer decrypted the sealed result for the shielded query");
  const replay = await fetch(`${gw}/v1/relay/open-shielded`, { method: "POST", headers: { "content-type": "application/json" }, body: lastPrivateRelayBody });
  ok(replay.status >= 400, "replaying the shielded proof is rejected");
  const syncedAfterSpend = await new StateTreeSync().rebuild(pub as never, privacy.pool, BigInt(dep.startBlock));
  const changeIndex = syncedAfterSpend.tree.size - 1;
  const changeNote = sdkPrivate.changeNote;
  const changeDeposit = { commitment: noteCommitment(changeNote.value!, changeNote.label!, notePrecommitment(changeNote.nullifier, changeNote.secret)), label: changeNote.label!, value: changeNote.value!, index: changeIndex };
  const secondPrivate = await privateSdk.ask({
    schema: SchemaId.FREEFORM_FACT,
    document: { bytes: new TextEncoder().encode("Pool Co reserves were fully backed on September 30, 2026."), contentType: "text/plain" },
    params: { question: "Were reserves fully backed?", answer_type: "BOOL" }, n: 3, isPublic: false,
    sender: payer.toLowerCase() as Address,
    pay: { path: "shielded-pool", note: changeNote, depositInfo: { deposit: changeDeposit, pool: privacy.pool, fromBlock: BigInt(dep.startBlock) } },
  }, wallet(PAYER_KEY)) as { queryId: Hex; txHash: Hex };
  const secondQuery = await read<{ paid: bigint }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [secondPrivate.queryId]);
  ok(secondQuery.paid > 0n, "the SDK-returned change note funded a second shielded query");
  ok((await pub.getTransaction({ hash: secondPrivate.txHash })).from.toLowerCase() === relayerAddress.toLowerCase(), "second change-note payment also uses the relayer");

  console.log("6. (C) Feed: intake fetches the notice; N=3 HUNG (DISSENTER disagrees) → auto-expand to N=5 → VERDICT → feed");
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [feedRunner, 1_000n * 10n ** 6n]);
  await send(DEV_KEYS.feedRunner, C.usdg, A.MockUSDGAbi, "approve", [C.queryEscrow, 2n ** 255n]);
  await send(DEV_KEYS.feedRunner, C.usdg, A.MockUSDGAbi, "approve", [C.panel, 2n ** 255n]);
  await send(DEV_KEYS.feedRunner, C.queryEscrow, A.QueryEscrowAbi, "fundFeedBudget", [200n * 10n ** 6n]);
  // The orchestrator escalates feed queries itself and pays the panel fee from its own account.
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [privateKeyToAccount(DEV_KEYS.orchestrator).address, 1_000n * 10n ** 6n]);
  // Three human evaluators stake USDG in PanelEscalation (stake only — no identity checks) before any case is drawn.
  for (const k of EVALUATOR_KEYS) {
    const addr = privateKeyToAccount(k).address;
    await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [addr, 2_500n * 10n ** 6n]);
    await send(k, C.usdg, A.MockUSDGAbi, "approve", [C.panel, 2n ** 255n]);
    await send(k, C.panel, A.PanelEscalationAbi, "stake", [2_500n * 10n ** 6n]);
  }
  const trig = await fetch(`http://127.0.0.1:${PORTS.feeds}/v1/feed-runners/run/corp-actions`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  ok(trig.ok, "feed-runner triggered (corp-actions)");
  const splitFeed = keccak256(toHex("corp-actions.split@RHC"));
  type FeedEntry = { verdictId: Hex; asOf: bigint; updatedAt: bigint; verdictTs: bigint; payload: Hex };
  const entry = await until("feed update", async () => {
    const e = await read<FeedEntry>(C.feeds, A.FeedsAbi, "latest", [splitFeed, toBytes32String("ACME")]);
    return /^0x0+$/.test(e.verdictId) ? undefined : e;
  }, 180_000);
  const vC = await read<{ round: number; agreementBps: number; status: number; ts: bigint }>(C.verdicts, A.MochiVerdictsAbi, "getVerdict", [entry.verdictId]);
  ok(Number(vC.round) === 1 && Number(vC.agreementBps) === 8000, "feed verdict came from round 1 (expanded to N=5) at 4/5 = 8000 bps");
  ok(entry.asOf === BigInt(ACME_EFFECTIVE), `corp-actions.split@RHC[ACME] updated with asOf = ${isoDate(ACME_EFFECTIVE)} (crosscheck passed)`);
  ok(entry.verdictTs === BigInt(vC.ts), "Feeds.latest() carries the verdict's on-chain time (verdictTs)");
  // Feeds.update is permissionless; the harness key only simulates (the revert means nothing is sent).
  const repost = await send(DEV_KEYS.deployer, C.feeds, A.FeedsAbi, "update", [splitFeed, toBytes32String("ACME"), entry.verdictId, entry.payload]).then(() => "applied", (e) => String(e));
  ok(repost.includes("VerdictAlreadyApplied"), "re-posting the feed's current verdict reverts VerdictAlreadyApplied");


  console.log("6b. (F) Anonyma send-to-jury: HMAC-authenticated partner call, voucher drawn from Anonyma's USDG float");
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [privateKeyToAccount(DEV_KEYS.deployer).address, 100n * 10n ** 6n]);
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "approve", [C.queryEscrow, 2n ** 255n]);
  await send(DEV_KEYS.deployer, C.queryEscrow, A.QueryEscrowAbi, "fundAnonymaFloat", [50n * 10n ** 6n]);
  const anonDoc = "Anon Co (NASDAQ: ANON) today announced a 2-for-1 stock split, effective December 1, 2026.";
  const voucherId = keccak256(toHex(`voucher-${Date.now()}`));
  const anonDocCommit = computeDocCommit(ZERO32, docHash(new TextEncoder().encode(anonDoc)));
  // Anonyma seals the open binding too: the gateway's relayer opens, with the voucher's low 64 bits as queryId nonce.
  // The voucher names that exact query, so no other grant (opener, nonce) can spend it.
  const anonRelayer = ((await (await fetch(`${gw}/v1/relayer`)).json()) as { address: Address }).address;
  const anonNonce = BigInt(voucherId) & ((1n << 64n) - 1n);
  const anonQueryId = await read<Hex>(C.queryEscrow, A.QueryEscrowAbi, "computeQueryId", [anonRelayer, anonDocCommit, anonNonce]);
  const voucher = {
    voucherId, queryId: anonQueryId,
    schemaId: SchemaId.SPLIT, n: 3, maxAmount: 10n * 10n ** 6n, tier: 2, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const anonOpen: OpenBinding = { opener: anonRelayer.toLowerCase(), payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: false, nonce: anonNonce.toString() };
  const anonPlain = { v: 1, schemaId: SchemaId.SPLIT, salt: ZERO32, params: {}, contentType: "text/plain", docB64: Buffer.from(anonDoc).toString("base64"), open: anonOpen };
  const anonEnvelope = seal(intakeAtt.encryptionPubKey, new TextEncoder().encode(JSON.stringify(anonPlain)), aad.intake());
  const voucherSig = await signAnonymaVoucher(privateKeyToAccount(DEV_KEYS.anonymaSigner), dep.chainId, C.queryEscrow, voucher);
  const anonBody = JSON.stringify({
    envelope: anonEnvelope, schemaId: SchemaId.SPLIT, n: 3, isPublic: true, refundTo: payer.toLowerCase(), voucherSig,
    voucher: { ...voucher, maxAmount: voucher.maxAmount.toString(), expiry: voucher.expiry.toString() },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const anonRes = await fetch(`${gw}/v1/anonyma/send-to-jury`, {
    method: "POST", body: anonBody,
    headers: { "content-type": "application/json", "x-mochi-timestamp": ts, "x-mochi-signature": signAnonyma(ANONYMA_SECRET, ts, anonBody) },
  });
  const anonJson = (await anonRes.json()) as { queryId: Hex; error?: unknown };
  ok(anonRes.ok, `Anonyma partner call accepted (HMAC) and relayed openWithVoucher${anonRes.ok ? "" : ` — ${anonRes.status} ${JSON.stringify(anonJson)}`}`);
  const anonQuery = anonJson.queryId;
  ok(anonQuery.toLowerCase() === anonQueryId.toLowerCase(), "voucher-paid query is the one the voucher names");
  const vidF = await waitVerdict(anonQuery, "Anonyma voucher");
  const qF = await read<{ payPath: number; status: number }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [anonQuery]);
  ok(Number(qF.payPath) === 2 && Number(qF.status) === 3, `voucher-paid query decided (verdict ${vidF.slice(0, 12)}…)`);

  console.log("6c. (G) The SDK end to end: MochiClient.ask → waitForVerdict → verifyReceipt → feed()");
  const sdk = new MochiClient({
    gatewayUrl: gw, indexerUrl: `http://127.0.0.1:${PORTS.indexer}`, quoteVerifier: verifier, intakeMeasurement: MEASUREMENT,
    chain: { deployment: dep },
  });
  const sdkDoc = new TextEncoder().encode("Sdk Co (NASDAQ: SDKX) today announced a 2-for-1 stock split, effective December 15, 2026.");
  const asked = await sdk.ask(
    { schema: "SPLIT", document: { bytes: sdkDoc, contentType: "text/plain" }, n: 3, isPublic: true, sender: payer.toLowerCase() as Address, refundTo: payer.toLowerCase() as Address },
    wallet(PAYER_KEY),
  );
  const vidG = await sdk.waitForVerdict(asked.queryId, { timeoutMs: 120_000 });
  const vG = await sdk.getVerdict(vidG);
  ok(JSON.stringify(vG).includes("SDKX"), "SDK ask → verdict with the right answer");
  const sdkReceipt = await until("SDK receipt", async () => { const r = await sdk.verifyReceipt(vidG); return r.valid ? r : undefined; }, 60_000);
  ok(sdkReceipt.valid, `SDK verifyReceipt valid (key ${sdkReceipt.keyId})`);
  const acmeFeed = await sdk.feed("corp-actions.split@RHC", toBytes32String("ACME"));
  ok((acmeFeed.body as { body?: { ratioNum?: unknown } })?.body?.ratioNum?.toString() === "2", "SDK feed() decodes corp-actions.split@RHC[ACME] (ratio 2)");

  console.log("6c-web. Browser client payment and private-result flow");
  const browserFlowModule = new URL("../web/test/e2e-flow.js", import.meta.url).href;
  const { browserFlow } = await import(browserFlowModule);
  await browserFlow({ dep, gw, indexer: `http://127.0.0.1:${PORTS.indexer}`, publicClient: pub,
    wallet: wallet(PAYER_KEY), verifier, measurement: MEASUREMENT, ok });
  // Other fixture flows use the harness's preapproved test balance.
  await send(PAYER_KEY, C.usdg, parseAbi(["function approve(address,uint256) returns (bool)"]), "approve", [C.queryEscrow, 1_000_000n * 10n ** 6n]);

  console.log("6d. View keys: payer discloses the private result to an auditor; the server can't read it");
  const auditor = x25519.utils.randomSecretKey();
  const auditorPub = toHex(x25519.getPublicKey(auditor));
  await sdk.disclose({ verdictId: vidB, result: plain, auditorPublicKey: auditorPub });
  const disclosed = await sdk.readDisclosure(vidB, toHex(auditor));
  ok(disclosed.answerJson === plain.answerJson, "auditor opened the disclosed result (answerHash checked on-chain)");

  console.log("7. Indexer: Anonyma-format receipts, verified independently against the published key");
  const ix = `http://127.0.0.1:${PORTS.indexer}`;
  const wellKnown = await until("receipt key", async () => (await fetch(`${ix}/.well-known/mochi-receipts.json`)).json() as Promise<{ key_id: string; public_key_pem: string }>);
  for (const [label, vid] of [["public", vidA], ["expanded feed", entry.verdictId]] as const) {
    const got = await until(`${label} receipt`, async () => {
      const r = await fetch(`${ix}/v1/receipts/${vid}`);
      return r.ok ? (await r.json()) as { receipt: Record<string, unknown>; signature: string } : undefined;
    }, 60_000);
    const check = verifyReceipt({ receipt: got.receipt, signature: got.signature, publicKeys: { [wellKnown.key_id]: wellKnown.public_key_pem } });
    ok(check.valid, `${label} verdict receipt verifies (key ${wellKnown.key_id}, ${(got.receipt.jurors as unknown[]).length} jurors)`);
  }


  console.log("8. Passports per verdict and kill-criteria stats");
  const vAjurors = (await (await fetch(`${gw}/v1/verdict/${vidA}`)).json() as { jurors?: { passport?: { modelId: string; lineage: string } | null }[] }).jurors ?? [];
  ok(vAjurors.length === 3 && vAjurors.every((j) => j.passport?.modelId.startsWith("model-class-")), "every juror on the public verdict shows its model Passport");
  const stats = await (await fetch(`${gw}/v1/stats`)).json() as { paidVerdicts: { external: number; total: number }; killCriteria: unknown };
  ok(stats.paidVerdicts.total >= 3 && stats.paidVerdicts.external >= 2, `stats: ${stats.paidVerdicts.external} external / ${stats.paidVerdicts.total} total paid verdicts (feed + internal excluded from external)`);

  console.log("9. (E) Human panel: feed query HUNG at N=3,5,7,9 → escalated → 3 staked evaluators → panel verdict → feed");
  const pnlKey = toBytes32String("PNL");
  // The PNL feed query that actually opened and got escalated (status ESCALATED = 5).
  const pnlQuery = await until("escalated PNL feed query", async () => {
    const rows = await db.sql<{ query_id: Hex }[]>`SELECT query_id FROM feed_queries WHERE key = ${pnlKey}`;
    for (const r of rows) {
      const q = await read<{ status: number }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [r.query_id]);
      if (Number(q.status) === 5) return r.query_id;
    }
    return undefined;
  }, 240_000);
  const P = A.PanelEscalationAbi;
  await until("panel drawn (COMMIT)", async () => Number((await read<{ status: number }>(C.panel, P, "getCase", [pnlQuery])).status) === 2 || undefined, 240_000);
  const qE = await read<{ n: number; round: number }>(C.queryEscrow, A.QueryEscrowAbi, "getQuery", [pnlQuery]);
  ok(Number(qE.n) === 9 && Number(qE.round) === 3, "orchestrator expanded 3→5→7→9, all HUNG, then escalated");
  const panelMembers = (await read<Address[]>(C.panel, P, "panelOf", [pnlQuery, 0])).map((a) => a.toLowerCase());
  const evaluators = EVALUATOR_KEYS.map((k) => ({ key: k, account: privateKeyToAccount(k) }));
  ok(panelMembers.length === 3 && evaluators.every((e) => panelMembers.includes(e.account.address.toLowerCase())), "the 3 staked evaluators were drawn");
  const pd = `http://127.0.0.1:${PORTS.panel}`;
  const reveals: { key: Hex; account: ReturnType<typeof privateKeyToAccount>; answerHash: Hex; payloadHash: Hex; salt: Hex; payload: Hex; answerJson: string }[] = [];
  let panelPayload: Hex = "0x";
  for (const e of evaluators) {
    const ek = generateEvaluatorKey();
    const keySig = await bindKey(e.account, pnlQuery, 0, ek.pubKey);
    const mres = await fetch(`${pd}/v1/panel/${pnlQuery}/materials`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluator: e.account.address.toLowerCase(), encryptionPubKey: ek.pubKey, keySig }),
    });
    const materials = await mres.json() as { queryId: Hex; evaluator: Hex; openedAt: string; docEnvelope: { v: 1; epk: Hex; nonce: Hex; ct: Hex }; jurorSummary: unknown };
    const doc = openMaterials(materials, ek.privKey);
    ok(Buffer.from(doc.docB64, "base64").toString().includes("PNL"), `evaluator ${e.account.address.slice(0, 8)}… opened the document sealed to it (juror split shown: ${materials.jurorSummary ? "yes" : "no"})`);
    // openedAt is the query's on-chain open time from the materials, so every evaluator builds the same payload.
    const answer = buildAnswer(doc.schemaId, doc.schemaVersion, doc.salt as Hex, doc.params,
      { ticker: "PNL", ratio_num: "2", ratio_den: "1", effective_date: longDate(PNL_EFFECTIVE) }, BigInt(materials.openedAt));
    const salt = keccak256(toHex(`salt-${e.account.address}`));
    await send(e.key, C.panel, P, "commit", [pnlQuery, commitment(pnlQuery, 0, e.account.address, answer.answerHash, answer.payloadHash, salt)]);
    reveals.push({ key: e.key, account: e.account, answerHash: answer.answerHash, payloadHash: answer.payloadHash, salt, payload: answer.payload, answerJson: answer.answerJson });
    panelPayload = answer.payload;
  }
  // The desk keeps a public payload only after the evaluator's on-chain reveal, and only the revealed one.
  for (const r of reveals) {
    await send(r.key, C.panel, P, "reveal", [pnlQuery, r.answerHash, r.payloadHash, r.salt]);
    const submitted = await fetch(`${pd}/v1/panel/${pnlQuery}/payload`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluator: r.account.address.toLowerCase(), panelIndex: 0, payload: r.payload, answerJson: r.answerJson, sig: await payloadSig(r.account, pnlQuery, 0, r.payload) }),
    });
    ok(submitted.status === 201, `evaluator ${r.account.address.slice(0, 8)}… payload accepted after its reveal`);
  }
  await until("panel resolved by keeper", async () => Number((await read<{ status: number }>(C.panel, P, "getCase", [pnlQuery])).status) === 4 || undefined, 60_000);
  ok(true, "keeper resolved the case (3/3 majority)");
  await pub.request({ method: "evm_increaseTime" as never, params: [86_401] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
  const panelVid = verdictIdOf(pnlQuery, 255);
  const pnlEntry = await until("panel feed update", async () => {
    const e = await read<FeedEntry>(C.feeds, A.FeedsAbi, "latest", [splitFeed, pnlKey]);
    return e.verdictId.toLowerCase() === panelVid.toLowerCase() ? e : undefined;
  }, 90_000);
  const vPanel = await read<{ escalated: boolean; round: number; ts: bigint }>(C.verdicts, A.MochiVerdictsAbi, "getVerdict", [panelVid]);
  ok(vPanel.escalated && Number(vPanel.round) === 255, "panel verdict on-chain (escalated, PANEL_ROUND)");
  ok(pnlEntry.asOf === BigInt(PNL_EFFECTIVE) && pnlEntry.verdictTs === BigInt(vPanel.ts) && keccak256(panelPayload) !== ZERO32, "keeper pushed the panel verdict into corp-actions.split@RHC[PNL] (crosscheck passed; verdictTs = panel verdict time)");

  console.log(`\nE2E PASSED: all services, every flow (${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s).`);
}

/** §7 load targets: 200-ticker corp-actions at N=3 (< 30 min) and earnings p95 < 120 s at N=7. */
async function runLoad(ctx: any) {
  const { gw, feedRunner, payer, send, read, submit, C, db } = ctx;
  const report: Record<string, unknown> = { tickers: LOAD_TICKERS, earnings: LOAD_EARNINGS, note:
    "Local anvil + fake model server: measures Mochi's own pipeline (intake, orchestration, consensus, chain), not GPU inference time." };
  console.log(`L1. corp-actions run over ${LOAD_TICKERS} tickers at N=3`);
  await send(DEV_KEYS.deployer, C.usdg, A.MockUSDGAbi, "mint", [feedRunner, 10_000n * 10n ** 6n]);
  await send(DEV_KEYS.feedRunner, C.usdg, A.MockUSDGAbi, "approve", [C.queryEscrow, 2n ** 255n]);
  await send(DEV_KEYS.feedRunner, C.queryEscrow, A.QueryEscrowAbi, "fundFeedBudget", [2_000n * 10n ** 6n]);
  const splitFeed = keccak256(toHex("corp-actions.split@RHC"));
  const t0 = Date.now();
  const trig = fetch(`http://127.0.0.1:${PORTS.feeds}/v1/feed-runners/run/corp-actions`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const keys = Array.from({ length: LOAD_TICKERS }, (_, i) => toBytes32String(loadTicker(i)));
  let done = 0;
  await until("all feed entries", async () => {
    const entries = await Promise.all(keys.map((k) => read(C.feeds, A.FeedsAbi, "latest", [splitFeed, k]) as Promise<{ verdictId: Hex }>));
    done = entries.filter((e) => !/^0x0+$/.test(e.verdictId)).length;
    process.stdout.write(`\r  ${done}/${LOAD_TICKERS} feed keys updated after ${Math.round((Date.now() - t0) / 1000)}s   `);
    return done === LOAD_TICKERS || undefined;
  }, 30 * 60_000);
  await trig;
  const corpSeconds = (Date.now() - t0) / 1000;
  console.log("");
  ok(corpSeconds < 30 * 60, `${LOAD_TICKERS}-ticker corp-actions run completed in ${corpSeconds.toFixed(1)}s (target < 1800s)`);
  report.corpActionsSeconds = corpSeconds;

  console.log(`L2. ${LOAD_EARNINGS} concurrent EARNINGS releases at N=7 (earnings-season burst)`);
  const latencies: number[] = [];
  await Promise.all(Array.from({ length: LOAD_EARNINGS }, async (_, i) => {
    await new Promise((r) => setTimeout(r, i * 150)); // stagger tx submission from one payer
    const t = letters(i);
    const text = `Load${t} Inc (NASDAQ: ERN${t}) reported diluted GAAP EPS of $2.${10 + (i % 80)} on revenue of $35.08 billion for the third quarter of fiscal 2026.`;
    const start = Date.now();
    const sub = await submitN7(ctx, text);
    const vid = await until(`earnings ${t}`, async () => {
      const q = await (await fetch(`${gw}/v1/queries/${sub}`)).json() as { latestVerdictId?: Hex };
      const id = q.latestVerdictId;
      if (!id || /^0x0+$/.test(id)) return undefined;
      return (await fetch(`${gw}/v1/verdict/${id}`)).ok ? id : undefined;
    }, 10 * 60_000);
    latencies.push((Date.now() - start) / 1000);
    void vid;
  }));
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)]!;
  report.earningsLatencySeconds = { p50: p(0.5), p95: p(0.95), max: latencies.at(-1) };
  ok(p(0.95) < 120, `earnings verdict latency p50 ${p(0.5).toFixed(1)}s, p95 ${p(0.95).toFixed(1)}s (target p95 < 120s) at N=7`);
  writeFileSync(join(RUN, "load-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`\nLOAD PASSED — report: ${join(RUN, "load-report.json")}`);
  void payer; void submit; void db;
}

/** Opens a public EARNINGS query at N=7 through the gateway (same path as flow A). */
async function submitN7(ctx: any, text: string): Promise<Hex> {
  const { gw, payer } = ctx;
  const att = await (await fetch(`${gw}/v1/intake/attestation`)).json() as { encryptionPubKey: Hex };
  const open: OpenBinding = { opener: payer.toLowerCase(), payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: false, nonce: BigInt(toHex(crypto.getRandomValues(new Uint8Array(8)))).toString() };
  const plain = { v: 1, schemaId: SchemaId.EARNINGS, salt: ZERO32, params: {}, contentType: "text/plain", docB64: Buffer.from(text).toString("base64"), open };
  const envelope = seal(att.encryptionPubKey, new TextEncoder().encode(JSON.stringify(plain)), aad.intake());
  const intake = await (await fetch(`${gw}/v1/intake/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) })).json();
  const prep = await (await fetch(`${gw}/v1/query`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ intake, n: 7, refundTo: payer.toLowerCase(), pay: { path: "usdg" } }),
  })).json() as { queryId: Hex; to: Address; data: Hex };
  // One payer account: send transactions strictly one after another (nonces).
  const run = payerQueue.then(async () => {
    const pub = createPublicClient({ transport: http(RPC) });
    const w = createWalletClient({ chain: chainFor({ chainId: 31337, rpcUrl: RPC, startBlock: "0", contracts: {} as never }), transport: http(RPC), account: privateKeyToAccount(PAYER_KEY) });
    const hash = await w.sendTransaction({ to: prep.to, data: prep.data });
    await pub.waitForTransactionReceipt({ hash });
  });
  payerQueue = run.catch(() => undefined);
  await run;
  return prep.queryId;
}
let payerQueue: Promise<unknown> = Promise.resolve();

main()
  .catch((e) => {
    console.error(e);
    console.error(`service logs: ${RUN}/*.log`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const p of procs) p.kill();
    process.exit(process.exitCode ?? 0);
  });
