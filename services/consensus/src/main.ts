import { createChain, loadDeployment } from "@mochi/chain";
import { FileSealedStore, teeProviderFromEnv, quoteVerifierFromEnv } from "@mochi/tee";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.ts";
import { consensusChain } from "./adapters/chain.ts";
import { createConsensusApp } from "./app.ts";
import { ConsensusEnclave } from "./rounds.ts";

const config = loadConfig();
const deployment = loadDeployment(config.MOCHI_DEPLOYMENT);
const chain = createChain(deployment);
const root = privateKeyToAccount(config.TEE_MOCK_ROOT_PRIVATE_KEY as `0x${string}`);
const tee = await teeProviderFromEnv(process.env, { seed: config.TEE_MOCK_SEED as `0x${string}`, measurement: config.TEE_MOCK_MEASUREMENT as `0x${string}`, mockRoot: root }, { role: "consensus" });
if (tee.kind === "tdx") console.info({ tee: "tdx", address: tee.signer().address, measurement: tee.measurement() });
const enclave = new ConsensusEnclave({ tee, chain: consensusChain(chain), store: new FileSealedStore(config.SEALED_STORE_DIR, tee), quoteVerifier: quoteVerifierFromEnv(process.env, { rootAddress: root.address }), chainId: deployment.chainId, verdictsAddress: deployment.contracts.verdicts, clock: { now: Date.now }, roundTimeoutMs: config.ROUND_TIMEOUT_MS });
const { app } = createConsensusApp(enclave);
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
  if (url.pathname === "/v1/attestation" && request.method === "GET") {
    const doc = await enclave.attestation();
    return Response.json({ ...doc, quote: await tee.quote() });
  }
  return app.fetch(request);
} });
