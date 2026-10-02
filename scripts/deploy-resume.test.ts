// deploy-local --mainnet --rehearsal on a local anvil with chain id 46630: the full plan, interruptions at several points
// followed by --resume, chain states that contradict the journal, a broadcast whose response is lost, the balance
// pre-flight, and the dress rehearsal resuming an interrupted deploy. Every chain is our own anvil on a free high port
// (listener PID and chain id checked before anything is sent). Skipped without anvil or forge artifacts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as A from "@mochi/chain";
import { ANVIL, ARTIFACTS, RESERVED_PORTS, freePort, rpcCall, runBun, startAnvil, writeKey, type LocalAnvil, type RunResult } from "./launch-ops/anvil-harness.ts";
import type { GasTable, Journal } from "./launch-ops/deploy-journal.ts";

// Well-known anvil development keys (public; local chains only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OPERATOR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const TOKEN_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const FAULT = "MOCHI_DEPLOY_TEST_FAULT";

/** The plan of `--mainnet --rehearsal --panel-escalation off` with the test token and no optional recipients, in order. */
const EXPECTED_PLAN = `
deploy.TestMochiToken deploy.DrandRandomness deploy.SchemaRegistry deploy.JurorRegistry deploy.QueryEscrow deploy.MochiStaking deploy.MochiVerdicts
deploy.PanelEscalation deploy.Feeds deploy.StockTokenCrosscheck deploy.ReceiptAnchor deploy.PoseidonT3 deploy.PoseidonT4 deploy.WithdrawalVerifier
deploy.CommitmentVerifier deploy.EntrypointImplementation deploy.EntrypointProxy deploy.PrivacyPoolComplex privacy.entrypoint.registerPool
deploy.PrivacyPoolShieldedPayments deploy.ClassMix deploy.ClerkVoting deploy.DisclosureRegistry
wire.queryEscrow.setVerdicts wire.queryEscrow.setPanelReserveBps wire.queryEscrow.setStaking wire.queryEscrow.setShielded wire.queryEscrow.setAnonymaSigner
wire.queryEscrow.setClassPrice.0 wire.queryEscrow.setClassPrice.1 wire.queryEscrow.setClassPrice.2 wire.queryEscrow.setClassPrice.3 wire.queryEscrow.setClassPrice.4
wire.queryEscrow.setProtocolFee wire.verdicts.setPanel wire.jurorRegistry.grantRole.SLASHER_ROLE.verdicts wire.jurorRegistry.setClassMix
wire.schemaRegistry.grantRole.GOVERNOR_ROLE.clerkVoting wire.classMix.grantRole.GOVERNOR_ROLE.clerkVoting wire.staking.grantRole.LOCKER_ROLE.clerkVoting
schemas.propose.1 schemas.propose.2 schemas.propose.3 schemas.propose.4 schemas.propose.5 schemas.propose.6 schemas.propose.7
feeds.register.corp-actions.exdiv@RHC feeds.register.corp-actions.split@RHC feeds.register.earnings@RHC feeds.register.attestations.reserve@RHC feeds.register.attestations.nav@RHC
launch.queryEscrow.pause deploy.MochiTimelock
handover.queryEscrow.grantRole.GOVERNOR_ROLE.timelock handover.queryEscrow.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.queryEscrow.grantRole.GUARDIAN_ROLE.guardian
handover.queryEscrow.grantRole.GUARDIAN_ROLE.timelock handover.queryEscrow.grantRole.FEED_RUNNER_ROLE.feedRunner handover.queryEscrow.grantRole.FEED_RUNNER_ROLE.orchestrator
handover.jurorRegistry.grantRole.GOVERNOR_ROLE.timelock handover.jurorRegistry.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.jurorRegistry.grantRole.SLASHER_ROLE.verdicts
handover.jurorRegistry.grantRole.ATTESTOR_ROLE.attestor handover.schemaRegistry.grantRole.GOVERNOR_ROLE.timelock handover.schemaRegistry.grantRole.DEFAULT_ADMIN_ROLE.timelock
handover.schemaRegistry.grantRole.GOVERNOR_ROLE.clerkVoting handover.staking.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.staking.grantRole.LOCKER_ROLE.clerkVoting
handover.verdicts.grantRole.GOVERNOR_ROLE.timelock handover.verdicts.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.panel.grantRole.GOVERNOR_ROLE.timelock
handover.panel.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.panel.grantRole.FEED_RUNNER_ROLE.feedRunner handover.panel.grantRole.FEED_RUNNER_ROLE.orchestrator
handover.feeds.grantRole.GOVERNOR_ROLE.timelock handover.feeds.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.stockTokenCrosscheck.grantRole.GOVERNOR_ROLE.timelock
handover.stockTokenCrosscheck.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.receiptAnchor.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.receiptAnchor.grantRole.ANCHORER_ROLE.orchestrator
handover.classMix.grantRole.GOVERNOR_ROLE.timelock handover.classMix.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.classMix.grantRole.GOVERNOR_ROLE.clerkVoting
handover.clerkVoting.grantRole.DEFAULT_ADMIN_ROLE.timelock handover.entrypoint.grantRole.OWNER_ROLE.timelock handover.entrypoint.renounceRole.ASP_POSTMAN_ROLE.deployer
handover.entrypoint.renounceRole.OWNER_ROLE.deployer
handover.queryEscrow.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.queryEscrow.renounceRole.GOVERNOR_ROLE.deployer handover.queryEscrow.renounceRole.GUARDIAN_ROLE.deployer
handover.queryEscrow.renounceRole.FEED_RUNNER_ROLE.deployer handover.jurorRegistry.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.jurorRegistry.renounceRole.GOVERNOR_ROLE.deployer
handover.jurorRegistry.renounceRole.ATTESTOR_ROLE.deployer handover.jurorRegistry.renounceRole.SLASHER_ROLE.deployer handover.schemaRegistry.renounceRole.DEFAULT_ADMIN_ROLE.deployer
handover.schemaRegistry.renounceRole.GOVERNOR_ROLE.deployer handover.staking.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.staking.renounceRole.LOCKER_ROLE.deployer
handover.verdicts.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.verdicts.renounceRole.GOVERNOR_ROLE.deployer handover.panel.renounceRole.DEFAULT_ADMIN_ROLE.deployer
handover.panel.renounceRole.GOVERNOR_ROLE.deployer handover.panel.renounceRole.FEED_RUNNER_ROLE.deployer handover.feeds.renounceRole.DEFAULT_ADMIN_ROLE.deployer
handover.feeds.renounceRole.GOVERNOR_ROLE.deployer handover.stockTokenCrosscheck.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.stockTokenCrosscheck.renounceRole.GOVERNOR_ROLE.deployer
handover.receiptAnchor.renounceRole.DEFAULT_ADMIN_ROLE.deployer handover.receiptAnchor.renounceRole.ANCHORER_ROLE.deployer handover.classMix.renounceRole.DEFAULT_ADMIN_ROLE.deployer
handover.classMix.renounceRole.GOVERNOR_ROLE.deployer handover.clerkVoting.renounceRole.DEFAULT_ADMIN_ROLE.deployer
handover.mochiToken.transferMetadataAdmin`.trim().split(/\s+/);

/** Top-level, contracts, privacy and roles keys of a mainnet-style deployment JSON (the shape tools downstream read). */
const DEPLOYMENT_SHAPE = {
  top: ["chainId", "rpcUrl", "startBlock", "randomness", "contracts", "privacy", "deployer", "owner", "timelock", "guardian", "paused", "roles", "stockTokens", "mochiRecipient", "postman", "rehearsal", "minJurorBond", "timelockDelay", "panelEscalation", "tokenSource"],
  contracts: ["mochiToken", "randomness", "schemaRegistry", "jurorRegistry", "queryEscrow", "verdicts", "feeds", "stockTokenCrosscheck", "panel", "staking", "receiptAnchor", "usdg", "shielded", "classMix", "clerkVoting", "disclosureRegistry", "timelock"],
  privacy: ["entrypoint", "pool", "adapter", "withdrawalVerifier", "commitmentVerifier", "poseidonT3", "poseidonT4", "scope"],
  roles: ["queryEscrow", "jurorRegistry", "schemaRegistry", "staking", "verdicts", "panel", "feeds", "stockTokenCrosscheck", "receiptAnchor", "classMix", "clerkVoting", "MochiTimelock", "entrypoint", "mochiToken"],
};

type Env = { anvil: LocalAnvil; rpc: string; dir: string; out: string; key: string; usdg: Address; snapshot: Hex };

/** Our own 46630 anvil, Mock USDG from a separate account (so the deployer starts at nonce 0), a key file and --out. */
async function setup(): Promise<Env> {
  const anvil = await startAnvil(46630);
  const pub = createPublicClient({ transport: http(anvil.rpc) });
  const tokenWallet = createWalletClient({ transport: http(anvil.rpc), account: privateKeyToAccount(TOKEN_KEY) });
  const usdg = (await pub.waitForTransactionReceipt({ hash: await tokenWallet.deployContract({ abi: A.MockUSDGAbi, bytecode: A.MockUSDGBytecode, chain: null }) })).contractAddress!;
  const dir = mkdtempSync(join(tmpdir(), "deploy-resume-"));
  const snapshot = await rpcCall<Hex>(anvil.rpc, "evm_snapshot");
  return { anvil, rpc: anvil.rpc, dir, out: join(dir, "deployment.json"), key: writeKey(dir, "deploy-key", DEPLOYER_KEY), usdg, snapshot };
}

const deployArgs = (env: Env, rpc: string, ...extra: string[]) => ["scripts/deploy-local.ts", "--mainnet", "--rehearsal", "--rpc", rpc, "--key-file", env.key, "--out", env.out,
  "--owner", OWNER, "--usdg", env.usdg, "--shielded", "privacy-pools", "--randomness", "drand", "--panel-escalation", "off", ...extra];
let runs = 0;
/** DEPLOY_RESUME_DEBUG=<dir> keeps every deploy-local run's output there, to review what the operator sees. */
const debugRun = (args: string[], r: RunResult) => {
  const dir = process.env.DEPLOY_RESUME_DEBUG;
  if (dir) writeFileSync(join(dir, `${String(++runs).padStart(2, "0")}.log`), `$ bun ${args.join(" ")}\nexit ${r.code} signal ${r.signal}\n${r.stdout}\n--- stderr\n${r.stderr}`);
  return r;
};
const deploy = async (env: Env, extra: string[] = [], opts: { fault?: string; rpc?: string; onStdout?: (text: string) => void } = {}) => {
  const args = deployArgs(env, opts.rpc ?? env.rpc, ...extra);
  return debugRun([...(opts.fault ? [`${FAULT}=${opts.fault}`] : []), ...args], await runBun(args, { env: opts.fault ? { [FAULT]: opts.fault } : {}, ...(opts.onStdout ? { onStdout: opts.onStdout } : {}), timeoutMs: 240_000 }));
};
const journalOf = (env: Env) => JSON.parse(readFileSync(`${env.out}.progress.json`, "utf8")) as Journal;
const stepOf = (env: Env, id: string) => journalOf(env).steps.find((s) => s.id === id);
const nonceOf = async (env: Env, tag: "latest" | "pending" = "latest") => Number(await rpcCall<string>(env.rpc, "eth_getTransactionCount", [DEPLOYER, tag]));
const ok = (r: RunResult) => { expect(r.code, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBe(0); return r; };
const killed = (r: RunResult) => { expect(r.signal, `${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`).toBe("SIGKILL"); return r; };
const refused = (r: RunResult, text: string) => { expect(r.code, r.stdout.slice(-1500)).toBe(1); expect(r.stderr).toContain(text); return r; };

/** Every transaction the deployer ever sent on this chain, in nonce order. */
async function deployerTxs(env: Env): Promise<Array<{ hash: Hex; nonce: number; to: Address | null }>> {
  const head = Number(await rpcCall<string>(env.rpc, "eth_blockNumber"));
  const txs: Array<{ hash: Hex; nonce: number; to: Address | null }> = [];
  for (let b = 0; b <= head; b++) {
    const block = await rpcCall<{ transactions: Array<{ hash: Hex; from: string; nonce: string; to: Address | null }> }>(env.rpc, "eth_getBlockByNumber", [toHex(b), true]);
    for (const t of block.transactions) if (t.from.toLowerCase() === DEPLOYER.toLowerCase()) txs.push({ hash: t.hash, nonce: Number(t.nonce), to: t.to });
  }
  return txs.sort((x, y) => x.nonce - y.nonce);
}

/** Exactly one transaction per sent step: the chain's deployer transactions are the journal's, in order, and nothing else. */
async function expectOneTransactionPerStep(env: Env) {
  const j = journalOf(env);
  expect(j.status).toBe("complete");
  expect(j.steps.map((s) => s.id)).toEqual(j.plan.map((s) => s.id));
  const sent = j.steps.filter((s) => s.status === "confirmed");
  expect(j.steps.every((s) => s.status === "confirmed" || s.status === "skipped")).toBe(true);
  const txs = await deployerTxs(env);
  expect(txs.map((t) => t.hash)).toEqual(sent.map((s) => s.hash!));
  expect(txs.map((t) => t.nonce)).toEqual(sent.map((_, i) => j.startNonce + i));
  expect(txs.filter((t) => t.to === null).length).toBe(j.plan.filter((s) => s.kind === "deploy").length);
  expect(new Set(sent.filter((s) => s.kind === "deploy").map((s) => s.address!.toLowerCase())).size).toBe(j.plan.filter((s) => s.kind === "deploy").length);
  expect(await nonceOf(env)).toBe(j.startNonce + sent.length);
}

/** The finished deployment passes verify-ownership.ts and panel-escalation.ts inspect. */
async function expectVerified(env: Env) {
  ok(await runBun(["scripts/verify-ownership.ts", env.out]));
  const inspect = ok(await runBun(["scripts/panel-escalation.ts", "inspect", env.out]));
  expect(JSON.parse(inspect.stdout.slice(inspect.stdout.indexOf("{")))).toMatchObject({ ok: true, recordedMode: "off", observedMode: "off" });
}

const normalized = (env: Env) => { const dep = JSON.parse(readFileSync(env.out, "utf8")); dep.rpcUrl = "<rpc>"; return dep; };
let baseline: Record<string, unknown> | undefined;

describe.skipIf(!ANVIL || !ARTIFACTS)("deploy-local --mainnet --rehearsal: journal, resume and transport robustness", () => {
  test("full deploy: reviewed plan without --yes, one transaction per step, same deployment shape, journal kept; reruns send nothing", async () => {
    const env = await setup();
    try {
      // Without --yes: the summary, the explicit step plan and the pre-flight are printed; nothing is sent or recorded.
      const plan = refused(await deploy(env), "review deployment summary and rerun with --yes");
      expect(JSON.parse(plan.stdout.slice(plan.stdout.indexOf("{"), plan.stdout.indexOf("\n}") + 2))).toMatchObject({ mode: "mainnet rehearsal", chainId: 46630, panelEscalation: "off" });
      expect(plan.stdout).toContain(`Plan: ${EXPECTED_PLAN.length} steps`);
      expect(plan.stdout).toContain("[ ]   5 deploy.QueryEscrow predicted 0x");
      expect(plan.stdout).toMatch(/Pre-flight: 115 transaction\(s\) to send \(23 deployments\), about \d+ gas .*: OK/);
      expect(existsSync(`${env.out}.progress.json`)).toBe(false);
      expect(await nonceOf(env)).toBe(0);
      const predicted = /\[ \]   5 deploy\.QueryEscrow predicted (0x[0-9a-fA-F]{40})/.exec(plan.stdout)![1]!;

      const run = ok(await deploy(env, ["--yes"]));
      expect(run.stdout).toContain(`Journal ${env.out}.progress.json: complete, 110 transactions for 115 steps.`);
      const j = journalOf(env);
      expect(j.plan.map((s) => s.id)).toEqual(EXPECTED_PLAN);
      expect(statSync(`${env.out}.progress.json`).mode & 0o777).toBe(0o600);
      expect(existsSync(`${env.out}.progress.lock`)).toBe(false);
      expect(j.steps.filter((s) => s.status === "skipped").map((s) => s.id)).toEqual([
        "handover.queryEscrow.renounceRole.FEED_RUNNER_ROLE.deployer", "handover.jurorRegistry.renounceRole.ATTESTOR_ROLE.deployer", "handover.jurorRegistry.renounceRole.SLASHER_ROLE.deployer",
        "handover.staking.renounceRole.LOCKER_ROLE.deployer", "handover.panel.renounceRole.FEED_RUNNER_ROLE.deployer",
      ]);
      expect(j.steps.some((s) => s.raw)).toBe(false);
      const journalText = readFileSync(`${env.out}.progress.json`, "utf8");
      expect(journalText).not.toContain(DEPLOYER_KEY.slice(2));
      expect(journalText).not.toContain(env.rpc);
      await expectOneTransactionPerStep(env);
      const dep = JSON.parse(readFileSync(env.out, "utf8"));
      expect(dep.contracts.queryEscrow.toLowerCase()).toBe(predicted.toLowerCase());
      expect(Object.keys(dep)).toEqual(DEPLOYMENT_SHAPE.top);
      expect(Object.keys(dep.contracts)).toEqual(DEPLOYMENT_SHAPE.contracts);
      expect(Object.keys(dep.privacy)).toEqual(DEPLOYMENT_SHAPE.privacy);
      expect(Object.keys(dep.roles)).toEqual(DEPLOYMENT_SHAPE.roles);
      expect(dep).toMatchObject({ chainId: 46630, startBlock: j.startBlock, deployer: DEPLOYER, owner: OWNER, guardian: OWNER, paused: true, rehearsal: true, panelEscalation: "off", minJurorBond: "0", timelockDelay: "60", tokenSource: { kind: "test-deployment", decimals: 18 } });
      await expectVerified(env);
      baseline = normalized(env);

      // The recorded gas table covers this plan and is close to what the chain charged.
      const table = JSON.parse(readFileSync(join(import.meta.dir, "deploy-gas-estimate.json"), "utf8")) as GasTable;
      expect(EXPECTED_PLAN.filter((id) => table.steps[id] === undefined)).toEqual([]);
      const used = j.steps.reduce((sum, s) => sum + Number(s.gasUsed ?? 0), 0);
      const recorded = j.steps.filter((s) => s.status === "confirmed").reduce((sum, s) => sum + table.steps[s.id]!, 0);
      expect(Math.abs(recorded - used) / used).toBeLessThan(0.25);

      // A rerun refuses while the journal exists; --resume alone verifies and sends nothing; --resume --yes rewrites the same file.
      refused(await deploy(env, ["--yes"]), "a deployment journal exists");
      // Even without the journal, a new mainnet deployment never starts over an existing deployment record.
      renameSync(`${env.out}.progress.json`, `${env.out}.aside`);
      refused(await deploy(env, ["--yes"]), "refusing to start a new mainnet deployment over an existing deployment record");
      renameSync(`${env.out}.aside`, `${env.out}.progress.json`);
      expect(await nonceOf(env, "pending")).toBe(110);
      const inspect = refused(await deploy(env, ["--resume"]), "review deployment summary and rerun with --yes");
      expect(inspect.stdout).toContain("(complete; 115/115 steps done, verified on chain)");
      expect(inspect.stdout).toContain("Next: nothing to send; every step is done.");
      expect(inspect.stdout).toContain("Pre-flight: 0 transaction(s) to send");
      const before = readFileSync(env.out, "utf8");
      ok(await deploy(env, ["--resume", "--yes"]));
      expect(readFileSync(env.out, "utf8")).toBe(before);
      await expectOneTransactionPerStep(env);
    } finally { await env.anvil.stop(); }
  }, 240_000);

  test("interrupted at several points (signed, broadcast and mined, broadcast and pending, between steps, a hard kill): --resume finishes with exactly one transaction per step", async () => {
    const env = await setup();
    try {
      // 1. Signed and recorded, killed before the broadcast: nothing reached the chain.
      killed(await deploy(env, ["--yes"], { fault: "before-broadcast:deploy.QueryEscrow" }));
      const signedQueryEscrow = stepOf(env, "deploy.QueryEscrow")!;
      expect(signedQueryEscrow).toMatchObject({ status: "signed", nonce: 4 });
      expect(signedQueryEscrow.raw).toBeDefined();
      expect(await nonceOf(env, "pending")).toBe(4);
      expect(existsSync(`${env.out}.progress.lock`)).toBe(true); // left by the killed run; taken over below
      expect(refused(await deploy(env, ["--yes"]), "a deployment journal exists").stdout).toContain("Took over the lock of an earlier run");
      const inspect = refused(await deploy(env, ["--resume"]), "review deployment summary and rerun with --yes");
      expect(inspect.stdout).toContain(`Next: deploy.QueryEscrow: its recorded transaction ${signedQueryEscrow.hash} (nonce 4) is not mined yet; it will be re-broadcast unchanged, never re-signed.`);
      expect(await nonceOf(env, "pending")).toBe(4);

      // 2. Resume re-broadcasts the same signed QueryEscrow transaction; killed after broadcasting setVerdicts (mined by automine).
      killed(await deploy(env, ["--resume", "--yes"], { fault: "after-broadcast:wire.queryEscrow.setVerdicts" }));
      expect(stepOf(env, "deploy.QueryEscrow")).toMatchObject({ status: "confirmed", hash: signedQueryEscrow.hash, nonce: 4 });
      const setVerdicts = stepOf(env, "wire.queryEscrow.setVerdicts")!;
      expect(setVerdicts.status).toBe("broadcast");
      expect(await nonceOf(env)).toBe(setVerdicts.nonce! + 1);

      // 3. Broadcast but not mined (automine off): the transaction waits in the mempool when the run dies.
      await rpcCall(env.rpc, "evm_setAutomine", [false]);
      killed(await deploy(env, ["--resume", "--yes"], { fault: "after-broadcast:wire.queryEscrow.setPanelReserveBps" }));
      expect(stepOf(env, "wire.queryEscrow.setVerdicts")!.status).toBe("confirmed");
      const reserve = stepOf(env, "wire.queryEscrow.setPanelReserveBps")!;
      expect(reserve.status).toBe("broadcast");
      expect(await nonceOf(env)).toBe(reserve.nonce!);
      expect(await nonceOf(env, "pending")).toBe(reserve.nonce! + 1);
      expect(await rpcCall<{ blockNumber: string | null }>(env.rpc, "eth_getTransactionByHash", [reserve.hash])).toMatchObject({ blockNumber: null });

      // 4. Resume finds it pending, re-broadcasts the same transaction ("already imported") and waits; mining resumes meanwhile.
      let mined = false;
      const fourth = killed(await deploy(env, ["--resume", "--yes"], {
        fault: "after-confirm:feeds.register.earnings@RHC",
        onStdout: (text) => {
          if (!mined && text.includes(`re-broadcasting the recorded transaction ${reserve.hash}`)) {
            mined = true;
            void Bun.sleep(300).then(async () => { await rpcCall(env.rpc, "evm_setAutomine", [true]); await rpcCall(env.rpc, "evm_mine"); });
          }
        },
      }));
      expect(mined).toBe(true);
      expect(fourth.stdout).toContain(`re-broadcasting the recorded transaction ${reserve.hash} (nonce ${reserve.nonce})`);
      expect(stepOf(env, "wire.queryEscrow.setPanelReserveBps")).toMatchObject({ status: "confirmed", hash: reserve.hash });
      expect(journalOf(env).steps.at(-1)).toMatchObject({ id: "feeds.register.earnings@RHC", status: "confirmed" });

      // 5. A hard kill from outside at an arbitrary moment during the handover.
      let child = false;
      const hard = await deploy(env, ["--resume", "--yes"], {
        onStdout: (text) => {
          if (!child && text.includes("handover.queryEscrow.grantRole.GUARDIAN_ROLE.guardian: nonce")) {
            child = true;
            const pid = Number(readFileSync(`${env.out}.progress.lock`, "utf8").trim());
            process.kill(pid, "SIGKILL");
          }
        },
      });
      killed(hard);
      expect(["signed", "broadcast", "confirmed"]).toContain(stepOf(env, "handover.queryEscrow.grantRole.GUARDIAN_ROLE.guardian")!.status);

      // 6. The last resume completes the plan.
      ok(await deploy(env, ["--resume", "--yes"]));
      await expectOneTransactionPerStep(env);
      await expectVerified(env);
      expect(stepOf(env, "deploy.QueryEscrow")!.hash).toBe(signedQueryEscrow.hash);
      if (baseline) expect(normalized(env)).toEqual(baseline); // identical to the uninterrupted deployment
    } finally { await env.anvil.stop(); }
  }, 300_000);

  test("--resume refuses when the chain or the journal contradicts it, and sends nothing", async () => {
    const env = await setup();
    try {
      killed(await deploy(env, ["--yes"], { fault: "after-confirm:wire.queryEscrow.setStaking" }));
      const journalFile = `${env.out}.progress.json`;
      const original = readFileSync(journalFile, "utf8");
      const nonce = await nonceOf(env);
      expect(nonce).toBe(journalOf(env).steps.length);
      const tampered = async (edit: (j: Journal) => void, message: string) => {
        const j = JSON.parse(original) as Journal; edit(j); writeFileSync(journalFile, JSON.stringify(j));
        refused(await deploy(env, ["--resume", "--yes"]), message);
        writeFileSync(journalFile, original);
        expect(await nonceOf(env, "pending")).toBe(nonce);
      };
      // Configuration changed between runs.
      refused(await deploy(env, ["--resume", "--yes", "--timelock-delay", "120"]), "deployment configuration differs from the journal's");
      // Steps out of the plan's order: a later step recorded without an earlier one.
      await tampered((j) => { const [x] = j.steps.splice(3, 1); j.steps.splice(5, 0, x!); }, "is out of order");
      await tampered((j) => { j.steps.splice(2, 1); }, "is out of order");
      await tampered((j) => { j.steps[2]!.status = "signed"; j.steps[2]!.raw = "0x01"; }, "a later step happened without this one");
      // A recorded address that is not what the transaction created.
      await tampered((j) => { j.steps.find((s) => s.id === "deploy.QueryEscrow")!.address = "0x00000000000000000000000000000000000000aa" as Address; }, "the journal records 0x00000000000000000000000000000000000000aa, the transaction created");
      // A recorded transaction that does not exist on chain.
      await tampered((j) => { j.steps[1]!.hash = keccak256(toHex("not on chain")); }, "the chain has no receipt for it");
      expect(original).toBe(readFileSync(journalFile, "utf8"));

      // The deployer key sent something outside the journal.
      const deployerWallet = createWalletClient({ transport: http(env.rpc), account: privateKeyToAccount(DEPLOYER_KEY) });
      const pub = createPublicClient({ transport: http(env.rpc) });
      await pub.waitForTransactionReceipt({ hash: await deployerWallet.sendTransaction({ to: OWNER, value: 1n, chain: null }) });
      refused(await deploy(env, ["--resume", "--yes"]), "1 transaction(s) were sent from the deployer outside this journal");
      expect(await nonceOf(env, "pending")).toBe(nonce + 1);

      // The chain lost the recorded deployment (reset to before it).
      await rpcCall(env.rpc, "evm_revert", [env.snapshot]);
      expect(await nonceOf(env)).toBe(0);
      const reset = refused(await deploy(env, ["--resume"]), "refusing to resume: the chain contradicts the journal");
      expect(reset.stderr).toContain("the chain has no receipt for it");
      expect(await nonceOf(env, "pending")).toBe(0);

      // A recorded, never-broadcast transaction whose nonce another transaction used.
      env.out = join(env.dir, "second.json");
      killed(await deploy(env, ["--yes"], { fault: "before-broadcast:deploy.SchemaRegistry" }));
      expect(stepOf(env, "deploy.SchemaRegistry")).toMatchObject({ status: "signed", nonce: 2 });
      await pub.waitForTransactionReceipt({ hash: await deployerWallet.sendTransaction({ to: OWNER, value: 1n, nonce: 2, chain: null }) });
      refused(await deploy(env, ["--resume", "--yes"]), "nonce 2 of the deployer was used by a transaction other than the recorded");
      expect(await nonceOf(env, "pending")).toBe(3);
    } finally { await env.anvil.stop(); }
  }, 240_000);

  test("a broadcast whose response is lost is re-sent as the same raw transaction (no new nonce); the balance pre-flight refuses unless overridden", async () => {
    const env = await setup();
    // A JSON-RPC proxy in front of our anvil that forwards everything but holds the answer to the 1st and 40th
    // eth_sendRawTransaction until long after the client's 1 s timeout.
    const raws: Hex[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 30,
      async fetch(req) {
        const body = await req.text();
        const upstream = await (await fetch(env.rpc, { method: "POST", headers: { "content-type": "application/json" }, body })).text();
        const call = JSON.parse(body) as { method: string; params: Hex[] };
        if (call.method === "eth_sendRawTransaction") {
          const n = raws.push(call.params[0]!);
          if (n === 1 || n === 40) await Bun.sleep(3_000);
        }
        return new Response(upstream, { headers: { "content-type": "application/json" } });
      },
    });
    try {
      expect(RESERVED_PORTS.has(proxy.port!)).toBe(false);
      const via = `http://127.0.0.1:${proxy.port}`;
      await rpcCall(env.rpc, "anvil_setBalance", [DEPLOYER, toHex(parseEther("0.12"))]);
      const low = refused(await deploy(env, ["--yes", "--rpc-timeout", "1"], { rpc: via }), "pass --allow-low-balance");
      expect(low.stdout).toMatch(/required with a 2x margin [0-9.]+ ETH; deployer balance 0\.12 ETH: INSUFFICIENT/);
      expect(existsSync(`${env.out}.progress.json`)).toBe(false);
      expect(raws).toEqual([]);

      const run = ok(await deploy(env, ["--yes", "--rpc-timeout", "1", "--allow-low-balance"], { rpc: via }));
      expect(run.stdout).toContain("(overridden by --allow-low-balance)");
      expect(run.stdout).toContain("re-broadcasting the same signed transaction");
      const j = journalOf(env);
      const sent = j.steps.filter((s) => s.status === "confirmed");
      // The timed-out broadcasts were followed by the identical raw transaction, and no raw transaction was signed twice.
      expect(raws[1]).toBe(raws[0]!);
      expect(keccak256(raws[0]!)).toBe(sent[0]!.hash!);
      expect(new Set(raws).size).toBe(sent.length);
      expect(raws.length).toBeGreaterThan(sent.length);
      await expectOneTransactionPerStep(env);
      writeFileSync(env.out, readFileSync(env.out, "utf8").replace(via, env.rpc));
      await expectVerified(env);
    } finally { proxy.stop(true); await env.anvil.stop(); }
  }, 240_000);

  test("dress rehearsal: an interrupted deploy resumes through deploy-local --resume instead of blocking", async () => {
    const anvil = await startAnvil(46630);
    try {
      const pub = createPublicClient({ transport: http(anvil.rpc) });
      const tokenWallet = createWalletClient({ transport: http(anvil.rpc), account: privateKeyToAccount(TOKEN_KEY) });
      const usdg = (await pub.waitForTransactionReceipt({ hash: await tokenWallet.deployContract({ abi: A.MockUSDGAbi, bytecode: A.MockUSDGBytecode, chain: null }) })).contractAddress!;
      const mochi = (await pub.waitForTransactionReceipt({ hash: await tokenWallet.deployContract({ abi: A.MochiTokenAbi, bytecode: A.MochiTokenBytecode, args: [tokenWallet.account.address, 10n ** 27n], chain: null }) })).contractAddress!;
      const dir = mkdtempSync(join(tmpdir(), "rehearsal-resume-"));
      const out = join(dir, "out");
      const keys = { deployer: writeKey(dir, "deploy-key", DEPLOYER_KEY), owner: writeKey(dir, "owner-key", OWNER_KEY), operator: writeKey(dir, "operator-key", OPERATOR_KEY) };
      const closedCvm = `http://127.0.0.1:${await freePort()}`; // nothing listens: the CVM is "unavailable", and no request leaves loopback
      const rehearse = (env: Record<string, string>, ...args: string[]) => runBun(["scripts/dress-rehearsal.ts", "--out", out, "--yes", ...args], { env, timeoutMs: 240_000 });
      const first = await rehearse({ [FAULT]: "after-confirm:wire.queryEscrow.setStaking" }, "--panel-escalation", "off", "--deployer-key-file", keys.deployer, "--owner-key-file", keys.owner,
        "--operator-key-file", keys.operator, "--measurement", keccak256(toHex("resume-measurement")), "--compose", "/review/compose.yml", "--cvm-url", closedCvm, "--rpc", anvil.rpc,
        "--usdg", usdg, "--mochi-token", mochi, "--timelock-delay", "0", "--until", "verify-deployment");
      expect(first.code, first.stdout + first.stderr).toBe(1);
      expect(first.stderr).toContain("[deploy] failed");
      const failed = JSON.parse(readFileSync(join(out, "checkpoints", "deploy.json"), "utf8"));
      expect(failed.state).toBe("failed");
      const partial = JSON.parse(readFileSync(join(out, "deployment.json.progress.json"), "utf8")) as Journal;
      expect(partial.steps.at(-1)).toMatchObject({ id: "wire.queryEscrow.setStaking", status: "confirmed" });

      const second = await rehearse({}, "--until", "verify-deployment");
      expect(second.code, second.stdout + second.stderr).toBe(0);
      expect(second.stdout).toContain("(resuming from chain state)");
      expect(second.stdout).toMatch(/\$ bun scripts\/deploy-local\.ts .* --resume --yes/);
      expect(second.stdout).toContain("ownership verified; panel escalation off on chain; escrow paused");
      const j = JSON.parse(readFileSync(join(out, "deployment.json.progress.json"), "utf8")) as Journal;
      expect(j.status).toBe("complete");
      const sent = j.steps.filter((s) => s.status === "confirmed").length;
      expect(Number(await rpcCall<string>(anvil.rpc, "eth_getTransactionCount", [DEPLOYER, "latest"]))).toBe(j.startNonce + sent);
      // The deploy's cost covers both attempts.
      const done = JSON.parse(readFileSync(join(out, "checkpoints", "deploy.json"), "utf8"));
      expect(done.state).toBe("done");
      expect(done.outputs.deployStartedFromBalance).toBe(failed.outputs.deployStartedFromBalance);
      expect(BigInt(done.outputs.deployCostWei)).toBe(BigInt(failed.outputs.deployStartedFromBalance) - await pub.getBalance({ address: DEPLOYER }));
    } finally { await anvil.stop(); }
  }, 300_000);
});
