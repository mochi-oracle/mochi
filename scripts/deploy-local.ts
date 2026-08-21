// Deploys and wires every Mochi contract to a local chain (anvil) and writes deployments/local.json.
// Usage: anvil &  then  bun scripts/deploy-local.ts [--rpc http://127.0.0.1:8545] [--out deployments/local.json]
// Local-only simplifications: the deployer is admin/governor (no TimelockController), schema activation delay is 0,
// and the mock USDG / mock shielded pool are used. Production deploys go through the timelocked multisig.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  isAddress,
  nonceManager,
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

const args = new Map<string, string>();
const flags = new Set(["--mainnet", "--rehearsal", "--yes"]);
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
const TIMELOCK_DELAY = BigInt(args.get("--timelock-delay") ?? 86400);
const SCHEMA_ACTIVATION_DELAY = BigInt(args.get("--schema-activation-delay") ?? 0);
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

async function main() {
  // Missing or malformed production token configuration fails before RPC or key-file access.
  resolveMochiTokenPolicy({ mainnetMode, rehearsal, tokenAddress: configuredMochiToken });
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
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
      timelockDelay: TIMELOCK_DELAY.toString(), schemaActivationDelay: "0",
      mochiToken: tokenPolicy.source === "external" ? configuredMochiToken : "test-only token deployed for rehearsal",
      mochiRecipient: tokenPolicy.source === "test-deployment" ? configuredRecipient : "team-managed external supply", guardian: configuredGuardian,
      postman: configuredPostman ?? "deployer (renounced at handover; vacant until rotated)", attestor: configuredAttestor ?? "later through timelock",
      feedRunner: configuredFeedRunner ?? "later through timelock", orchestrator: configuredOrchestrator ?? "later through timelock",
      anonymaSigner: configuredAnonymaSigner ?? "disabled until set through timelock", stockTokens: stock, feedOrigins, mockUSDGAllowed: rehearsal,
    }, null, 2));
    if (!args.has("--yes")) throw new Error("review deployment summary and rerun with --yes");
  } else if (rehearsal) throw new Error("--rehearsal requires --mainnet");
  if (chainId !== 31337 && !fileKey) throw new Error("non-local network: pass --key-file");
  const KEYS = fileKey
    ? { deployer: fileKey, attestor: fileKey, feedRunner: fileKey, orchestrator: fileKey, anonymaSigner: fileKey }
    : DEV_KEYS;
  const deployer = fileKey ? privateKeyToAccount(KEYS.deployer, { nonceManager }) : privateKeyToAccount(KEYS.deployer);
  const persistedRpcUrl = process.env.PUBLIC_RPC_URL ?? (redactRpc(rpcUrl) === rpcUrl ? rpcUrl : PUBLIC_RPC[chainId] ?? redactRpc(rpcUrl));
  const dep0: Deployment = { chainId, rpcUrl: persistedRpcUrl, startBlock: "0", contracts: {} as Deployment["contracts"] };
  const chain = chainFor(dep0);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: deployer });
  if (tokenPolicy.source === "external") {
    const externalToken = tokenPolicy.address as Address;
    const code = await pub.getCode({ address: externalToken });
    if (!code || code === "0x") throw new Error("--mochi-token has no contract code on the selected chain");
    const tokenMetadataAbi = [
      { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    ] as const;
    let tokenName: string; let tokenSymbol: string; let tokenDecimals: number;
    try {
      [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "name" }),
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "symbol" }),
        pub.readContract({ address: externalToken, abi: tokenMetadataAbi, functionName: "decimals" }),
      ]);
    } catch { throw new Error("--mochi-token must implement ERC20 name(), symbol(), and decimals() metadata"); }
    if (!tokenName.trim() || tokenSymbol.toUpperCase() !== "MOCHI") throw new Error(`--mochi-token metadata mismatch: expected a named MOCHI token, received ${JSON.stringify({ name: tokenName, symbol: tokenSymbol })}`);
    assertMochiTokenDecimals(tokenDecimals);
  }
  const startBlock = await pub.getBlockNumber();

  async function deploy(name: string, abi: Abi, bytecode: Hex, ctorArgs: unknown[] = []): Promise<Address> {
    const hash = await wallet.deployContract({ abi, bytecode, args: ctorArgs as never });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    console.log(`  ${name.padEnd(22)} ${r.contractAddress}`);
    return r.contractAddress;
  }
  async function call(address: Address, abi: Abi, functionName: string, fnArgs: unknown[]) {
    const hash = await wallet.writeContract({ address, abi, functionName, args: fnArgs as never } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
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
  let usdg: Address;
  if (mainnetMode) {
    usdg = configuredUsdg!;
    const tokenMetaAbi = [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }, { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
    const code = await pub.getCode({ address: usdg });
    if (!code || code === "0x") throw new Error("--usdg has no contract code");
    const [tokenName, tokenSymbol] = await Promise.all([
      pub.readContract({ address: usdg, abi: tokenMetaAbi, functionName: "name" }),
      pub.readContract({ address: usdg, abi: tokenMetaAbi, functionName: "symbol" }),
    ]);
    if (tokenName === "Mock USDG") {
      if (!rehearsal) throw new Error("MockUSDG is refused outside --rehearsal");
      console.log("WARNING: rehearsal only; explicitly supplied MockUSDG accepted on testnet.");
    }
  } else usdg = await deploy("MockUSDG", A.MockUSDGAbi as Abi, A.MockUSDGBytecode);
  const mochiToken = tokenPolicy.source === "external"
    ? tokenPolicy.address as Address
    : await deploy("TestMochiToken", A.MochiTokenAbi as Abi, A.MochiTokenBytecode, [mochiRecipient!, 10n ** 27n]);
  const randomness = randomnessKind === "drand"
    ? await deploy("DrandRandomness", A.DrandRandomnessAbi as Abi, A.DrandRandomnessBytecode, [
      g2ToEip2537(args.get("--drand-public-key") ?? DRAND_QUICKNET.publicKey),
      BigInt(args.get("--drand-genesis") ?? DRAND_QUICKNET.genesisTime),
      BigInt(args.get("--drand-period") ?? DRAND_QUICKNET.period),
      BigInt(args.get("--drand-lookahead") ?? "2"),
    ])
    : await deploy("BlockhashRandomness", A.BlockhashRandomnessAbi as Abi, A.BlockhashRandomnessBytecode, [1n]);
  const schemaRegistry = await deploy("SchemaRegistry", A.SchemaRegistryAbi as Abi, A.SchemaRegistryBytecode, [me, mainnetMode ? 0n : SCHEMA_ACTIVATION_DELAY]);
  const jurorRegistry = await deploy("JurorRegistry", A.JurorRegistryAbi as Abi, A.JurorRegistryBytecode, [
    me, mochiToken, me, 25_000n * 10n ** 18n, 7n * 86400n,
  ]);
  const queryEscrow = await deploy("QueryEscrow", A.QueryEscrowAbi as Abi, A.QueryEscrowBytecode, [
    me, usdg, jurorRegistry, schemaRegistry, randomness,
  ]);
  const staking = await deploy("MochiStaking", A.MochiStakingAbi as Abi, A.MochiStakingBytecode, [me, mochiToken, usdg, 7n * 86400n, 7n * 86400n]);
  const verdicts = await deploy("MochiVerdicts", A.MochiVerdictsAbi as Abi, A.MochiVerdictsBytecode, [
    me, queryEscrow, jurorRegistry, "0x0000000000000000000000000000000000000000",
  ]);
  const panel = await deploy("PanelEscalation", A.PanelEscalationAbi as Abi, A.PanelEscalationBytecode, [
    me, usdg, queryEscrow, verdicts, randomness, USDG(2500), USDG(25),
  ]);
  const feeds = await deploy("Feeds", A.FeedsAbi as Abi, A.FeedsBytecode, [me, verdicts, queryEscrow, usdg, me]);
  const stockTokenCrosscheck = await deploy("StockTokenCrosscheck", A.StockTokenCrosscheckAbi as Abi, A.StockTokenCrosscheckBytecode, [me]);
  const receiptAnchor = await deploy("ReceiptAnchor", A.ReceiptAnchorAbi as Abi, A.ReceiptAnchorBytecode, [me, orchestrator]);
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
    async function deployArtifact(name: string, artifact: ReturnType<typeof readArtifact>, ctorArgs: unknown[] = [], links: Record<string, Address> = {}): Promise<Address> {
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
      const abi = artifact.abi;
      const hash = await wallet.deployContract({ abi, bytecode: `0x${bytecode}` as Hex, args: ctorArgs as never });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
      const code = await pub.getCode({ address: r.contractAddress });
      const runtimeBytes = code ? (code.length - 2) / 2 : 0;
      if (runtimeBytes >= 24_576) throw new Error(`${name} runtime is ${runtimeBytes} bytes (EIP-170 limit 24576)`);
      console.log(`  ${name.padEnd(22)} ${r.contractAddress} (${runtimeBytes} runtime bytes)`);
      return r.contractAddress;
    }
    const poseidonT3 = await deployArtifact("PoseidonT3", t3);
    const poseidonT4 = await deployArtifact("PoseidonT4", t4);
    const withdrawalVerifier = await deployArtifact("WithdrawalVerifier", readArtifact("WithdrawalVerifier"));
    const commitmentVerifier = await deployArtifact("CommitmentVerifier", readArtifact("CommitmentVerifier"));
    const epImpl = await deployArtifact("Entrypoint", readArtifact("Entrypoint"));
    const proxyArt = readArtifact("ERC1967Proxy");
    const initData = encodeFunctionData({ abi: readArtifact("Entrypoint").abi, functionName: "initialize", args: [me, mainnetMode ? postman : me] } as never);
    const entrypoint = await deployArtifact("ERC1967Proxy", proxyArt, [epImpl, initData]);
    const poolArt = readArtifact("PrivacyPoolComplex", "PrivacyPoolComplex");
    const pool = await deployArtifact("PrivacyPoolComplex", poolArt, [entrypoint, withdrawalVerifier, commitmentVerifier, usdg], { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 });
    const epAbi = readArtifact("Entrypoint").abi;
    await call(entrypoint, epAbi, "registerPool", [usdg, pool, 1n, 0, 0]);
    const adapter = await deployArtifact("PrivacyPoolShieldedPayments", readArtifact("PrivacyPoolShieldedPayments"), [pool, usdg, queryEscrow]);
    shielded = adapter;
    const poolScope = await pub.readContract({ address: pool, abi: poolArt.abi, functionName: "SCOPE" });
    privacy = { entrypoint, pool, adapter, withdrawalVerifier, commitmentVerifier, poseidonT3, poseidonT4, scope: String(poolScope) };
  } else {
    shielded = await deploy("MockShieldedPayments", A.MockShieldedPaymentsAbi as Abi, A.MockShieldedPaymentsBytecode, [usdg]);
  }
  const classMix = await deploy("ClassMix", A.ClassMixAbi as Abi, A.ClassMixBytecode, [me]);
  const clerkVoting = await deploy("ClerkVoting", A.ClerkVotingAbi as Abi, A.ClerkVotingBytecode, [
    me, staking, schemaRegistry, classMix, VOTING_PERIOD, EXECUTION_DELAY, 400n, 100_000n * 10n ** 18n,
  ]);
  const disclosureRegistry = await deploy("DisclosureRegistry", A.DisclosureRegistryAbi as Abi, A.DisclosureRegistryBytecode, []);
  // Production: this timelock (owned by the 2-of-3 multisig) takes GOVERNOR/DEFAULT_ADMIN on every contract.
  // Here it is deployed with the deployer as proposer/executor; handover is a separate, explicit step.
  let timelock: Address | undefined;
  if (!mainnetMode) timelock = await deploy("MochiTimelock", A.MochiTimelockAbi as Abi, A.MochiTimelockBytecode, [TIMELOCK_DELAY, [me], [me], me]);

  console.log("Wiring roles and parameters");
  const E = A.QueryEscrowAbi as Abi;
  await call(queryEscrow, E, "setVerdicts", [verdicts]);
  await call(queryEscrow, E, "setPanel", [panel]);
  await call(queryEscrow, E, "setStaking", [staking]);
  await call(queryEscrow, E, "setShielded", [shielded]);
  await call(queryEscrow, E, "setAnonymaSigner", [mainnetMode ? (configuredAnonymaSigner ?? "0x0000000000000000000000000000000000000000") : anonymaSigner]);
  // Local fixture tariff stays stable. Mainnet uses the approved $0.05 short-N3 launch tariff.
  const prices: [number, number, number][] = [
    [0, 0.004, 0.0008], // LARGE_A
    [1, 0.004, 0.0008], // LARGE_B
    [2, 0.004, 0.0009], // DOC_SPECIALIST
    [3, 0.001, 0.0001], // SMALL_FAST
    [4, 0.003, 0.0006], // DISSENTER
  ];
  const classPrices = mainnetMode ? LAUNCH_CLASS_PRICES : prices.map(([cls, base, perK]) => [cls, USDG(base), USDG(perK)] as const);
  for (const [cls, base, perK] of classPrices) await call(queryEscrow, E, "setClassPrice", [cls, base, perK]);
  if (mainnetMode) await call(queryEscrow, E, "setProtocolFee", [LAUNCH_PROTOCOL_FEE_BPS, LAUNCH_MIN_PROTOCOL_FEE]);
  if (!mainnetMode) await call(queryEscrow, E, "grantRole", [ROLE_IDS.FEED_RUNNER, feedRunner]);
  // The orchestrator expands and escalates standing feed queries with its own key (one key per process: sharing the
  // feed runner's key across processes causes nonce collisions).
  if (!mainnetMode) await call(queryEscrow, E, "grantRole", [ROLE_IDS.FEED_RUNNER, orchestrator]);
  await call(verdicts, A.MochiVerdictsAbi as Abi, "setPanel", [panel]);
  await call(jurorRegistry, A.JurorRegistryAbi as Abi, "grantRole", [ROLE_IDS.SLASHER, verdicts]);
  if (!mainnetMode) {
    await call(jurorRegistry, A.JurorRegistryAbi as Abi, "grantRole", [ROLE_IDS.ATTESTOR, attestor]);
    await call(panel, A.PanelEscalationAbi as Abi, "grantRole", [ROLE_IDS.FEED_RUNNER, feedRunner]);
    await call(panel, A.PanelEscalationAbi as Abi, "grantRole", [ROLE_IDS.FEED_RUNNER, orchestrator]);
  }
  // Governed class mix + clerk voting (spec: clerks vote task schemas and juror-class mixes).
  await call(jurorRegistry, A.JurorRegistryAbi as Abi, "setClassMix", [classMix]);
  await call(schemaRegistry, A.SchemaRegistryAbi as Abi, "grantRole", [ROLE_IDS.GOVERNOR, clerkVoting]);
  await call(classMix, A.ClassMixAbi as Abi, "grantRole", [ROLE_IDS.GOVERNOR, clerkVoting]);
  await call(staking, A.MochiStakingAbi as Abi, "grantRole", [keccak256(toHex("mochi.role.LOCKER")), clerkVoting]);

  console.log("Registering the 7 task schemas");
  for (const id of [1, 2, 3, 4, 5, 6, 7] as SchemaId[]) {
    await call(schemaRegistry, A.SchemaRegistryAbi as Abi, "propose", [...registryArgs(getSchema(id))]);
  }

  console.log("Registering feeds");
  const origins = (process.env.FEED_ORIGINS ?? (mainnetMode ? "www.sec.gov" : "www.sec.gov,127.0.0.1")).split(",").map((h) => originId(h));
  for (const f of FEEDS) {
    await call(feeds, A.FeedsAbi as Abi, "register", [
      feedId(f.name), f.schemaId, origins, f.crosscheck ? stockTokenCrosscheck : "0x0000000000000000000000000000000000000000", USDG(10),
    ]);
  }

  const stockTokens: Record<string, Address> = {};
  if (args.has("--stock-tokens")) {
    const erc20Meta = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
    for (const entry of (args.get("--stock-tokens") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const sep = entry.indexOf("=");
      if (sep < 1) throw new Error(`invalid --stock-tokens entry: ${entry}`);
      const ticker = entry.slice(0, sep).trim().toUpperCase();
      const token = entry.slice(sep + 1).trim() as Address;
      if (!/^[A-Z0-9._-]{1,31}$/.test(ticker) || !isAddress(token)) throw new Error(`invalid stock token registration: ${entry}`);
      const actual = await pub.readContract({ address: token, abi: erc20Meta, functionName: "symbol" });
      if (actual.toUpperCase() !== ticker) throw new Error(`${ticker} symbol mismatch: token reports ${actual}`);
      await call(stockTokenCrosscheck, A.StockTokenCrosscheckAbi as Abi, "setToken", [toHex(ticker, { size: 32 }), token]);
      stockTokens[ticker] = token;
    }
  }

  let mainnetRoles: Record<string, Record<string, Address[]>> | undefined;
  if (mainnetMode) {
    // Pausing before governance handover ensures launch starts closed and the guardian remains independently fast.
    await call(queryEscrow, E, "pause", []);
    const proposers = [owner];
    const executors = [owner];
    timelock = await deploy("MochiTimelock", A.MochiTimelockAbi as Abi, A.MochiTimelockBytecode, [TIMELOCK_DELAY, proposers, executors, "0x0000000000000000000000000000000000000000"]);
    const aclAbi = [
      { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
      { type: "function", name: "renounceRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "callerConfirmation", type: "address" }], outputs: [] },
      { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
    ] as const;
    const governor = ROLE_IDS.GOVERNOR;
    const guardianRole = ROLE_IDS.GUARDIAN;
    const attestorRole = ROLE_IDS.ATTESTOR;
    const feedRole = ROLE_IDS.FEED_RUNNER;
    const roleLocal = (name: string) => keccak256(toHex(`mochi.role.${name}`));
    const targets: { name: string; address: Address; roles: [Hex, Address][] }[] = [
      { name: "queryEscrow", address: queryEscrow, roles: [[guardianRole, guardian], [guardianRole, timelock], [feedRole, configuredFeedRunner ?? timelock], [feedRole, configuredOrchestrator ?? timelock]] },
      { name: "jurorRegistry", address: jurorRegistry, roles: [[ROLE_IDS.SLASHER, verdicts], [attestorRole, configuredAttestor ?? timelock]] },
      { name: "schemaRegistry", address: schemaRegistry, roles: [[governor, clerkVoting]] },
      { name: "staking", address: staking, roles: [[roleLocal("LOCKER"), clerkVoting]] },
      { name: "verdicts", address: verdicts, roles: [] },
      { name: "panel", address: panel, roles: [[feedRole, configuredFeedRunner ?? timelock], [feedRole, configuredOrchestrator ?? timelock]] },
      { name: "feeds", address: feeds, roles: [] },
      { name: "stockTokenCrosscheck", address: stockTokenCrosscheck, roles: [] },
      { name: "receiptAnchor", address: receiptAnchor, roles: [[roleLocal("ANCHORER"), configuredOrchestrator ?? timelock]] },
      { name: "classMix", address: classMix, roles: [[governor, clerkVoting]] },
      { name: "clerkVoting", address: clerkVoting, roles: [] },
    ];
    const governed = new Set(["queryEscrow", "jurorRegistry", "schemaRegistry", "verdicts", "panel", "feeds", "stockTokenCrosscheck", "classMix"]);
    const byName: Record<string, Record<string, Address[]>> = {};
    for (const c of targets) {
      const assignments = [...c.roles];
      if (governed.has(c.name)) assignments.unshift([governor, timelock], ["0x" + "00".repeat(32) as Hex, timelock]);
      else assignments.unshift(["0x" + "00".repeat(32) as Hex, timelock]);
      for (const [role, account] of assignments) {
        await call(c.address, aclAbi as Abi, "grantRole", [role, account]);
        const roleName = role === "0x" + "00".repeat(32) ? "DEFAULT_ADMIN_ROLE" : role === governor ? "GOVERNOR_ROLE" : role === guardianRole ? "GUARDIAN_ROLE" : role === attestorRole ? "ATTESTOR_ROLE" : role === feedRole ? "FEED_RUNNER_ROLE" : role === ROLE_IDS.SLASHER ? "SLASHER_ROLE" : role === roleLocal("LOCKER") ? "LOCKER_ROLE" : role === roleLocal("ANCHORER") ? "ANCHORER_ROLE" : "GOVERNOR_ROLE";
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
      await call(privacy.entrypoint, epAbi, "grantRole", [ownerRole, timelock]);
      if (configuredPostman) await call(privacy.entrypoint, epAbi, "grantRole", [postmanRole, configuredPostman]);
      else await call(privacy.entrypoint, epAbi, "renounceRole", [postmanRole, me]);
      await call(privacy.entrypoint, epAbi, "renounceRole", [ownerRole, me]);
      byName.entrypoint = { OWNER_ROLE: [timelock], ASP_POSTMAN_ROLE: configuredPostman ? [configuredPostman] : [] };
    }
    // Fixed known role surface: renounce every role granted by constructors and wiring on each AccessControl contract.
    const allRoles: Record<string, Hex[]> = {
      queryEscrow: ["0x" + "00".repeat(32) as Hex, governor, guardianRole, feedRole],
      jurorRegistry: ["0x" + "00".repeat(32) as Hex, governor, attestorRole, ROLE_IDS.SLASHER],
      schemaRegistry: ["0x" + "00".repeat(32) as Hex, governor],
      staking: ["0x" + "00".repeat(32) as Hex, roleLocal("LOCKER")],
      verdicts: ["0x" + "00".repeat(32) as Hex, governor], panel: ["0x" + "00".repeat(32) as Hex, governor, feedRole],
      feeds: ["0x" + "00".repeat(32) as Hex, governor], stockTokenCrosscheck: ["0x" + "00".repeat(32) as Hex, governor],
      receiptAnchor: ["0x" + "00".repeat(32) as Hex, roleLocal("ANCHORER")], classMix: ["0x" + "00".repeat(32) as Hex, governor], clerkVoting: ["0x" + "00".repeat(32) as Hex],
    };
    for (const c of targets) for (const role of allRoles[c.name] ?? []) {
      const holds = await pub.readContract({ address: c.address, abi: aclAbi, functionName: "hasRole", args: [role, me] });
      if (holds) await call(c.address, aclAbi as Abi, "renounceRole", [role, me]);
    }
    if (tokenPolicy.source === "test-deployment") {
      // Only the locally/rehearsal-deployed test token has a metadata admin to hand over.
      const tokenAdminAbi = [
        { type: "function", name: "transferMetadataAdmin", stateMutability: "nonpayable", inputs: [{ name: "newAdmin", type: "address" }], outputs: [] },
      ] as const;
      await call(mochiToken, tokenAdminAbi as unknown as Abi, "transferMetadataAdmin", [timelock]);
      byName.mochiToken = { METADATA_ADMIN: [timelock] };
    }
    mainnetRoles = byName;
    console.log(`Handover complete; deployer ${me} renounced its assigned roles.`);
  }

  const dep: Deployment = {
    chainId,
    rpcUrl: persistedRpcUrl,
    startBlock: startBlock.toString(),
    randomness: randomnessKind === "drand" ? { kind: "drand", chainHash: args.get("--drand-chain-hash") ?? DRAND_QUICKNET.chainHash, publicKey: args.get("--drand-public-key") ?? DRAND_QUICKNET.publicKey, genesisTime: Number(args.get("--drand-genesis") ?? DRAND_QUICKNET.genesisTime), period: Number(args.get("--drand-period") ?? DRAND_QUICKNET.period), ...(args.has("--drand-relays") ? { relays: args.get("--drand-relays")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}) } : { kind: "blockhash" },
    contracts: {
      mochiToken, randomness, schemaRegistry, jurorRegistry, queryEscrow, verdicts, feeds,
      stockTokenCrosscheck, panel, staking, receiptAnchor, usdg, shielded,
      classMix, clerkVoting, disclosureRegistry, timelock: timelock!,
    },
    ...(privacy ? { privacy } : {}),
  };
  const finalDeployment = mainnetMode ? Object.assign(dep, { deployer: me, owner, timelock, guardian, paused: true, roles: mainnetRoles, stockTokens, ...(mochiRecipient ? { mochiRecipient } : {}), postman: configuredPostman ?? me, rehearsal }) : dep;
  Object.assign(finalDeployment, { tokenSource: tokenPolicy.source === "external" ? { kind: "external", decimals: 18 } : { kind: "test-deployment", decimals: 18 } });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(finalDeployment, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
