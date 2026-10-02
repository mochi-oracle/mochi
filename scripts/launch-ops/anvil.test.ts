// Local-anvil plumbing tests for the launch tools. No enclave services run: an in-process fake intake/gateway (mock TEE
// keys, as scripts/e2e-core.ts uses) and a fake CVM status server stand in for the CVM, and the test itself plays the
// orchestrator, jurors and consensus. Everything binds to 127.0.0.1. Skipped when anvil is not installed; the dress
// rehearsal part also needs `forge build` output (privacy-pool artifacts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, formatUnits, http, keccak256, parseAbi, parseEther, toHex,
  type Abi, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalJson, docCommit, docHash, answerHash, spansRoot, votesHash, verdictId as computeVerdictId, ZERO32, type SeatInput, type JurorClass } from "@mochi/core";
import { aad, provenanceFromJson, type ProvenanceJson } from "@mochi/protocol";
import { buildPayload, normalizeAnswer, normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { buildVerdictHashes, runConsensus } from "@mochi/consensus";
import { MockTeeProvider, quoteHash, seal, signJurorAnswer, signProvenance, signVerdictAttestation } from "@mochi/tee";
import * as A from "@mochi/chain";
import { TxRefused, sendGuardedTx, type ConfirmIO } from "./common.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), Bun.which("anvil") ?? ""].find((p) => p && existsSync(p));
const ARTIFACTS = existsSync(join(ROOT, "contracts/out/Entrypoint.sol/Entrypoint.json"));
// Well-known anvil development keys (public; local chains only).
const DEV = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const satisfies readonly Hex[];
const M = keccak256(toHex("launch-ops-anvil-measurement"));
const mockRoot = privateKeyToAccount(keccak256(toHex("launch-ops-mock-root")));
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "canary-fixture.json"), "utf8")) as { claim: string; evidence: Array<{ title: string; excerpt: string }> };
const NEVER_PRINTED = [fixture.claim, fixture.evidence[0]!.excerpt, fixture.evidence[0]!.title];

/** Ports another local project may use; never start on or talk to them. */
const RESERVED_PORTS = new Set([8545, 18545]);
const LSOF = Bun.which("lsof");

/** PIDs listening on 127.0.0.1:<port> (undefined when lsof is unavailable). */
function listenerPids(port: number): number[] | undefined {
  if (!LSOF) return undefined;
  const out = Bun.spawnSync([LSOF, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
  return out.stdout.toString().split("\n").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
}

/** An OS-assigned high port that nothing listens on. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((ok) => server.close(() => ok()));
    if (port >= 20_000 && !RESERVED_PORTS.has(port) && (listenerPids(port)?.length ?? 0) === 0) return port;
  }
  throw new Error("no free high port");
}

/**
 * Starts our own anvil and proves the endpoint is ours before anything is sent: the port was free, the listener PID is
 * the anvil we spawned (when lsof exists), the process is alive, and eth_chainId is the one we asked for.
 */
async function startAnvil(chainId: number): Promise<{ rpc: string; proc: ChildProcess; stop(): void }> {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const proc = spawn(ANVIL!, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
  const stop = () => { proc.kill("SIGKILL"); };
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) {
        const reported = Number.parseInt((await r.json() as { result: string }).result, 16);
        const pids = listenerPids(port);
        if (proc.exitCode !== null || reported !== chainId || (pids !== undefined && (pids.length !== 1 || pids[0] !== proc.pid))) {
          stop();
          throw new Error(`127.0.0.1:${port} is not our anvil (chain ${reported}, listeners ${JSON.stringify(pids)}, ours ${proc.pid}); nothing sent`);
        }
        return { rpc, proc, stop };
      }
    } catch (error) { if (error instanceof Error && error.message.includes("is not our anvil")) throw error; }
    await Bun.sleep(100);
  }
  stop();
  throw new Error("anvil did not start");
}

function writeKey(dir: string, name: string, key: Hex): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ address: privateKeyToAccount(key).address, privateKey: key }), { mode: 0o600 });
  return file;
}

/** LAUNCH_OPS_DEBUG=1 prints each tool's (content-free) output, to review what the operator will see. */
const debug = (label: string, r: { code: number; stdout: string; stderr: string }) => { if (process.env.LAUNCH_OPS_DEBUG) console.log(`\n===== ${label} (exit ${r.code})\n${r.stdout}${r.stderr}`); return r; };

async function runBun(args: string[], opts: { env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return debug(args.slice(0, 2).join(" "), { code: await proc.exited, stdout, stderr });
}

function clientsFor(rpc: string, chainId: number) {
  const chain = defineChain({ id: chainId, name: `anvil-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = (key: Hex) => createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(key) });
  const send = async (key: Hex, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const w = wallet(key);
    const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args } as never);
    const hash = await w.writeContract(request as never);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };
  return { chain, pub, wallet, send };
}

function allFilesText(dir: string): string {
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    text += entry.isDirectory() ? allFilesText(path) : readFileSync(path, "utf8");
  }
  return text;
}

// ───────────────────────────── canary on a local deployment ─────────────────────────────

/** Fake intake + gateway (HTTP, loopback) and a test-driven orchestrator/jury/consensus. */
async function fakeProtocol(dep: A.Deployment, rpc: string) {
  const { pub, send } = clientsFor(rpc, 31337);
  const C = dep.contracts;
  const [admin, attestorKey, , orchestratorKey] = DEV;
  const provider = (seed: string) => new MockTeeProvider({ seed: keccak256(toHex(seed)), measurement: M, mockRoot });
  const intake = provider("anvil-intake"); const consensus = provider("anvil-consensus");
  const jurors = new Map<string, { tee: MockTeeProvider; cls: JurorClass }>();
  for (const cls of [0, 1, 2, 3, 4] as JurorClass[]) for (let i = 0; i < 2; i++) { const tee = provider(`anvil-juror-${cls}-${i}`); jurors.set(tee.signer().address.toLowerCase(), { tee, cls }); }
  const R = A.JurorRegistryAbi as Abi;
  for (const role of [1, 2, 3]) await send(admin, C.jurorRegistry, R, "setMeasurement", [M, role, true]);
  const adminAddress = privateKeyToAccount(admin).address;
  await send(admin, C.jurorRegistry, R, "registerServiceKey", [intake.signer().address, adminAddress, M, 2]);
  await send(admin, C.jurorRegistry, R, "registerServiceKey", [consensus.signer().address, adminAddress, M, 3]);
  await send(admin, C.mochiToken, A.MochiTokenAbi as Abi, "approve", [C.jurorRegistry, 2n ** 255n]);
  for (const { tee, cls } of jurors.values()) {
    const digest = await pub.readContract({ address: C.jurorRegistry, abi: R, functionName: "enrollmentDigest", args: [adminAddress, tee.signer().address, M, cls] }) as Hex;
    await send(admin, C.jurorRegistry, R, "enrollJuror", [tee.signer().address, M, cls, 25_000n * 10n ** 18n, await tee.signer().signMessage({ message: { raw: digest } })]);
  }
  const allKeys = [intake.signer().address, consensus.signer().address, ...[...jurors.values()].map((j) => j.tee.signer().address)];
  const now = (await pub.getBlock()).timestamp;
  await send(attestorKey, C.jurorRegistry, R, "refreshAttestation", [allKeys, now + 86_400n * 3n]);

  type Pending = { salt: Hex; text: string; params: Record<string, unknown>; resultPubKey?: Hex; ciphertext?: Hex; answered?: boolean };
  const byCommit = new Map<string, Pending>(); const byQuery = new Map<string, Pending>();
  const state = { answering: true, served: 0 };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const url = new URL(req.url); state.served++;
      if (req.method === "GET" && url.pathname === "/v1/intake/attestation") {
        return json({ role: "INTAKE", address: intake.signer().address.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement: M, quote: await intake.quote() });
      }
      if (req.method === "POST" && url.pathname === "/v1/intake/upload") {
        const { envelope } = await req.json() as { envelope: never };
        const plain = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake()))) as { schemaId: number; salt: Hex; params: Record<string, unknown>; docB64: string; open: { opener: string; payerCommit: Hex; isPublic: boolean; allowPanelDisclosure: boolean; nonce: string } };
        const bytes = new Uint8Array(Buffer.from(plain.docB64, "base64"));
        const def = resolveSchema(plain.schemaId as never, plain.params);
        const norm = normalizeParams(def, plain.params);
        if (!norm.ok) return json({ error: "params" }, 400);
        const commit = docCommit(plain.salt, docHash(bytes));
        const schemaVersion = Number(await pub.readContract({ address: C.schemaRegistry, abi: A.SchemaRegistryAbi, functionName: "latest", args: [plain.schemaId] }));
        const provenance: ProvenanceJson = {
          docCommit: commit, kind: 0, originId: ZERO32, fetchedAt: "0", tokensK: 1, transcriptHash: ZERO32, schemaId: plain.schemaId, schemaVersion,
          paramsHash: paramsHash(norm.params), ...plain.open, opener: plain.open.opener.toLowerCase(), expiry: String((await pub.getBlock()).timestamp + 900n),
        };
        const intakeSig = await signProvenance(intake.signer(), 31337, C.queryEscrow, provenanceFromJson(provenance));
        byCommit.set(commit, { salt: plain.salt, text: new TextDecoder().decode(bytes), params: plain.params });
        return json({ provenance, intakeSig, intake: intake.signer().address.toLowerCase(), docCommit: commit, paramsHash: provenance.paramsHash, schemaId: provenance.schemaId, tokensK: 1 });
      }
      if (req.method === "POST" && url.pathname === "/v1/query") {
        const body = await req.json() as { intake: { provenance: ProvenanceJson; intakeSig: Hex }; n: number; refundTo: Address; payerResultPubKey?: Hex };
        const prov = provenanceFromJson(body.intake.provenance);
        const queryId = (await pub.readContract({ address: C.queryEscrow, abi: A.QueryEscrowAbi, functionName: "computeQueryId", args: [prov.opener, prov.docCommit, prov.nonce] }) as Hex).toLowerCase();
        const pending = byCommit.get(prov.docCommit)!;
        byQuery.set(queryId, { ...pending, ...(body.payerResultPubKey ? { resultPubKey: body.payerResultPubKey } : {}) });
        const [jurorFees, protocolFee] = await pub.readContract({ address: C.queryEscrow, abi: A.QueryEscrowAbi, functionName: "quote", args: [prov.schemaId, body.n, prov.tokensK] }) as readonly [bigint, bigint];
        const data = encodeFunctionData({ abi: A.QueryEscrowAbi, functionName: "openWithUSDG", args: [{ n: body.n, refundTo: body.refundTo }, prov, body.intake.intakeSig] });
        return json({ queryId, to: C.queryEscrow.toLowerCase(), data, quote: { jurorFees: jurorFees.toString(), protocolFee: protocolFee.toString() } });
      }
      const queryMatch = /^\/v1\/queries\/(0x[0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === "GET" && queryMatch) {
        const q = await pub.readContract({ address: C.queryEscrow, abi: A.QueryEscrowAbi, functionName: "getQuery", args: [queryMatch[1] as Hex] }) as { status: number };
        const latest = await pub.readContract({ address: C.verdicts, abi: A.MochiVerdictsAbi, functionName: "latestVerdictOf", args: [queryMatch[1] as Hex] }) as Hex;
        return json({ query: { status: Number(q.status) }, latestVerdictId: latest.toLowerCase() });
      }
      const verdictMatch = /^\/v1\/verdict\/(0x[0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === "GET" && verdictMatch) {
        const v = await pub.readContract({ address: C.verdicts, abi: A.MochiVerdictsAbi, functionName: "getVerdict", args: [verdictMatch[1] as Hex] }) as unknown as A.VerdictView;
        const pending = byQuery.get(v.queryId.toLowerCase());
        if (!pending?.ciphertext) return json({ error: "not found" }, 404);
        return json({ verdictId: verdictMatch[1], chain: { queryId: v.queryId, schemaId: Number(v.schemaId), status: Number(v.status), answerHash: v.answerHash, payloadHash: v.payloadHash, isPublic: v.isPublic }, ciphertext: pending.ciphertext });
      }
      return json({ error: "not found" }, 404);
    },
  });

  /** Plays orchestrator, jurors and consensus for every opened query that has not been answered. */
  async function drive() {
    if (!state.answering) return;
    for (const [queryId, pending] of byQuery) {
      if (pending.answered) continue;
      const q = await pub.readContract({ address: C.queryEscrow, abi: A.QueryEscrowAbi, functionName: "getQuery", args: [queryId as Hex] }) as { status: number; schemaVersion: number; openedAt: bigint };
      if (Number(q.status) !== 1) continue;
      pending.answered = true;
      await pub.request({ method: "anvil_mine" as never, params: [toHex(2)] as never });
      await send(orchestratorKey, C.queryEscrow, A.QueryEscrowAbi as Abi, "seal", [queryId]);
      const seats = (await pub.readContract({ address: C.queryEscrow, abi: A.QueryEscrowAbi, functionName: "jurorsOf", args: [queryId as Hex] }) as Address[]).map((x) => x.toLowerCase());
      const def = resolveSchema(7 as never, pending.params);
      const norm = normalizeParams(def, pending.params);
      if (!norm.ok) throw new Error("params");
      const quoted = "The paper is available at: http://www.bitcoin.org/bitcoin.pdf";
      const raw = { fields: { answer: "contradicted" }, evidence: { answer: quoted }, confidence: { answer: 0.95 } };
      const inputs: SeatInput[] = []; const votes: { juror: Address; answerHash: Hex; spansRoot: Hex; quoteHash: Hex; sig: Hex }[] = [];
      const docCommitValue = docCommit(pending.salt, docHash(new TextEncoder().encode(pending.text)));
      for (const [seat, address] of seats.entries()) {
        const { tee, cls } = jurors.get(address)!;
        const body = normalizeAnswer(def, raw, pending.text);
        const ah = answerHash({ salt: pending.salt, schemaId: def.id, schemaVersion: Number(q.schemaVersion), fields: body.fields });
        const sr = spansRoot(body.spans); const qh = quoteHash(await tee.quote());
        const sig = await signJurorAnswer(tee.signer(), 31337, C.verdicts, { queryId: queryId as Hex, docCommit: docCommitValue, schemaId: def.id, schemaVersion: Number(q.schemaVersion), answerHash: ah, spansRoot: sr, quoteHash: qh });
        votes.push({ juror: address as Address, answerHash: ah, spansRoot: sr, quoteHash: qh, sig });
        inputs.push({ seat, juror: address as Address, jurorClass: cls, timedOut: false, answer: body });
      }
      const result = runConsensus(def, inputs);
      const hashes = buildVerdictHashes(def, result, inputs, pending.salt);
      const payload = buildPayload(def, result.agreed, norm.params, { openedAt: BigInt(q.openedAt), privateSalt: pending.salt });
      const input = { queryId: queryId as Hex, round: 0, status: result.status, agreementBps: result.agreementBps, dissentMask: result.dissentMask, timeoutMask: result.timeoutMask, answerHash: hashes.answerHash, payloadHash: payload.payloadHash, evidenceRoot: hashes.evidenceRoot };
      await send(orchestratorKey, C.verdicts, A.MochiVerdictsAbi as Abi, "post", [input, votes, await signVerdictAttestation(consensus.signer(), 31337, C.verdicts, input, votesHash(votes))]);
      const vid = computeVerdictId(queryId as Hex, 0);
      const envelope = seal(pending.resultPubKey!, new TextEncoder().encode(canonicalJson({ v: 1, verdictId: vid, salt: pending.salt, answerJson: hashes.answerJson, payload: payload.payload, fields: [] })), aad.result(vid));
      pending.ciphertext = toHex(new TextEncoder().encode(JSON.stringify(envelope)));
    }
  }
  return { url: `http://127.0.0.1:${server.port}`, server, state, drive, intake: intake.signer().address, byQuery };
}

/** Runs the canary as a separate process while the test drives the fake protocol. */
async function runCanaryWhileDriving(args: string[], backend: Awaited<ReturnType<typeof fakeProtocol>>) {
  const proc = Bun.spawn([process.execPath, "scripts/canary-check.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  while (!exited) { await backend.drive(); await Bun.sleep(300); }
  const [stdout, stderr] = await output;
  return debug("canary-check (driven)", { code: await proc.exited, stdout, stderr });
}

describe.skipIf(!ANVIL)("canary on local anvil (fake intake/gateway, test-driven jury)", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let dir: string; let deploymentPath: string; let dep: A.Deployment;
  let backend: Awaited<ReturnType<typeof fakeProtocol>>;
  let common: string[]; let quotedTotal: bigint;

  beforeAll(async () => {
    anvil = await startAnvil(31337);
    dir = mkdtempSync(join(tmpdir(), "canary-anvil-"));
    deploymentPath = join(dir, "local.json");
    const deployed = await runBun(["scripts/deploy-local.ts", "--rpc", anvil.rpc, "--out", deploymentPath]);
    if (deployed.code !== 0) throw new Error(`local deploy failed:\n${deployed.stderr.slice(-2000)}`);
    dep = JSON.parse(readFileSync(deploymentPath, "utf8"));
    backend = await fakeProtocol(dep, anvil.rpc);
    const { send, pub } = clientsFor(anvil.rpc, 31337);
    const payer = privateKeyToAccount(DEV[5]);
    await send(DEV[0], dep.contracts.usdg, A.MockUSDGAbi as Abi, "mint", [payer.address, 10_000_000n]);
    const [fees, fee] = await pub.readContract({ address: dep.contracts.queryEscrow, abi: A.QueryEscrowAbi, functionName: "quote", args: [7, 3, 1] }) as readonly [bigint, bigint];
    quotedTotal = fees + fee;
    const identities = join(dir, "identities.json");
    writeFileSync(identities, JSON.stringify({ intake: { address: backend.intake.toLowerCase() }, attestor: privateKeyToAccount(DEV[1]).address, feedRunner: privateKeyToAccount(DEV[2]).address, orchestrator: privateKeyToAccount(DEV[3]).address, indexer: privateKeyToAccount(DEV[0]).address, postman: privateKeyToAccount(DEV[4]).address }));
    common = ["--deployment", deploymentPath, "--payer-key-file", writeKey(dir, "payer", DEV[5]), "--measurement", M, "--gateway-url", backend.url, "--identities", identities,
      "--expected-total", formatUnits(quotedTotal, 6), "--insecure-mock-quote-root", mockRoot.address, "--yes"];
  }, 120_000);
  afterAll(() => { backend?.server.stop(true); anvil?.stop(); });

  test("VERDICT: label, on-chain answer/payload hashes, exact charge, service-signer gas and latency; no content anywhere", async () => {
    const out = join(dir, "out-verdict");
    const result = await runCanaryWhileDriving([...common, "--out", out, "--timeout", "60"], backend);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    for (const part of ["Transaction:", "function : approve(spender=QueryEscrow", "function : openWithUSDG(n=3", "chain    : 31337", "CANARY VERDICT", "outcome (decrypted enum label): contradicted; expected contradicted: match", "MATCHES", "salted private payloadHash matches", "CANARY PASSED", "gas orchestrator"]) expect(result.stdout).toContain(part);
    const report = JSON.parse(readFileSync(join(out, readdirSync(out).find((f) => f.startsWith("canary-report-"))!), "utf8"));
    expect(report).toMatchObject({ status: "VERDICT", answer: "contradicted", answerMatchesExpected: true, answerHashMatches: true, payloadHashMatches: true });
    expect(report.reconciliation.ok).toBe(true);
    expect(Number(report.gas.find((g: { role: string }) => g.role === "orchestrator").spentEth)).toBeGreaterThan(0);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(out)) expect(statSync(join(out, f)).mode & 0o777).toBe(0o600);
    const everything = result.stdout + result.stderr + allFilesText(out);
    for (const secret of [...NEVER_PRINTED, DEV[5].slice(2)]) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("resultPrivateKey");
  }, 120_000);

  test("timeout keeps the checkpoint open, a rerun refuses to pay again, expiry refunds exactly and --resume reconciles", async () => {
    const out = join(dir, "out-timeout");
    backend.state.answering = false;
    const first = await runCanaryWhileDriving([...common, "--out", out, "--timeout", "4"], backend);
    expect(first.code).toBe(1);
    for (const part of ["CANARY timeout", "Telemetry pointers", "causeCode", "anyone may expire it"]) expect(first.stdout).toContain(part);
    const checkpoint = JSON.parse(readFileSync(join(out, "canary-checkpoint.json"), "utf8"));
    expect(checkpoint.status).toBe("opened");
    const again = await runBun(["scripts/canary-check.ts", ...common, "--out", out, "--timeout", "4"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("did not finish; rerun with --resume");
    const { pub } = clientsFor(anvil.rpc, 31337);
    await pub.request({ method: "evm_increaseTime" as never, params: [3601] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    const expire = await runBun(["scripts/canary-check.ts", "expire", "--deployment", deploymentPath, "--payer-key-file", join(dir, "payer.json"), "--query-id", checkpoint.queryId, "--out", out, "--yes"]);
    expect(expire.code, expire.stdout + expire.stderr).toBe(0);
    expect(expire.stdout).toContain(`QueryExpired refunded ${formatUnits(quotedTotal, 6)}`);
    const resumed = await runBun(["scripts/canary-check.ts", ...common, "--out", out, "--resume", "--timeout", "4"]);
    expect(resumed.stdout).toContain("CANARY EXPIRED");
    const report = JSON.parse(readFileSync(join(out, "canary-checkpoint.json"), "utf8"));
    expect(report.status).toBe("finished");
    expect(report.result.status).toBe("EXPIRED");
    expect(report.result.reconciliation.ok).toBe(true);
    expect(report.result.reconciliation.lines.join("\n")).toContain("payer net debit 0 USDG");
    backend.state.answering = true;
  }, 120_000);
});

// ───────────────────────────── the 4663 send gate on a real chain ─────────────────────────────

describe.skipIf(!ANVIL)("send gate on an anvil that reports chain 4663", () => {
  test("nothing is sent without an interactive typed yes; --yes is refused", async () => {
    const anvil = await startAnvil(4663);
    try {
      const { chain, pub } = clientsFor(anvil.rpc, 4663);
      const account = privateKeyToAccount(DEV[0]);
      const walletClient = createWalletClient({ chain, transport: http(anvil.rpc), account });
      const intent = { chainId: 4663, signer: account.address, to: privateKeyToAccount(DEV[1]).address, functionName: "(ETH transfer)", value: 1n, amount: "1 wei", purpose: "gate test", data: "0x" as Hex };
      const io = (answer: string, interactive: boolean): ConfirmIO => ({ interactive, ask: async () => answer, print: () => {} });
      const nonce = () => pub.getTransactionCount({ address: account.address });
      const before = await nonce();
      await expect(sendGuardedTx({ publicClient: pub as never, walletClient: walletClient as never }, intent, { yes: false }, io("yes", false))).rejects.toBeInstanceOf(TxRefused);
      await expect(sendGuardedTx({ publicClient: pub as never, walletClient: walletClient as never }, intent, { yes: true }, io("yes", true))).rejects.toBeInstanceOf(TxRefused);
      await expect(sendGuardedTx({ publicClient: pub as never, walletClient: walletClient as never }, intent, { yes: false }, io("y", true))).rejects.toBeInstanceOf(TxRefused);
      expect(await nonce()).toBe(before);
      await sendGuardedTx({ publicClient: pub as never, walletClient: walletClient as never }, intent, { yes: false }, io("yes", true));
      expect(await nonce()).toBe(before + 1);
    } finally { anvil.stop(); }
  }, 60_000);
});

// ───────────────────────────── dress rehearsal + launch-watch on a 46630-shaped anvil ─────────────────────────────

describe.skipIf(!ANVIL || !ARTIFACTS)("dress rehearsal on an anvil with chain id 46630 (fake CVM)", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let cvm: ReturnType<typeof Bun.serve>;
  const cvmState: { mode: string; payments: boolean; services: Record<string, string>; identities: unknown[]; serviceSigners: unknown[]; proofs: unknown[] } = { mode: "standby", payments: false, services: {}, identities: [], serviceSigners: [], proofs: [] };

  beforeAll(async () => {
    anvil = await startAnvil(46630);
    cvm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/production/status") return Response.json({ status: cvmState.mode === "standby" ? "standby" : "running", mode: cvmState.mode, payments: cvmState.payments, services: cvmState.services });
      if (path === "/production/identities") return Response.json({ ready: true, identities: cvmState.identities, serviceSigners: cvmState.serviceSigners });
      if (path === "/production/enrollment") return Response.json({ proofs: cvmState.proofs });
      return Response.json({ error: "not found" }, { status: 404 });
    } });
  }, 60_000);
  afterAll(() => { cvm?.stop(true); anvil?.stop(); });

  test("runs every non-CVM step, hands CVM steps to the operator, resumes from checkpoints and never repeats a sent step", async () => {
    const { pub, wallet, send } = clientsFor(anvil.rpc, 46630);
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-anvil-"));
    const out = join(dir, "out");
    const deployer = wallet(DEV[0]);
    const usdg = (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: A.MockUSDGAbi, bytecode: A.MockUSDGBytecode }) })).contractAddress!;
    const mochi = (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: A.MochiTokenAbi, bytecode: A.MochiTokenBytecode, args: [deployer.account.address, 10n ** 27n] }) })).contractAddress!;
    const keys = { deployer: writeKey(dir, "deployer", DEV[0]), owner: writeKey(dir, "owner", DEV[1]), operator: writeKey(dir, "operator", DEV[2]) };
    const operator = privateKeyToAccount(DEV[2]).address;
    const cvmUrl = `http://127.0.0.1:${cvm.port}`;
    const rehearse = (...args: string[]) => runBun(["scripts/dress-rehearsal.ts", "--out", out, "--yes", ...args]);
    const expectOk = (r: { code: number; stdout: string; stderr: string }) => { expect(r.code, r.stdout + r.stderr).toBe(0); return r; };

    // 1. preflight → deploy → verify-deployment
    const first = expectOk(await rehearse("--panel-escalation", "off", "--deployer-key-file", keys.deployer, "--owner-key-file", keys.owner, "--operator-key-file", keys.operator,
      "--measurement", M, "--compose", "/review/compose.yml", "--cvm-url", cvmUrl, "--rpc", anvil.rpc, "--usdg", usdg, "--mochi-token", mochi, "--timelock-delay", "0",
      "--wait-healthy", "30", "--warmup", "1", "--until", "verify-deployment"));
    expect(first.stdout).toContain("ownership verified; panel escalation off on chain; escrow paused");
    const deploymentPath = join(out, "deployment.json");
    expect(statSync(deploymentPath).mode & 0o777).toBe(0o600);
    const dep = JSON.parse(readFileSync(deploymentPath, "utf8")) as A.Deployment & { owner: Address };
    const deployerNonceAfterDeploy = await pub.getTransactionCount({ address: deployer.account.address });

    // 2. identities need DCAP-verified CVM quotes; stand in reviewed launch identities (as prepare-production-launch writes them).
    const enclave = Array.from({ length: 11 }, () => privateKeyToAccount(generatePrivateKey()));
    const classes = [0, 0, 1, 1, 2, 2, 3, 4, 4];
    const ids = {
      salt: keccak256(toHex("anvil-rehearsal-salt")), intake: { address: enclave[0]!.address, operator, measurement: M }, consensus: { address: enclave[1]!.address, operator, measurement: M },
      jurors: classes.map((cls, i) => ({ address: enclave[i + 2]!.address, operator, measurement: M, class: cls })),
      attestor: privateKeyToAccount(DEV[3]).address, feedRunner: privateKeyToAccount(generatePrivateKey()).address, orchestrator: privateKeyToAccount(generatePrivateKey()).address,
      indexer: privateKeyToAccount(generatePrivateKey()).address, postman: privateKeyToAccount(generatePrivateKey()).address,
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(out, "launch"), { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "launch", "production-identities.json"), JSON.stringify(ids), { mode: 0o600 });
    for (const id of ["identities", "env-files"]) writeFileSync(join(out, "checkpoints", `${id}.json`), JSON.stringify({ id, state: "done", startedAt: "t", updatedAt: "t", txs: [], outputs: { note: "stood in by the anvil test" } }), { mode: 0o600 });

    // 3. fund, then the first CVM step is handed to the operator
    const handOff = expectOk(await rehearse());
    expect(handOff.stdout).toContain("top up orchestrator");
    expect(handOff.stdout).toContain(`OPERATOR STEP — this script does not run phala. The lead agent runs exactly:\n  phala deploy --cvm-id 21dfb9d71c8d72522bb4372657b96308a190daaa -c /review/compose.yml -e ${join(out, "cvm-prepare.env")} --public-logs --wait --timeout 600`);
    expect(await pub.getBalance({ address: ids.orchestrator })).toBe(parseEther("0.0005"));
    const waiting = expectOk(await rehearse());
    expect(waiting.stdout).toContain("OPERATOR STEP");
    expect(await pub.getBalance({ address: ids.orchestrator })).toBe(parseEther("0.0005"));

    // 4. lead agent "deploys" prepare mode → configure batch → enrollment proofs and 9 operator transactions → enroll hand-off
    cvmState.mode = "prepare"; cvmState.services = { intake: "healthy", consensus: "healthy", gateway: "healthy" };
    cvmState.identities = enclave.map((acct) => ({ name: "x", address: acct.address, measurement: M, quote: { measurement: M } }));
    cvmState.serviceSigners = [["attestor", ids.attestor], ["indexer", ids.indexer], ["orchestrator", ids.orchestrator], ["feed-runner", ids.feedRunner], ["postman", ids.postman]].map(([name, address]) => ({ name, address }));
    const registry = dep.contracts.jurorRegistry;
    cvmState.proofs = await Promise.all(classes.map(async (cls, i) => {
      const key = enclave[i + 2]!;
      const digest = keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }], ["mochi.enroll.v1", 46630n, registry, operator, key.address, M, cls]));
      return { chainId: 46630, registry, operator, key: key.address, measurement: M, jurorClass: cls, digest, signature: await key.signMessage({ message: { raw: digest } }) };
    }));
    const prepared = expectOk(await rehearse("--continue", "cvm-prepare"));
    expect(prepared.stdout).toContain("configure batch executed");
    expect(prepared.stdout).toContain("function : enrollJuror(");
    expect(prepared.stdout).toContain("-e " + join(out, "cvm-enroll.env"));
    expect(await pub.readContract({ address: dep.contracts.queryEscrow, abi: parseAbi(["function paused() view returns (bool)"]), functionName: "paused" })).toBe(true);

    // 5. enroll mode: the CVM's attestor refreshes attestations; then activate → active hand-off
    cvmState.mode = "enroll";
    const now = (await pub.getBlock()).timestamp;
    await send(DEV[3], registry, A.JurorRegistryAbi as Abi, "refreshAttestation", [enclave.map((e) => e.address), now + 1200n]);
    const enrolled = expectOk(await rehearse("--continue", "cvm-enroll"));
    expect(enrolled.stdout).toContain("11/11 identities active");
    expect(enrolled.stdout).toContain("escrow unpaused through the timelock");

    // 6. active mode, then launch-watch against the live wiring
    cvmState.mode = "active"; cvmState.payments = true;
    expectOk(await rehearse("--continue", "cvm-active", "--until", "cvm-active"));
    const watch = await runBun(["scripts/launch-watch.ts", "--deployment", deploymentPath, "--identities", join(out, "launch", "production-identities.json"), "--measurement", M, "--cvm-url", cvmUrl, "--once", "--json"]);
    const tick = JSON.parse(watch.stdout.trim().split("\n").at(-1)!);
    expect(watch.code, watch.stdout + watch.stderr).toBe(0);
    expect(tick).toMatchObject({ ok: true, escrow: { paused: false }, cvm: { status: { mode: "active", payments: true } }, identities: { summary: { count: 11, measurementOk: true } } });
    expect(tick.warnings).toContain("low_orchestrator");
    expect(tick.balances.map((b: { role: string }) => b.role)).toEqual(["owner", "operator", "orchestrator", "indexer", "attestor", "postman", "feedRunner"]);
    const line = await runBun(["scripts/launch-watch.ts", "--deployment", deploymentPath, "--cvm-url", cvmUrl, "--once", "--expect-mode", "prepare"]);
    expect(line.code).toBe(1);
    expect(line.stdout).toContain("failures=cvm_mode_active_expected_prepare");

    // 7. the canary needs drand beacons and enclave services (covered on 31337 above); stand it in, then pause → standby
    writeFileSync(join(out, "checkpoints", "canary.json"), JSON.stringify({ id: "canary", state: "done", startedAt: "t", updatedAt: "t", txs: [], outputs: { note: "covered by the 31337 canary test" } }), { mode: 0o600 });
    const paused = expectOk(await rehearse());
    expect(paused.stdout).toContain("function : pause()");
    expect(paused.stdout).toContain("-e " + join(out, "cvm-standby.env"));
    cvmState.mode = "standby"; cvmState.payments = false; cvmState.services = {};
    const done = expectOk(await rehearse("--continue", "cvm-standby"));
    expect(done.stdout).toContain("DRESS REHEARSAL COMPLETE");

    // 8. a rerun sends nothing; deploy ran exactly once; nothing secret was written
    const ownerNonce = await pub.getTransactionCount({ address: dep.owner });
    expectOk(await rehearse());
    expect(await pub.getTransactionCount({ address: dep.owner })).toBe(ownerNonce);
    // Four fresh service signers needed top-ups (owner, operator and the attestor account were already funded); no redeploy.
    expect(await pub.getTransactionCount({ address: deployer.account.address })).toBe(deployerNonceAfterDeploy + 4);
    const written = allFilesText(out);
    for (const key of [DEV[0], DEV[1], DEV[2]]) expect(written).not.toContain(key.slice(2));
    const config = JSON.parse(readFileSync(join(out, "rehearsal-config.json"), "utf8"));
    expect(config).toMatchObject({ chainId: 46630, panelEscalation: "off", timelockDelay: "0" });
  }, 240_000);
});
