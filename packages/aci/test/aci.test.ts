import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { readFile } from "node:fs/promises";
import { AciClient, AciVerificationError, attestationStatement, jcsBytes, reportData, verifyAciReceipt, verifyAciReport, verifyComposeMeasurement, workloadKeysetDigest } from "../src/index.ts";

const enc = new TextEncoder();
const fixturePath = new URL("./fixtures/aci_report.json", import.meta.url);
const rawFixture = JSON.parse(await readFile(fixturePath, "utf8"));
const bytes = (v: string) => hexToBytes(v.replace(/^0x/, ""));
const digest = (v: Uint8Array) => `sha256:${bytesToHex(sha256(v))}`;
const seed = new Uint8Array(32).fill(7);
const pub = ed25519.getPublicKey(seed);
const KEYSET = {
  subject: "ignored-subject", not_after: 2_000_000_000,
  receipt_signing_keys: [{ key_id: "r1", algo: "ed25519", public_key: bytesToHex(pub) }], e2ee_public_keys: [],
};
function report(nonce: string, keyset: any = KEYSET, extra: Record<string, unknown> = {}): any {
  const keysetDigest = workloadKeysetDigest(keyset);
  return { api_version: "aci/1", workload_keyset_digest: keysetDigest, ...extra,
    attestation: { tee_type: "tdx", workload_keyset: keyset, report_data: reportData(keysetDigest, nonce), evidence: { quote: "aabb" } } };
}
function callback(data: Uint8Array, changes: Record<string, unknown> = {}) {
  const reportData = data.length === 32 ? Uint8Array.from([...data, ...new Uint8Array(32)]) : data;
  return (_quote: Uint8Array) => ({ ok: true, status: "UpToDate", reportType: "tdx", reportData, ...changes });
}
function established() { return { workloadId: workloadKeysetDigest(KEYSET), keysetDigest: workloadKeysetDigest(KEYSET), receiptKeys: KEYSET.receipt_signing_keys, staleAfter: 2_000_000_000, tcbStatus: "UpToDate" }; }
function signedReceipt(requestBody: Uint8Array, responseBody: Uint8Array, changes: Record<string, unknown> = {}, keyId = "r1", keyset = KEYSET) {
  const unsigned: any = { api_version: "aci/1", receipt_id: "rcpt-1", model: "demo", provider: "phala", workload_id: workloadKeysetDigest(keyset),
    workload_keyset_digest: workloadKeysetDigest(keyset), key_id: keyId,
    event_log: [
      { type: "request.received", body_hash: digest(requestBody) },
      { type: "upstream.verified", result: "verified", required: true, model_id: "demo", session_id: "session-1" },
      { type: "response.returned", wire_hash: digest(responseBody) },
    ], ...changes };
  return { ...unsigned, signature: bytesToHex(ed25519.sign(jcsBytes(unsigned), seed)) };
}
async function replay(events: Array<{ imr: number; digest: string }>) {
  let mr = new Uint8Array(48);
  for (const event of events) if (event.imr === 3) {
    const d = bytes(event.digest); const input = new Uint8Array(48 + Math.max(48, d.length)); input.set(mr); input.set(d, 48); mr = sha384(input);
  }
  return mr;
}

describe("Phala ACI verifier parity", () => {
  test("pins fixture digest and report-data construction", async () => {
    const f = rawFixture;
    expect(workloadKeysetDigest(f.attestation.workload_keyset)).toBe(f.workload_keyset_digest);
    const nonce = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const statement = attestationStatement(f.workload_keyset_digest, nonce);
    expect(new TextDecoder().decode(statement)).toBe(`{"keyset_digest":"${f.workload_keyset_digest}","nonce":"${nonce}","purpose":"aci.report_data.v1"}`);
    expect(reportData(f.workload_keyset_digest, nonce)).toBe(bytesToHex(sha256(statement)));
  });
  test("binds the fixture keyset and rejects tampering, nonce changes, stale keysets, malformed quote data and non-TDX reports", async () => {
    const f = structuredClone(rawFixture); const nonce = "ab".repeat(32);
    const fixtureBound = { ...f, attestation: { ...f.attestation, report_data: reportData(f.workload_keyset_digest, nonce) } };
    const qdata = bytes(fixtureBound.attestation.report_data); const dcap = callback(qdata);
    expect((await verifyAciReport(fixtureBound, { nonce, dcap, now: 1_700_000_000 })).workloadId).toBe(f.workload_keyset_digest);
    const changedKeyset = { ...fixtureBound, attestation: { ...fixtureBound.attestation, workload_keyset: { ...f.attestation.workload_keyset, not_after: 1_999_999_999 } } };
    await expect(verifyAciReport(changedKeyset, { nonce, dcap, now: 1_700_000_000 })).rejects.toMatchObject({ code: "report_binding" });
    await expect(verifyAciReport(fixtureBound, { nonce: "cd".repeat(32), dcap, now: 1_700_000_000 })).rejects.toMatchObject({ code: "report_binding" });
    const staleKeyset = { ...f.attestation.workload_keyset, not_after: 1_600_000_000 };
    const stale = report(nonce, staleKeyset);
    await expect(verifyAciReport(stale, { nonce, dcap: callback(bytes(stale.attestation.report_data)), now: 1_700_000_000 })).rejects.toMatchObject({ code: "report_stale" });
    const badPadding = new Uint8Array(64); badPadding.set(qdata); badPadding[63] = 1;
    await expect(verifyAciReport(fixtureBound, { nonce, dcap: callback(badPadding) })).rejects.toMatchObject({ code: "quote_binding" });
    await expect(verifyAciReport(fixtureBound, { nonce, dcap: callback(qdata, { reportType: "sgx" }) })).rejects.toMatchObject({ code: "quote_binding" });
  });
  test("uses top-level workload_id and enforces allow-lists", async () => {
    const nonce = "ef".repeat(32); const r = report(nonce, KEYSET, { workload_id: "sha256:" + "aa".repeat(32) });
    expect((await verifyAciReport(r, { nonce, dcap: callback(bytes(r.attestation.report_data)), allowedWorkloads: [r.workload_id] })).workloadId).toBe(r.workload_id);
    await expect(verifyAciReport(r, { nonce, dcap: callback(bytes(r.attestation.report_data)), allowedWorkloads: ["other"] })).rejects.toMatchObject({ code: "workload_not_allowed" });
  });
  test("verifies Ed25519 receipts and rejects altered signatures, keys, algorithms, bindings and body hashes", async () => {
    const request = enc.encode('{"model":"demo"}'); const response = enc.encode('{"choices":[]}'); const est = established();
    const good = signedReceipt(request, response);
    expect(await verifyAciReceipt(good, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).toMatchObject({ receiptId: "rcpt-1", sessionId: "session-1" });
    const flipped = { ...good, signature: `${good.signature.slice(0, -2)}00` };
    await expect(verifyAciReceipt(flipped, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "receipt_signature" });
    const unknown = signedReceipt(request, response, {}, "missing");
    await expect(verifyAciReceipt(unknown, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "receipt_signature" });
    const ecdsaEst = { ...est, receiptKeys: [{ key_id: "r1", algo: "ecdsa-secp256k1", public_key: bytesToHex(pub) }] };
    await expect(verifyAciReceipt(good, { established: ecdsaEst, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "receipt_signature" });
    const badDigest = { ...good, workload_keyset_digest: "sha256:" + "00".repeat(32) };
    await expect(verifyAciReceipt(badDigest, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "receipt_binding" });
    const badWorkload = { ...good, workload_id: "sha256:" + "22".repeat(32) };
    await expect(verifyAciReceipt(badWorkload, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "receipt_binding" });
    await expect(verifyAciReceipt(good, { established: est, requestBody: enc.encode("changed"), responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "body_hash" });
    await expect(verifyAciReceipt(good, { established: est, requestBody: request, responseBody: enc.encode("changed"), requireConfidential: true })).rejects.toMatchObject({ code: "body_hash" });
  });
  test("receipt provider comes from the gateway's route.selected event", async () => {
    const request = new TextEncoder().encode('{"model":"g"}'); const response = new TextEncoder().encode('{"ok":1}');
    const receipt = signedReceipt(request, response, { provider: undefined, event_log: [
      { type: "request.received", body_hash: digest(request) },
      { type: "route.selected", target_route_id: "tinfoil:google/gemma-4-31b-it" },
      { type: "upstream.verified", result: "verified", required: true, model_id: "gemma4-31b", session_id: "s-9" },
      { type: "response.returned", wire_hash: digest(response) },
    ] });
    const out = await verifyAciReceipt(receipt, { established: established(), requestBody: request, responseBody: response, requireConfidential: true });
    expect(out).toMatchObject({ provider: "tinfoil", modelId: "gemma4-31b", sessionId: "s-9" });
  });
  test("requires verified upstream session and receipt workload binding", async () => {
    const request = enc.encode("req"); const response = enc.encode("res"); const est = established();
    const routed = signedReceipt(request, response, { event_log: [{ type: "request.received", body_hash: digest(request) }, { type: "upstream.verified", result: "failed", required: false }, { type: "response.returned", wire_hash: digest(response) }] });
    await expect(verifyAciReceipt(routed, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "upstream_unverified" });
    const missing = signedReceipt(request, response, { event_log: [{ type: "request.received", body_hash: digest(request) }, { type: "response.returned", wire_hash: digest(response) }] });
    await expect(verifyAciReceipt(missing, { established: est, requestBody: request, responseBody: response, requireConfidential: true })).rejects.toMatchObject({ code: "upstream_unverified" });
  });
  test("replays compose measurement against parsed TD RTMR3 and rejects altered or duplicate compose events", async () => {
    const compose = "services: {}"; const composeHash = bytesToHex(sha256(enc.encode(compose)));
    const events = [
      { imr: 3, digest: "01".repeat(48), event: "compose-hash", event_payload: composeHash },
      { imr: 3, digest: "02".repeat(48), event: "system-ready", event_payload: "" },
    ];
    const tdReport = { rtmr: [new Uint8Array(48), new Uint8Array(48), new Uint8Array(48), await replay(events)] };
    const evidence = { event_log: JSON.stringify(events), app_compose: compose };
    expect(await verifyComposeMeasurement(evidence, tdReport)).toEqual({ ok: true, composeHash });
    expect(await verifyComposeMeasurement({ ...evidence, event_log: JSON.stringify([{ ...events[0]!, digest: "03".repeat(48) }, events[1]]) }, tdReport)).toMatchObject({ ok: false });
    expect(await verifyComposeMeasurement({ ...evidence, event_log: JSON.stringify([{ ...events[0]! }, { ...events[0]! }, events[1]]) }, tdReport)).toMatchObject({ ok: false });
    const nonce = "a1".repeat(32); const attested = report(nonce);
    attested.attestation.evidence = { ...evidence, quote: "aabb" };
    const dcap = callback(bytes(attested.attestation.report_data), { tdReport });
    expect((await verifyAciReport(attested, { nonce, dcap, allowedComposeHashes: [composeHash] })).workloadId).toBe(workloadKeysetDigest(KEYSET));
    await expect(verifyAciReport(attested, { nonce, dcap, allowedComposeHashes: ["00".repeat(32)] })).rejects.toMatchObject({ code: "compose_measurement" });
  });
  test("AciClient retries until the third receipt poll, requires headers, refreshes stale reports, and fails closed on DCAP", async () => {
    const noncePattern = /nonce=([0-9a-f]{64})/; let now = 1_700_000_000; let attestCount = 0; let receiptCount = 0; let omitHeader = false; let failDcap = false; const redirectModes: Array<RequestInit['redirect']> = [];
    const responseBytes = enc.encode(JSON.stringify({ choices: [{ message: { content: "{}" } }] })); let requestBytes = new Uint8Array(); let currentReportData = ""; let currentKeyset = KEYSET;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      redirectModes.push(init?.redirect);
      const url = String(input);
      if (url.includes("attestation")) { attestCount++; const nonce = url.match(noncePattern)![1]!; currentKeyset = attestCount === 1 ? KEYSET : { ...KEYSET, not_after: 2_100_000_000 }; const r = report(nonce, currentKeyset); currentReportData = r.attestation.report_data; return Response.json(r); }
      if (url.endsWith("chat/completions")) { requestBytes = new Uint8Array(init?.body as ArrayBuffer); return new Response(responseBytes, { headers: omitHeader ? {} : { "x-receipt-id": "rcpt-1" } }); }
      receiptCount++; if (receiptCount <= 2) return new Response("pending", { status: 404 });
      return Response.json(signedReceipt(requestBytes, responseBytes, {}, "r1", currentKeyset));
    }) as typeof globalThis.fetch;
    const client = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch, now: () => now, dcap: (q) => failDcap ? { ok: false, status: "Invalid", reportType: "tdx", reportData: new Uint8Array() } : { ok: q[0] === 0xaa, status: "UpToDate", reportType: "tdx", reportData: callback(bytes(currentReportData))(q).reportData } });
    const result = await client.chat({ model: "demo", messages: [] }); expect(result.receipt.receiptId).toBe("rcpt-1"); expect(receiptCount).toBe(3); expect(attestCount).toBe(1);
    expect(redirectModes.every((mode) => mode === "error")).toBe(true);
    omitHeader = true; await expect(client.chat({ model: "demo", messages: [] })).rejects.toMatchObject({ code: "receipt_header" });
    now = 2_000_000_001; await client.attest(); expect(attestCount).toBe(2);
    failDcap = true; now += 3601; await expect(client.chat({ model: "demo", messages: [] })).rejects.toMatchObject({ code: "dcap_failed" });
  });
  test("aborts a pending inference body read and bounds the response before receipt polling", async () => {
    let currentData = ""; let inferenceCalls = 0; let bodyCancelled = false;
    const fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("attestation")) { const nonce = url.match(/nonce=([0-9a-f]{64})/)![1]!; const r = report(nonce); currentData = r.attestation.report_data; return Response.json(r); }
      inferenceCalls++;
      return new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel() { bodyCancelled = true; } }), { headers: { "x-receipt-id": "rcpt-1" } });
    }) as typeof globalThis.fetch;
    const client = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch, now: () => 1_700_000_000, dcap: (q) => callback(bytes(currentData))(q) });
    const controller = new AbortController();
    const pending = client.chat({ model: "demo" }, { signal: controller.signal, maxResponseBytes: 8 });
    while (inferenceCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(bodyCancelled).toBe(true);

    let largeCalls = 0;
    const oversizedFetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("attestation")) { const nonce = String(input).match(/nonce=([0-9a-f]{64})/)![1]!; const r = report(nonce); currentData = r.attestation.report_data; return Response.json(r); }
      if (String(input).endsWith("chat/completions")) { largeCalls++; return new Response("12345", { headers: { "x-receipt-id": "unused" } }); }
      throw new Error("receipt must not be requested");
    }) as typeof globalThis.fetch;
    const bounded = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch: oversizedFetch, now: () => 1_700_000_000, dcap: (q) => callback(bytes(currentData))(q) });
    await expect(bounded.chat({ model: "demo" }, { maxResponseBytes: 4 })).rejects.toMatchObject({ code: "response_too_large" });
    expect(largeCalls).toBe(1);
  });
  test("aborts receipt polling delay and propagates the signal to receipt requests", async () => {
    let currentData = ""; let requestBytes = new Uint8Array(); let responseBytes = new Uint8Array(); let receiptReached!: () => void;
    const reached = new Promise<void>((resolve) => { receiptReached = resolve; });
    const signalSeen: AbortSignal[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input); if (init?.signal) signalSeen.push(init.signal);
      if (url.includes("attestation")) { const nonce = url.match(/nonce=([0-9a-f]{64})/)![1]!; const r = report(nonce); currentData = r.attestation.report_data; return Response.json(r); }
      if (url.endsWith("chat/completions")) { requestBytes = new Uint8Array(init?.body as ArrayBuffer); responseBytes = enc.encode('{"choices":[{"message":{"content":"{}"}}]}'); return new Response(responseBytes, { headers: { "x-receipt-id": "rcpt-1" } }); }
      receiptReached(); return new Response("pending", { status: 404 });
    }) as typeof globalThis.fetch;
    const client = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch, now: () => 1_700_000_000, dcap: (q) => callback(bytes(currentData))(q) });
    const controller = new AbortController();
    const pending = client.chat({ model: "demo" }, { signal: controller.signal });
    await reached;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(signalSeen.length).toBeGreaterThanOrEqual(3);
    expect(signalSeen.every((signal) => signal === controller.signal)).toBe(true);
    expect(requestBytes.length).toBeGreaterThan(0);
    expect(responseBytes.length).toBeGreaterThan(0);
  });
  test("rejects non-UpToDate attestation before inference and rejects redirected endpoints", async () => {
    let inferenceCalls = 0; let currentData = "";
    const statusFetch = (async (input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(input).includes("attestation")) { const nonce = String(input).match(/nonce=([0-9a-f]{64})/)![1]!; const r = report(nonce); currentData = r.attestation.report_data; return Response.json(r); }
      inferenceCalls++;
      return new Response("{}", { headers: { "x-receipt-id": "unused" } });
    }) as typeof globalThis.fetch;
    const stale = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch: statusFetch, now: () => 1_700_000_000, dcap: (q) => ({ ...callback(bytes(currentData))(q), status: "OutOfDate" }) });
    await expect(stale.chat({ model: "demo" }, { requireUpToDate: true })).rejects.toMatchObject({ code: "tcb_status" });
    expect(inferenceCalls).toBe(0);

    let attestationRequests = 0; let redirectedInferenceRequests = 0;
    const redirectedFetch = (async (input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(input).includes("attestation")) { attestationRequests++; const nonce = String(input).match(/nonce=([0-9a-f]{64})/)![1]!; const r = report(nonce); currentData = r.attestation.report_data; return Response.json(r); }
      redirectedInferenceRequests++;
      const response = new Response("{}", { headers: { "x-receipt-id": "unused" } });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    }) as typeof globalThis.fetch;
    const redirected = new AciClient({ baseUrl: "https://aci.test/v1", apiKey: "test-key", fetch: redirectedFetch, now: () => 1_700_000_000, dcap: (q) => callback(bytes(currentData))(q) });
    await expect(redirected.chat({ model: "demo" })).rejects.toMatchObject({ code: "inference_redirect" });
    expect(attestationRequests).toBe(1);
    expect(redirectedInferenceRequests).toBe(1);
  });
});
