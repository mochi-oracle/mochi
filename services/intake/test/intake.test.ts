import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, sha256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aad, IntakeUploadPlainSchema, JurorDocPlainSchema, ConsensusSeedPlainSchema } from "@mochi/protocol";
import { docCommit, originId, ZERO32 } from "@mochi/core";
import { MemorySealedStore, MockQuoteVerifier, MockTeeProvider, keyBinding, open, seal, recoverProvenance } from "@mochi/tee";
import { DefaultPdfTextExtractor, extractText, estimateTokensK, UnsupportedContentType } from "../src/extract.ts";
import { fetchDocument } from "../src/fetcher.ts";
import type { Clock, FetchPolicy, HttpGetter, HttpResponse } from "../src/ports.ts";
import { IntakeEnclave } from "../src/intake.ts";
import { createIntakeApp } from "../src/app.ts";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const measurement = `0x${"22".repeat(32)}` as Hex;
const fixedClock: Clock = { nowSeconds: () => 1_700_000_123 };
const bytes = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => bytes(JSON.stringify(v));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const makeTee = (seed: string) => new MockTeeProvider({ seed: `0x${seed.repeat(32)}` as Hex, measurement, mockRoot: root });

class FakeGetter implements HttpGetter {
  calls: URL[] = [];
  constructor(private readonly response: (url: URL, index: number) => HttpResponse) {}
  async get(url: URL): Promise<HttpResponse> { this.calls.push(url); return this.response(url, this.calls.length - 1); }
}
const response = (status: number, headers: Record<string, string>, body = "doc", certFingerprints: string[] = []): HttpResponse => ({ status, headers, bytes: bytes(body), certFingerprints });
const pin = Buffer.from("11".repeat(32), "hex").toString("base64");
const originPolicy: FetchPolicy = { origins: [{ host: "docs.example", spkiSha256: [pin] }], maxBytes: 10, timeoutMs: 1000 };

describe("document extraction", () => {
  test("normalizes plain, JSON and HTML text, strips scripts and decodes entities", async () => {
    expect(await extractText(bytes("a\r\nb"), "text/plain")).toBe("a\nb");
    expect(await extractText(bytes('{"x":1}'), "application/json")).toBe('{"x":1}');
    const html = "<h1> A &amp; B </h1><script>private()</script><p>x&nbsp;&lt;y&gt; &quot;q&quot; &#39; &#65; &#x42;</p><style>hide</style><div>z</div>";
    expect(await extractText(bytes(html), "text/html")).toBe("A & B\nx <y> \"q\" ' A B\nz");
    expect(estimateTokensK("")).toBe(1);
    expect(estimateTokensK("x".repeat(4_000_001))).toBe(1001);
  });
  test("rejects PDF when OCR runtime is absent and unsupported types", async () => {
    await expect(extractText(bytes("%PDF"), "application/pdf")).rejects.toThrow("OCR runtime not bundled");
    expect(() => extractText(bytes("x"), "image/png")).toThrow(UnsupportedContentType);
    await expect(new DefaultPdfTextExtractor().extract(bytes("%PDF"))).rejects.toThrow(UnsupportedContentType);
  });
});

describe("allow-listed document fetch", () => {
  test("rejects disallowed hosts, unapproved HTTP and redirects outside allow-list", async () => {
    const getter = new FakeGetter(() => response(200, { "content-type": "text/plain" }));
    await expect(fetchDocument("https://evil.example/doc", originPolicy, { httpGetter: getter, clock: fixedClock })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    await expect(fetchDocument("http://docs.example/doc", originPolicy, { httpGetter: getter, clock: fixedClock })).rejects.toMatchObject({ code: "HTTPS_REQUIRED" });
    const redirect = new FakeGetter(() => response(302, { location: "https://evil.example/doc" }, "", [pin]));
    await expect(fetchDocument("https://docs.example/doc", originPolicy, { httpGetter: redirect, clock: fixedClock })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });
  test("enforces size and pins and produces a stable ABI transcript hash", async () => {
    const tooLarge = new FakeGetter(() => response(200, { "content-type": "text/plain" }, "01234567890", [pin]));
    await expect(fetchDocument("https://docs.example/doc", originPolicy, { httpGetter: tooLarge, clock: fixedClock })).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
    const badPin = new FakeGetter(() => response(200, { "content-type": "text/plain" }, "hello", [Buffer.from("22".repeat(32), "hex").toString("base64")]));
    await expect(fetchDocument("https://docs.example/doc", originPolicy, { httpGetter: badPin, clock: fixedClock })).rejects.toMatchObject({ code: "PIN_MISMATCH" });
    const getter = new FakeGetter(() => response(200, { "content-type": "text/plain; charset=utf-8" }, "hello", [pin]));
    const fetched = await fetchDocument("https://docs.example/doc", originPolicy, { httpGetter: getter, clock: fixedClock });
    const expected = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint16" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32[]" }],
      ["docs.example", "https://docs.example/doc", 200, "text/plain; charset=utf-8", sha256(bytes("hello")), [`0x${Buffer.from(pin, "base64").toString("hex")}` as Hex]],
    ));
    expect(fetched.transcriptHash).toBe(expected);
    expect(fetched.fetchedAt).toBe(1_700_000_123);
  });
});

function fixture(pdfTextExtractor?: { extract(bytes: Uint8Array): Promise<string> }) {
  const intakeTee = makeTee("33");
  const juror = makeTee("44");
  const consensus = makeTee("55");
  const queryId = `0x${"ab".repeat(32)}` as Hex;
  const chainState = { status: 2, docCommit: ZERO32 as Hex, paramsHash: ZERO32 as Hex, schemaId: 7 };
  const selected = [juror.signer().address.toLowerCase() as Hex];
  const active = new Map<string, boolean>([[juror.signer().address.toLowerCase(), true], [consensus.signer().address.toLowerCase(), true]]);
  const chain = {
    getQuery: async () => ({ ...chainState }), jurorsOf: async () => selected,
    isActive: async (address: Hex) => active.get(address.toLowerCase()) ?? false,
    getJuror: async (address: Hex) => ({ measurement: address.toLowerCase() === juror.signer().address.toLowerCase() ? measurement : consensus.measurement() }),
  };
  const getter = new FakeGetter(() => response(200, { "content-type": "text/plain; charset=utf-8" }, "url document", [pin]));
  const store = new MemorySealedStore();
  const intake = new IntakeEnclave({ tee: intakeTee, chain, store, fetchPolicy: { origins: [{ host: "docs.example", spkiSha256: [pin] }] }, httpGetter: getter, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), chainId: 31337, escrowAddress: `0x${"66".repeat(20)}`, clock: fixedClock, ...(pdfTextExtractor ? { pdfTextExtractor } : {}) });
  const app = createIntakeApp(intake).app;
  const makePeer = async (provider: MockTeeProvider) => ({ address: provider.signer().address.toLowerCase(), encryptionPubKey: provider.encryptionPublicKey(), quote: await provider.quote() });
  return { intake, intakeTee, juror, consensus, queryId, chainState, selected, active, getter, app, makePeer };
}

describe("intake API and dispatch", () => {
  test("PDF upload uses extracted text for tokensK and default extractor keeps rejecting PDFs", async () => {
    const extracted = "ACME Corp announces a 3-for-1 stock split effective November 20, 2026";
    const f = fixture({ extract: async () => extracted });
    const upload = { v: 1, schemaId: 7, salt: ZERO32, params: { question: "What happened?", answer_type: "STRING" }, contentType: "application/pdf", docB64: Buffer.from("%PDF fake bytes").toString("base64") };
    const envelope = seal(f.intakeTee.encryptionPublicKey(), json(upload), aad.intake());
    const response = await f.app.request("/v1/intake/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { tokensK: number }).tokensK).toBe(estimateTokensK(extracted));

    const defaultIntake = fixture();
    const defaultEnvelope = seal(defaultIntake.intakeTee.encryptionPublicKey(), json(upload), aad.intake());
    const rejected = await defaultIntake.app.request("/v1/intake/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: defaultEnvelope }) });
    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toMatchObject({ error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
  });

  test("uploads through Hono, signs the commitment, and preserves public/private salt behavior", async () => {
    const f = fixture();
    const doc = bytes("hello, intake");
    const salt = `0x${"77".repeat(32)}` as Hex;
    const plain = { v: 1, schemaId: 7, salt, params: { question: "What is printed?", answer_type: "STRING" }, contentType: "text/plain", docB64: Buffer.from(doc).toString("base64") };
    const reqEnvelope = seal(f.intakeTee.encryptionPublicKey(), json(plain), aad.intake());
    const response = await f.app.request("/v1/intake/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: reqEnvelope }) });
    expect(response.status).toBe(200);
    const result = await response.json() as { provenance: { docCommit: Hex; kind: number; fetchedAt: string }; intakeSig: Hex; intake: Hex; paramsHash: Hex; tokensK: number };
    const expectedCommit = docCommit(salt, sha256(doc));
    expect(result.provenance.docCommit).toBe(expectedCommit);
    expect(result.provenance.kind).toBe(0);
    expect(result.provenance.fetchedAt).toBe("0");
    expect((await recoverProvenance(31337, `0x${"66".repeat(20)}`, { ...result.provenance, fetchedAt: 0n, tokensK: result.tokensK, originId: ZERO32, transcriptHash: ZERO32 }, result.intakeSig)).toLowerCase()).toBe(result.intake);
    const publicPlain = { ...plain, salt: ZERO32 };
    const publicEnv = seal(f.intakeTee.encryptionPublicKey(), json(publicPlain), aad.intake());
    const publicRes = await f.app.request("/v1/intake/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: publicEnv }) });
    expect(publicRes.status).toBe(200);
    const publicResult = await publicRes.json() as { docCommit: Hex; paramsHash: Hex };
    expect(publicResult.docCommit).toBe(docCommit(ZERO32, sha256(doc)));
    expect(publicResult.docCommit).not.toBe(result.provenance.docCommit);
    expect(publicResult.paramsHash).not.toBe(ZERO32);
  });

  test("rejects bad params and bad request schemas", async () => {
    const f = fixture();
    const bad = { v: 1, schemaId: 7, salt: ZERO32, params: { question: "x", answer_type: "OTHER" }, contentType: "text/plain", docB64: Buffer.from("x").toString("base64") };
    const env = seal(f.intakeTee.encryptionPublicKey(), json(bad), aad.intake());
    const res = await f.app.request("/v1/intake/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: env }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_PARAMS" } });
    const invalid = await f.app.request("/v1/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(invalid.status).toBe(400);
  });

  test("URL intake creates fetched provenance and dispatch wraps doc and params to selected peers", async () => {
    const f = fixture();
    const salt = ZERO32 as Hex;
    const params = { question: "Find it", answer_type: "STRING" };
    const urlPlain = { v: 1, schemaId: 7, salt, params, url: "https://docs.example/report" };
    const envelope = seal(f.intakeTee.encryptionPublicKey(), json(urlPlain), aad.intake());
    const urlRes = await f.app.request("/v1/intake/url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) });
    expect(urlRes.status).toBe(200);
    const result = await urlRes.json() as { provenance: { docCommit: Hex; kind: number; originId: Hex; fetchedAt: string; transcriptHash: Hex }; paramsHash: Hex };
    expect(result.provenance).toMatchObject({ kind: 1, originId: originId("docs.example"), fetchedAt: "1700000123" });
    f.chainState.docCommit = result.provenance.docCommit; f.chainState.paramsHash = result.paramsHash;
    const jurorPeer = await f.makePeer(f.juror), consensusPeer = await f.makePeer(f.consensus);
    const req = { queryId: f.queryId, jurors: [{ ...jurorPeer, seat: 0 }], consensus: consensusPeer };
    const dispatchRes = await f.app.request("/v1/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    expect(dispatchRes.status).toBe(200);
    const payload = await dispatchRes.json() as { jurors: { seat: number; address: string; docEnvelope: Parameters<typeof open>[1] }[]; consensusSeed: Parameters<typeof open>[1] };
    expect(payload.jurors).toHaveLength(1);
    const docPlain = JurorDocPlainSchema.parse(JSON.parse(text(f.juror.decryptEnvelope(payload.jurors[0]!.docEnvelope, aad.doc(result.provenance.docCommit)))));
    expect(docPlain).toMatchObject({ queryId: f.queryId, schemaId: 7, docCommit: result.provenance.docCommit, paramsHash: result.paramsHash, text: "url document", params });
    const seed = ConsensusSeedPlainSchema.parse(JSON.parse(text(f.consensus.decryptEnvelope(payload.consensusSeed, aad.consensusSeed(f.queryId)))));
    expect(seed).toMatchObject({ queryId: f.queryId, docCommit: result.provenance.docCommit, paramsHash: result.paramsHash, params });
  });

  test("dispatch rejects unsealed, unknown, unselected, inactive, and incorrectly attested peers", async () => {
    const f = fixture();
    const upload = { v: 1, schemaId: 7, salt: ZERO32, params: { question: "q", answer_type: "STRING" }, contentType: "text/plain", docB64: Buffer.from("dispatch doc").toString("base64") };
    const env = seal(f.intakeTee.encryptionPublicKey(), json(upload), aad.intake());
    const result = await f.intake.intakeUpload(env);
    f.chainState.docCommit = result.docCommit as Hex; f.chainState.paramsHash = result.paramsHash as Hex;
    const jurorPeer = await f.makePeer(f.juror), consensusPeer = await f.makePeer(f.consensus);
    const goodReq = { queryId: f.queryId, jurors: [{ ...jurorPeer, seat: 0 }], consensus: consensusPeer };
    const send = (body: unknown) => f.app.request("/v1/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    f.chainState.status = 1;
    expect((await send(goodReq)).status).toBe(409);
    f.chainState.status = 2;
    f.chainState.docCommit = `0x${"99".repeat(32)}`;
    expect(await (await send(goodReq)).json()).toMatchObject({ error: { code: "UNKNOWN_DOC" } });
    f.chainState.docCommit = result.docCommit as Hex;

    const other = await f.makePeer(makeTee("66"));
    expect(await (await send({ ...goodReq, jurors: [{ ...other, seat: 0 }] })).json()).toMatchObject({ error: { code: "NOT_SELECTED" } });

    f.active.set(f.juror.signer().address.toLowerCase(), false);
    expect(await (await send(goodReq)).json()).toMatchObject({ error: { code: "INACTIVE_JUROR" } });
    f.active.set(f.juror.signer().address.toLowerCase(), true);

    const badReportPeer = { ...jurorPeer, quote: { ...jurorPeer.quote, reportData: `0x${"fe".repeat(32)}` } };
    expect(await (await send({ ...goodReq, jurors: [{ ...badReportPeer, seat: 0 }] })).json()).toMatchObject({ error: { code: "BAD_ATTESTATION" } });
    const wrongMeasurementPeer = { ...jurorPeer, quote: { ...jurorPeer.quote, measurement: `0x${"fd".repeat(32)}` } };
    expect(await (await send({ ...goodReq, jurors: [{ ...wrongMeasurementPeer, seat: 0 }] })).json()).toMatchObject({ error: { code: "BAD_ATTESTATION" } });
  });
});
