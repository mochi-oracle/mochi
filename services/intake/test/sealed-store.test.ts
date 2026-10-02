import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aad } from "@mochi/protocol";
import { ZERO32 } from "@mochi/core";
import { FileSealedStore, MockQuoteVerifier, MockTeeProvider, seal, SealedStoreFullError } from "@mochi/tee";
import { INTAKE_UPLOAD_RETENTION, IntakeSealedStore, createIntakeSealedStore } from "../src/sealed-store.ts";
import { decodeIntakeRecord, encodeIntakeRecord } from "../src/record-codec.ts";
import { IntakeEnclave, PROVENANCE_TTL_SECONDS } from "../src/intake.ts";
import { createIntakeApp } from "../src/app.ts";
import { extractText } from "../src/extract.ts";

const root = privateKeyToAccount(`0x${"33".repeat(32)}`);
const tee = new MockTeeProvider({ seed: `0x${"11".repeat(32)}` as Hex, measurement: `0x${"22".repeat(32)}` as Hex, mockRoot: root });
const dirs: string[] = [];
const stores: FileSealedStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const HOUR = 3_600_000, DAY = 24 * HOUR;
async function intakeStore(overrides: Partial<typeof INTAKE_UPLOAD_RETENTION> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mochi-intake-store-")); dirs.push(dir);
  const clock = { now: Date.now() };
  const store = createIntakeSealedStore(dir, tee, { ...INTAKE_UPLOAD_RETENTION, sweepIntervalMs: 0, now: () => clock.now, ...overrides });
  stores.push(store);
  return { store, dir, clock };
}
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** A StoredIntake as intake.ts writes it (the fields the codec does not look into are opaque to it). */
const record = (doc: Uint8Array, text: string) => ({
  provenance: { docCommit: `0x${"aa".repeat(32)}`, nonce: "1", expiry: "1700000900" }, schemaId: 7, schemaVersion: 1, docCommit: `0x${"aa".repeat(32)}`,
  salt: ZERO32, params: { question: "Q", answer_type: "STRING", note: "caf\u00e9 \ud83d\ude00" }, paramsHash: ZERO32, payerCommit: ZERO32, isPublic: true,
  allowPanelDisclosure: false, contentType: "text/plain", docB64: Buffer.from(doc).toString("base64"), text,
});

describe("intake retention policy", () => {
  test("unretained uploads live 3 hours (past grant TTL + queryTtl), retained records 14 days, caps split the 2 GiB", () => {
    expect(INTAKE_UPLOAD_RETENTION).toMatchObject({ ttlSec: 3 * 3600, retainedTtlSec: 14 * 86_400, retainOnRead: false });
    expect(INTAKE_UPLOAD_RETENTION.ttlSec).toBeGreaterThanOrEqual(2 * (PROVENANCE_TTL_SECONDS + 3600));
    expect(INTAKE_UPLOAD_RETENTION.maxUnretainedBytes! + INTAKE_UPLOAD_RETENTION.maxRetainedBytes!).toBe(INTAKE_UPLOAD_RETENTION.maxBytes!);
    expect(INTAKE_UPLOAD_RETENTION.maxBytes).toBe(2 * 1024 ** 3);
  });

  test("an unopened upload expires after 3 hours; a released record lives 14 days from its last release", async () => {
    const { store, clock } = await intakeStore();
    await store.putIfAbsent("prov:0xopened", json(record(new Uint8Array([1]), "opened")));
    await store.putIfAbsent("prov:0xescalated", json(record(new Uint8Array([2]), "escalated")));
    await store.putIfAbsent("prov:0xabandoned", json(record(new Uint8Array([3]), "abandoned")));
    expect(await store.get("prov:0xabandoned")).toBeDefined(); // the upload de-duplication read does not retain
    await store.retain("prov:0xopened"); // what dispatch() does for a query sealed with this grant
    await store.retain("prov:0xescalated");
    clock.now += 3 * HOUR + 60_000;
    expect(await store.sweep()).toBe(1);
    expect(await store.has("prov:0xabandoned")).toBe(false);
    clock.now += 5 * DAY;
    await store.retain("prov:0xescalated"); // dispatchPanel() releasing it to a panel restarts its lifetime
    clock.now += 9 * DAY;
    expect(await store.sweep()).toBe(1);
    expect(await store.has("prov:0xopened")).toBe(false);
    expect(await store.has("prov:0xescalated")).toBe(true);
    clock.now += 5 * DAY + 60_000;
    expect(await store.sweep()).toBe(1);
    expect(await store.usage()).toEqual({ unretainedBytes: 0, retainedBytes: 0, pendingBytes: 0 });
  });

  test("a full retained pool never fails a paid dispatch: the record keeps its upload lifetime", async () => {
    const { store } = await intakeStore({ maxRetainedBytes: 2 * 4096 });
    await store.putIfAbsent("prov:0xa", json(record(new Uint8Array([1]), "a")));
    await store.putIfAbsent("prov:0xb", json(record(new Uint8Array([2]), "b")));
    await store.retain("prov:0xa");
    const logged: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { logged.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await store.retain("prov:0xb"); } finally { process.stdout.write = write; }
    expect(logged.map((line) => JSON.parse(line))).toEqual([{ level: "warn", event: "intake_retention_full", pool: "retained" }]);
    expect(await store.usage()).toMatchObject({ retainedBytes: 2 * 4096, unretainedBytes: 4096 });
  });

  test("the intake store offers atomic first-write-wins for a grant's record", async () => {
    const { dir } = await intakeStore();
    const [a, b] = [0, 1].map(() => { const s = createIntakeSealedStore(dir, tee, { ...INTAKE_UPLOAD_RETENTION, sweepIntervalMs: 0 }); stores.push(s); return s; });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a! : b!).putIfAbsent("prov:0xgrant", new Uint8Array([i]))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([...(await a!.get("prov:0xgrant"))!]).toEqual([results.indexOf(true)]);
  });
});

describe("compact intake records", () => {
  // The reported amplification: 1.75x the sealed request on disk for ASCII text, 3.25x for invalid UTF-8 and 5.5x for
  // control characters (base64 document and JSON-escaped text, then hex inside a JSON envelope).
  test("store the document bytes and the text once each, whatever the text is", async () => {
    for (const [label, byte] of [["ascii", 0x61], ["control characters", 0x01], ["invalid UTF-8", 0xff]] as const) {
      const { store, dir } = await intakeStore();
      const doc = new Uint8Array(390_000).fill(byte);
      const text = await extractText(doc, "text/plain");
      await store.putIfAbsent("prov:0xdoc", json(record(doc, text)));
      const [name] = (await readdir(dir)).filter((n) => n.endsWith(".bin"));
      const disk = (await stat(join(dir, name!))).size;
      const textBytes = Math.min(Buffer.byteLength(text, "utf8"), 2 * text.length);
      expect({ label, compact: disk <= doc.byteLength + textBytes + 2048 }).toEqual({ label, compact: true });
      expect(JSON.parse(new TextDecoder().decode((await store.get("prov:0xdoc"))!))).toEqual(record(doc, text));
    }
  });

  test("round-trip every record exactly, including text with a lone surrogate", () => {
    for (const text of ["", "plain", "caf\u00e9 \ud83d\ude00 \u2028", "\ufffd\ufffd\ufffd", "lone \ud800 surrogate", "\udc00", "x\ud83d"]) {
      const value = json(record(new Uint8Array([0, 255, 10]), text));
      const decoded = decodeIntakeRecord(encodeIntakeRecord(value));
      expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(JSON.parse(new TextDecoder().decode(value)));
      expect(new TextDecoder().decode(decoded)).toBe(new TextDecoder().decode(value));
    }
  });

  test("a damaged record is reported as an internal error, not as a bad request", () => {
    const encoded = encodeIntakeRecord(json(record(new Uint8Array([1, 2]), "lone \ud800")));
    for (const damaged of [encoded.subarray(0, encoded.byteLength - 1), Buffer.concat([encoded, Uint8Array.of(0)])]) {
      expect(() => decodeIntakeRecord(damaged)).toThrow(/intake record is (truncated|malformed)/);
    }
    const badHeader = Buffer.from(encoded); badHeader[8] = 0x7d; // "}" where the header JSON starts
    expect(() => decodeIntakeRecord(badHeader)).toThrow("intake record is malformed");
  });

  test("other values are kept unchanged, and records written before the format are read as they are", async () => {
    for (const value of [new Uint8Array([1, 2, 3]), new Uint8Array([0x4d, 0x49, 0x52, 0x01, 9]), json({ docB64: "not base64!", text: "x" }), json([1])]) {
      expect([...decodeIntakeRecord(encodeIntakeRecord(value))]).toEqual([...value]);
    }
    const legacy = json(record(new Uint8Array([7]), "legacy"));
    expect([...decodeIntakeRecord(legacy)]).toEqual([...legacy]);
    const { store, dir } = await intakeStore();
    await new FileSealedStore(dir, tee).put("prov:0xold", legacy); // the store layer without the record codec
    expect([...(await store.get("prov:0xold"))!]).toEqual([...legacy]);
    expect(store).toBeInstanceOf(IntakeSealedStore);
  });
});

describe("intake HTTP app", () => {
  function app(store: IntakeSealedStore) {
    const intake = new IntakeEnclave({
      tee, chain: {} as never, store, fetchPolicy: { origins: [] }, httpGetter: {} as never, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
      chainId: 31337, escrowAddress: `0x${"66".repeat(20)}`, clock: { nowSeconds: () => 1_700_000_000 },
    });
    return createIntakeApp(intake).app;
  }
  const upload = (doc: string, nonce: string, contentType = "text/plain") => ({
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: seal(tee.encryptionPublicKey(), json({ v: 1, schemaId: 7, salt: ZERO32, params: { question: "Q", answer_type: "STRING" }, contentType,
      docB64: Buffer.from(doc).toString("base64"), open: { opener: `0x${"b0".repeat(20)}`, payerCommit: ZERO32, isPublic: true, allowPanelDisclosure: false, nonce } }), aad.intake()) }),
  });

  test("a full store answers 503 STORE_FULL with Retry-After, not 500", async () => {
    // Room for exactly one upload (its record and whatever grant claims intake stores with it).
    const { store: probe } = await intakeStore();
    expect((await app(probe).request("/v1/intake/upload", upload("first document", "1"))).status).toBe(200);
    const { store } = await intakeStore({ maxUnretainedBytes: (await probe.usage()).unretainedBytes });
    const intakeApp = app(store);
    expect((await intakeApp.request("/v1/intake/upload", upload("first document", "1"))).status).toBe(200);
    const full = await intakeApp.request("/v1/intake/upload", upload("second document", "2"));
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("600");
    expect(await full.json()).toEqual({ error: { code: "STORE_FULL", message: "Intake storage is temporarily full; retry later" } });
    expect(SealedStoreFullError).toBeDefined();
  });

  test("a document with no extractable text answers 422 EMPTY_DOCUMENT and stores nothing", async () => {
    const { store, dir } = await intakeStore();
    const response = await app(store).request("/v1/intake/upload", upload("<b></b>".repeat(1000), "3", "text/html"));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "EMPTY_DOCUMENT", message: "Document has no extractable text" } });
    expect(await readdir(dir)).toEqual([]);
  });
});
