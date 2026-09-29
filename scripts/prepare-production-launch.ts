import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { quoteVerifierFromEnv, type Env } from "@mochi/tee";
import { isAddress, bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { verifyAciReport, type AciReport, type DcapResult } from "@mochi/aci";
import { phalaDcap } from "../services/juror/src/phala-dcap.ts";
import { PRODUCTION_IDENTITY_SPECS, PRODUCTION_SERVICE_SPECS, PRODUCTION_RECEIPT_SIGNING_SPEC } from "../deploy/phala/production-identities/identities.ts";
import { PRODUCTION_PORTS, type ProductionLaunchConfig } from "../deploy/production/runtime.ts";
import { verifyProductionIdentityReport, type ProductionIdentitySummary } from "./verify-production-identities.ts";
import { deploymentMinJurorBond, productionChainId, productionTimelockDelay } from "../deploy/production/chain-policy.ts";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const CLASS_COUNTS = [2, 2, 2, 1, 2] as const;
const MODEL_IDS = [
  "qwen/qwen3.6-35b-a3b", "qwen/qwen3.6-35b-a3b",
  "deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731",
  "google/gemma-4-31b-it", "google/gemma-4-31b-it", "moonshotai/kimi-k2.6",
  "openai/gpt-oss-120b", "openai/gpt-oss-120b",
] as const;
const LINEAGES = ["qwen", "qwen", "deepseek", "deepseek", "gemma", "gemma", "kimi", "gpt-oss", "gpt-oss"] as const;
const DEFAULT_ACI_BASE_URL = "https://inference.phala.com/v1";

type Deployment = Record<string, any>;
type Verified = Awaited<ReturnType<typeof verifyProductionIdentityReport>>;

export const PRODUCTION_LAUNCH_FILES = {
  runtime: "production-runtime.json",
  identities: "production-identities.json",
  releaseInput: "production-release-input.json",
  website: "website-config.json",
} as const;

export type PreparedProductionLaunch = {
  runtime: ProductionLaunchConfig;
  identities: {
    salt: Hex;
    intake: { address: Address; operator: Address; measurement: Hex };
    consensus: { address: Address; operator: Address; measurement: Hex };
    jurors: Array<{ address: Address; operator: Address; measurement: Hex; class: number }>;
    attestor: Address; feedRunner: Address; orchestrator: Address; indexer: Address; postman: Address;
  };
  releaseInput: Record<string, unknown>;
  website: Record<string, unknown>;
  salt: Hex;
};

/** Public, no-auth, no-inference ACI report discovery. The workload is accepted only after nonce/DCAP checks. */
export async function discoverPhalaAciWorkload(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  dcap?: (quote: Uint8Array) => Promise<DcapResult> | DcapResult;
} = {}): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_ACI_BASE_URL;
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("ACI base URL must be a clean HTTPS URL");
  const nonce = randomBytes(32).toString("hex");
  const url = `${base.toString().replace(/\/$/, "")}/aci/attestation?nonce=${nonce}`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.redirected) throw new Error(`unauthenticated ACI report request returned HTTP ${response.status}`);
  const report = await readBoundedJson(response, 1_048_576) as AciReport;
  if (!report || typeof report !== "object") throw new Error("ACI report is missing");
  const established = await verifyAciReport(report, {
    nonce,
    dcap: options.dcap ?? phalaDcap,
    ...(options.now ? { now: options.now() } : {}),
  });
  if (typeof established.workloadId !== "string" || !established.workloadId.trim()
    || (report.workload_id !== undefined && established.workloadId !== report.workload_id)
    || established.tcbStatus !== "UpToDate") throw new Error("ACI workload report is not fresh and up to date");
  return established.workloadId;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("ACI report response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("ACI report exceeds the size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new Error("ACI report returned invalid JSON"); }
}

/** Pure preparation: no file writes, networking, wallet access, or transaction submission. */
export function prepareProductionLaunch(options: {
  verified: Verified;
  deployment: Deployment;
  operator: string;
  workloads: Record<string, string>;
  deploymentPath: string;
  outputDirectory: string;
  now?: () => number;
  randomSalt?: () => Hex;
}): PreparedProductionLaunch {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const verifiedAt = options.verified?.summary?.locallyVerifiedAt;
  const currentTime = now();
  if (!Number.isSafeInteger(verifiedAt) || currentTime - verifiedAt > 300 || verifiedAt > currentTime + 30) {
    throw new Error("verified identity report is stale; run the local DCAP verifier again");
  }
  if (options.verified.summary.expectedMeasurement === ZERO32) throw new Error("verified measurement pin must be nonzero");
  if (options.verified.summary.identities.length !== PRODUCTION_IDENTITY_SPECS.length
    || options.verified.summary.identities.some((identity) => !identity.verified || identity.measurement.toLowerCase() !== options.verified.summary.expectedMeasurement.toLowerCase())) {
    throw new Error("fresh locally verified identity evidence is required");
  }
  const { report, summary } = options.verified;
  if (!report || report.ready !== true || report.identities.length !== PRODUCTION_IDENTITY_SPECS.length
    || report.serviceSigners.length !== PRODUCTION_SERVICE_SPECS.length
    || report.receiptSigner.name !== PRODUCTION_RECEIPT_SIGNING_SPEC.name
    || report.receiptSigner.publicKey.toLowerCase() !== summary.receiptSigner.publicKey.toLowerCase()) {
    throw new Error("verified identity report is incomplete");
  }
  const operator = requireAddress(options.operator, "--operator");
  const deployment = validateDeployment(options.deployment);
  const identityRows = report.identities;
  for (let index = 0; index < PRODUCTION_IDENTITY_SPECS.length; index += 1) {
    const spec = PRODUCTION_IDENTITY_SPECS[index]!;
    const row = identityRows[index]!;
    const local = summary.identities[index]!;
    if (row.name !== spec.name || row.role !== spec.role || row.label !== spec.label
      || row.address.toLowerCase() !== local.address.toLowerCase()
      || row.encryptionPublicKey.toLowerCase() !== local.encryptionPublicKey.toLowerCase()
      || row.measurement.toLowerCase() !== local.measurement.toLowerCase()) {
      throw new Error(`verified identity report does not match the production roster at ${spec.name}`);
    }
  }
  const jurors = report.identities.filter((identity) => identity.role === "juror").map((identity) => ({
    address: identity.address, operator, measurement: identity.measurement, class: identity.jurorClass!,
  }));
  for (const [jurorClass, count] of CLASS_COUNTS.entries()) {
    if (jurors.filter((juror) => juror.class === jurorClass).length !== count) throw new Error(`verified report must contain class counts ${CLASS_COUNTS.join("/")}`);
  }
  const services = new Map(report.serviceSigners.map((signer) => [signer.name, requireAddress(signer.address, `service signer ${signer.name}`)]));
  for (const spec of PRODUCTION_SERVICE_SPECS) {
    if (report.serviceSigners.find((signer) => signer.name === spec.name)?.label !== spec.label || !services.has(spec.name)) {
      throw new Error(`verified report is missing service signer ${spec.name}`);
    }
  }
  const receiptPublicKey = requireBytes32(report.receiptSigner.publicKey, "receipt signer public key");
  if (receiptPublicKey === ZERO32) throw new Error("receipt signer public key must be nonzero");
  const intake = report.identities.find((identity) => identity.role === "intake")!;
  const consensus = report.identities.find((identity) => identity.role === "consensus")!;
  const salt = options.randomSalt?.() ?? `0x${randomBytes(32).toString("hex")}` as Hex;
  requireBytes32(salt, "generated batch salt");

  const identityInput: PreparedProductionLaunch["identities"] = {
    salt,
    intake: { address: intake.address, operator, measurement: intake.measurement },
    consensus: { address: consensus.address, operator, measurement: consensus.measurement },
    jurors,
    attestor: services.get("attestor")!,
    feedRunner: services.get("feed-runner")!,
    orchestrator: services.get("orchestrator")!,
    indexer: services.get("indexer")!,
    postman: services.get("postman")!,
  };
  const outDir = resolve(options.outputDirectory);
  const deploymentPath = resolve(options.deploymentPath);
  const identitiesPath = join(outDir, PRODUCTION_LAUNCH_FILES.identities);
  const runtime: ProductionLaunchConfig = {
    format: "mochi-production-runtime-v1",
    enabled: true,
    mode: "prepare",
    deployment,
    rpcUrl: deployment.rpcUrl,
    databaseUrlEnv: "MOCHI_PRODUCTION_DATABASE_URL",
    endpoints: {
      intake: `http://127.0.0.1:${PRODUCTION_PORTS.intake}`,
      consensus: `http://127.0.0.1:${PRODUCTION_PORTS.consensus}`,
      jurors: PRODUCTION_PORTS.jurors.map((port) => `http://127.0.0.1:${port}`),
      gateway: `http://127.0.0.1:${PRODUCTION_PORTS.gateway}`,
      indexer: `http://127.0.0.1:${PRODUCTION_PORTS.indexer}`,
      attestor: `http://127.0.0.1:${PRODUCTION_PORTS.attestor}`,
      orchestrator: `http://127.0.0.1:${PRODUCTION_PORTS.orchestrator}`,
    },
    identities: {
      intake: identityInput.intake,
      consensus: identityInput.consensus,
      jurors: identityInput.jurors.map((juror, index) => ({
        ...juror,
        passport: {
          modelId: MODEL_IDS[index]!, lineage: LINEAGES[index]!, weightsSha256: ZERO32,
          openWeights: false, provider: "phala-aci", zdr: false, aciModel: MODEL_IDS[index]!,
          workload: requireWorkload(options.workloads, PRODUCTION_IDENTITY_SPECS.filter((identity) => identity.role === "juror")[index]!.name), maxTokens: 4096,
        },
      })),
    },
    serviceRoleAddresses: {
      attestor: identityInput.attestor, indexer: identityInput.indexer, orchestrator: identityInput.orchestrator,
      feedRunner: identityInput.feedRunner, postman: identityInput.postman,
    },
    aciApiKeyEnv: "PHALA_API_KEY",
    attestorAdminTokenEnv: "MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN",
  };
  const roles = {
    owner: deployment.owner,
    guardian: deployment.guardian,
    tokenRecipient: validOptionalAddress(deployment.mochiRecipient),
    feeTreasury: validOptionalAddress(deployment.feeTreasury),
    attestor: identityInput.attestor,
    feedRunner: identityInput.feedRunner,
    orchestrator: identityInput.orchestrator,
    indexer: identityInput.indexer,
    postman: identityInput.postman,
  };
  const releaseInput = {
    chainId: deployment.chainId,
    rpcUrl: deployment.rpcUrl,
    mochiToken: deployment.contracts.mochiToken,
    usdg: deployment.contracts.usdg,
    roles,
    timelockDelaySeconds: productionTimelockDelay(deployment),
    jurorCount: 9,
    jurorClassCounts: [...CLASS_COUNTS],
    minimumJurorBondMochi: Number(deploymentMinJurorBond(deployment) / 10n ** 18n),
    bondBelowSpecApproved: deploymentMinJurorBond(deployment) < 25_000n * 10n ** 18n,
    initialFeedBudgetUsdg: null,
    deploymentFile: deploymentPath,
    identitiesFile: identitiesPath,
    salt,
  };
  const website = {
    enabled: false,
    chainId: deployment.chainId,
    contracts: {
      queryEscrow: deployment.contracts.queryEscrow,
      jurorRegistry: deployment.contracts.jurorRegistry,
      verdicts: deployment.contracts.verdicts,
      usdg: deployment.contracts.usdg,
      receiptAnchor: deployment.contracts.receiptAnchor,
    },
    intakeAddress: intake.address,
    intakeMeasurement: intake.measurement,
    receiptPublicKey,
    jurySizes: [3, 5, 7, 9],
  };
  return { runtime, identities: identityInput, releaseInput, website, salt };
}

function validateDeployment(value: Deployment): Deployment {
  if (!value) throw new Error("deployment must be chain 4663 with external MOCHI CA");
  productionChainId(value);
  const rpc = new URL(value.rpcUrl);
  if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.search || rpc.hash) throw new Error("deployment rpcUrl must be a public HTTPS URL");
  requireAddress(value.owner, "deployment.owner");
  requireAddress(value.guardian, "deployment.guardian");
  if (value.owner.toLowerCase() === value.guardian.toLowerCase()) throw new Error("deployment owner and guardian must be distinct");
  const required = ["mochiToken", "usdg", "queryEscrow", "jurorRegistry", "verdicts", "receiptAnchor", "panel", "timelock"];
  for (const name of required) requireAddress(value.contracts?.[name], `deployment.contracts.${name}`);
  requireAddress(value.privacy?.entrypoint, "deployment.privacy.entrypoint");
  return {
    chainId: value.chainId,
    rpcUrl: value.rpcUrl,
    startBlock: value.startBlock,
    contracts: { ...value.contracts },
    privacy: { ...value.privacy },
    randomness: value.randomness ? { ...value.randomness } : undefined,
    tokenSource: { kind: "external", ...(value.tokenSource.decimals === 18 ? { decimals: 18 } : {}) },
    owner: value.owner,
    guardian: value.guardian,
    timelock: value.timelock,
    paused: value.paused,
    roles: value.roles,
    mochiRecipient: validOptionalAddress(value.mochiRecipient),
    feeTreasury: validOptionalAddress(value.feeTreasury),
    // Launch parameters recorded by deploy-local; the rehearsal flag keeps a 46630 deployment usable by the runtime.
    ...(value.rehearsal === true ? { rehearsal: true } : {}),
    ...(value.timelockDelay !== undefined ? { timelockDelay: String(value.timelockDelay) } : {}),
    ...(value.minJurorBond !== undefined ? { minJurorBond: deploymentMinJurorBond(value).toString() } : {}),
  };
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error(`${field} must be a real nonzero address`);
  return value as Address;
}
function validOptionalAddress(value: unknown): Address | null {
  if (value == null || value === "") return null;
  return requireAddress(value, "optional deployment address");
}
function requireBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${field} must be bytes32 hex`);
  return value as Hex;
}
function requireWorkload(workloads: Record<string, string>, name: string): string {
  const workload = workloads?.[name];
  if (typeof workload !== "string" || !workload.trim() || workload.length > 256) {
    throw new Error(`a reviewed Phala ACI workload ID is required for ${name}`);
  }
  return workload.trim();
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" }); }
  finally { await file.close(); }
}

export async function writeProductionLaunch(outputDirectory: string, prepared: PreparedProductionLaunch): Promise<Record<string, string>> {
  const outDir = resolve(outputDirectory);
  await mkdir(outDir, { mode: 0o700 });
  const paths = Object.fromEntries(Object.entries(PRODUCTION_LAUNCH_FILES).map(([key, name]) => [key, join(outDir, name)]));
  await writeJsonExclusive(paths.runtime!, prepared.runtime);
  await writeJsonExclusive(paths.identities!, prepared.identities);
  await writeJsonExclusive(paths.releaseInput!, prepared.releaseInput);
  await writeJsonExclusive(paths.website!, prepared.website);
  return paths;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!["--report", "--deployment", "--operator", "--measurement", "--workloads", "--aci-base-url", "--out-dir"].includes(arg) || values.has(arg)) throw new Error("usage: bun scripts/prepare-production-launch.ts --report verified-report.json --deployment deployments/mainnet.json --operator 0x... --measurement 0x<64 hex> [--workloads juror-workloads.json | --aci-base-url https://inference.phala.com/v1] --out-dir <new-directory>");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  }
  for (const arg of ["--report", "--deployment", "--operator", "--measurement", "--out-dir"]) if (!values.has(arg)) throw new Error(`missing required argument ${arg}`);
  if (values.has("--workloads") && values.has("--aci-base-url")) throw new Error("choose one of --workloads and --aci-base-url");
  return {
    reportPath: values.get("--report")!, deploymentPath: values.get("--deployment")!, operator: values.get("--operator")!,
    measurement: values.get("--measurement") as Hex,
    ...(values.has("--workloads") ? { workloadsPath: values.get("--workloads")! } : {}),
    ...(values.has("--aci-base-url") ? { aciBaseUrl: values.get("--aci-base-url")! } : {}),
    outputDirectory: values.get("--out-dir")!,
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const env: Env = { ...process.env, QUOTE_VERIFIER: "dcap" };
    const verifier = quoteVerifierFromEnv(env);
    const rawReport = JSON.parse(await readFile(resolve(args.reportPath), "utf8")) as unknown;
    const checked = await verifyProductionIdentityReport(rawReport, { expectedMeasurement: args.measurement, quoteVerifier: verifier });
    const deployment = JSON.parse(await readFile(resolve(args.deploymentPath), "utf8")) as Deployment;
    const workloadId = args.workloadsPath
      ? undefined
      : await discoverPhalaAciWorkload({ ...(args.aciBaseUrl ? { baseUrl: args.aciBaseUrl } : {}) });
    const workloads = args.workloadsPath
      ? JSON.parse(await readFile(resolve(args.workloadsPath), "utf8")) as Record<string, string>
      : Object.fromEntries(PRODUCTION_IDENTITY_SPECS.filter((identity) => identity.role === "juror").map((identity) => [identity.name, workloadId!]));
    const prepared = prepareProductionLaunch({
      verified: checked, deployment, operator: args.operator, workloads, deploymentPath: args.deploymentPath, outputDirectory: args.outputDirectory,
    });
    const paths = await writeProductionLaunch(args.outputDirectory, prepared);
    process.stdout.write(`${JSON.stringify({ status: "prepared", salt: prepared.salt, files: paths })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "preparation failed"}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
