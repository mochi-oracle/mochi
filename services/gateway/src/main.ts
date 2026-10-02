import { createDb } from "@mochi/db";
import { createChain, DisclosureRegistryAbi, FeedsAbi, loadDeployment, QueryEscrowAbi } from "@mochi/chain";
import { seal } from "@mochi/tee";
import { aad } from "@mochi/protocol";
import { type Hex } from "viem";
import { createGatewayApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { GatewayDeps } from "./ports.ts";
import { createIntakeClient } from "./adapters/intake.ts";
import { createGatewayStore } from "./adapters/store.ts";

const config = loadConfig();
const deployment = loadDeployment(config.MOCHI_DEPLOYMENT);
const db = createDb(config.DATABASE_URL);
const chain = createChain(deployment);
const relayerChain = config.RELAYER_KEY ? createChain(deployment, { privateKey: config.RELAYER_KEY as Hex }) : undefined;
const deps: GatewayDeps = {
  intake: createIntakeClient(config.INTAKE_URL, config.HTTP_TIMEOUT_MS),
  chain: {
    chainId: deployment.chainId,
    escrow: deployment.contracts.queryEscrow,
    isActive: (key, role) => chain.isActive(key, role),
    ...(relayerChain?.account ? { relayer: relayerChain.account.address } : {}),
    quote: (schemaId, n, tokensK) => chain.quote(schemaId, n, tokensK),
    computeQueryId: (sender, docCommit, nonce) => chain.computeQueryId(sender, docCommit, nonce),
    getQuery: (queryId) => chain.getQuery(queryId),
    latestVerdictOf: (queryId) => chain.latestVerdictOf(queryId),
    getVerdict: (id) => chain.getVerdict(id),
    jurorsOf: (queryId) => chain.jurorsOf(queryId),
    getJuror: async (juror) => ({ jurorClass: (await chain.getJuror(juror)).jurorClass }),
    feedLatest: (feedId, key) => chain.feedLatest(feedId, key),
    feedSchemaId: async (feedId) => Number((await chain.publicClient.readContract({
      address: deployment.contracts.feeds, abi: FeedsAbi, functionName: "getFeed", args: [feedId],
    }) as { schemaId: number }).schemaId),
    ...(deployment.contracts.disclosureRegistry ? {
      disclosedEnvelopeHash: async (verdictId: Hex, recipientKeyHash: Hex, discloser: Hex) => (await chain.publicClient.readContract({
        address: deployment.contracts.disclosureRegistry!, abi: DisclosureRegistryAbi, functionName: "disclosureOf", args: [verdictId, recipientKeyHash, discloser],
      }) as { envelopeHash: Hex }).envelopeHash,
    } : {}),
    openWithVoucher: async (params, provenance, sig, voucher, voucherSig) => {
      if (!relayerChain?.walletClient || !relayerChain.account) throw new Error("Relayer key is not configured");
      const { request } = await relayerChain.publicClient.simulateContract({ account: relayerChain.account, address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "openWithVoucher", args: [params, provenance, sig, voucher, voucherSig] as never });
      const hash = await relayerChain.walletClient.writeContract(request);
      const receipt = await relayerChain.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Voucher transaction reverted");
      return hash;
    },
    simulateOpenShielded: async (params, provenance, sig, nullifier, proof) => {
      if (!relayerChain?.publicClient || !relayerChain.account) throw new Error("Relayer key is not configured");
      await relayerChain.publicClient.simulateContract({ account: relayerChain.account, address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "openShielded", args: [params, provenance, sig, nullifier, proof] as never });
    },
    relayOpenShielded: async (params, provenance, sig, nullifier, proof) => {
      if (!relayerChain?.publicClient || !relayerChain.walletClient || !relayerChain.account) throw new Error("Relayer key is not configured");
      const { request } = await relayerChain.publicClient.simulateContract({ account: relayerChain.account, address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "openShielded", args: [params, provenance, sig, nullifier, proof] as never });
      const hash = await relayerChain.walletClient.writeContract(request);
      const receipt = await relayerChain.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Shielded transaction reverted");
      return hash;
    },
    simulateExpandShielded: async (queryId, newN, nullifier, proof) => {
      if (!relayerChain?.publicClient || !relayerChain.account) throw new Error("Relayer key is not configured");
      await relayerChain.publicClient.simulateContract({ account: relayerChain.account, address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "expandShielded", args: [queryId, newN, nullifier, proof] });
    },
    relayExpandShielded: async (queryId, newN, nullifier, proof) => {
      if (!relayerChain?.publicClient || !relayerChain.walletClient || !relayerChain.account) throw new Error("Relayer key is not configured");
      const { request } = await relayerChain.publicClient.simulateContract({ account: relayerChain.account, address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "expandShielded", args: [queryId, newN, nullifier, proof] });
      const hash = await relayerChain.walletClient.writeContract(request);
      const receipt = await relayerChain.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Shielded expansion reverted");
      return hash;
    },
  },
  store: createGatewayStore(db.db),
  ...(relayerChain?.account ? { relayer: { sender: relayerChain.account.address, openWithVoucher: (p, prov, sig, voucher, voucherSig) => deps.chain.openWithVoucher(p, prov, sig, voucher, voucherSig) } } : {}),
  clock: { nowSeconds: () => Math.floor(Date.now() / 1000) },
  ...(config.ANONYMA_HMAC_SECRET ? { anonymaSecret: config.ANONYMA_HMAC_SECRET } : {}),
  mcpVoucherMode: config.MCP_VOUCHER_MODE === "true",
  relayRateLimit: { capacity: config.RELAY_RATE_LIMIT_CAPACITY, refillPerSecond: config.RELAY_RATE_LIMIT_REFILL_PER_SECOND },
  relayBodyLimitBytes: config.RELAY_BODY_LIMIT_BYTES,
  internalPayers: config.INTERNAL_PAYERS.split(",").map((payer) => payer.trim().toLowerCase()).filter(Boolean),
  sealForIntake: async (attestation, plaintext) => {
    const key = (attestation as { encryptionPubKey: Hex }).encryptionPubKey;
    return seal(key, new TextEncoder().encode(JSON.stringify(plaintext)), aad.intake());
  },
};
const { app } = createGatewayApp(deps);
Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: config.PORT, fetch: (request, server) => new URL(request.url).pathname === "/health" && request.method === "GET" ? Response.json({ ok: true }) : app.fetch(request, { peer: server.requestIP(request)?.address }) });
