import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { endpointRows, PRODUCTION_PORTS, startProductionRuntime, startupFailureReason, validateEnrollmentReadiness, validateLaunchConfig, watchChildLifecycle } from "./runtime.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const models = [
  ["qwen/qwen3.6-35b-a3b", "qwen"], ["qwen/qwen3.6-35b-a3b", "qwen"],
  ["deepseek/deepseek-v4-flash-0731", "deepseek"], ["deepseek/deepseek-v4-flash-0731", "deepseek"],
  ["google/gemma-4-31b-it", "gemma"], ["google/gemma-4-31b-it", "gemma"],
  ["moonshotai/kimi-k2.6", "kimi"], ["openai/gpt-oss-120b", "gpt-oss"], ["openai/gpt-oss-120b", "gpt-oss"],
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
    jurors: models.map(([modelId, lineage], i) => ({ address: a(20 + i), operator: a(40 + i), measurement: h(110 + i), class: [0, 0, 1, 1, 2, 2, 3, 4, 4][i], passport: { modelId, lineage, weightsSha256: h(0), openWeights: false, provider: "phala-aci", zdr: false, aciModel: modelId, workload: `os:${String(i + 1).padStart(2, "0").repeat(32)}`, maxTokens: 4096 } })),
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
    for (const workload of ["reviewed-workload-0", "os:short", `workload:x,model:${"m"}`]) {
      const unpinned = config(); (unpinned as any).identities.jurors[3].passport.workload = workload;
      expect(() => validateLaunchConfig(unpinned)).toThrow("attested os: or compose: pin");
    }
    const publicBind = config(); (publicBind as any).endpoints.intake = "http://0.0.0.0:3001";
    expect(() => validateLaunchConfig(publicBind)).toThrow("loopback");
  });

  test("the Intel TCB policy is explicit: UpToDate by default, a reviewed wider list allowed, Revoked never", () => {
    expect(validateLaunchConfig(config()).tdxAllowedTcbStatuses).toBeUndefined();
    const relaxed = config(); (relaxed as any).tdxAllowedTcbStatuses = ["UpToDate", "SWHardeningNeeded", "OutOfDate"];
    expect(validateLaunchConfig(relaxed).tdxAllowedTcbStatuses).toEqual(["UpToDate", "SWHardeningNeeded", "OutOfDate"]);
    for (const bad of [[], ["OutOfDate"], ["UpToDate", "Revoked"], ["UpToDate", "UpToDate"], ["UpToDate", "Bogus"], "UpToDate"]) {
      const c = config(); (c as any).tdxAllowedTcbStatuses = bad;
      expect(() => validateLaunchConfig(c)).toThrow("tdxAllowedTcbStatuses");
    }
  });

  test("startup failure reasons keep our message but drop credentials and key-like values", () => {
    const reason = startupFailureReason(Object.assign(new Error(`connect postgres://user:pa55word@db:5432/x key 0x${"ab".repeat(32)} token ${"Z".repeat(40)}`), { code: "ECONNREFUSED" }));
    expect(reason.startsWith("Error [ECONNREFUSED]: connect <url-credentials>@db:5432/x key <hex> token <redacted>")).toBe(true);
    expect(reason).not.toContain("pa55word");
    expect(startupFailureReason(new Error("x".repeat(500))).length).toBeLessThanOrEqual(230);
    expect(startupFailureReason(undefined)).toBe("Error: ");
  });

  test("registers every enclave endpoint with a lowercase address the database accepts", () => {
    const launch = validateLaunchConfig(config());
    (launch.identities.intake as any).address = "0x300746866b918D9dD1f4De4a12Eed2b13Be57701";
    const rows = endpointRows(launch);
    expect(rows).toHaveLength(11);
    expect(rows.every((row) => /^0x[0-9a-f]{40}$/.test(row.address))).toBe(true);
    expect(rows[0]).toMatchObject({ address: "0x300746866b918d9dd1f4de4a12eed2b13be57701", role: 2, url: launch.endpoints.intake });
    expect(rows[1]!.role).toBe(3);
    expect(rows.slice(2).map((row) => row.role)).toEqual(Array(9).fill(1));
    expect(rows.slice(2).map((row) => row.url)).toEqual(launch.endpoints.jurors);
  });

  test("the reviewed class models satisfy the attestor's dissenter lineage rules", () => {
    const launch = validateLaunchConfig(config());
    const lineageOf = (cls: number) => launch.identities.jurors.filter((j) => j.class === cls).map((j) => j.passport!.lineage.toLowerCase());
    for (const lineage of lineageOf(4)) {
      expect(["llama", "qwen"]).not.toContain(lineage); // services/attestor DISSENTER_EXCLUDED_LINEAGES default
      expect(lineageOf(0)).not.toContain(lineage); // dissenter_lineage_not_distinct
    }
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


test("zero-bond readiness requires exact team approval; legacy deployments still require their bond", async () => {
  const launch = validateLaunchConfig(config());
  launch.deployment.minJurorBond = "0";
  const identities = [launch.identities.intake, launch.identities.consensus, ...launch.identities.jurors];
  const reader = {
    juror: async (address: `0x${string}`) => { const j = identities.find(j => j.address === address)!; return { operator: j.operator, measurement: j.measurement, role: j === launch.identities.intake ? 2 : j === launch.identities.consensus ? 3 : 1, jurorClass: j.class ?? 0, bond: 0n, delisted: false }; },
    isActive: async () => true, hasRole: async () => true,
    unbondedOperator: async (address: `0x${string}`) => identities.find(j => j.address === address)!.operator,
  };
  await expect(validateEnrollmentReadiness(launch, reader, true)).resolves.toBeUndefined();
  await expect(validateEnrollmentReadiness(launch, { ...reader, unbondedOperator: undefined }, false)).rejects.toThrow("team juror approval missing");
  await expect(validateEnrollmentReadiness(launch, { ...reader, unbondedOperator: async () => a(0) }, false)).rejects.toThrow("team juror approval missing");
  delete launch.deployment.minJurorBond;
  await expect(validateEnrollmentReadiness(launch, reader, false)).rejects.toThrow("bond below configured minimum");
});

test("active restart allows only expired attestations, with content-free recovery logging", async () => {
  const launch = validateLaunchConfig(config());
  launch.deployment.minJurorBond = "0";
  const identities = [launch.identities.intake, launch.identities.consensus, ...launch.identities.jurors];
  const juror = async (address: `0x${string}`) => {
    const j = identities.find(j => j.address === address)!;
    return { operator: j.operator, measurement: j.measurement, role: j === launch.identities.intake ? 2 : j === launch.identities.consensus ? 3 : 1,
      jurorClass: j.class ?? 0, bond: 0n, delisted: false, exitRequestedAt: 0n, attestedUntil: 999n };
  };
  const reader = { juror, isActive: async () => false, hasRole: async () => true,
    unbondedOperator: async (address: `0x${string}`) => identities.find(j => j.address === address)!.operator,
    latestTimestamp: async () => 1000n, minimumBond: async () => 0n, measurementAllowed: async () => true };
  const logs: string[] = [];
  await expect(validateEnrollmentReadiness(launch, reader, true, (message) => logs.push(message))).resolves.toBeUndefined();
  expect(logs).toEqual(Array(11).fill("attestation expired; attestor will refresh"));
  for (const change of [
    { operator: a(0) }, { operator: a(999) }, { measurement: h(99) }, { role: 0 }, { jurorClass: 99 },
    { delisted: true }, { exitRequestedAt: 1n }, { exitRequestedAt: undefined }, { attestedUntil: 1000n }, { attestedUntil: 1001n }, { attestedUntil: undefined },
  ]) {
    await expect(validateEnrollmentReadiness(launch, { ...reader, juror: async (address) => ({ ...await juror(address), ...change }) }, true)).rejects.toThrow();
  }
  await expect(validateEnrollmentReadiness(launch, { ...reader, measurementAllowed: async () => false }, true)).rejects.toThrow("not active");
  await expect(validateEnrollmentReadiness(launch, { ...reader, measurementAllowed: undefined }, true)).rejects.toThrow("not active");
  await expect(validateEnrollmentReadiness(launch, { ...reader, latestTimestamp: undefined }, true)).rejects.toThrow("not active");
  await expect(validateEnrollmentReadiness(launch, { ...reader, minimumBond: undefined }, true)).rejects.toThrow("not active");
  await expect(validateEnrollmentReadiness(launch, { ...reader, latestTimestamp: async () => { throw new Error("RPC read failed"); } }, true)).rejects.toThrow("RPC read failed");
  await expect(validateEnrollmentReadiness(launch, { ...reader, unbondedOperator: async () => a(0) }, true)).rejects.toThrow("approval missing");
  await expect(validateEnrollmentReadiness(launch, { ...reader, hasRole: async () => false }, true)).rejects.toThrow("service role");
  launch.deployment.minJurorBond = "100";
  const bonded = { ...reader, minimumBond: async () => 100n, juror: async (address: `0x${string}`) => ({ ...await juror(address), bond: 100n }) };
  await expect(validateEnrollmentReadiness(launch, bonded, true)).resolves.toBeUndefined();
  await expect(validateEnrollmentReadiness(launch, { ...bonded, juror: async (address) => ({ ...await juror(address), bond: 99n }) }, true)).rejects.toThrow("bond below");
  await expect(validateEnrollmentReadiness(launch, { ...bonded, minimumBond: async () => 101n }, true)).rejects.toThrow("bond below");
});
