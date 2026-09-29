import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PRODUCTION_PORTS, startProductionRuntime, validateEnrollmentReadiness, validateLaunchConfig, watchChildLifecycle } from "./runtime.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const models = [
  ["meta-llama/llama-3.3-70b-instruct", "llama"], ["meta-llama/llama-3.3-70b-instruct", "llama"],
  ["nvidia/nemotron-3.5-lightning", "nemotron"], ["nvidia/nemotron-3.5-lightning", "nemotron"],
  ["google/gemma-4-31b-it", "gemma"], ["google/gemma-4-31b-it", "gemma"],
  ["nvidia/nemotron-3.5-lightning", "nemotron"], ["google/gemma-4-31b-it", "gemma"], ["google/gemma-4-31b-it", "gemma"],
] as const;
const config = () => ({
  format: "mochi-production-runtime-v1", enabled: true, mode: "prepare",
  deployment: { chainId: 4663, tokenSource: { kind: "external" }, contracts: { mochiToken: a(1), queryEscrow: a(2), jurorRegistry: a(3), verdicts: a(4), panel: a(5), receiptAnchor: a(6) }, privacy: { entrypoint: a(7), pool: a(8) } },
  rpcUrl: "https://rpc.example", databaseUrlEnv: "MOCHI_PRODUCTION_DATABASE_URL",
  endpoints: {
    intake: `http://127.0.0.1:${PRODUCTION_PORTS.intake}`, consensus: `http://127.0.0.1:${PRODUCTION_PORTS.consensus}`,
    jurors: PRODUCTION_PORTS.jurors.map((p) => `http://127.0.0.1:${p}`), gateway: `http://127.0.0.1:${PRODUCTION_PORTS.gateway}`,
    indexer: `http://127.0.0.1:${PRODUCTION_PORTS.indexer}`, attestor: `http://127.0.0.1:${PRODUCTION_PORTS.attestor}`, orchestrator: `http://127.0.0.1:${PRODUCTION_PORTS.orchestrator}`,
  },
  identities: {
    intake: { address: a(11), operator: a(31), measurement: h(101) }, consensus: { address: a(12), operator: a(32), measurement: h(102) },
    jurors: models.map(([modelId, lineage], i) => ({ address: a(20 + i), operator: a(40 + i), measurement: h(110 + i), class: [0, 0, 1, 1, 2, 2, 3, 4, 4][i], passport: { modelId, lineage, weightsSha256: h(0), openWeights: false, provider: "phala-aci", zdr: false, aciModel: modelId, workload: `reviewed-workload-${i}`, maxTokens: 4096 } })),
  },
  serviceRoleAddresses: { attestor: a(61), indexer: a(62), orchestrator: a(63), feedRunner: a(64), postman: a(65) },
  aciApiKeyEnv: "ACI_API_KEY", attestorAdminTokenEnv: "ATTESTOR_ADMIN_TOKEN",
});

describe("production runtime config", () => {
  test("missing config remains standby without deriving keys or spawning children", async () => {
    let effects = 0;
    const status = await startProductionRuntime(undefined, {
      keySource: { derive: async () => { effects++; throw new Error("must not derive"); } },
      spawn: (() => { effects++; throw new Error("must not spawn"); }) as never,
    });
    expect(status.status).toBe("standby");
    expect(status.childhealth).toEqual({});
    expect(effects).toBe(0);
  });

  test("accepts the reviewed nine-passport class allocation", () => {
    expect(validateLaunchConfig(config()).identities.jurors).toHaveLength(9);
  });

  test("tracks non-HTTP child startup and reports unexpected exit once, while suppressing shutdown exits", () => {
    const process = new EventEmitter();
    const health: Record<string, "starting" | "healthy" | "failed"> = { postman: "starting" };
    const fatal: string[] = [];
    const watcher = watchChildLifecycle(process as any, "postman", health, { httpHealth: false, onFatal: (service) => fatal.push(service) });
    process.emit("spawn");
    expect(health.postman).toBe("healthy");
    process.emit("exit", 1, null);
    process.emit("error", new Error("suppressed detail"));
    expect(health.postman).toBe("failed");
    expect(fatal).toEqual(["postman"]);
    watcher.stop();
    const shutdownProcess = new EventEmitter();
    const shutdownHealth: Record<string, "starting" | "healthy" | "failed"> = { gateway: "starting" };
    const shutdownWatcher = watchChildLifecycle(shutdownProcess as any, "gateway", shutdownHealth, { httpHealth: true, onFatal: (service) => fatal.push(service) });
    shutdownWatcher.stop();
    shutdownProcess.emit("exit", null, "SIGTERM");
    expect(fatal).toEqual(["postman"]);
  });


  test("enroll mode accepts registered and bonded but inactive identities; active mode requires activation", async () => {
    const launch = validateLaunchConfig(config());
    const reader = {
      juror: async (address: `0x${string}`) => {
        const identity = [launch.identities.intake, launch.identities.consensus, ...launch.identities.jurors].find((row) => row.address.toLowerCase() === address.toLowerCase())!;
        return { operator: identity.operator, measurement: identity.measurement, role: identity === launch.identities.intake ? 2 : identity === launch.identities.consensus ? 3 : 1, jurorClass: identity.class ?? 0, bond: 25_000n * 10n ** 18n, delisted: false };
      },
      isActive: async () => false,
      hasRole: async () => true,
    };
    await expect(validateEnrollmentReadiness(launch, reader, false)).resolves.toBeUndefined();
    await expect(validateEnrollmentReadiness(launch, reader, true)).rejects.toThrow("not active");
    await expect(validateEnrollmentReadiness(launch, { ...reader, hasRole: async () => false }, false)).rejects.toThrow("service role is not granted");
  });

  test("requires explicit enablement, all reviewed class passports, real model identities and loopback ports", () => {
    const noEnable = config(); delete (noEnable as any).enabled;
    expect(() => validateLaunchConfig(noEnable)).toThrow("enabled=true");
    const missingSeat = config(); (missingSeat as any).identities.jurors.pop();
    expect(() => validateLaunchConfig(missingSeat)).toThrow("exactly nine");
    const stub = config(); (stub as any).identities.jurors[0].passport.modelId = "stub-model";
    expect(() => validateLaunchConfig(stub)).toThrow("reviewed Phala ACI model");
    const publicBind = config(); (publicBind as any).endpoints.intake = "http://0.0.0.0:3001";
    expect(() => validateLaunchConfig(publicBind)).toThrow("loopback");
  });

  test("accepts only mainnet or an explicit testnet rehearsal deployment", () => {
    const rehearsal = config(); Object.assign((rehearsal as any).deployment, { chainId: 46630, rehearsal: true });
    expect(validateLaunchConfig(rehearsal).deployment.chainId).toBe(46630);
    const unmarked = config(); (unmarked as any).deployment.chainId = 46630;
    expect(() => validateLaunchConfig(unmarked)).toThrow("explicit testnet rehearsal");
    const markedMainnet = config(); (markedMainnet as any).deployment.rehearsal = true;
    expect(() => validateLaunchConfig(markedMainnet)).toThrow("explicit testnet rehearsal");
    const otherChain = config(); (otherChain as any).deployment.chainId = 1;
    expect(() => validateLaunchConfig(otherChain)).toThrow();
    const localToken = config(); (localToken as any).deployment.tokenSource.kind = "test-deployment";
    expect(() => validateLaunchConfig(localToken)).toThrow("external MOCHI");
  });
});
