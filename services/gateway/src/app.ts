import { IntakeHttpError } from "./adapters/intake.ts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { QueryEscrowAbi } from "@mochi/chain";
import { Role, SchemaId, canonicalBytes, toBytes32String } from "@mochi/core";
import { DisclosureReqSchema, IntakeReqSchema, IntakeResultSchema, address, hex, hex32, payerCommit, provenanceFromJson, recipientKeyHash, type ProvenanceJson } from "@mochi/protocol";
import { decodePayload, getSchema } from "@mochi/schemas";
import { recoverProvenance } from "@mochi/tee";
import type { GatewayDeps, PreparedQuery } from "./ports.ts";
import { verifyAnonyma } from "./hmac.ts";
import { log } from "./log.ts";
import { trpcFetchHandler } from "./trpc.ts";
import { createMcpHandler } from "./mcp.ts";
import { TRUSTED_CLIENT_HEADER, forwardedClient, isLoopback, validTrustedClient } from "../../claims/src/client-address.ts";

/**
 * Visibility, consent, payerCommit, opener and nonce are not request fields: they are in the intake-signed provenance
 * (sealed by the document owner with the document), and the escrow takes them from there.
 */
const QuerySchema = z.object({
  intake: IntakeResultSchema,
  n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  refundTo: address,
  /** Private queries: the result key whose payerCommit the grant signs; stored for the orchestrator. */
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
  voucherId: hex32, queryId: hex32, schemaId: z.number().int().positive(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  maxAmount: z.string().regex(/^\d+$/), tier: z.number().int().nonnegative(), expiry: z.string().regex(/^\d+$/),
});
const AnonymaSchema = z.object({
  envelope: IntakeReqSchema.shape.envelope, schemaId: z.number().int().positive(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  voucher: VoucherSchema, voucherSig: hex, refundTo: address, payerResultPubKey: hex32.optional(), isPublic: z.boolean(),
});
const jsonError = (code: string, message: string, status: number) => ({ error: { code, message }, status });
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, val) => typeof val === "bigint" ? val.toString() : val));
/** Errors thrown by prepareQuery / open helpers, mapped to 400 responses. */
const OPEN_ERRORS: Record<string, string> = {
  PRIVATE_KEY_REQUIRED: "Private queries require payerResultPubKey",
  PAYER_KEY_MISMATCH: "payerResultPubKey does not match the payer commitment in the intake grant",
  PROVENANCE_EXPIRED: "The intake grant has expired; upload again",
  INCONSISTENT_INTAKE: "Intake result fields do not match its signed provenance",
  BAD_INTAKE_SIGNATURE: "The intake grant is not signed by an active intake key",
};
/** Thrown by the shared /v1/query admission (REST and tRPC) when a caller or the payer-key budget is exhausted. */
export class QueryRateLimited extends Error {
  constructor(message: string) { super(message); this.name = "QueryRateLimited"; }
}
const StatsDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid ISO date");

function statsWindow(deps: GatewayDeps, fromRaw?: string, toRaw?: string) {
  const now = new Date(deps.clock.nowSeconds() * 1000);
  const to = toRaw ? new Date(StatsDateSchema.parse(toRaw)) : now;
  const from = fromRaw ? new Date(StatsDateSchema.parse(fromRaw)) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (from >= to) throw new Error("INVALID_STATS_WINDOW");
  return { from, to };
}

/**
 * Checks an intake result before it is used to open: its top-level fields agree with the signed grant, the grant has
 * not expired, its EIP-712 signature (QueryEscrow domain) recovers to the named intake and that key is an active INTAKE
 * on chain, as `open*` itself requires, and, for a private query, `payerResultPubKey` is the key the grant commits to
 * (stored for the orchestrator, which looks it up by the on-chain payerCommit). Nothing is stored for a grant that fails.
 */
async function checkGrant(deps: GatewayDeps, intake: z.infer<typeof IntakeResultSchema>, payerResultPubKey?: string, beforePayerKeyWrite?: (prov: ProvenanceJson) => void): Promise<ProvenanceJson> {
  const prov = intake.provenance;
  if (intake.docCommit !== prov.docCommit || intake.paramsHash !== prov.paramsHash || intake.schemaId !== prov.schemaId || intake.tokensK !== prov.tokensK) throw new Error("INCONSISTENT_INTAKE");
  if (BigInt(prov.expiry) < BigInt(deps.clock.nowSeconds())) throw new Error("PROVENANCE_EXPIRED");
  const signer = await recoverProvenance(deps.chain.chainId, deps.chain.escrow, provenanceFromJson(prov), intake.intakeSig as Hex).catch(() => undefined);
  if (!signer || signer.toLowerCase() !== intake.intake || !(await deps.chain.isActive(signer, Role.INTAKE))) throw new Error("BAD_INTAKE_SIGNATURE");
  if (!prov.isPublic) {
    if (!payerResultPubKey) throw new Error("PRIVATE_KEY_REQUIRED");
    if (payerCommit(payerResultPubKey as Hex) !== prov.payerCommit) throw new Error("PAYER_KEY_MISMATCH");
    beforePayerKeyWrite?.(prov);
    await deps.store.putPayerResultKey(prov.payerCommit, payerResultPubKey);
  }
  return prov;
}

const openArgs = (input: { n: number; refundTo: string }, prov: ProvenanceJson) =>
  ({ params: { n: input.n, refundTo: input.refundTo as Address }, provenance: provenanceFromJson(prov) });

/** `beforePayerKeyWrite` runs once the grant has passed every check, just before a private query's key row is stored. */
export async function prepareQuery(deps: GatewayDeps, input: z.input<typeof QuerySchema>, beforePayerKeyWrite?: (prov: ProvenanceJson) => void): Promise<PreparedQuery> {
  const parsed = QuerySchema.parse(input);
  const prov = await checkGrant(deps, parsed.intake, parsed.payerResultPubKey, beforePayerKeyWrite);
  const [queryId, quote] = await Promise.all([
    deps.chain.computeQueryId(prov.opener as Address, prov.docCommit as Hex, BigInt(prov.nonce)),
    deps.chain.quote(prov.schemaId, parsed.n, prov.tokensK),
  ]);
  const { params, provenance } = openArgs(parsed, prov);
  const fn = parsed.pay.path === "usdg" ? "openWithUSDG" : "openShielded";
  const args = parsed.pay.path === "usdg"
    ? [params, provenance, parsed.intake.intakeSig]
    : [params, provenance, parsed.intake.intakeSig, parsed.pay.nullifier, parsed.pay.proof];
  const data = encodeFunctionData({ abi: QueryEscrowAbi, functionName: fn, args } as never);
  return { queryId, to: deps.chain.escrow, data, quote: { jurorFees: quote.jurorFees.toString(), protocolFee: quote.protocolFee.toString() } };
}

/**
 * Per-caller rate-limit key. In the CVM only the public proxy reaches the gateway, over loopback, and it names the
 * caller in X-Mochi-Client (a website visitor, or the address it keys on); that header counts only from a loopback
 * peer. Otherwise the key is the transport peer (passed by main.ts as `peer` in the Hono env), IPv6 grouped by /64.
 * X-Forwarded-For and other caller-settable headers are not trusted here.
 */
function clientIp(c: Context) {
  const raw = (c.env as { peer?: unknown } | undefined)?.peer;
  const peer = typeof raw === "string" ? raw : undefined;
  const proxied = c.req.header(TRUSTED_CLIENT_HEADER);
  if (isLoopback(peer) && validTrustedClient(proxied)) return `proxy:${proxied}`;
  return forwardedClient(c.req.raw, peer);
}

type Rate = { capacity: number; refillPerSecond: number };
type Bucket = { tokens: number; updated: number };
const MAX_BUCKETS = 10_000;
/** Token bucket keyed by caller; the map is bounded so spoofed keys cannot grow memory without limit. */
function tokenBuckets(rate: Rate, nowSeconds: () => number) {
  const buckets = new Map<string, Bucket>();
  return (key: string) => {
    const now = nowSeconds();
    const refill = (bucket: Bucket) => Math.min(rate.capacity, bucket.tokens + Math.max(0, now - bucket.updated) * rate.refillPerSecond);
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
      for (const [stale, bucket] of buckets) if (refill(bucket) >= rate.capacity) buckets.delete(stale);
      for (const oldest of buckets.keys()) { if (buckets.size < MAX_BUCKETS) break; buckets.delete(oldest); }
    }
    const bucket = buckets.get(key) ?? { tokens: rate.capacity, updated: now };
    bucket.tokens = refill(bucket);
    bucket.updated = now;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}
/** Public /v1/query: per-caller calls, and a global budget for the payer-key rows that private queries write. */
const DEFAULT_QUERY_RATE: Rate = { capacity: 60, refillPerSecond: 1 };
const DEFAULT_PAYER_KEY_WRITE_RATE: Rate = { capacity: 500, refillPerSecond: 1 / 3 };
const DEFAULT_PAYER_KEY_GRANT_RATE: Rate = { capacity: 3, refillPerSecond: 1 / 600 };
const QUERY_BODY_LIMIT_BYTES = 65_536;
/**
 * Public POST /v1/disclosures. Every distinct envelope is stored (no first-come slot per recipient, no recipient cap per
 * verdict, either of which anyone could fill with junk first), so writes are bounded per caller and globally instead:
 * a caller over budget gets a 429 and can retry, but can never block someone else's disclosure for good.
 */
const DEFAULT_DISCLOSURE_RATE: Rate = { capacity: 10, refillPerSecond: 1 / 60 };
const DEFAULT_DISCLOSURE_WRITE_RATE: Rate = { capacity: 200, refillPerSecond: 1 / 10 };
const DISCLOSURE_BODY_LIMIT_BYTES = 65_536;

export function createGatewayApp(deps: GatewayDeps) {
  const app = new Hono();
  const relayRate = deps.relayRateLimit ?? { capacity: 20, refillPerSecond: 0.5 };
  const relayBodyLimit = deps.relayBodyLimitBytes ?? 1_048_576;
  const takeRelayToken = tokenBuckets(relayRate, () => deps.clock.nowSeconds());
  const takeQueryToken = tokenBuckets(deps.queryRateLimit ?? DEFAULT_QUERY_RATE, () => deps.clock.nowSeconds());
  const takePayerKeyWrite = tokenBuckets(deps.payerKeyWriteLimit ?? DEFAULT_PAYER_KEY_WRITE_RATE, () => deps.clock.nowSeconds());
  const takeGrantPayerKeyWrite = tokenBuckets(deps.payerKeyGrantLimit ?? DEFAULT_PAYER_KEY_GRANT_RATE, () => deps.clock.nowSeconds());
  /**
   * Shared by /v1/query and tRPC prepareQuery (after the caller's own query token). A private query stores one
   * payer-key row before it is opened on-chain; its token is taken only once the grant has passed checkGrant (intake
   * signature, active intake key, expiry, payer commitment), first from that payerCommit's share, then from the global
   * budget, so neither junk bodies nor replays of one valid grant can exhaust it.
   */
  const admitQuery = async (raw: unknown): Promise<PreparedQuery> => prepareQuery(deps, QuerySchema.parse(raw), (prov) => {
    if (!takeGrantPayerKeyWrite(prov.payerCommit) || !takePayerKeyWrite("global")) throw new QueryRateLimited("Private query preparation is busy; try again shortly");
  });
  const takeDisclosureToken = tokenBuckets(deps.disclosureRateLimit ?? DEFAULT_DISCLOSURE_RATE, () => deps.clock.nowSeconds());
  const takeDisclosureWrite = tokenBuckets(deps.disclosureWriteLimit ?? DEFAULT_DISCLOSURE_WRITE_RATE, () => deps.clock.nowSeconds());
  const readLimitedBody = async (c: any, limit: number): Promise<{ raw: string; error?: undefined } | { error: Response }> => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > limit) return { error: c.json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } }, 413) };
    const reader = c.req.raw.body?.getReader();
    if (!reader) return { error: c.json({ error: { code: "BAD_REQUEST", message: "Request body is required" } }, 400) };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { error: c.json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } }, 413) };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { raw: new TextDecoder().decode(body) };
  };
  const readRelayJson = async (c: any, limit = relayBodyLimit): Promise<{ body: unknown; error?: undefined } | { error: Response }> => {
    const read = await readLimitedBody(c, limit);
    if (read.error) return read;
    try { return { body: JSON.parse(read.raw) as unknown }; }
    catch { return { error: c.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400) }; }
  };
  const mcp = createMcpHandler(deps);
  // tRPC prepareQuery is the same public write as /v1/query: same body cap, per-caller budget and payer-key budget.
  app.all("/trpc/*", async (c) => {
    let req = c.req.raw;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const read = await readLimitedBody(c, QUERY_BODY_LIMIT_BYTES);
      if (read.error) return read.error;
      req = new Request(req.url, { method: req.method, headers: req.headers, body: read.raw });
    }
    const caller = clientIp(c);
    return trpcFetchHandler(deps, req, {
      prepareQuery: async (raw) => {
        if (!takeQueryToken(caller)) throw new QueryRateLimited("Query rate limit exceeded");
        return admitQuery(raw);
      },
    });
  });
  app.post("/mcp", (c) => mcp(c.req.raw));
  app.onError((err, c) => {
    if (err instanceof z.ZodError || err instanceof SyntaxError) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid request" } }, 400);
    if (OPEN_ERRORS[err.message]) return c.json({ error: { code: err.message, message: OPEN_ERRORS[err.message] } }, 400);
    if (err instanceof QueryRateLimited) return c.json({ error: { code: "RATE_LIMITED", message: err.message } }, 429);
    if (err instanceof IntakeHttpError && err.publicError) {
      const { code, message, status, retryAfter } = err.publicError;
      return c.json({ error: { code, message } }, status as 400, retryAfter ? { "retry-after": String(retryAfter) } : undefined);
    }
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
    if (!takeQueryToken(clientIp(c))) return c.json({ error: { code: "RATE_LIMITED", message: "Query rate limit exceeded" } }, 429);
    const received = await readRelayJson(c, QUERY_BODY_LIMIT_BYTES); if (received.error) return received.error;
    return c.json(await admitQuery(received.body));
  });

  app.post("/v1/relay/open-shielded", async (c) => {
    if (!deps.relayer || !deps.chain.simulateOpenShielded || !deps.chain.relayOpenShielded) return c.json({ error: { code: "UNAVAILABLE", message: "Shielded relay is not configured" } }, 503);
    if (!takeRelayToken(clientIp(c))) return c.json({ error: { code: "RATE_LIMITED", message: "Relay rate limit exceeded" } }, 429);
    const received = await readRelayJson(c); if (received.error) return received.error;
    const body = RelayOpenSchema.parse(received.body);
    if (body.intake.provenance.opener !== deps.relayer.sender.toLowerCase()) return c.json({ error: { code: "SENDER_MISMATCH", message: "The intake grant must name the configured relayer as opener" } }, 400);
    const prov = await checkGrant(deps, body.intake, body.payerResultPubKey);
    const queryId = await deps.chain.computeQueryId(deps.relayer.sender, prov.docCommit as Hex, BigInt(prov.nonce));
    const { params, provenance } = openArgs(body, prov);
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
    // Anonyma seals the open binding with the document: opener = this relayer, payerCommit(payerResultPubKey) (or
    // zero when public), the consent flags and a queryId nonce (conventionally the voucherId's low 64 bits).
    const intake = IntakeResultSchema.parse(await deps.intake.request("/v1/intake/upload", { envelope: body.envelope }));
    if (intake.schemaId !== body.schemaId) return c.json({ error: { code: "BAD_REQUEST", message: "Voucher does not match intake result" } }, 400);
    if (intake.provenance.opener !== deps.relayer.sender.toLowerCase() || intake.provenance.isPublic !== body.isPublic) return c.json({ error: { code: "BINDING_MISMATCH", message: "The sealed open binding must name this relayer and match isPublic" } }, 400);
    // The voucher is signed for exactly one query; check it before anything is stored or sent.
    const voucherQueryId = await deps.chain.computeQueryId(deps.relayer.sender, intake.provenance.docCommit as Hex, BigInt(intake.provenance.nonce));
    if (voucherQueryId.toLowerCase() !== body.voucher.queryId.toLowerCase()) return c.json({ error: { code: "BAD_REQUEST", message: "Voucher is for a different query" } }, 400);
    // The consensus enclave only releases a private result to the key committed in payerCommit; the orchestrator
    // looks it up by the on-chain payerCommit, so it must be stored before the query is opened.
    const prov = await checkGrant(deps, intake, body.payerResultPubKey);
    const queryId = await deps.chain.computeQueryId(deps.relayer.sender, prov.docCommit as Hex, BigInt(prov.nonce));
    const { params, provenance } = openArgs(body, prov);
    const quoted = await deps.chain.quote(prov.schemaId, body.n, prov.tokensK);
    const txHash = await deps.relayer.openWithVoucher(params, provenance, intake.intakeSig as Hex, { ...body.voucher, maxAmount: BigInt(body.voucher.maxAmount), expiry: BigInt(body.voucher.expiry) }, body.voucherSig as Hex);
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
  /**
   * Stores a disclosure envelope as its canonical JSON under envelopeHash = keccak256 of those bytes, the hash
   * `MochiClient.disclose` records on-chain in DisclosureRegistry (keyed by the discloser's address). Nothing here
   * proves who posted it, and nothing needs to: the recipient opens each envelope and checks the result against the
   * verdict's on-chain answerHash/payloadHash, so a junk envelope is simply skipped and cannot displace the payer's.
   */
  app.post("/v1/disclosures", async (c) => {
    if (!takeDisclosureToken(clientIp(c))) return c.json({ error: { code: "RATE_LIMITED", message: "Disclosure rate limit exceeded" } }, 429);
    const received = await readRelayJson(c, deps.disclosureBodyLimitBytes ?? DISCLOSURE_BODY_LIMIT_BYTES); if (received.error) return received.error;
    const body = DisclosureReqSchema.parse(received.body);
    const row = await deps.store.getVerdict(body.verdictId);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Verdict not found" } }, 404);
    const verdict: any = row.verdict ?? row;
    if (verdict.isPublic) return c.json({ error: { code: "PUBLIC_VERDICT", message: "Public verdicts do not need a disclosure" } }, 400);
    const keyHash = recipientKeyHash(body.recipientPubKey as Hex);
    const envelope = canonicalBytes(body.envelope);
    const envelopeHash = keccak256(envelope);
    if (!takeDisclosureWrite("global")) return c.json({ error: { code: "RATE_LIMITED", message: "Disclosure storage is busy; try again shortly" } }, 429);
    await deps.store.insertDisclosure(body.verdictId, keyHash, envelopeHash, envelope);
    return c.json({ recipientKeyHash: keyHash, envelopeHash });
  });
  /**
   * The envelope hash that the verdict's payer or refund address recorded in DisclosureRegistry for this recipient, if
   * any (the registry keys records by sender, so nobody else can write that slot). Best effort: undefined when the
   * deployment has no registry, the verdict or query is unknown, or a read fails.
   */
  const anchoredEnvelope = async (verdictId: string, keyHash: string): Promise<{ envelopeHash: string; discloser: string } | undefined> => {
    if (!deps.chain.disclosedEnvelopeHash) return undefined;
    try {
      const row = await deps.store.getVerdict(verdictId);
      const queryId = (row?.verdict ?? row)?.queryId as string | undefined;
      if (!queryId) return undefined;
      const query = await deps.chain.getQuery(queryId as Hex) as { payer?: string; refundTo?: string } | undefined;
      for (const discloser of new Set([query?.payer, query?.refundTo].map((a) => a?.toLowerCase()))) {
        if (!discloser || !/^0x[0-9a-f]{40}$/.test(discloser) || /^0x0{40}$/.test(discloser)) continue;
        const hash = (await deps.chain.disclosedEnvelopeHash(verdictId as Hex, keyHash as Hex, discloser as Address)).toLowerCase();
        if (!/^0x0{64}$/.test(hash)) return { envelopeHash: hash, discloser };
      }
    } catch (error) {
      log("warn", "disclosure_anchor_read_failed", { message: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    return undefined;
  };
  /**
   * `?envelopeHash=` returns exactly that envelope. Otherwise `envelope`/`envelopeHash` are the one the verdict's payer
   * (or refund address) anchored in DisclosureRegistry when it is stored here (`anchoredBy`), else the oldest stored
   * envelope: what a single-envelope client opens. `envelopes` lists every stored envelope hash, oldest first (bounded;
   * `total` counts all), for clients that try each one or look up another discloser's anchor.
   */
  app.get("/v1/disclosures/:verdictId/:recipientKeyHash", async (c) => {
    const verdictId = hex32.parse(c.req.param("verdictId"));
    const keyHash = hex32.parse(c.req.param("recipientKeyHash"));
    const wantedRaw = c.req.query("envelopeHash");
    const wanted = wantedRaw === undefined ? undefined : hex32.parse(wantedRaw.toLowerCase());
    if (wanted !== undefined) {
      const exact = await deps.store.getDisclosure(verdictId, keyHash, wanted);
      if (!exact) return c.json({ error: { code: "NOT_FOUND", message: "Disclosure not found" } }, 404);
      return c.json({ envelope: JSON.parse(new TextDecoder().decode(exact.envelope)), envelopeHash: exact.envelopeHash });
    }
    const anchor = await anchoredEnvelope(verdictId, keyHash);
    const anchored = anchor ? await deps.store.getDisclosure(verdictId, keyHash, anchor.envelopeHash) : null;
    const disclosure = anchored ?? await deps.store.getDisclosure(verdictId, keyHash);
    if (!disclosure) return c.json({ error: { code: "NOT_FOUND", message: "Disclosure not found" } }, 404);
    const listed = await deps.store.listDisclosures(verdictId, keyHash);
    return c.json({
      envelope: JSON.parse(new TextDecoder().decode(disclosure.envelope)), envelopeHash: disclosure.envelopeHash,
      anchoredBy: anchored ? anchor!.discloser : null, total: listed.total,
      envelopes: listed.envelopes.map((e) => ({ envelopeHash: e.envelopeHash, createdAt: e.createdAt.toISOString() })),
    });
  });
  return { app };
}
