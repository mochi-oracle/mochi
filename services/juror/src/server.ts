import { enrollmentProof } from "./enrollment.ts";
import { privateKeyToAccount } from "viem/accounts";
import { createJurorApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createJurorChain } from "./adapters/chain.ts";
import { FetchHttpPoster } from "./adapters/http.ts";
import { JurorEnclave } from "./juror.ts";
import { OpenAICompatibleRunner, PhalaAciRunner, StubRunner } from "./runner.ts";
import { emitTimingEvent } from "@mochi/protocol";
import { warmupModel } from "./warmup.ts";
import { AciClient } from "@mochi/aci";
import { quoteVerifierFromEnv, teeProviderFromEnv, tdxPolicyFromEnv, FileSealedStore } from "@mochi/tee";
import { createPhalaDcap } from "./phala-dcap.ts";
import { loadDeployment } from "@mochi/chain";
import { hashWeightsDirectory } from "./weights.ts";

/** Starts one juror seat from an environment map. A process may host several seats, each with its own enclave key
 * label, port, sealed store and model configuration. */
export async function startJurorServer(env: Record<string, string | undefined>): Promise<{ port: number; stop(): void }> {
  const config = loadConfig(env);
  const deployment = loadDeployment(config.MOCHI_DEPLOYMENT);
  const root = privateKeyToAccount(config.TEE_MOCK_ROOT_PRIVATE_KEY as `0x${string}`);
  const tee = await teeProviderFromEnv(env, {
    seed: config.TEE_MOCK_SEED as `0x${string}`,
    measurement: config.TEE_MOCK_MEASUREMENT as `0x${string}`,
    mockRoot: root,
  }, { role: "juror" });
  if (tee.kind === "tdx") console.info({ tee: "tdx", address: tee.signer().address, measurement: tee.measurement() });
  // One Intel TCB policy (TDX_ALLOWED_TCB_STATUSES, default UpToDate) for MOCHI quotes and the ACI gateway's quote.
  const tdxPolicy = tdxPolicyFromEnv(env);
  const aci = config.MODEL_PROVIDER === "phala-aci" ? new AciClient({
    // The seat's environment locates the shared, persisted PCS collateral cache beside its sealed store.
    baseUrl: config.PHALA_ACI_BASE_URL, apiKey: config.PHALA_AI_API_KEY!, dcap: createPhalaDcap({ env }),
    allowedWorkloads: config.PHALA_ACI_ALLOWED_WORKLOADS?.split(",").map(value => value.trim()).filter(Boolean),
  }) : undefined;
  const warmupController = new AbortController();
  const runner = config.MODEL_PROVIDER === "phala-aci"
    ? new PhalaAciRunner({
        client: aci!,
        model: config.PHALA_ACI_MODEL!,
        timeoutMs: config.MODEL_TIMEOUT_MS,
        maxAttempts: config.MODEL_MAX_ATTEMPTS,
        attemptCapMs: config.MODEL_ATTEMPT_CAP_MS,
        allowedTcbStatuses: tdxPolicy.allowedStatuses,
      })
    : config.RUNNER === "openai"
    ? new OpenAICompatibleRunner({
        baseUrl: config.MODEL_BASE_URL,
        model: config.MODEL_ID,
        apiKey: config.MODEL_API_KEY,
        timeoutMs: config.MODEL_TIMEOUT_MS,
      })
    : new StubRunner((input) => {
        const schema = input.jsonSchema as { properties?: { fields?: { properties?: Record<string, unknown> } } };
        const fieldNames = Object.keys(schema.properties?.fields?.properties ?? {});
        return { fields: Object.fromEntries(fieldNames.map((name) => [name, null])), evidence: {}, confidence: {} };
      });
  const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const weightsSha256 = config.MODEL_WEIGHTS_SHA256?.toLowerCase() as `0x${string}` | undefined
    ?? (config.MODEL_WEIGHTS_DIR ? await hashWeightsDirectory(config.MODEL_WEIGHTS_DIR) : `0x${"00".repeat(32)}`);
  const juror = new JurorEnclave({
    tee,
    jurorClass: config.JUROR_CLASS,
    passport: {
      modelId: config.MODEL_ID,
      lineage: config.MODEL_LINEAGE,
      weightsSha256,
      openWeights: config.MODEL_OPEN_WEIGHTS,
      provider: config.MODEL_PROVIDER,
      zdr: config.ZDR,
    },
    maxTokens: config.MAX_TOKENS,
    deliveryReserveMs: config.DELIVERY_RESERVE_MS,
    answerTimeoutMs: config.MODEL_TIMEOUT_MS,
    telemetry: emitTimingEvent,
    runner,
    chain: createJurorChain(config.MOCHI_DEPLOYMENT),
    store: new FileSealedStore(config.SEALED_STORE_DIR, tee),
    quoteVerifier: quoteVerifierFromEnv(env, { rootAddress: root.address }),
    http: new FetchHttpPoster(),
    chainId: deployment.chainId,
    verdictsAddress: deployment.contracts.verdicts,
    clock,
  });

  const { app } = createJurorApp(juror, config.JUROR_OPERATOR ? () => enrollmentProof(
    tee, deployment.chainId, deployment.contracts.jurorRegistry, config.JUROR_OPERATOR as `0x${string}`, config.JUROR_CLASS,
  ) : undefined);
  if (aci) await warmupModel(aci, config.PHALA_ACI_MODEL!, warmupController.signal, emitTimingEvent, { allowedTcbStatuses: tdxPolicy.allowedStatuses });
  const server = Bun.serve({ idleTimeout: 130, hostname: env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request) });
  return { port: config.PORT, stop: () => { warmupController.abort(); server.stop(true); } };
}
