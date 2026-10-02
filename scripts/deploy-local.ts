// Deploys and wires every Mochi contract to a local chain (anvil) and writes deployments/local.json.
// Usage: anvil &  then  bun scripts/deploy-local.ts [--rpc http://127.0.0.1:8545] [--out deployments/local.json]
// Local-only simplifications: the deployer is admin/governor (no TimelockController), schema activation delay is 0,
// and the mock USDG / mock shielded pool are used. Production deploys go through the timelocked multisig.
//
// Robustness (every mode): each transaction is one explicit, stably named step. It is signed once with an explicit nonce
// (the chain's pending nonce at the start, then +1 per step), its hash is recorded before it is broadcast, and a
// broadcast that times out is retried with the SAME signed transaction while its receipt is awaited for up to
// --receipt-timeout seconds (default 1800). "already known" and "nonce too low" count as success when the recorded hash
// is on chain. RPC requests time out after --rpc-timeout seconds (default 60); reads retry a bounded number of times.
//
// --mainnet (mainnet and its 46630 rehearsal) keeps a progress journal next to --out: <out>.progress.json (mode 600,
// written atomically) with, per step id, the nonce, transaction hash, status and deployed address. If a run stops for any
// reason, do not restart blindly:
//   1. rerun the same command with --resume and WITHOUT --yes: it checks every recorded step on chain (receipt, sender,
//      nonce, calldata, code at the address, role held, parameter value), prints what is done and what comes next, and
//      sends nothing;
//   2. rerun with --resume --yes to continue from the first incomplete step (an unmined recorded transaction is
//      re-broadcast unchanged; nothing is ever signed twice for one step).
// --resume refuses when the chain contradicts the journal (a missing or different transaction, an address without code,
// a role or parameter that differs, a deployer nonce the journal does not account for). Without --resume a run refuses
// to start while a journal exists. Before the first transaction the deployer balance must cover the remaining plan
// (recorded per-step gas x current gas price x 2); --allow-low-balance overrides that check.
import { productionTimelockDelay } from "../deploy/production/chain-policy.ts";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getContractAddress,
  http,
  keccak256,
  toHex,
  isAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { originId, SchemaId } from "@mochi/core";
import { getSchema, registryArgs } from "@mochi/schemas";
import * as A from "@mochi/chain";
import { chainFor, DRAND_QUICKNET, g2ToEip2537, ROLE_IDS, type Deployment } from "@mochi/chain";
import { LAUNCH_CLASS_PRICES, LAUNCH_PROTOCOL_FEE_BPS, LAUNCH_MIN_PROTOCOL_FEE } from "./launch-pricing.ts";
import { assertMochiTokenDecimals, resolveMochiTokenPolicy } from "./token-policy.ts";
import { panelWiringProblems, parsePanelEscalationOption, readPanelWiring } from "./panel-escalation.ts";
import { scrubText } from "./launch-ops/common.ts";
import * as J from "./launch-ops/deploy-journal.ts";

const args = new Map<string, string>();
const flags = new Set(["--mainnet", "--rehearsal", "--yes", "--resume", "--allow-low-balance", "--retry-reverted"]);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!;
  if (flags.has(key)) args.set(key, "true");
  else { if (!process.argv[i + 1]) throw new Error(`missing value for ${key}`); args.set(key, process.argv[++i]!); }
}
const mainnetMode = args.has("--mainnet");
const rehearsal = args.has("--rehearsal");
const rpcUrl = args.get("--rpc") ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Provider URLs embed API keys (dRPC: /robinhood/<key> or ?dkey=<key>). Never print or persist them.
const redactRpc = (url: string) => url
  .replace(/([?&](?:dkey|key|apikey|api_key|token)=)[^&#]+/gi, "$1<redacted>")
  .replace(/(\/)[A-Za-z0-9_-]{20,}(?=\/?$|[?#])/, "$1<redacted>");
const PUBLIC_RPC: Record<number, string> = { 4663: "https://rpc.mainnet.chain.robinhood.com", 46630: "https://rpc.testnet.chain.robinhood.com/rpc" };
const outPath = args.get("--out") ?? "deployments/local.json";
const randomnessKind = args.get("--randomness") ?? (mainnetMode ? "drand" : "blockhash");
const shieldedKind = args.get("--shielded") ?? (mainnetMode ? "privacy-pools" : "mock");
if (shieldedKind !== "mock" && shieldedKind !== "privacy-pools") throw new Error("--shielded must be mock or privacy-pools");
if (randomnessKind !== "blockhash" && randomnessKind !== "drand") throw new Error("--randomness must be blockhash or drand");
// --key-file <path>: on a real network every role (deployer/admin, attestor, feed runner, orchestrator/anchorer,
// Anonyma signer) uses this one funded key. Local anvil runs use the well-known dev keys.
const keyFile = args.get("--key-file");
// Governance timings (seconds). Production defaults; testnet runs pass short values to exercise the full path.
const VOTING_PERIOD = BigInt(args.get("--voting-period") ?? 3 * 86400);
const EXECUTION_DELAY = BigInt(args.get("--execution-delay") ?? 86400);
const TIMELOCK_DELAY = BigInt(productionTimelockDelay({ timelockDelay: args.get("--timelock-delay") }));
const SCHEMA_ACTIVATION_DELAY = BigInt(args.get("--schema-activation-delay") ?? 0);
// New mainnet-style launches use approved team seats without deposits. Legacy local fixtures retain bonded mode.
const MIN_JUROR_BOND_MOCHI = args.get("--min-juror-bond") ?? (mainnetMode ? "0" : "25000");
if (!/^(0|[1-9][0-9]{0,11})$/.test(MIN_JUROR_BOND_MOCHI)) throw new Error("--min-juror-bond must be a whole number of MOCHI from 0 to 999999999999");
const MIN_JUROR_BOND = BigInt(MIN_JUROR_BOND_MOCHI) * 10n ** 18n;
const configuredOwner = args.get("--owner") as Address | undefined;
const configuredUsdg = args.get("--usdg") as Address | undefined;
const configuredMochiToken = args.get("--mochi-token");
const configuredRecipient = (args.get("--mochi-recipient") ?? args.get("--owner")) as Address | undefined;
const configuredGuardian = (args.get("--guardian") ?? args.get("--owner")) as Address | undefined;
const configuredPostman = args.get("--postman") as Address | undefined;
const configuredAttestor = args.get("--attestor") as Address | undefined;
const configuredFeedRunner = args.get("--feed-runner") as Address | undefined;
const configuredOrchestrator = args.get("--orchestrator") as Address | undefined;
const configuredAnonymaSigner = args.get("--anonyma-signer") as Address | undefined;

function wholeSeconds(name: string, fallback: number, min: number, max: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be whole seconds from ${min} to ${max}`);
  return Number(raw);
}
/** Per-request HTTP timeout. viem's 10 s default was shorter than a stalled sequencer's answer to eth_sendRawTransaction. */
const RPC_TIMEOUT_MS = wholeSeconds("--rpc-timeout", 60, 1, 600) * 1000;
/** How long one step waits for its receipt (re-broadcasting the same transaction) before the run stops for --resume. */
const RECEIPT_TIMEOUT_MS = wholeSeconds("--receipt-timeout", 1800, 10, 86_400) * 1000;
/** Options that change how a run behaves, not what it deploys; every other option is part of the journal's configuration. */
const OPERATIONAL_OPTIONS = new Set(["--yes", "--resume", "--allow-low-balance", "--retry-reverted", "--rpc", "--rpc-timeout", "--receipt-timeout", "--key-file", "--out"]);
/** Required balance = expected cost of the remaining plan × this margin (covers L1 data fees, gas estimate buffers and price moves). */
const BALANCE_MARGIN = 2n;

function checkedAddress(value: Address | undefined, option: string, required = false): Address | undefined {
  if (!value) { if (required) throw new Error(`${option} is required with --mainnet`); return undefined; }
  if (!isAddress(value)) throw new Error(`${option} must be a valid address`);
  if (value === "0x0000000000000000000000000000000000000000") throw new Error(`${option} cannot be the zero address`);
  return value;
}

// anvil default accounts (well-known dev keys; never use outside a local chain)
export const DEV_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attestor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  feedRunner: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  orchestrator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  anonymaSigner: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

const USDG = (x: number) => BigInt(Math.round(x * 1e6));

export const FEEDS = [
  { name: "corp-actions.exdiv@RHC", schemaId: SchemaId.EX_DIVIDEND, crosscheck: true },
  { name: "corp-actions.split@RHC", schemaId: SchemaId.SPLIT, crosscheck: true },
  { name: "earnings@RHC", schemaId: SchemaId.EARNINGS, crosscheck: false },
  { name: "attestations.reserve@RHC", schemaId: SchemaId.RESERVE_ATTESTATION, crosscheck: false },
  { name: "attestations.nav@RHC", schemaId: SchemaId.NAV, crosscheck: false },
] as const;
export const feedId = (name: string) => keccak256(toHex(name));

const ZERO_ROLE = ("0x" + "00".repeat(32)) as Hex;
const ACL_ABI = [
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "renounceRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "callerConfirmation", type: "address" }], outputs: [] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const roleLocal = (name: string) => keccak256(toHex(`mochi.role.${name}`));
/** Role names recorded in the deployment JSON and used in step ids. */
function roleNameOf(role: Hex): string {
  return role === ZERO_ROLE ? "DEFAULT_ADMIN_ROLE" : role === ROLE_IDS.GOVERNOR ? "GOVERNOR_ROLE" : role === ROLE_IDS.GUARDIAN ? "GUARDIAN_ROLE" : role === ROLE_IDS.ATTESTOR ? "ATTESTOR_ROLE" : role === ROLE_IDS.FEED_RUNNER ? "FEED_RUNNER_ROLE" : role === ROLE_IDS.SLASHER ? "SLASHER_ROLE" : role === roleLocal("LOCKER") ? "LOCKER_ROLE" : role === roleLocal("ANCHORER") ? "ANCHORER_ROLE" : "GOVERNOR_ROLE";
}

/**
 * The deployment body runs twice: once as a plan (nothing is sent, created contracts get placeholder addresses) to fix
 * the ordered list of step ids, then for real. Every transaction goes through `deploy`, `call` or `renounceIfHeld` with
 * an explicit step id; reads of contracts this deployment created go through `read` (skipped while planning).
 */
type Ex = {
  readonly planning: boolean;
  log(line: string): void;
  deploy(id: string, name: string, abi: Abi, bytecode: Hex, ctorArgs?: unknown[], opts?: { runtimeLimit?: boolean }): Promise<Address>;
  call(id: string, address: Address, abi: Abi, functionName: string, fnArgs: unknown[]): Promise<void>;
  renounceIfHeld(id: string, address: Address, role: Hex): Promise<void>;
  read<T>(placeholder: T, fn: (block: bigint) => Promise<T>): Promise<T>;
};

function planner(me: Address): { ex: Ex; steps: J.PlannedStep[] } {
  const steps: J.PlannedStep[] = [];
  const ex: Ex = {
    planning: true,
    log() {},
    async deploy(id, name, abi, bytecode, ctorArgs = []) {
      steps.push({ id, kind: "deploy", label: name, to: null, dataHash: keccak256(encodeDeployData({ abi, bytecode, args: ctorArgs } as never)) });
      return J.placeholderAddress(id);
    },
    async call(id, address, abi, functionName, fnArgs) {
      steps.push({ id, kind: "call", label: functionName, to: address, dataHash: keccak256(encodeFunctionData({ abi, functionName, args: fnArgs } as never)) });
    },
    async renounceIfHeld(id, address, role) {
      steps.push({ id, kind: "renounce-if-held", label: "renounceRole", to: address, dataHash: keccak256(encodeFunctionData({ abi: ACL_ABI, functionName: "renounceRole", args: [role, me] })) });
    },
    async read(placeholder) { return placeholder; },
  };
  return { ex, steps };
}

async function main() {
  // Missing or malformed production token configuration fails before RPC or key-file access.
  resolveMochiTokenPolicy({ mainnetMode, rehearsal, tokenAddress: configuredMochiToken });
  // Off leaves PanelEscalation deployed but unwired from QueryEscrow (see scripts/panel-escalation.ts).
  const panelEscalation = parsePanelEscalationOption(args.get("--panel-escalation"), mainnetMode);
  const faults = J.parseFaults(process.env[J.FAULT_ENV]);
  // One transport for everything: explicit timeout, no hidden retries (reads retry explicitly; sends re-broadcast the
  // same signed transaction explicitly).
  const transport = http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 });
  const retry = <T>(fn: () => Promise<T>) => J.withRetries(fn, { onRetry: (n, e) => console.log(`    RPC read failed (${J.shortReason(e)}); retry ${n}`) });
  const probe = createPublicClient({ transport });
  const chainId = await retry(() => probe.getChainId());
  J.assertFaultsAllowed(faults, rpcUrl, chainId);
  const tokenPolicy = resolveMochiTokenPolicy({ mainnetMode, rehearsal, chainId, tokenAddress: configuredMochiToken });
  if (chainId === 4663 && !mainnetMode) throw new Error("chainId 4663 requires --mainnet; refusing unsafe local deployment mode");
  const fileKey = keyFile ? (JSON.parse(readFileSync(keyFile.replace(/^~/, homedir()), "utf8")) as { privateKey: Hex }).privateKey : undefined;
  if (mainnetMode) {
    const owner = checkedAddress(configuredOwner, "--owner", true)!;
    checkedAddress(configuredUsdg, "--usdg", true);
    if (tokenPolicy.source === "test-deployment") checkedAddress(configuredRecipient, "--mochi-recipient", true);
    checkedAddress(configuredGuardian, "--guardian", true);
    checkedAddress(configuredPostman, "--postman");
    checkedAddress(configuredAttestor, "--attestor");
    checkedAddress(configuredFeedRunner, "--feed-runner");
    checkedAddress(configuredOrchestrator, "--orchestrator");
    checkedAddress(configuredAnonymaSigner, "--anonyma-signer");
    if (chainId !== 4663 && !(chainId === 46630 && rehearsal)) throw new Error("--mainnet requires chainId 4663, or chainId 46630 with --rehearsal");
    if (rehearsal && chainId !== 46630) throw new Error("--rehearsal is allowed only on chainId 46630");
    if (!args.has("--shielded") || !args.has("--randomness") || shieldedKind !== "privacy-pools" || randomnessKind !== "drand") throw new Error("--mainnet requires explicit --shielded privacy-pools and --randomness drand");
    const stock = args.get("--stock-tokens") ?? "(none)";
    const feedOrigins = process.env.FEED_ORIGINS ?? "www.sec.gov";
    console.log(JSON.stringify({
      mode: rehearsal ? "mainnet rehearsal" : "mainnet", chainId, rpc: redactRpc(rpcUrl), out: outPath,
      keyFileConfigured: Boolean(keyFile), owner, usdg: configuredUsdg, shielded: shieldedKind, randomness: randomnessKind,
      drand: { chainHash: args.get("--drand-chain-hash") ?? DRAND_QUICKNET.chainHash, publicKey: args.get("--drand-public-key") ?? DRAND_QUICKNET.publicKey, genesisTime: args.get("--drand-genesis") ?? DRAND_QUICKNET.genesisTime, period: args.get("--drand-period") ?? DRAND_QUICKNET.period, lookaheadRounds: args.get("--drand-lookahead") ?? "2" },
      timelockDelay: TIMELOCK_DELAY.toString(), schemaActivationDelay: "0", minJurorBondMochi: MIN_JUROR_BOND_MOCHI, panelEscalation,
      mochiToken: tokenPolicy.source === "external" ? configuredMochiToken : "test-only token deployed for rehearsal",
      mochiRecipient: tokenPolicy.source === "test-deployment" ? configuredRecipient : "team-managed external supply", guardian: configuredGuardian,
      postman: configuredPostman ?? "deployer (renounced at handover; vacant until rotated)", attestor: configuredAttestor ?? "later through timelock",
      feedRunner: configuredFeedRunner ?? "later through timelock", orchestrator: configuredOrchestrator ?? "later through timelock",
      anonymaSigner: configuredAnonymaSigner ?? "disabled until set through timelock", stockTokens: stock, feedOrigins, mockUSDGAllowed: rehearsal,
    }, null, 2));
  } else if (rehearsal) throw new Error("--rehearsal requires --mainnet");
  if (chainId !== 31337 && !fileKey) throw new Error("non-local network: pass --key-file");
  const KEYS = fileKey
    ? { deployer: fileKey, attestor: fileKey, feedRunner: fileKey, orchestrator: fileKey, anonymaSigner: fileKey }
    : DEV_KEYS;
  const deployer = privateKeyToAccount(KEYS.deployer);
  const persistedRpcUrl = process.env.PUBLIC_RPC_URL ?? (redactRpc(rpcUrl) === rpcUrl ? rpcUrl : PUBLIC_RPC[chainId] ?? redactRpc(rpcUrl));
  const dep0: Deployment = { chainId, rpcUrl: persistedRpcUrl, startBlock: "0", contracts: {} as Deployment["contracts"] };
  const chain = chainFor(dep0);
  const pub = createPublicClient({ chain, transport });
  const rawRpc: J.RawRpc = { request: (method, params) => pub.request({ method, params } as never) as Promise<unknown> };
  const reader = J.chainReader(rawRpc);
  if (tokenPolicy.source === "external") {
    const externalToken = tokenPolicy.address as Address;
    const code = await retry(() => pub.getCode({ address: externalToken }));
    if (!code || code === "0x") throw new Error("--mochi-token has no contract code on the selected chain");
    const tokenMetadataAbi = [
      { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    ] as const;
    let tokenName: string; let tokenSymbol: string; let tokenDecimals: number;
    try {
      [tokenName, tokenSymbol, tokenDecimals] = await retry(() => Promise.all([
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "name" }),
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "symbol" }),
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "decimals" }),
      ]));
    } catch { throw new Error("--mochi-token must implement ERC20 name(), symbol(), and decimals() metadata"); }
    if (!tokenName.trim() || tokenSymbol.toUpperCase() !== "MOCHI") throw new Error(`--mochi-token metadata mismatch: expected a named MOCHI token, received ${JSON.stringify({ name: tokenName, symbol: tokenSymbol })}`);
    assertMochiTokenDecimals(tokenDecimals);
  }

  const me = deployer.address;
  const owner = mainnetMode ? configuredOwner! : me;
  const guardian = mainnetMode ? configuredGuardian! : me;
  const postman = mainnetMode ? (configuredPostman ?? me) : me;
  const mochiRecipient = tokenPolicy.source === "test-deployment" ? (mainnetMode ? configuredRecipient! : me) : undefined;
  if (mainnetMode && (owner.toLowerCase() === me.toLowerCase() || guardian.toLowerCase() === me.toLowerCase())) throw new Error("mainnet owner and guardian must not be the deployer");
  if (mainnetMode && [configuredAttestor, configuredFeedRunner, configuredOrchestrator, configuredPostman].some((x) => x?.toLowerCase() === me.toLowerCase())) throw new Error("operational role recipients must not be the deployer; omitted recipients are held by the timelock until assigned");
  const attestor = mainnetMode ? (configuredAttestor ?? me) : privateKeyToAccount(KEYS.attestor).address;
  const feedRunner = mainnetMode ? (configuredFeedRunner ?? me) : privateKeyToAccount(KEYS.feedRunner).address;
  const orchestrator = mainnetMode ? (configuredOrchestrator ?? me) : privateKeyToAccount(KEYS.orchestrator).address;
  const anonymaSigner = privateKeyToAccount(KEYS.anonymaSigner).address;

  console.log(`Deploying to chain ${chainId} at ${redactRpc(rpcUrl)}`);
  // Everything that can be checked before the first transaction is checked here: external tokens, stock tokens.
  if (mainnetMode) {
    const usdg = configuredUsdg!;
    const tokenMetaAbi = [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }, { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
    const code = await retry(() => pub.getCode({ address: usdg }));
    if (!code || code === "0x") throw new Error("--usdg has no contract code");
    const [tokenName] = await retry(() => Promise.all([
      pub.readContract({ address: usdg, abi: tokenMetaAbi, functionName: "name" }),
      pub.readContract({ address: usdg, abi: tokenMetaAbi, functionName: "symbol" }),
    ]));
    if (tokenName === "Mock USDG") {
      if (!rehearsal) throw new Error("MockUSDG is refused outside --rehearsal");
      console.log("WARNING: rehearsal only; explicitly supplied MockUSDG accepted on testnet.");
    }
  }
  const stockTokenList: { ticker: string; token: Address }[] = [];
  if (args.has("--stock-tokens")) {
    const erc20Meta = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
    for (const entry of (args.get("--stock-tokens") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const sep = entry.indexOf("=");
      if (sep < 1) throw new Error(`invalid --stock-tokens entry: ${entry}`);
      const ticker = entry.slice(0, sep).trim().toUpperCase();
      const token = entry.slice(sep + 1).trim() as Address;
      if (!/^[A-Z0-9._-]{1,31}$/.test(ticker) || !isAddress(token)) throw new Error(`invalid stock token registration: ${entry}`);
      if (stockTokenList.some((x) => x.ticker === ticker)) throw new Error(`--stock-tokens lists ${ticker} twice`);
      const actual = await retry(() => pub.readContract({ address: token, abi: erc20Meta, functionName: "symbol" }));
      if (actual.toUpperCase() !== ticker) throw new Error(`${ticker} symbol mismatch: token reports ${actual}`);
      stockTokenList.push({ ticker, token });
    }
  }
  const feedOriginList = (process.env.FEED_ORIGINS ?? (mainnetMode ? "www.sec.gov" : "www.sec.gov,127.0.0.1")).split(",");

  // ─────────────── the deployment, as ordered steps with explicit ids ───────────────
  async function body(ex: Ex) {
    let usdg: Address;
    if (mainnetMode) usdg = configuredUsdg!;
    else usdg = await ex.deploy("deploy.MockUSDG", "MockUSDG", A.MockUSDGAbi as Abi, A.MockUSDGBytecode);
    const mochiToken = tokenPolicy.source === "external"
      ? tokenPolicy.address as Address
      : await ex.deploy("deploy.TestMochiToken", "TestMochiToken", A.MochiTokenAbi as Abi, A.MochiTokenBytecode, [mochiRecipient!, 10n ** 27n]);
    const randomness = randomnessKind === "drand"
      ? await ex.deploy("deploy.DrandRandomness", "DrandRandomness", A.DrandRandomnessAbi as Abi, A.DrandRandomnessBytecode, [
        g2ToEip2537(args.get("--drand-public-key") ?? DRAND_QUICKNET.publicKey),
        BigInt(args.get("--drand-genesis") ?? DRAND_QUICKNET.genesisTime),
        BigInt(args.get("--drand-period") ?? DRAND_QUICKNET.period),
        BigInt(args.get("--drand-lookahead") ?? "2"),
      ])
      : await ex.deploy("deploy.BlockhashRandomness", "BlockhashRandomness", A.BlockhashRandomnessAbi as Abi, A.BlockhashRandomnessBytecode, [1n]);
    const schemaRegistry = await ex.deploy("deploy.SchemaRegistry", "SchemaRegistry", A.SchemaRegistryAbi as Abi, A.SchemaRegistryBytecode, [me, mainnetMode ? 0n : SCHEMA_ACTIVATION_DELAY]);
    const jurorRegistry = await ex.deploy("deploy.JurorRegistry", "JurorRegistry", A.JurorRegistryAbi as Abi, A.JurorRegistryBytecode, [
      me, mochiToken, me, MIN_JUROR_BOND, 7n * 86400n,
    ]);
    const queryEscrow = await ex.deploy("deploy.QueryEscrow", "QueryEscrow", A.QueryEscrowAbi as Abi, A.QueryEscrowBytecode, [
      me, usdg, jurorRegistry, schemaRegistry, randomness,
    ]);
    const staking = await ex.deploy("deploy.MochiStaking", "MochiStaking", A.MochiStakingAbi as Abi, A.MochiStakingBytecode, [me, mochiToken, usdg, 7n * 86400n, 7n * 86400n]);
    const verdicts = await ex.deploy("deploy.MochiVerdicts", "MochiVerdicts", A.MochiVerdictsAbi as Abi, A.MochiVerdictsBytecode, [
      me, queryEscrow, jurorRegistry, "0x0000000000000000000000000000000000000000",
    ]);
    const panel = await ex.deploy("deploy.PanelEscalation", "PanelEscalation", A.PanelEscalationAbi as Abi, A.PanelEscalationBytecode, [
      me, usdg, queryEscrow, verdicts, randomness, USDG(2500), USDG(25),
    ]);
    const feeds = await ex.deploy("deploy.Feeds", "Feeds", A.FeedsAbi as Abi, A.FeedsBytecode, [me, verdicts, queryEscrow, usdg, me]);
    const stockTokenCrosscheck = await ex.deploy("deploy.StockTokenCrosscheck", "StockTokenCrosscheck", A.StockTokenCrosscheckAbi as Abi, A.StockTokenCrosscheckBytecode, [me]);
    const receiptAnchor = await ex.deploy("deploy.ReceiptAnchor", "ReceiptAnchor", A.ReceiptAnchorAbi as Abi, A.ReceiptAnchorBytecode, [me, orchestrator]);
    let shielded: Address;
    let privacy: Deployment["privacy"];
    if (shieldedKind === "privacy-pools") {
      // Foundry nests an artifact under its source path only when two sources share a file name, so the location depends
      // on the build; take the newest existing candidate.
      const artifactPath = (name: string, dir: string) => {
        const found = [...new Set([`contracts/out/${dir}.sol/${name}.json`, `contracts/out/${name}.sol/${name}.json`])]
          .filter((p) => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (!found.length) throw new Error(`artifact ${name} not found under contracts/out (run forge build)`);
        return found[0]!;
      };
      const readArtifact = (name: string, dir = name) => JSON.parse(readFileSync(artifactPath(name, dir), "utf8")) as { abi: Abi; bytecode: { object: string; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> }; deployedBytecode: { object: string } };
      const t3 = readArtifact("PoseidonT3", "poseidon-solidity/PoseidonT3");
      const t4 = readArtifact("PoseidonT4", "poseidon-solidity/PoseidonT4");
      async function deployArtifact(id: string, name: string, artifact: ReturnType<typeof readArtifact>, ctorArgs: unknown[] = [], links: Record<string, Address> = {}): Promise<Address> {
        // Foundry artifacts store bytecode with a 0x prefix; link offsets are relative to the bare hex.
        let bytecode = artifact.bytecode.object.replace(/^0x/, "");
        for (const [source, libs] of Object.entries(artifact.bytecode.linkReferences ?? {})) for (const [libName, refs] of Object.entries(libs)) {
          const address = links[libName]; if (!address) throw new Error(`missing linked library ${source}:${libName}`);
          const value = address.slice(2).toLowerCase();
          // Solidity placeholders are keccak256(fully-qualified source:library), resolved from artifact references.
          const placeholder = `__$${keccak256(toHex(`${source}:${libName}`)).slice(2, 36)}$__`;
          for (const ref of refs) {
            const start = ref.start * 2;
            if (bytecode.slice(start, start + placeholder.length) !== placeholder) throw new Error(`artifact link placeholder mismatch for ${source}:${libName}`);
            bytecode = `${bytecode.slice(0,start)}${value}${bytecode.slice(start+ref.length*2)}`;
          }
        }
        if (bytecode.includes("__$")) throw new Error(`${name} has unresolved Solidity library placeholders`);
        return ex.deploy(id, name, artifact.abi, `0x${bytecode}` as Hex, ctorArgs, { runtimeLimit: true });
      }
      const poseidonT3 = await deployArtifact("deploy.PoseidonT3", "PoseidonT3", t3);
      const poseidonT4 = await deployArtifact("deploy.PoseidonT4", "PoseidonT4", t4);
      const withdrawalVerifier = await deployArtifact("deploy.WithdrawalVerifier", "WithdrawalVerifier", readArtifact("WithdrawalVerifier"));
      const commitmentVerifier = await deployArtifact("deploy.CommitmentVerifier", "CommitmentVerifier", readArtifact("CommitmentVerifier"));
      const epImpl = await deployArtifact("deploy.EntrypointImplementation", "Entrypoint", readArtifact("Entrypoint"));
      const proxyArt = readArtifact("ERC1967Proxy");
      const initData = encodeFunctionData({ abi: readArtifact("Entrypoint").abi, functionName: "initialize", args: [me, mainnetMode ? postman : me] } as never);
      const entrypoint = await deployArtifact("deploy.EntrypointProxy", "ERC1967Proxy", proxyArt, [epImpl, initData]);
      const poolArt = readArtifact("PrivacyPoolComplex", "PrivacyPoolComplex");
      const pool = await deployArtifact("deploy.PrivacyPoolComplex", "PrivacyPoolComplex", poolArt, [entrypoint, withdrawalVerifier, commitmentVerifier, usdg], { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 });
      const epAbi = readArtifact("Entrypoint").abi;
      await ex.call("privacy.entrypoint.registerPool", entrypoint, epAbi, "registerPool", [usdg, pool, 1n, 0, 0]);
      const adapter = await deployArtifact("deploy.PrivacyPoolShieldedPayments", "PrivacyPoolShieldedPayments", readArtifact("PrivacyPoolShieldedPayments"), [pool, usdg, queryEscrow]);
      shielded = adapter;
      const poolScope = await ex.read<unknown>(0n, (block) => pub.readContract({ address: pool, abi: poolArt.abi, functionName: "SCOPE", blockNumber: block }));
      privacy = { entrypoint, pool, adapter, withdrawalVerifier, commitmentVerifier, poseidonT3, poseidonT4, scope: String(poolScope) };
    } else {
      shielded = await ex.deploy("deploy.MockShieldedPayments", "MockShieldedPayments", A.MockShieldedPaymentsAbi as Abi, A.MockShieldedPaymentsBytecode, [usdg]);
    }
    const classMix = await ex.deploy("deploy.ClassMix", "ClassMix", A.ClassMixAbi as Abi, A.ClassMixBytecode, [me]);
    const clerkVoting = await ex.deploy("deploy.ClerkVoting", "ClerkVoting", A.ClerkVotingAbi as Abi, A.ClerkVotingBytecode, [
      me, staking, schemaRegistry, classMix, VOTING_PERIOD, EXECUTION_DELAY, 400n, 100_000n * 10n ** 18n,
    ]);
    const disclosureRegistry = await ex.deploy("deploy.DisclosureRegistry", "DisclosureRegistry", A.DisclosureRegistryAbi as Abi, A.DisclosureRegistryBytecode, []);
    // Production: this timelock (owned by the 2-of-3 multisig) takes GOVERNOR/DEFAULT_ADMIN on every contract.
    // Here it is deployed with the deployer as proposer/executor; handover is a separate, explicit step.
    let timelock: Address | undefined;
    if (!mainnetMode) timelock = await ex.deploy("deploy.MochiTimelock", "MochiTimelock", A.MochiTimelockAbi as Abi, A.MochiTimelockBytecode, [TIMELOCK_DELAY, [me], [me], me]);

    ex.log("Wiring roles and parameters");
    const E = A.QueryEscrowAbi as Abi;
    await ex.call("wire.queryEscrow.setVerdicts", queryEscrow, E, "setVerdicts", [verdicts]);
    // Off: no setPanel, so escalate reverts before any fee moves; reserve 0 so settlement never pays the zero address.
    if (panelEscalation === "on") await ex.call("wire.queryEscrow.setPanel", queryEscrow, E, "setPanel", [panel]);
    else await ex.call("wire.queryEscrow.setPanelReserveBps", queryEscrow, E, "setPanelReserveBps", [0]);
    await ex.call("wire.queryEscrow.setStaking", queryEscrow, E, "setStaking", [staking]);
    await ex.call("wire.queryEscrow.setShielded", queryEscrow, E, "setShielded", [shielded]);
    await ex.call("wire.queryEscrow.setAnonymaSigner", queryEscrow, E, "setAnonymaSigner", [mainnetMode ? (configuredAnonymaSigner ?? "0x0000000000000000000000000000000000000000") : anonymaSigner]);
    // Local fixture tariff stays stable. Mainnet uses the approved $0.05 short-N3 launch tariff.
    const prices: [number, number, number][] = [
      [0, 0.004, 0.0008], // LARGE_A
      [1, 0.004, 0.0008], // LARGE_B
      [2, 0.004, 0.0009], // DOC_SPECIALIST
      [3, 0.001, 0.0001], // SMALL_FAST
      [4, 0.003, 0.0006], // DISSENTER
    ];
    const classPrices = mainnetMode ? LAUNCH_CLASS_PRICES : prices.map(([cls, base, perK]) => [cls, USDG(base), USDG(perK)] as const);
    for (const [cls, base, perK] of classPrices) await ex.call(`wire.queryEscrow.setClassPrice.${cls}`, queryEscrow, E, "setClassPrice", [cls, base, perK]);
    if (mainnetMode) await ex.call("wire.queryEscrow.setProtocolFee", queryEscrow, E, "setProtocolFee", [LAUNCH_PROTOCOL_FEE_BPS, LAUNCH_MIN_PROTOCOL_FEE]);
    if (!mainnetMode) await ex.call("wire.queryEscrow.grantRole.FEED_RUNNER_ROLE.feedRunner", queryEscrow, E, "grantRole", [ROLE_IDS.FEED_RUNNER, feedRunner]);
    // The orchestrator expands and escalates standing feed queries with its own key (one key per process: sharing the
    // feed runner's key across processes causes nonce collisions).
    if (!mainnetMode) await ex.call("wire.queryEscrow.grantRole.FEED_RUNNER_ROLE.orchestrator", queryEscrow, E, "grantRole", [ROLE_IDS.FEED_RUNNER, orchestrator]);
    await ex.call("wire.verdicts.setPanel", verdicts, A.MochiVerdictsAbi as Abi, "setPanel", [panel]);
    if (!ex.planning) {
      // Read at (or after) the block of our last receipt, so a load-balanced RPC node behind it retries instead of
      // answering with older state.
      const wiring = await ex.read<Awaited<ReturnType<typeof readPanelWiring>> | undefined>(undefined, (block) => readPanelWiring({ readContract: (a: Record<string, unknown>) => pub.readContract({ ...a, blockNumber: block } as never) }, queryEscrow));
      const panelProblems = panelWiringProblems(panelEscalation, panel, wiring!);
      if (panelProblems.length) throw new Error(`panel escalation ${panelEscalation} wiring check failed: ${panelProblems.join("; ")}`);
    }
    await ex.call("wire.jurorRegistry.grantRole.SLASHER_ROLE.verdicts", jurorRegistry, A.JurorRegistryAbi as Abi, "grantRole", [ROLE_IDS.SLASHER, verdicts]);
    if (!mainnetMode) {
      await ex.call("wire.jurorRegistry.grantRole.ATTESTOR_ROLE.attestor", jurorRegistry, A.JurorRegistryAbi as Abi, "grantRole", [ROLE_IDS.ATTESTOR, attestor]);
      await ex.call("wire.panel.grantRole.FEED_RUNNER_ROLE.feedRunner", panel, A.PanelEscalationAbi as Abi, "grantRole", [ROLE_IDS.FEED_RUNNER, feedRunner]);
      await ex.call("wire.panel.grantRole.FEED_RUNNER_ROLE.orchestrator", panel, A.PanelEscalationAbi as Abi, "grantRole", [ROLE_IDS.FEED_RUNNER, orchestrator]);
    }
    // Governed class mix + clerk voting (spec: clerks vote task schemas and juror-class mixes).
    await ex.call("wire.jurorRegistry.setClassMix", jurorRegistry, A.JurorRegistryAbi as Abi, "setClassMix", [classMix]);
    await ex.call("wire.schemaRegistry.grantRole.GOVERNOR_ROLE.clerkVoting", schemaRegistry, A.SchemaRegistryAbi as Abi, "grantRole", [ROLE_IDS.GOVERNOR, clerkVoting]);
    await ex.call("wire.classMix.grantRole.GOVERNOR_ROLE.clerkVoting", classMix, A.ClassMixAbi as Abi, "grantRole", [ROLE_IDS.GOVERNOR, clerkVoting]);
    await ex.call("wire.staking.grantRole.LOCKER_ROLE.clerkVoting", staking, A.MochiStakingAbi as Abi, "grantRole", [roleLocal("LOCKER"), clerkVoting]);

    ex.log("Registering the 7 task schemas");
    for (const id of [1, 2, 3, 4, 5, 6, 7] as SchemaId[]) {
      await ex.call(`schemas.propose.${id}`, schemaRegistry, A.SchemaRegistryAbi as Abi, "propose", [...registryArgs(getSchema(id))]);
    }

    ex.log("Registering feeds");
    const origins = feedOriginList.map((h) => originId(h));
    for (const f of FEEDS) {
      await ex.call(`feeds.register.${f.name}`, feeds, A.FeedsAbi as Abi, "register", [
        feedId(f.name), f.schemaId, origins, f.crosscheck ? stockTokenCrosscheck : "0x0000000000000000000000000000000000000000", USDG(10),
      ]);
    }

    const stockTokens: Record<string, Address> = {};
    for (const { ticker, token } of stockTokenList) {
      await ex.call(`stockTokens.setToken.${ticker}`, stockTokenCrosscheck, A.StockTokenCrosscheckAbi as Abi, "setToken", [toHex(ticker, { size: 32 }), token]);
      stockTokens[ticker] = token;
    }

    let mainnetRoles: Record<string, Record<string, Address[]>> | undefined;
    if (mainnetMode) {
      // Pausing before governance handover ensures launch starts closed and the guardian role remains immediately usable.
      await ex.call("launch.queryEscrow.pause", queryEscrow, E, "pause", []);
      const proposers = [owner];
      const executors = [owner];
      timelock = await ex.deploy("deploy.MochiTimelock", "MochiTimelock", A.MochiTimelockAbi as Abi, A.MochiTimelockBytecode, [TIMELOCK_DELAY, proposers, executors, "0x0000000000000000000000000000000000000000"]);
      const governor = ROLE_IDS.GOVERNOR;
      const guardianRole = ROLE_IDS.GUARDIAN;
      const attestorRole = ROLE_IDS.ATTESTOR;
      const feedRole = ROLE_IDS.FEED_RUNNER;
      // Each assignment carries a slot label, so its step id stays unique and stable when two slots name the same account.
      const targets: { name: string; address: Address; roles: [Hex, Address, string][] }[] = [
        { name: "queryEscrow", address: queryEscrow, roles: [[guardianRole, guardian, "guardian"], [guardianRole, timelock, "timelock"], [feedRole, configuredFeedRunner ?? timelock, "feedRunner"], [feedRole, configuredOrchestrator ?? timelock, "orchestrator"]] },
        { name: "jurorRegistry", address: jurorRegistry, roles: [[ROLE_IDS.SLASHER, verdicts, "verdicts"], [attestorRole, configuredAttestor ?? timelock, "attestor"]] },
        { name: "schemaRegistry", address: schemaRegistry, roles: [[governor, clerkVoting, "clerkVoting"]] },
        { name: "staking", address: staking, roles: [[roleLocal("LOCKER"), clerkVoting, "clerkVoting"]] },
        { name: "verdicts", address: verdicts, roles: [] },
        { name: "panel", address: panel, roles: [[feedRole, configuredFeedRunner ?? timelock, "feedRunner"], [feedRole, configuredOrchestrator ?? timelock, "orchestrator"]] },
        { name: "feeds", address: feeds, roles: [] },
        { name: "stockTokenCrosscheck", address: stockTokenCrosscheck, roles: [] },
        { name: "receiptAnchor", address: receiptAnchor, roles: [[roleLocal("ANCHORER"), configuredOrchestrator ?? timelock, "orchestrator"]] },
        { name: "classMix", address: classMix, roles: [[governor, clerkVoting, "clerkVoting"]] },
        { name: "clerkVoting", address: clerkVoting, roles: [] },
      ];
      const governed = new Set(["queryEscrow", "jurorRegistry", "schemaRegistry", "verdicts", "panel", "feeds", "stockTokenCrosscheck", "classMix"]);
      const byName: Record<string, Record<string, Address[]>> = {};
      for (const c of targets) {
        const assignments = [...c.roles];
        if (governed.has(c.name)) assignments.unshift([governor, timelock, "timelock"], [ZERO_ROLE, timelock, "timelock"]);
        else assignments.unshift([ZERO_ROLE, timelock, "timelock"]);
        for (const [role, account, slot] of assignments) {
          const roleName = roleNameOf(role);
          await ex.call(`handover.${c.name}.grantRole.${roleName}.${slot}`, c.address, ACL_ABI as Abi, "grantRole", [role, account]);
          (byName[c.name] ??= {})[roleName] ??= [];
          if (!byName[c.name]![roleName]!.includes(account)) byName[c.name]![roleName]!.push(account);
        }
      }
      byName.MochiTimelock = {
        DEFAULT_ADMIN_ROLE: [timelock], PROPOSER_ROLE: [owner], EXECUTOR_ROLE: [owner], CANCELLER_ROLE: [owner],
      };
      // Timelock takes the Entrypoint owner role; the configured postman keeps only ASP_POSTMAN (deployer default is rotated off).
      if (privacy) {
        const epAbi = JSON.parse(readFileSync("contracts/out/Entrypoint.sol/Entrypoint.json", "utf8")).abi as Abi;
        const ownerRole = keccak256(toHex("OWNER_ROLE"));
        const postmanRole = keccak256(toHex("ASP_POSTMAN"));
        await ex.call("handover.entrypoint.grantRole.OWNER_ROLE.timelock", privacy.entrypoint, epAbi, "grantRole", [ownerRole, timelock]);
        if (configuredPostman) await ex.call("handover.entrypoint.grantRole.ASP_POSTMAN_ROLE.postman", privacy.entrypoint, epAbi, "grantRole", [postmanRole, configuredPostman]);
        else await ex.call("handover.entrypoint.renounceRole.ASP_POSTMAN_ROLE.deployer", privacy.entrypoint, epAbi, "renounceRole", [postmanRole, me]);
        await ex.call("handover.entrypoint.renounceRole.OWNER_ROLE.deployer", privacy.entrypoint, epAbi, "renounceRole", [ownerRole, me]);
        byName.entrypoint = { OWNER_ROLE: [timelock], ASP_POSTMAN_ROLE: configuredPostman ? [configuredPostman] : [] };
      }
      // Fixed known role surface: renounce every role granted by constructors and wiring on each AccessControl contract.
      // A role the deployer does not hold at that point is recorded as a skipped step (no transaction).
      const allRoles: Record<string, Hex[]> = {
        queryEscrow: [ZERO_ROLE, governor, guardianRole, feedRole],
        jurorRegistry: [ZERO_ROLE, governor, attestorRole, ROLE_IDS.SLASHER],
        schemaRegistry: [ZERO_ROLE, governor],
        staking: [ZERO_ROLE, roleLocal("LOCKER")],
        verdicts: [ZERO_ROLE, governor], panel: [ZERO_ROLE, governor, feedRole],
        feeds: [ZERO_ROLE, governor], stockTokenCrosscheck: [ZERO_ROLE, governor],
        receiptAnchor: [ZERO_ROLE, roleLocal("ANCHORER")], classMix: [ZERO_ROLE, governor], clerkVoting: [ZERO_ROLE],
      };
      for (const c of targets) for (const role of allRoles[c.name] ?? []) {
        await ex.renounceIfHeld(`handover.${c.name}.renounceRole.${roleNameOf(role)}.deployer`, c.address, role);
      }
      if (tokenPolicy.source === "test-deployment") {
        // Only the locally/rehearsal-deployed test token has a metadata admin to hand over.
        const tokenAdminAbi = [
          { type: "function", name: "transferMetadataAdmin", stateMutability: "nonpayable", inputs: [{ name: "newAdmin", type: "address" }], outputs: [] },
        ] as const;
        await ex.call("handover.mochiToken.transferMetadataAdmin", mochiToken, tokenAdminAbi as unknown as Abi, "transferMetadataAdmin", [timelock]);
        byName.mochiToken = { METADATA_ADMIN: [timelock] };
      }
      mainnetRoles = byName;
      ex.log(`Handover complete; deployer ${me} renounced its assigned roles.`);
    }
    return {
      contracts: { mochiToken, randomness, schemaRegistry, jurorRegistry, queryEscrow, verdicts, feeds, stockTokenCrosscheck, panel, staking, receiptAnchor, usdg, shielded, classMix, clerkVoting, disclosureRegistry, timelock: timelock! },
      privacy, mainnetRoles, timelock, stockTokens,
    };
  }

  // ─────────────── plan ───────────────
  const plan = planner(me);
  await body(plan.ex);
  const steps = plan.steps;
  J.assertUniqueStepIds(steps);
  const thePlanHash = J.planHash(steps);
  const config: Record<string, unknown> = {
    ...Object.fromEntries([...args].filter(([key]) => !OPERATIONAL_OPTIONS.has(key))),
    chainId, deployer: me, feedOrigins: feedOriginList.join(","),
  };
  const theConfigHash = J.configHash(config);
  const persist = mainnetMode; // --mainnet (4663 and its 46630 rehearsal); local 31337 fixtures keep the journal in memory
  const journalPath = J.journalPathFor(outPath);
  const resume = args.has("--resume");
  if (resume && !persist) throw new Error("--resume needs a --mainnet deployment journal; local chain 31337 deployments keep none");
  let lock: { release(): void } | undefined;
  try {
    let journal: J.Journal | undefined;
    if (persist) {
      mkdirSync(dirname(outPath), { recursive: true });
      const taken = J.acquireLock(J.lockPathFor(outPath));
      lock = taken;
      if (taken.tookOver) console.log(`Took over the lock of an earlier run (pid ${taken.tookOver}) that is no longer running.`);
      if (existsSync(journalPath)) {
        if (!resume) {
          const existing = J.readJournal(journalPath);
          const done = existing.steps.filter((s) => s.status === "confirmed" || s.status === "skipped").length;
          throw new Error(`a deployment journal exists at ${journalPath} (${existing.status}, ${done}/${existing.plan.length} steps done): a deployment was already started. Do not restart blindly: rerun with --resume and without --yes to check it against the chain, then --resume --yes to continue`);
        }
        journal = J.readJournal(journalPath);
      } else if (resume) throw new Error(`--resume: no deployment journal at ${journalPath}; nothing to resume`);
      else if (existsSync(outPath)) throw new Error(`${outPath} already exists; refusing to start a new mainnet deployment over an existing deployment record (move it aside or choose another --out)`);
    }

    // ─────────────── journal against the chain (resume) ───────────────
    let lastBlock = 0n;
    if (journal) {
      const problems = J.journalProblems(journal, steps, { chainId, deployer: me, configHash: theConfigHash, planHash: thePlanHash });
      if (problems.length) throw new Error(`refusing to resume from ${journalPath}:\n${problems.slice(0, 12).map((p) => `  - ${p}`).join("\n")}`);
      const verified = await J.verifyJournalOnChain(journal, reader);
      if (verified.changed) J.writeJournal(journalPath, journal);
      for (const w of verified.warnings) console.log(`WARNING: ${w}`);
      if (verified.problems.length) throw new Error(`refusing to resume: the chain contradicts the journal ${journalPath}:\n${verified.problems.slice(0, 12).map((p) => `  - ${p}`).join("\n")}`);
      lastBlock = verified.lastBlock;
    }

    // ─────────────── printed plan ───────────────
    const latestNonce = await reader.nonce(me, "latest");
    const startNonce = journal?.startNonce ?? latestNonce;
    const done = (journal?.steps ?? []).filter((s) => s.status === "confirmed" || s.status === "skipped").length;
    const deploys = steps.filter((s) => s.kind === "deploy").length;
    const conditional = steps.filter((s) => s.kind === "renounce-if-held").length;
    console.log(`Plan: ${steps.length} steps (${deploys} deployments, ${steps.length - deploys - conditional} calls, ${conditional} renounces sent only if the deployer still holds the role); deployer ${me}, nonces from ${startNonce}`);
    if (persist) {
      console.log(`Journal: ${journalPath}${journal ? ` (${journal.status}; ${done}/${steps.length} steps done, verified on chain)` : " (created before the first transaction)"}`);
      let nonce = startNonce;
      steps.forEach((s, i) => {
        const rec = journal?.steps[i];
        const mark = !rec ? " " : rec.status === "confirmed" ? "x" : rec.status === "skipped" ? "-" : rec.status === "reverted" ? "!" : ">";
        let detail = "";
        if (rec?.status === "confirmed") detail = rec.address ? ` ${rec.address}` : ` tx ${rec.hash}`;
        else if (rec?.status === "skipped") detail = ` skipped: ${rec.reason ?? ""}`;
        else if (rec) detail = ` ${rec.status}: tx ${rec.hash} nonce ${rec.nonce}`;
        else if (s.kind === "deploy") detail = ` predicted ${getContractAddress({ from: me, nonce: BigInt(nonce) })}`;
        nonce += (rec?.attempts?.length ?? 0) + (rec?.status === "skipped" ? 0 : 1);
        console.log(`  [${mark}] ${String(i + 1).padStart(3)} ${s.id}${detail}`);
      });
      const next = steps[journal?.steps.filter((s) => s.status === "confirmed" || s.status === "skipped").length ?? 0];
      const pending = journal?.steps.find((s) => s.status === "signed" || s.status === "broadcast");
      if (pending) console.log(`Next: ${pending.id}: its recorded transaction ${pending.hash} (nonce ${pending.nonce}) is not mined yet; it will be re-broadcast unchanged, never re-signed.`);
      else if (journal?.steps.at(-1)?.status === "reverted") console.log(`Next: ${journal.steps.at(-1)!.id} reverted; it needs --retry-reverted after inspection.`);
      else console.log(next ? `Next: step ${steps.indexOf(next) + 1} ${next.id}` : "Next: nothing to send; every step is done.");
    }

    // ─────────────── pre-flight: nonce and balance ───────────────
    if (!journal) {
      const pendingNonce = await reader.nonce(me, "pending");
      if (pendingNonce !== latestNonce) throw new Error(`the deployer has ${pendingNonce - latestNonce} pending transaction(s) (nonce ${latestNonce} mined, ${pendingNonce} pending); wait for them and inspect them before deploying`);
    }
    const table = JSON.parse(readFileSync(join(import.meta.dir, "deploy-gas-estimate.json"), "utf8")) as J.GasTable;
    const estimate = J.remainingGas(steps, journal, table);
    const gasPrice = await retry(() => pub.getGasPrice());
    const balance = await retry(() => pub.getBalance({ address: me }));
    const expectedWei = estimate.gas * gasPrice;
    const requiredWei = expectedWei * BALANCE_MARGIN;
    const balanceOk = balance >= requiredWei;
    console.log(`Pre-flight: ${estimate.steps} transaction(s) to send (${estimate.deploys} deployments), about ${estimate.gas} gas (recorded per-step estimate${estimate.factor > 1 ? `, x${estimate.factor} as measured on this chain` : ""}) at ${gasPrice} wei/gas: expected cost ${formatEther(expectedWei)} ETH; required with a ${BALANCE_MARGIN}x margin ${formatEther(requiredWei)} ETH; deployer balance ${formatEther(balance)} ETH: ${balanceOk ? "OK" : "INSUFFICIENT"}`);
    if (estimate.unknown.length) console.log(`  note: ${estimate.unknown.length} step(s) have no recorded gas and use the default for their kind: ${estimate.unknown.slice(0, 6).join(", ")}${estimate.unknown.length > 6 ? ", …" : ""}`);
    const lowBalance = balanceOk ? undefined : `deployer balance ${formatEther(balance)} ETH is below the required ${formatEther(requiredWei)} ETH for the remaining plan; fund the deployer, or pass --allow-low-balance to proceed anyway`;
    if (lowBalance && args.has("--allow-low-balance")) console.log(`WARNING: ${lowBalance} (overridden by --allow-low-balance)`);
    if (mainnetMode && !args.has("--yes")) {
      if (lowBalance && !args.has("--allow-low-balance")) console.log(`REFUSED: ${lowBalance}`);
      throw new Error("review deployment summary and rerun with --yes");
    }
    if (lowBalance && !args.has("--allow-low-balance")) throw new Error(lowBalance);

    // ─────────────── send ───────────────
    if (!journal) {
      const startBlock = await retry(() => pub.getBlockNumber());
      const now = new Date().toISOString();
      journal = {
        kind: J.JOURNAL_KIND, version: J.JOURNAL_VERSION, chainId, deployer: me, mode: mainnetMode ? (rehearsal ? "mainnet rehearsal" : "mainnet") : "local",
        configHash: theConfigHash, config, planHash: thePlanHash, plan: steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label })),
        startNonce: latestNonce, startBlock: startBlock.toString(), status: "in-progress", createdAt: now, updatedAt: now, steps: [],
      };
      lastBlock = startBlock;
      if (persist) J.writeJournal(journalPath, journal);
    }
    const theJournal = journal;
    const save = () => { if (persist) J.writeJournal(journalPath, theJournal); };
    const runner = new J.StepRunner({
      journal: theJournal, plan: steps, persist: save, chainId, from: me, rpc: rawRpc, reader,
      lastBlock: lastBlock > BigInt(theJournal.startBlock) ? lastBlock : BigInt(theJournal.startBlock),
      nextNonce: theJournal.startNonce + J.noncesUsed(theJournal), retryReverted: args.has("--retry-reverted"), faults, receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      log: (line) => console.log(line),
      sign: (tx) => deployer.signTransaction("gasPrice" in tx.fees
        ? { type: "legacy", chainId: tx.chainId, nonce: tx.nonce, ...(tx.to ? { to: tx.to } : {}), data: tx.data, gas: tx.gas, gasPrice: tx.fees.gasPrice, value: 0n }
        : { type: "eip1559", chainId: tx.chainId, nonce: tx.nonce, ...(tx.to ? { to: tx.to } : {}), data: tx.data, gas: tx.gas, maxFeePerGas: tx.fees.maxFeePerGas, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas, value: 0n }),
    });
    const hasRole = (address: Address, role: Hex) => J.checksFor(ACL_ABI as Abi, address, "renounceRole", [role, me], me)[0] as Extract<J.StepCheck, { kind: "view" }>;
    const send: Ex = {
      planning: false,
      log: (line) => console.log(line),
      async deploy(id, name, abi, bytecode, ctorArgs = [], opts = {}) {
        const result = await runner.run(id, "deploy", { to: null, data: encodeDeployData({ abi, bytecode, args: ctorArgs } as never) }, { runtimeLimit: opts.runtimeLimit });
        console.log(`  ${name.padEnd(22)} ${result.step.address}${result.runtimeBytes !== undefined ? ` (${result.runtimeBytes} runtime bytes)` : ""}${result.replayed ? " (recorded)" : ""}`);
        return result.step.address!;
      },
      async call(id, address, abi, functionName, fnArgs) {
        await runner.run(id, "call", { to: address, data: encodeFunctionData({ abi, functionName, args: fnArgs } as never) }, { checks: J.checksFor(abi, address, functionName, fnArgs, me) });
      },
      async renounceIfHeld(id, address, role) {
        const check = hasRole(address, role);
        await runner.run(id, "renounce-if-held", { to: address, data: encodeFunctionData({ abi: ACL_ABI, functionName: "renounceRole", args: [role, me] }) }, {
          checks: [check],
          // check.expect is "false" (not held after the step): the step is needed only while hasRole is still true.
          skipIf: async () => await reader.view(check, runner.lastBlock) === "false" ? `deployer does not hold ${roleNameOf(role)}` : undefined,
        });
      },
      read: (_placeholder, fn) => J.withRetries(() => fn(runner.lastBlock)),
    };
    if (theJournal.steps.length) console.log(`Resuming: ${done} recorded step(s) verified on chain are replayed without sending; continuing at step ${done + 1}.`);
    const result = await body(send);
    if (runner.position !== steps.length) throw new Error(`internal error: ran ${runner.position} of ${steps.length} planned steps`);

    const dep: Deployment = {
      chainId,
      rpcUrl: persistedRpcUrl,
      startBlock: theJournal.startBlock,
      randomness: randomnessKind === "drand" ? { kind: "drand", chainHash: args.get("--drand-chain-hash") ?? DRAND_QUICKNET.chainHash, publicKey: args.get("--drand-public-key") ?? DRAND_QUICKNET.publicKey, genesisTime: Number(args.get("--drand-genesis") ?? DRAND_QUICKNET.genesisTime), period: Number(args.get("--drand-period") ?? DRAND_QUICKNET.period), ...(args.has("--drand-relays") ? { relays: args.get("--drand-relays")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}) } : { kind: "blockhash" },
      contracts: result.contracts,
      ...(result.privacy ? { privacy: result.privacy } : {}),
    };
    const finalDeployment = mainnetMode ? Object.assign(dep, { deployer: me, owner, timelock: result.timelock, guardian, paused: true, roles: result.mainnetRoles, stockTokens: result.stockTokens, ...(mochiRecipient ? { mochiRecipient } : {}), postman: configuredPostman ?? me, rehearsal }) : dep;
    Object.assign(finalDeployment, { minJurorBond: MIN_JUROR_BOND.toString(), timelockDelay: TIMELOCK_DELAY.toString(), panelEscalation });
    Object.assign(finalDeployment, { tokenSource: tokenPolicy.source === "external" ? { kind: "external", decimals: 18 } : { kind: "test-deployment", decimals: 18 } });
    mkdirSync(dirname(outPath), { recursive: true });
    J.writePrivateFileAtomic(outPath, JSON.stringify(finalDeployment, null, 2) + "\n", 0o644);
    console.log(`Wrote ${outPath}`);
    if (theJournal.status !== "complete") { theJournal.status = "complete"; theJournal.completedAt = new Date().toISOString(); }
    save();
    if (persist) console.log(`Journal ${journalPath}: complete, ${theJournal.steps.filter((s) => s.status === "confirmed").length} transactions for ${steps.length} steps.`);
  } finally {
    lock?.release();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    // viem errors carry the request URL; a provider URL embeds its API key.
    console.error(scrubText(e instanceof Error ? `${e.name}: ${e.message}` : String(e), redactRpc(rpcUrl) === rpcUrl ? [] : [rpcUrl]));
    process.exit(1);
  });
}
