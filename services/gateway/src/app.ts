import { Hono, type Context } from "hono";
import { z } from "zod";
import { encodeFunctionData, keccak256, stringToHex, zeroHash, type Address, type Hex } from "viem";
import { QueryEscrowAbi } from "@mochi/chain";
import { SchemaId, toBytes32String } from "@mochi/core";
import { DisclosureReqSchema, IntakeReqSchema, IntakeResultSchema, address, hex, hex32, recipientKeyHash } from "@mochi/protocol";
import { decodePayload, getSchema } from "@mochi/schemas";
import type { GatewayDeps, PreparedQuery } from "./ports.ts";
import { verifyAnonyma } from "./hmac.ts";
import { log } from "./log.ts";
import { trpcFetchHandler } from "./trpc.ts";
import { createMcpHandler } from "./mcp.ts";

const QuerySchema = z.object({
  intake: IntakeResultSchema,
  n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  isPublic: z.boolean(),
  allowPanelDisclosure: z.boolean().optional().default(false),
  refundTo: address,
  nonce: z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= (1n << 64n) - 1n),
  sender: address,
  payerResultPubKey: hex32.optional(),
  pay: z.discriminatedUnion("path", [
    z.object({ path: z.literal("usdg") }),
    z.object({ path: z.literal("shielded"), nullifier: hex32, proof: hex }),
  ]),
});
const RelayOpenSchema = QuerySchema.omit({ pay: true }).extend({ nullifier: hex32, proof: hex });
const RelayExpandSchema = z.object({ queryId: hex32, newN: z.union([z.literal(5), z.literal(7), z.literal(9)]), nullifier: hex32, proof: hex });
const JurorCountSchema = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]);
const VoucherSchema = z.object({
  voucherId: hex32, docCommit: hex32, schemaId: z.number().int().positive(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  maxAmount: z.string().regex(/^\d+$/), tier: z.number().int().nonnegative(), expiry: z.string().regex(/^\d+$/),
});
const AnonymaSchema = z.object({
  envelope: IntakeReqSchema.shape.envelope, schemaId: z.number().int().positive(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  voucher: VoucherSchema, voucherSig: hex, refundTo: address, payerResultPubKey: hex32.optional(), isPublic: z.boolean(),
});
const jsonError = (code: string, message: string, status: number) => ({ error: { code, message }, status });
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, val) => typeof val === "bigint" ? val.toString() : val));
const voucherNonce = (voucherId: string) => BigInt(voucherId) & ((1n << 64n) - 1n);
const StatsDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid ISO date");

function statsWindow(deps: GatewayDeps, fromRaw?: string, toRaw?: string) {
  const now = new Date(deps.clock.nowSeconds() * 1000);
  const to = toRaw ? new Date(StatsDateSchema.parse(toRaw)) : now;
  const from = fromRaw ? new Date(StatsDateSchema.parse(fromRaw)) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (from >= to) throw new Error("INVALID_STATS_WINDOW");
  return { from, to };
}

export function prepareQuery(deps: GatewayDeps, input: z.infer<typeof QuerySchema>): Promise<PreparedQuery> {
  const parsed = QuerySchema.parse(input);
  if (!parsed.isPublic && !parsed.payerResultPubKey) throw new Error("PRIVATE_KEY_REQUIRED");
  const prov = parsed.intake.provenance;
  return Promise.all([
    deps.chain.computeQueryId(parsed.sender as Address, parsed.intake.docCommit as Hex, BigInt(parsed.nonce)),
    deps.chain.quote(parsed.intake.schemaId, parsed.n, parsed.intake.tokensK),
  ]).then(async ([queryId, quote]) => {
    const payerCommit = parsed.isPublic ? zeroHash : (await import("@mochi/protocol")).payerCommit(parsed.payerResultPubKey! as Hex);
    if (!parsed.isPublic) await deps.store.putPayerResultKey(payerCommit, parsed.payerResultPubKey!);
    const { params, provenance } = deriveOpenArgs(parsed, payerCommit as Hex);
    const fn = parsed.pay.path === "usdg" ? "openWithUSDG" : "openShielded";
    const args = parsed.pay.path === "usdg"
      ? [params, provenance, parsed.intake.intakeSig]
      : [params, provenance, parsed.intake.intakeSig, parsed.pay.nullifier, parsed.pay.proof];
    const data = encodeFunctionData({ abi: QueryEscrowAbi, functionName: fn, args } as never);
    return { queryId, to: deps.chain.escrow, data, quote: { jurorFees: quote.jurorFees.toString(), protocolFee: quote.protocolFee.toString() } };
  });
}

function deriveOpenArgs(input: Pick<z.infer<typeof QuerySchema>, "intake" | "n" | "isPublic" | "allowPanelDisclosure" | "refundTo" | "nonce">, payerCommit: Hex) {
  const prov = input.intake.provenance;
  const params: { schemaId: number; n: number; isPublic: boolean; allowPanelDisclosure: boolean; paramsHash: Hex; payerCommit: Hex; refundTo: Address; nonce: bigint } = {
    schemaId: input.intake.schemaId, n: input.n, isPublic: input.isPublic,
    allowPanelDisclosure: input.allowPanelDisclosure ?? false, paramsHash: input.intake.paramsHash as Hex,
    payerCommit, refundTo: input.refundTo as Address, nonce: BigInt(input.nonce),
  };
  return {
    params,
    provenance: {
      docCommit: prov.docCommit, kind: prov.kind, originId: prov.originId,
      fetchedAt: BigInt(prov.fetchedAt), tokensK: prov.tokensK, transcriptHash: prov.transcriptHash,
    },
  };
}

function clientIp(c: Context) {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export function createGatewayApp(deps: GatewayDeps) {
  const app = new Hono();
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const relayRate = deps.relayRateLimit ?? { capacity: 20, refillPerSecond: 0.5 };
  const relayBodyLimit = deps.relayBodyLimitBytes ?? 1_048_576;
  const takeRelayToken = (ip: string) => {
    const now = deps.clock.nowSeconds();
    const bucket = buckets.get(ip) ?? { tokens: relayRate.capacity, updated: now };
    bucket.tokens = Math.min(relayRate.capacity, bucket.tokens + Math.max(0, now - bucket.updated) * relayRate.refillPerSecond);
    bucket.updated = now;
    if (bucket.tokens < 1) { buckets.set(ip, bucket); return false; }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    return true;
  };
  const readRelayJson = async (c: any) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > relayBodyLimit) return { error: c.json({ error: { code: "BODY_TOO_LARGE", message: "Relay request is too large" } }, 413) };
    const reader = c.req.raw.body?.getReader();
    if (!reader) return { error: c.json({ error: { code: "BAD_REQUEST", message: "Request body is required" } }, 400) };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > relayBodyLimit) {
        await reader.cancel();
        return { error: c.json({ error: { code: "BODY_TOO_LARGE", message: "Relay request is too large" } }, 413) };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(body);
    try { return { body: JSON.parse(raw) as unknown }; }
    catch { return { error: c.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400) }; }
  };
  const mcp = createMcpHandler(deps);
  app.all("/trpc/*", (c) => trpcFetchHandler(deps, c.req.raw));
  app.post("/mcp", (c) => mcp(c.req.raw));
  app.onError((err, c) => {
    if (err instanceof z.ZodError || err instanceof SyntaxError) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid request" } }, 400);
    if (err.message === "PRIVATE_KEY_REQUIRED") return c.json({ error: { code: "PRIVATE_KEY_REQUIRED", message: "Private queries require payerResultPubKey" } }, 400);
    if (err.message === "INVALID_STATS_WINDOW") return c.json({ error: { code: "BAD_REQUEST", message: "from must be earlier than to" } }, 400);
    // Log the error message only (never request bodies: they can carry envelopes, vouchers or keys).
    log("error", "gateway_internal_error", { path: new URL(c.req.url).pathname, message: String(err.message).slice(0, 300) });
    return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/v1/relayer", (c) => deps.relayer ? c.json({ address: deps.relayer.sender.toLowerCase() }) : c.json({ error: { code: "UNAVAILABLE", message: "Shielded relay is not configured" } }, 503));
  app.get("/v1/intake/attestation", async (c) => c.json(await deps.intake.attestation()));
  for (const endpoint of ["upload", "url"] as const) app.post(`/v1/intake/${endpoint}`, async (c) => {
    const body = IntakeReqSchema.parse(await c.req.json());
    const intake = IntakeResultSchema.parse(await deps.intake.request(`/v1/intake/${endpoint}`, body));
    const nRaw = c.req.query("n");
    const response = nRaw === undefined ? intake : { ...intake, quote: toJson(await deps.chain.quote(intake.schemaId, JurorCountSchema.parse(Number(nRaw)), intake.tokensK)) };
    return c.json(response);
  });
  app.post("/v1/query", async (c) => {
    const body = QuerySchema.parse(await c.req.json());
    return c.json(await prepareQuery(deps, body));
  });

  app.post("/v1/relay/open-shielded", async (c) => {
    if (!deps.relayer || !deps.chain.simulateOpenShielded || !deps.chain.relayOpenShielded) return c.json({ error: { code: "UNAVAILABLE", message: "Shielded relay is not configured" } }, 503);
    if (!takeRelayToken(clientIp(c))) return c.json({ error: { code: "RATE_LIMITED", message: "Relay rate limit exceeded" } }, 429);
    const received = await readRelayJson(c); if (received.error) return received.error;
    const body = RelayOpenSchema.parse(received.body);
    if (body.sender.toLowerCase() !== deps.relayer.sender.toLowerCase()) return c.json({ error: { code: "SENDER_MISMATCH", message: "sender must match the configured relayer" } }, 400);
    if (!body.isPublic && !body.payerResultPubKey) return c.json({ error: { code: "PRIVATE_KEY_REQUIRED", message: "Private queries require payerResultPubKey" } }, 400);
    const queryId = await deps.chain.computeQueryId(deps.relayer.sender, body.intake.docCommit as Hex, BigInt(body.nonce));
    const payerCommit = body.isPublic ? zeroHash : (await import("@mochi/protocol")).payerCommit(body.payerResultPubKey! as Hex);
    const { params, provenance } = deriveOpenArgs(body, payerCommit as Hex);
    if (!body.isPublic) await deps.store.putPayerResultKey(payerCommit, body.payerResultPubKey!);
    try {
      await deps.chain.simulateOpenShielded(params, provenance, body.intake.intakeSig as Hex, body.nullifier as Hex, body.proof as Hex);
    } catch (error) {
      const reason = String((error as any)?.shortMessage ?? (error as Error)?.message ?? "simulation failed").slice(0, 240);
      return c.json({ error: { code: "SIMULATION_FAILED", message: reason } }, 400);
    }
    const txHash = await deps.chain.relayOpenShielded(params, provenance, body.intake.intakeSig as Hex, body.nullifier as Hex, body.proof as Hex);
    return c.json({ queryId, txHash });
  });

  app.post("/v1/relay/expand-shielded", async (c) => {
    if (!deps.relayer || !deps.chain.simulateExpandShielded || !deps.chain.relayExpandShielded) return c.json({ error: { code: "UNAVAILABLE", message: "Shielded relay is not configured" } }, 503);
    if (!takeRelayToken(clientIp(c))) return c.json({ error: { code: "RATE_LIMITED", message: "Relay rate limit exceeded" } }, 429);
    const received = await readRelayJson(c); if (received.error) return received.error;
    const body = RelayExpandSchema.parse(received.body);
    try { await deps.chain.simulateExpandShielded(body.queryId as Hex, body.newN, body.nullifier as Hex, body.proof as Hex); }
    catch (error) {
      const reason = String((error as any)?.shortMessage ?? (error as Error)?.message ?? "simulation failed").slice(0, 240);
      return c.json({ error: { code: "SIMULATION_FAILED", message: reason } }, 400);
    }
    const txHash = await deps.chain.relayExpandShielded(body.queryId as Hex, body.newN, body.nullifier as Hex, body.proof as Hex);
    return c.json({ queryId: body.queryId, txHash });
  });

  app.post("/v1/anonyma/send-to-jury", async (c) => {
    if (!deps.anonymaSecret || !deps.relayer) return c.json({ error: { code: "UNAVAILABLE", message: "Partner relay is not configured" } }, 503);
    const raw = await c.req.text();
    const timestamp = c.req.header("X-Mochi-Timestamp") ?? "";
    const signature = c.req.header("X-Mochi-Signature") ?? "";
    if (!verifyAnonyma(deps.anonymaSecret, timestamp, raw, signature, deps.clock.nowSeconds())) return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid partner authentication" } }, 401);
    const body = AnonymaSchema.parse(JSON.parse(raw));
    if (!body.isPublic && !body.payerResultPubKey) return c.json({ error: { code: "PRIVATE_KEY_REQUIRED", message: "Private queries require payerResultPubKey" } }, 400);
    if (body.voucher.schemaId !== body.schemaId || body.voucher.n !== body.n) return c.json({ error: { code: "BAD_REQUEST", message: "Voucher does not match query" } }, 400);
    const intake = IntakeResultSchema.parse(await deps.intake.request("/v1/intake/upload", { envelope: body.envelope }));
    if (intake.docCommit !== body.voucher.docCommit || intake.schemaId !== body.schemaId) return c.json({ error: { code: "BAD_REQUEST", message: "Voucher does not match intake result" } }, 400);
    const nonce = voucherNonce(body.voucher.voucherId);
    const queryId = await deps.chain.computeQueryId(deps.relayer.sender, intake.docCommit as Hex, nonce);
    const p = {
      schemaId: intake.schemaId, n: body.n, isPublic: body.isPublic, allowPanelDisclosure: false,
      paramsHash: intake.paramsHash, payerCommit: body.payerResultPubKey ? (await import("@mochi/protocol")).payerCommit(body.payerResultPubKey as Hex) : zeroHash,
      refundTo: body.refundTo, nonce,
    };
    const prov = { ...intake.provenance, fetchedAt: BigInt(intake.provenance.fetchedAt) };
    // The consensus enclave only releases a private result to the key committed in payerCommit; the orchestrator
    // looks it up by the on-chain payerCommit, so it must be stored before the query is opened.
    if (!body.isPublic) await deps.store.putPayerResultKey(p.payerCommit, body.payerResultPubKey!);
    const quoted = await deps.chain.quote(intake.schemaId, body.n, intake.tokensK);
    const txHash = await deps.relayer.openWithVoucher(p, prov, intake.intakeSig as Hex, { ...body.voucher, maxAmount: BigInt(body.voucher.maxAmount), expiry: BigInt(body.voucher.expiry) }, body.voucherSig as Hex);
    await deps.store.insertAnonymaVoucher({ voucherId: body.voucher.voucherId, queryId, tier: body.voucher.tier, usdgAmount: String(quoted.jurorFees + quoted.protocolFee), settled: false });
    return c.json({ queryId, txHash });
  });

  app.get("/v1/verdict/:verdictId", async (c) => {
    const id = hex32.parse(c.req.param("verdictId")) as Hex;
    const row = await deps.store.getVerdict(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Verdict not found" } }, 404);
    const verdict: any = row.verdict ?? row;
    const chainRecord: any = await deps.chain.getVerdict(id);
    const queryId = verdict.queryId ?? chainRecord?.queryId;
    let jurors: Array<{ seat: number; juror: string; class: number; passport: unknown | null }> = [];
    if (queryId) {
      const keys = await deps.chain.jurorsOf(queryId as Hex);
      const [registryJurors, passportRows] = await Promise.all([
        Promise.all(keys.map((juror) => deps.chain.getJuror(juror))),
        deps.store.getJurorPassports(keys),
      ]);
      const passports = new Map(passportRows.map((passport) => [passport.key.toLowerCase(), passport.passport]));
      jurors = keys.map((juror, seat) => ({ seat, juror: juror.toLowerCase(), class: registryJurors[seat]!.jurorClass, passport: passports.get(juror.toLowerCase()) ?? null }));
    }
    if (!verdict.isPublic) {
      const privateRow = await deps.store.getPrivateResult(id);
      const bytes = privateRow?.ciphertext;
      const ciphertext = bytes instanceof Uint8Array ? `0x${Buffer.from(bytes).toString("hex")}` : typeof bytes === "string" ? bytes : "0x";
      // The indexer can record the on-chain verdict before the orchestrator stores its encrypted result.
      // Match the public-result readiness contract so polling clients keep waiting instead of decrypting empty bytes.
      if (ciphertext === "0x" || ciphertext === "") return c.json({ error: { code: "NOT_FOUND", message: "Private verdict content not found" } }, 404);
      // The on-chain record is already public and carries only salted hashes/masks — lets clients verify a
      // decrypted or disclosed result against answerHash without trusting this server.
      return c.json(toJson({ status: verdict.status, agreementBps: verdict.agreementBps, masks: { dissent: String(verdict.dissentMask ?? "0"), timeout: String(verdict.timeoutMask ?? "0") }, ciphertext, jurors, chain: chainRecord }));
    }
    const pub = row.publicPart;
    if (!pub) return c.json({ error: { code: "NOT_FOUND", message: "Public verdict content not found" } }, 404);
    let answer: unknown = pub.answer;
    if (typeof answer === "string") { try { answer = JSON.parse(answer); } catch { /* preserve string */ } }
    let decoded: unknown;
    const schemaId = Number(verdict.schemaId ?? chainRecord?.schemaId);
    const payload = (pub.payload instanceof Uint8Array ? `0x${Buffer.from(pub.payload).toString("hex")}` : pub.payload) as Hex;
    if (payload && payload !== "0x" && schemaId) decoded = decodePayload(schemaId as SchemaId, payload);
    // toJson: the chain record and decoded payload carry bigints (ts, E8 values).
    return c.json(toJson({ status: verdict.status, agreementBps: verdict.agreementBps, answer, decodedPayload: decoded, dissent: pub.dissent, fieldAgreement: pub.fieldAgreement, chain: chainRecord, jurors }));
  });
  app.get("/v1/queries/:queryId", async (c) => {
    const id = hex32.parse(c.req.param("queryId")) as Hex;
    return c.json(toJson({ query: await deps.chain.getQuery(id), latestVerdictId: await deps.chain.latestVerdictOf(id) }));
  });
  app.get("/v1/feeds/:feedId/:key", async (c) => {
    const rawFeed = c.req.param("feedId");
    const feedId = (rawFeed.startsWith("0x") ? hex32.parse(rawFeed) : keccak256(stringToHex(rawFeed))) as Hex;
    const rawKey = c.req.param("key");
    // Feed keys are payload subject keys: tickers/symbols are left-aligned ASCII bytes32 (toBytes32String), not hashes.
    const key = (rawKey.startsWith("0x") ? hex32.parse(rawKey) : toBytes32String(rawKey.toUpperCase())) as Hex;
    const entry = await deps.chain.feedLatest(feedId, key);
    // The feed's schema comes from the Feeds contract, not from the feed's name.
    const schemaId = deps.chain.feedSchemaId ? await deps.chain.feedSchemaId(feedId) : undefined;
    const decodable = schemaId !== undefined && schemaId > 0 && entry.payload !== "0x";
    return c.json(toJson({ feedId, key, schemaId, ...entry, decodedPayload: decodable ? decodePayload(schemaId as SchemaId, entry.payload) : undefined }));
  });
  app.get("/v1/disagreement", async (c) => {
    const schema = z.coerce.number().int().positive().parse(c.req.query("schema"));
    const field = z.string().min(1).parse(c.req.query("field"));
    const window = z.string().min(1).default("1d").parse(c.req.query("window") ?? "1d");
    return c.json(toJson(await deps.store.disagreementSeries(schema, field, window)));
  });
  app.get("/v1/disagreement/models", async (c) => {
    const schema = z.coerce.number().int().positive().parse(c.req.query("schema"));
    const field = z.string().min(1).parse(c.req.query("field"));
    const window = z.string().min(1).default("1d").parse(c.req.query("window") ?? "1d");
    return c.json(toJson(await deps.store.modelDisagreementSeries(schema, field, window)));
  });
  app.get("/v1/stats", async (c) => {
    const { from, to } = statsWindow(deps, c.req.query("from"), c.req.query("to"));
    const [paidVerdicts, activeFeedSubscribers] = await Promise.all([
      deps.store.paidVerdictCounts(from, to, deps.internalPayers ?? []),
      deps.store.activeFeedSubscribers(new Date(deps.clock.nowSeconds() * 1000)),
    ]);
    const durationWeeks = (to.getTime() - from.getTime()) / (7 * 24 * 60 * 60 * 1000);
    return c.json({
      window: { from: from.toISOString(), to: to.toISOString() },
      paidVerdicts,
      activeFeedSubscribers,
      killCriteria: {
        day14: { metric: "external paid verdicts / week", threshold: 5000, met: paidVerdicts.external / durationWeeks >= 5000 },
        day30: { metric: "external feed subscriber contracts", threshold: 10, met: activeFeedSubscribers >= 10 },
      },
    });
  });
  app.post("/v1/disclosures", async (c) => {
    const body = DisclosureReqSchema.parse(await c.req.json());
    const row = await deps.store.getVerdict(body.verdictId);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Verdict not found" } }, 404);
    const verdict: any = row.verdict ?? row;
    if (verdict.isPublic) return c.json({ error: { code: "PUBLIC_VERDICT", message: "Public verdicts do not need a disclosure" } }, 400);
    const keyHash = recipientKeyHash(body.recipientPubKey as Hex);
    if (!await deps.store.insertDisclosure(body.verdictId, keyHash, new TextEncoder().encode(JSON.stringify(body.envelope)))) {
      return c.json({ error: { code: "DISCLOSURE_LIMIT", message: "Disclosure limit reached" } }, 409);
    }
    return c.json({ recipientKeyHash: keyHash });
  });
  app.get("/v1/disclosures/:verdictId/:recipientKeyHash", async (c) => {
    const verdictId = hex32.parse(c.req.param("verdictId"));
    const keyHash = hex32.parse(c.req.param("recipientKeyHash"));
    const disclosure = await deps.store.getDisclosure(verdictId, keyHash);
    if (!disclosure) return c.json({ error: { code: "NOT_FOUND", message: "Disclosure not found" } }, 404);
    return c.json({ envelope: JSON.parse(new TextDecoder().decode(disclosure.envelope)) });
  });
  return { app };
}
