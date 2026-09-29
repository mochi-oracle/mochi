import { readFile, readdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { createChain, ROLE_IDS } from "@mochi/chain";
import { DstackKeySource } from "@mochi/tee";
import { createDb, upsertEndpoint } from "@mochi/db";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_RECEIPT_SIGNING_SPEC, PRODUCTION_SERVICE_SPECS } from "../phala/production-identities/identities.ts";
import { productionChainId } from "./chain-policy.ts";

type Address = `0x${string}`;
type Hex = `0x${string}`;
export type Passport = {
  modelId: string; lineage: string; weightsSha256: Hex; openWeights: boolean;
  provider: "phala-aci"; zdr: boolean; aciModel: string;
  workload: string; maxTokens?: number;
};
export type Enrollment = { address: Address; operator: Address; measurement: Hex; class?: number; passport?: Passport };
export type ProductionLaunchConfig = {
  format: "mochi-production-runtime-v1";
  enabled: true;
  mode: "prepare" | "enroll" | "active";
  deployment: Record<string, any>;
  rpcUrl: string;
  databaseUrlEnv: string;
  fetchOrigins?: Array<{ host: string; spkiSha256?: string[] }>;
  endpoints: { intake: string; consensus: string; jurors: string[]; gateway: string; indexer: string; attestor: string; orchestrator: string };
  identities: { intake: Enrollment; consensus: Enrollment; jurors: Enrollment[] };
  serviceRoleAddresses: { attestor: Address; indexer: Address; orchestrator: Address; feedRunner: Address; postman: Address };
  aciApiKeyEnv: string;
  attestorAdminTokenEnv: string;
  relayKeyEnv?: string;
  anonHmacSecretEnv?: string;
};
export type RuntimeDeps = {
  keySource?: Pick<DstackKeySource, "derive">;
  spawn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  artifactDir?: string;
  migrationDir?: string;
  log?: (message: string) => void;
  onFatal?: (service: string) => void;
};
export const PRODUCTION_PORTS = { intake: 3001, consensus: 3002, jurors: [3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108], gateway: 3200, indexer: 3201, attestor: 3202, orchestrator: 3203 } as const;
export type RuntimeState = { status: "standby" | "running"; reason: string; childhealth: Record<string, "starting" | "healthy" | "failed">; stop(): Promise<void> };

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hex32Pattern = /^0x[0-9a-fA-F]{64}$/;
const classCounts = [2, 2, 2, 1, 2];
const classModels = [
  ["meta-llama/llama-3.3-70b-instruct", "llama"],
  ["nvidia/nemotron-3.5-lightning", "nemotron"],
  ["google/gemma-4-31b-it", "gemma"],
  ["nvidia/nemotron-3.5-lightning", "nemotron"],
  ["google/gemma-4-31b-it", "gemma"],
] as const;
const localUrl = (value: string, field: string) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) throw new Error(`${field} must be an HTTP loopback URL`);
  return value;
};
function nonzeroAddress(value: unknown, field: string): asserts value is Address {
  if (typeof value !== "string" || !addressPattern.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${field} must be a nonzero address`);
}

/** Enclave endpoints to register (role 2 intake, 3 consensus, 1 juror). The endpoint table stores lowercase addresses. */
export function endpointRows(config: ProductionLaunchConfig): Array<{ address: string; role: 1 | 2 | 3; url: string }> {
  return [config.identities.intake, config.identities.consensus, ...config.identities.jurors].map((identity, i) => ({
    address: identity.address.toLowerCase(),
    role: i === 0 ? 2 : i === 1 ? 3 : 1,
    url: i === 0 ? config.endpoints.intake : i === 1 ? config.endpoints.consensus : config.endpoints.jurors[i - 2]!,
  }));
}

/** Fail-closed parser. An absent launch file is the normal pre-CA standby state. */
export function validateLaunchConfig(raw: unknown): ProductionLaunchConfig {
  if (!raw || typeof raw !== "object") throw new Error("launch config must be an object");
  const c = raw as ProductionLaunchConfig;
  if (c.format !== "mochi-production-runtime-v1") throw new Error("unsupported production runtime config format");
  if (c.enabled !== true) throw new Error("production runtime requires explicit enabled=true after CA and identity review");
  if (!["prepare", "enroll", "active"].includes(c.mode)) throw new Error("runtime mode must be explicitly prepare, enroll or active");
  if (!c.deployment || !c.deployment.contracts?.mochiToken) throw new Error("deployment must be the reviewed Robinhood mainnet deployment with external MOCHI CA");
  productionChainId(c.deployment);
  nonzeroAddress(c.deployment.contracts.mochiToken, "deployment.contracts.mochiToken");
  let rpc: URL;
  try { rpc = new URL(c.rpcUrl); } catch { throw new Error("rpcUrl must be a valid HTTPS URL"); }
  if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.search || rpc.hash) throw new Error("rpcUrl must use HTTPS without embedded credentials or query parameters");
  if (typeof c.databaseUrlEnv !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(c.databaseUrlEnv)) throw new Error("databaseUrlEnv must name a protected database URL environment variable");
  const expectedEndpoints = {
    intake: [c.endpoints.intake, PRODUCTION_PORTS.intake], consensus: [c.endpoints.consensus, PRODUCTION_PORTS.consensus],
    gateway: [c.endpoints.gateway, PRODUCTION_PORTS.gateway], indexer: [c.endpoints.indexer, PRODUCTION_PORTS.indexer],
    attestor: [c.endpoints.attestor, PRODUCTION_PORTS.attestor], orchestrator: [c.endpoints.orchestrator, PRODUCTION_PORTS.orchestrator],
  } as const;
  for (const [key, [value, port]] of Object.entries(expectedEndpoints)) if (new URL(localUrl(value, `endpoints.${key}`)).port !== String(port)) throw new Error(`endpoints.${key} must use loopback port ${port}`);
  if (!Array.isArray(c.endpoints.jurors) || c.endpoints.jurors.length !== 9 || c.endpoints.jurors.some((value, i) => new URL(localUrl(value, `endpoints.jurors[${i}]`)).port !== String(PRODUCTION_PORTS.jurors[i]))) throw new Error("juror endpoints must use the nine assigned loopback ports");
  if (c.fetchOrigins !== undefined && (!Array.isArray(c.fetchOrigins) || c.fetchOrigins.some((origin) => !origin || !/^[a-z0-9.-]+$/i.test(origin.host) || origin.host.includes("..") || (origin.spkiSha256 && origin.spkiSha256.some((pin) => typeof pin !== "string" || !pin))))) throw new Error("fetchOrigins must be a reviewed host allowlist");
  if (c.fetchOrigins && new Set(c.fetchOrigins.map((origin) => origin.host.toLowerCase())).size !== c.fetchOrigins.length) throw new Error("fetchOrigins hosts must be unique");
  if (c.identities?.jurors?.length !== 9) throw new Error("exactly nine reviewed juror identities are required");
  if (c.deployment.owner && c.deployment.guardian && c.deployment.owner.toLowerCase() === c.deployment.guardian.toLowerCase()) throw new Error("deployment owner and guardian custody must be distinct");
  const identities = [c.identities.intake, c.identities.consensus, ...c.identities.jurors];
  const seen = new Set<string>();
  for (const [i, identity] of identities.entries()) {
    nonzeroAddress(identity?.address, `identities[${i}].address`);
    nonzeroAddress(identity?.operator, `identities[${i}].operator`);
    if (typeof identity.measurement !== "string" || !hex32Pattern.test(identity.measurement) || /^0x0{64}$/i.test(identity.measurement)) throw new Error(`identities[${i}].measurement must be nonzero bytes32`);
    if (seen.has(identity.address.toLowerCase())) throw new Error("reviewed enclave addresses must be unique");
    seen.add(identity.address.toLowerCase());
  }
  for (const [cls, count] of classCounts.entries()) {
    const seats = c.identities.jurors.filter((j) => j.class === cls);
    if (seats.length !== count || seats.some((j) => !j.passport)) throw new Error(`class ${cls} requires ${count} jurors with reviewed model passports`);
    for (const seat of seats) validatePassport(seat.passport!, cls);
  }
  const serviceAddresses = new Set<string>();
  for (const name of ["attestor", "indexer", "orchestrator", "feedRunner", "postman"] as const) {
    nonzeroAddress(c.serviceRoleAddresses[name], `serviceRoleAddresses.${name}`);
    if (serviceAddresses.has(c.serviceRoleAddresses[name].toLowerCase())) throw new Error("service role signer addresses must be distinct");
    for (const custody of [c.deployment.owner, c.deployment.guardian]) if (typeof custody === "string" && c.serviceRoleAddresses[name].toLowerCase() === custody.toLowerCase()) throw new Error("service signers must be distinct from external owner and guardian custody");
    serviceAddresses.add(c.serviceRoleAddresses[name].toLowerCase());
    if (seen.has(c.serviceRoleAddresses[name].toLowerCase())) throw new Error("service role signers must be distinct from enclave identities");
  }
  if (c.anonHmacSecretEnv !== undefined && !/^[A-Z][A-Z0-9_]{1,63}$/.test(c.anonHmacSecretEnv)) throw new Error("anonHmacSecretEnv must name an environment variable");
  for (const envName of [c.databaseUrlEnv, c.aciApiKeyEnv, c.attestorAdminTokenEnv]) if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(envName)) throw new Error("secret env references must be environment variable names");
  return c;
}
function validatePassport(p: Passport, cls: number) {
  const [expectedModel, expectedLineage] = classModels[cls]!;
  if (!p || !p.modelId || !p.lineage || p.provider !== "phala-aci" || !p.aciModel || p.modelId !== p.aciModel || p.modelId !== expectedModel || p.lineage !== expectedLineage || !p.workload || (p.maxTokens !== undefined && (!Number.isInteger(p.maxTokens) || p.maxTokens < 1 || p.maxTokens > 8192)) || p.weightsSha256 !== `0x${"00".repeat(32)}` || p.openWeights !== false || p.zdr !== false) {
    throw new Error(`juror class ${cls} passport must identify a reviewed Phala ACI model and make no weights/ZDR claims`);
  }
}

export type EnrollmentReadinessReader = {
  juror(address: Address): Promise<{ operator: Address; measurement: Hex; role: number; jurorClass: number; bond: bigint; delisted: boolean }>;
  isActive(address: Address, role: number): Promise<boolean>;
  hasRole(contract: Address, role: Hex, account: Address): Promise<boolean>;
};

/** Checks configured chain state before DB mutations or service startup. Enroll mode tolerates inactive keys. */
export async function validateEnrollmentReadiness(config: ProductionLaunchConfig, reader: EnrollmentReadinessReader, requireActive: boolean): Promise<void> {
  const registered = [
    { identity: config.identities.intake, role: 2, jurorClass: undefined },
    { identity: config.identities.consensus, role: 3, jurorClass: undefined },
    ...config.identities.jurors.map((identity) => ({ identity, role: 1, jurorClass: identity.class })),
  ];
  const minimumBond = 25_000n * 10n ** 18n;
  for (const { identity, role, jurorClass } of registered) {
    const current = await reader.juror(identity.address);
    if (current.operator.toLowerCase() !== identity.operator.toLowerCase() || current.measurement.toLowerCase() !== identity.measurement.toLowerCase() || current.role !== role || (jurorClass !== undefined && current.jurorClass !== jurorClass) || current.delisted) {
      throw new Error(`enrollment mismatch for ${identity.address}`);
    }
    if (requireActive && !(await reader.isActive(identity.address, role))) throw new Error(`enclave identity is not active: ${identity.address}`);
    if (role === 1 && current.bond < minimumBond) throw new Error(`juror bond below 25000 MOCHI: ${identity.address}`);
  }
  const roles = [
    [config.deployment.contracts.jurorRegistry as Address, ROLE_IDS.ATTESTOR, config.serviceRoleAddresses.attestor],
    [config.deployment.contracts.queryEscrow as Address, ROLE_IDS.FEED_RUNNER, config.serviceRoleAddresses.feedRunner],
    [config.deployment.contracts.queryEscrow as Address, ROLE_IDS.FEED_RUNNER, config.serviceRoleAddresses.orchestrator],
    [config.deployment.contracts.panel as Address, ROLE_IDS.FEED_RUNNER, config.serviceRoleAddresses.feedRunner],
    [config.deployment.contracts.panel as Address, ROLE_IDS.FEED_RUNNER, config.serviceRoleAddresses.orchestrator],
    [config.deployment.contracts.receiptAnchor as Address, ROLE_IDS.ANCHORER, config.serviceRoleAddresses.indexer],
    [config.deployment.privacy!.entrypoint as Address, keccak256(toHex("ASP_POSTMAN")), config.serviceRoleAddresses.postman],
  ] as const;
  for (const [contract, role, account] of roles) if (!(await reader.hasRole(contract, role, account))) throw new Error(`required service role is not granted to ${account}`);
}

async function validateActivatedDeployment(config: ProductionLaunchConfig, client: ReturnType<typeof createPublicClient>, requireActive: boolean): Promise<void> {
  const deployment = { ...config.deployment, rpcUrl: config.rpcUrl } as any;
  const chain = createChain(deployment, { transport: http(config.rpcUrl) });
  const hasRoleAbi = parseAbi(["function hasRole(bytes32,address) view returns (bool)"]);
  await validateEnrollmentReadiness(config, {
    juror: (address) => chain.getJuror(address),
    isActive: (address, role) => chain.isActive(address, role),
    hasRole: (contract, role, account) => client.readContract({ address: contract, abi: hasRoleAbi, functionName: "hasRole", args: [role, account] }),
  }, requireActive);
}


export function watchChildLifecycle(
  child: ChildProcess,
  id: string,
  childhealth: Record<string, "starting" | "healthy" | "failed">,
  options: { httpHealth: boolean; onFatal?: (service: string) => void; log?: (message: string) => void },
): { stop(): void } {
  let stopping = false;
  let reported = false;
  const fail = (code: number | null, signal: NodeJS.Signals | null, reason: "exit" | "error") => {
    childhealth[id] = "failed";
    if (stopping || reported) return;
    reported = true;
    (options.log ?? (() => {}))(reason === "error" ? `${id} could not start` : `${id} exited${code !== 0 && code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}`);
    options.onFatal?.(id);
  };
  child.on("spawn", () => { if (!options.httpHealth && !stopping) childhealth[id] = "healthy"; });
  child.on("error", () => fail(null, null, "error"));
  child.on("exit", (code, signal) => fail(code, signal, "exit"));
  return { stop: () => { stopping = true; } };
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`required protected environment variable ${name} is absent`);
  return value;
}

/** Starts in standby until the reviewed CA-bound launch JSON exists and validates. */
export async function startProductionRuntime(raw: unknown | undefined, deps: RuntimeDeps = {}): Promise<RuntimeState> {
  if (raw === undefined || raw === null || raw === "") return { status: "standby", reason: "reviewed CA launch config is absent", childhealth: {}, stop: async () => {} };
  const rootDir = resolve(deps.rootDir ?? process.cwd());
  const artifactDir = resolve(deps.artifactDir ?? "/tmp/mochi-runtime");
  const config = validateLaunchConfig(typeof raw === "string" ? JSON.parse(raw) : raw);
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const children: ChildProcess[] = [];
  const entry = (service: string) => join(artifactDir, "services", `${service}.mjs`);
  const keySource = deps.keySource ?? new DstackKeySource({ socketPath: env.DSTACK_SOCKET });
  const deployPath = join(artifactDir, "deployments/mainnet.json");
  const base = (port: number) => ({ HOST: "127.0.0.1", PORT: String(port), MOCHI_DEPLOYMENT: deployPath, DATABASE_URL: requiredSecret(env, config.databaseUrlEnv) });
  const url = (kind: Exclude<keyof ProductionLaunchConfig["endpoints"], "jurors">) => config.endpoints[kind];
  const derived = new Map<string, Hex>();
  const derive = async (label: string, purpose: string) => {
    const result = await keySource.derive(`mochi/service/${label}/sign`, purpose, "mochi/dstack-kms/secp256k1/v1");
    const key = result.key;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`invalid dstack KMS key for ${label}`);
    derived.set(label, key);
    return key;
  };
  try {
    // Public read-only gates happen before KMS signing, DB writes, or service startup.
    const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
    const expectedChainId = productionChainId(config.deployment);
    if (await publicClient.getChainId() !== expectedChainId) throw new Error(`RPC chain ID must be ${expectedChainId}`);
    const token = config.deployment.contracts.mochiToken as Address;
    const code = await publicClient.getCode({ address: token });
    if (!code || code === "0x") throw new Error("external MOCHI contract code is absent");
    const decimals = await publicClient.readContract({ address: token, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
    if (decimals !== 18) throw new Error("external MOCHI must use 18 decimals");
    const escrow = config.deployment.contracts.queryEscrow as Address;
    const paused = await publicClient.readContract({ address: escrow, abi: parseAbi(["function paused() view returns (bool)"]), functionName: "paused" });
    if (config.mode !== "active" && !paused) throw new Error(`${config.mode} mode requires QueryEscrow paused`);
    if (config.mode === "active" && paused) throw new Error("active mode requires QueryEscrow unpaused after approved activation");
    const addresses = [config.deployment.contracts.queryEscrow, config.deployment.contracts.verdicts, config.deployment.contracts.jurorRegistry, config.deployment.contracts.panel, config.deployment.contracts.receiptAnchor, config.deployment.privacy?.entrypoint, config.deployment.privacy?.pool];
    for (const [i, address] of addresses.entries()) {
      nonzeroAddress(address, `deployment contract ${i}`);
      const deployedCode = await publicClient.getCode({ address });
      if (!deployedCode || deployedCode === "0x") throw new Error(`deployment contract ${i} has no code`);
    }
    if (config.mode !== "prepare") await validateActivatedDeployment(config, publicClient, config.mode === "active");
    // Validate KMS-derived enclave identities before any network service can start.
    for (const [i, spec] of PRODUCTION_IDENTITY_SPECS.entries()) {
      const identity = i === 0 ? config.identities.intake : i === 1 ? config.identities.consensus : config.identities.jurors[i - 2]!;
      const result = await keySource.derive(`mochi/${spec.role}/${spec.label}/sign`, "mochi signing key", "mochi/dstack-kms/secp256k1/v1");
      if (privateKeyToAccount(result.key).address.toLowerCase() !== identity.address.toLowerCase()) throw new Error(`dstack identity mismatch for ${spec.name}`);
    }
    const serviceKeys = {
      ATTESTOR_KEY: await derive(PRODUCTION_SERVICE_SPECS[0].label, PRODUCTION_SERVICE_SPECS[0].purpose),
      ANCHORER_KEY: await derive(PRODUCTION_SERVICE_SPECS[1].label, PRODUCTION_SERVICE_SPECS[1].purpose),
      ORCHESTRATOR_KEY: await derive(PRODUCTION_SERVICE_SPECS[2].label, PRODUCTION_SERVICE_SPECS[2].purpose),
      FEED_RUNNER_KEY: await derive(PRODUCTION_SERVICE_SPECS[3].label, PRODUCTION_SERVICE_SPECS[3].purpose),
      POSTMAN_KEY: await derive(PRODUCTION_SERVICE_SPECS[4].label, PRODUCTION_SERVICE_SPECS[4].purpose),
    };
    for (const [name, key] of Object.entries(serviceKeys)) {
      const roleName = ({ ATTESTOR_KEY: "attestor", ANCHORER_KEY: "indexer", ORCHESTRATOR_KEY: "orchestrator", FEED_RUNNER_KEY: "feedRunner", POSTMAN_KEY: "postman" } as const)[name as keyof typeof serviceKeys];
      if (privateKeyToAccount(key).address.toLowerCase() !== config.serviceRoleAddresses[roleName].toLowerCase()) throw new Error(`${name} dstack-derived address does not match reviewed service role address`);
    }
    if (privateKeyToAccount(serviceKeys.POSTMAN_KEY).address.toLowerCase() !== config.serviceRoleAddresses.postman.toLowerCase()) throw new Error("POSTMAN_KEY dstack-derived address does not match reviewed service role address");
    const receiptSeed = (await keySource.derive(PRODUCTION_RECEIPT_SIGNING_SPEC.path, PRODUCTION_RECEIPT_SIGNING_SPEC.purpose, PRODUCTION_RECEIPT_SIGNING_SPEC.info)).key;
    const receiptDerPrefix = "302e020100300506032b657004220420";
    const receiptSigningKey = Buffer.from(receiptDerPrefix + receiptSeed.slice(2), "hex").toString("base64");
    const adminToken = config.mode === "prepare" ? undefined : requiredSecret(env, config.attestorAdminTokenEnv);
    const aciKey = requiredSecret(env, config.aciApiKeyEnv);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(artifactDir, "deployments"), { recursive: true, mode: 0o700 });
    await writeFile(deployPath, JSON.stringify({ ...config.deployment, rpcUrl: config.rpcUrl }), { mode: 0o600 });
    const db = createDb(requiredSecret(env, config.databaseUrlEnv));
    try {
      const migrationDir = resolve(deps.migrationDir ?? join(artifactDir, "migrations"));
      const files = (await readdir(migrationDir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
      for (const name of files) {
        const contents = await readFile(join(migrationDir, name), "utf8");
        await db.sql.begin(async (tx) => {
          await tx`CREATE TABLE IF NOT EXISTS _mochi_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
          const [existing] = await tx<{ name: string }[]>`SELECT name FROM _mochi_migrations WHERE name = ${name}`;
          if (existing) return;
          await tx.unsafe(contents);
          await tx`INSERT INTO _mochi_migrations (name) VALUES (${name})`;
        });
      }
      for (const row of endpointRows(config)) await upsertEndpoint(db.db, row.address, row.role, row.url);
    } finally { await db.close(); }
    const dstackBase = { TEE_MODE: "dstack", TEE_KEYS: "kms", TEE_MEASUREMENT: "dstack-config-v1", QUOTE_VERIFIER: "dcap", DSTACK_SOCKET: env.DSTACK_SOCKET ?? "/var/run/dstack.sock" };
    const childhealth: Record<string, "starting" | "healthy" | "failed"> = {};
    const healthPorts: Record<string, number> = {};
    const exited = new Set<string>();
    const watchers: Array<{ stop(): void }> = [];
    let stopping = false;
    const childSpawn = deps.spawn ?? spawn;
    const launch = (id: string, service: string, port: number, childEnv: Record<string, string>, args: string[] = [], httpHealth = true) => {
      childhealth[id] = "starting";
      if (httpHealth) healthPorts[id] = port;
      const child = childSpawn(process.execPath, [entry(service), ...args], { cwd: rootDir, env: { PATH: env.PATH ?? "/usr/bin:/bin", ...childEnv }, stdio: "ignore" });
      watchers.push(watchChildLifecycle(child, id, childhealth, { httpHealth, onFatal: (service) => { exited.add(service); if (!stopping) deps.onFatal?.(service); }, log }));
      child.on("exit", () => { exited.add(id); });
      child.on("error", () => { exited.add(id); });
      children.push(child);
      log(`${id} started on loopback port ${port}`);
    };
    launch("intake", "intake", 3001, { ...base(3001), PORT: "3001", FETCH_ORIGINS: JSON.stringify(config.fetchOrigins ?? []), SEALED_STORE_DIR: "/data/mochi/sealed/intake", TEE_KEY_LABEL: "production-intake", ...dstackBase });
    launch("consensus", "consensus", 3002, { ...base(3002), PORT: "3002", SEALED_STORE_DIR: "/data/mochi/sealed/consensus", TEE_KEY_LABEL: "production-consensus", ...dstackBase });
    const classes = config.identities.jurors.map((j) => j.class!);
    const seats = [0, 0, 0, 0, 0];
    config.identities.jurors.forEach((j, i) => {
      const cls = classes[i]!; const seat = seats[cls]!++;
      const p = j.passport!;
      launch(`juror-${i}`, "juror", 3100 + i, { ...base(3100 + i), JUROR_OPERATOR: j.operator, JUROR_CLASS: String(cls), MODEL_ID: p.modelId, MODEL_LINEAGE: p.lineage, MODEL_WEIGHTS_SHA256: p.weightsSha256, MODEL_OPEN_WEIGHTS: "false", MODEL_PROVIDER: "phala-aci", ZDR: "false", RUNNER: "phala-aci", PHALA_ACI_MODEL: p.aciModel, PHALA_ACI_ALLOWED_WORKLOADS: p.workload, PHALA_AI_API_KEY: aciKey, MAX_TOKENS: String(p.maxTokens ?? 4096), SEALED_STORE_DIR: `/data/mochi/sealed/juror-${i}`, TEE_KEY_LABEL: `production-juror-class-${cls}-seat-${seat}`, ...dstackBase });
    });
    launch("gateway", "gateway", 3200, { ...base(3200), MOCHI_DEPLOYMENT: deployPath, INTAKE_URL: url("intake"), ...(config.mode === "active" ? { RELAYER_KEY: serviceKeys.ORCHESTRATOR_KEY } : {}), ...(env[config.anonHmacSecretEnv ?? ""] ? { ANONYMA_HMAC_SECRET: env[config.anonHmacSecretEnv!] } : {}) });
    if (config.mode === "enroll" || config.mode === "active") launch("attestor", "attestor", 3202, { ...base(3202), MOCHI_DEPLOYMENT: deployPath, ATTESTOR_KEY: serviceKeys.ATTESTOR_KEY, ADMIN_TOKEN: adminToken!, PORT: "3202", QUOTE_VERIFIER: "dcap" });
    if (config.mode === "active") {
      launch("indexer", "indexer", 3201, { ...base(3201), MOCHI_DEPLOYMENT: deployPath, ANCHORER_KEY: serviceKeys.ANCHORER_KEY, RECEIPT_SIGNING_KEY: receiptSigningKey, PORT: "3201" });
      launch("orchestrator", "orchestrator", 3203, { ...base(3203), MOCHI_DEPLOYMENT: deployPath, ORCHESTRATOR_KEY: serviceKeys.ORCHESTRATOR_KEY, FEED_RUNNER_KEY: serviceKeys.FEED_RUNNER_KEY, INTAKE_URL: url("intake"), CONSENSUS_URL: url("consensus"), PORT: "3203", MAX_PARALLEL_QUERIES: "1" });
      launch("postman", "postman", 0, { RPC_URL: config.rpcUrl, ASP_POSTMAN_KEY: serviceKeys.POSTMAN_KEY, MOCHI_DEPLOYMENT: deployPath }, ["--rpc", config.rpcUrl, "--deployment", deployPath], false);
    }
    const refreshHealth = async () => {
      await Promise.all(Object.entries(healthPorts).map(async ([id, port]) => {
        if (exited.has(id)) return;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
          childhealth[id] = response.ok ? "healthy" : "failed";
        } catch { childhealth[id] = "failed"; }
      }));
    };
    await refreshHealth();
    const healthTimer = setInterval(() => { if (!stopping) void refreshHealth(); }, 2000);
    for (const id of Object.keys(healthPorts)) if (childhealth[id] === "starting") childhealth[id] = "failed";
    derived.clear();
    return { status: "running", reason: `reviewed CA config and ${config.mode} read-only chain gates passed; runtime services started`, childhealth, stop: async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(healthTimer);
      for (const watcher of watchers) watcher.stop();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const waitForExit = (child: ChildProcess) => new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
        child.once("exit", () => resolveExit());
      });
      const allExited = Promise.all(children.map(waitForExit));
      await Promise.race([allExited, new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5000))]);
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await allExited;
    } };
  } catch (error) {
    for (const child of children) child.kill("SIGTERM");
    // Do not leak KMS key material through thrown values or logs.
    derived.clear();
    throw error;
  }
}
