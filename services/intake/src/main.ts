import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment } from "@mochi/chain";
import { FileSealedStore, quoteVerifierFromEnv, teeProviderFromEnv } from "@mochi/tee";
import { createIntakeChain } from "./adapters/chain.ts";
import { createIntakeApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { NodeHttpGetter } from "./fetcher.ts";
import { IntakeEnclave } from "./intake.ts";
import { OcrPdfTextExtractor } from "./extract.ts";

const config = loadConfig();
const deployment = loadDeployment(config.deploymentPath);
const root = privateKeyToAccount(config.mockRootKey);
const tee = await teeProviderFromEnv(process.env, { seed: config.mockTeeSeed, measurement: config.mockTeeMeasurement, mockRoot: root }, { role: "intake" });
if (tee.kind === "tdx") console.info({ tee: "tdx", address: tee.signer().address, measurement: tee.measurement() });
const intake = new IntakeEnclave({
  tee, chain: createIntakeChain(deployment), store: new FileSealedStore(config.sealedStoreDir, tee),
  fetchPolicy: config.fetchPolicy, httpGetter: new NodeHttpGetter(), quoteVerifier: quoteVerifierFromEnv(process.env, { rootAddress: config.mockRootAddress }),
  chainId: deployment.chainId, escrowAddress: deployment.contracts.queryEscrow, clock: { nowSeconds: () => Math.floor(Date.now() / 1000) },
  ...(config.pdfOcrCommand ? { pdfTextExtractor: new OcrPdfTextExtractor({ command: config.pdfOcrCommand }) } : {}),
});
const { app } = createIntakeApp(intake);
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.port, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
  if (url.pathname === "/v1/attestation" && request.method === "GET") {
    const doc = await intake.attestation();
    return Response.json({ ...doc, quote: await tee.quote() });
  }
  return app.fetch(request);
} });
