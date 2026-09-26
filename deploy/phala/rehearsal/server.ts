import { type Hex } from "viem";
import { AttestationDocSchema, IntakeReqSchema, IntakeUploadPlainSchema, aad } from "@mochi/protocol";
import { IntakeEnclave } from "../../../services/intake/src/intake.ts";
import type { Clock, FetchPolicy, HttpGetter, IntakeChainPort } from "../../../services/intake/src/ports.ts";
import { FileSealedStore, TdxTeeProvider, DstackQuoteSource, tdxQuoteMeasurement, keyBinding, type Envelope } from "@mochi/tee";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? "8080");
const MAX_BODY = 16 * 1024;
const MAX_DOCUMENT = 8 * 1024;
const MAX_UPLOADS = 10;
const ESCROW = `0x${"00".repeat(20)}` as const;
const CHAIN_ID = 31337;
const FIXTURE = "Synthetic hardware rehearsal document. It contains no user or production data.";
const FIXTURE_QUESTION = "Does the synthetic fixture identify itself as a hardware rehearsal document?";
const fetchPolicy: FetchPolicy = { origins: [] };
const clock: Clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };
const noFetch: HttpGetter = { async get() { throw new Error("fetch disabled in rehearsal"); } };

// Ephemeral in-process key material plus the hardware dstack quote socket; no KMS or application credentials.
if (process.env.TEE_MODE !== "dstack" || process.env.TEE_KEYS !== "ephemeral") throw new Error("Rehearsal requires dstack with ephemeral keys.");
const tee = await TdxTeeProvider.create({
  measurementOf: tdxQuoteMeasurement,
  quoteSource: new DstackQuoteSource({ socketPath: process.env.DSTACK_SOCKET ?? "/var/run/dstack.sock" }),
});
const intake = new IntakeEnclave({
  tee,
  // Upload intake uses only the enclave's signing/encryption APIs; chain methods are unavailable by design.
  chain: {} as IntakeChainPort,
  store: new FileSealedStore(process.env.SEALED_STORE_DIR ?? "/tmp/intake", tee),
  fetchPolicy, httpGetter: noFetch,
  quoteVerifier: { async verify() { return { ok: false, reason: "verification intentionally external to rehearsal" }; } },
  chainId: CHAIN_ID, escrowAddress: ESCROW, clock,
});

async function readBounded(request: Request): Promise<Uint8Array> {
  const size = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(size) && size > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

let uploadCount = 0;
let uploadActive = false;
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "hardware_rehearsal" });
    if (request.method === "GET" && url.pathname === "/v1/attestation") {
      try {
        const quote = await tee.quote();
        const binding = keyBinding(tee.signer().address.toLowerCase() as Hex, tee.encryptionPublicKey());
        if (quote.kind !== "tdx" || quote.reportData.toLowerCase() !== binding.toLowerCase()) return json({ error: { code: "ATTESTATION_BINDING_FAILED" } }, 503);
        return json(AttestationDocSchema.parse({
          role: "INTAKE", address: tee.signer().address.toLowerCase(),
          encryptionPubKey: tee.encryptionPublicKey().toLowerCase(), measurement: tee.measurement().toLowerCase(), quote,
        }));
      } catch { return json({ error: { code: "QUOTE_UNAVAILABLE" } }, 503); }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/intake/upload") return json({ error: { code: "NOT_FOUND" } }, 404);
    if (uploadActive) return json({ error: { code: "UPLOAD_BUSY" } }, 429);
    if (uploadCount >= MAX_UPLOADS) return json({ error: { code: "UPLOAD_LIMIT_REACHED" } }, 429);
    uploadActive = true;
    uploadCount += 1;
    try {
      const body = await readBounded(request);
      const payload = IntakeReqSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      const envelope = payload.envelope as unknown as Envelope;
      // The rehearsal accepts only a tiny plain-text synthetic document and never invokes OCR/fetch.
      const plain = IntakeUploadPlainSchema.parse(JSON.parse(new TextDecoder().decode(tee.decryptEnvelope(envelope, aad.intake()))));
      if (plain.contentType !== "text/plain") return json({ error: { code: "UNSUPPORTED_CONTENT_TYPE" } }, 415);
      if (plain.docB64.length > Math.ceil(MAX_DOCUMENT * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(plain.docB64) || Buffer.from(plain.docB64, "base64").byteLength > MAX_DOCUMENT) {
        return json({ error: { code: "DOCUMENT_TOO_LARGE" } }, 413);
      }
      const expectedB64 = Buffer.from(FIXTURE, "utf8").toString("base64");
      if (plain.schemaId !== 7 || plain.salt !== `0x${"00".repeat(32)}` || plain.params.question !== FIXTURE_QUESTION || plain.params.answer_type !== "BOOL" || plain.docB64 !== expectedB64) {
        return json({ error: { code: "FIXTURE_ONLY" } }, 400);
      }
      const result = await intake.intakeUpload(envelope);
      return json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "BODY_TOO_LARGE") return json({ error: { code: "BODY_TOO_LARGE" } }, 413);
      // Do not log request bodies, envelope data, plaintext, or exception messages.
      return json({ error: { code: "BAD_REQUEST", message: "Upload could not be processed." } }, 400);
    } finally { uploadActive = false; }
  },
});

const lifetimeTimer = setTimeout(() => {
  console.info("Mochi hardware rehearsal lifetime ended");
  server.stop(true);
  process.exit(0);
}, 30 * 60 * 1000);
lifetimeTimer.unref();

// Do not log identity material, quote bytes, request bodies, or source text.
console.info("Mochi hardware rehearsal service ready");
