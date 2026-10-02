import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { staleCollateralGraceSec, type TdxCollateral } from "../src/dcap/collateral.ts";
import { PcsCollateralSource, collateralNextUpdate, isOlderCollateral, sharedPcsCollateralSource } from "../src/dcap/pcs.ts";
import { DcapError, verifyTdxQuote } from "../src/dcap/verify.ts";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { CollateralUnavailableError, DcapQuoteVerifier, verifyWithCollateral } from "../src/verifier.ts";
import { tdxMeasurement } from "../src/tdx-common.ts";
import type { Quote } from "../src/provider.ts";
import { FIXTURE_NOW, readFixture, readFixtureJson } from "./forge-quote.ts";

type Mode = "ok" | "down" | "503" | "404";
type Endpoint = "tcb" | "qe" | "pckCrl" | "rootCrl";
const HOUR = 3600;

function pcsStub(initial: TdxCollateral) {
  let collateral = initial;
  const modes: Record<Endpoint, Mode> = { tcb: "ok", qe: "ok", pckCrl: "ok", rootCrl: "ok" };
  const calls: Endpoint[] = [];
  const respond = (body: string | Uint8Array, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const endpoint: Endpoint = url.pathname.endsWith("/tcb") ? "tcb" : url.pathname.endsWith("/qe/identity") ? "qe" : url.pathname.endsWith("/pckcrl") ? "pckCrl" : "rootCrl";
    calls.push(endpoint);
    const mode = modes[endpoint];
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode !== "ok") return new Response("unavailable", { status: Number(mode) });
    if (endpoint === "tcb") return respond(JSON.stringify({ tcbInfo: JSON.parse(collateral.tcb_info), signature: collateral.tcb_info_signature }), { "TCB-Info-Issuer-Chain": encodeURIComponent(collateral.tcb_info_issuer_chain) });
    if (endpoint === "qe") return respond(JSON.stringify({ enclaveIdentity: JSON.parse(collateral.qe_identity), signature: collateral.qe_identity_signature }), { "SGX-Enclave-Identity-Issuer-Chain": encodeURIComponent(collateral.qe_identity_issuer_chain) });
    if (endpoint === "pckCrl") return respond(hexToBytes(`0x${collateral.pck_crl}`), { "SGX-PCK-CRL-Issuer-Chain": encodeURIComponent(collateral.pck_crl_issuer_chain) });
    return respond(hexToBytes(`0x${collateral.root_ca_crl}`));
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch, calls, modes,
    setAll(mode: Mode) { for (const key of Object.keys(modes) as Endpoint[]) modes[key] = mode; },
    serve(next: TdxCollateral) { collateral = next; },
  };
}

const dirs: string[] = [];
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), "mochi-pcs-")); dirs.push(dir); return dir; }
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const FMSPC = "B0C06F000000";

describe("PCS collateral cache", () => {
  test("an outage is served from cache within the grace and refused after it, through the real DCAP verifier", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const raw = await readFixture("tdx_quote");
    const expiry = collateralNextUpdate(collateral);
    let now = FIXTURE_NOW - 24 * HOUR;
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, staleGraceSec: 48 * HOUR, random: () => 0 });
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
    pcs.setAll("down");

    // One hour past nextUpdate: PCS is unreachable, so the cached copy is served, marked with the grace.
    now = expiry + HOUR;
    const stale = await source.get(FMSPC, "platform");
    expect(stale).toEqual(collateral);
    expect(staleCollateralGraceSec(stale)).toBe(48 * HOUR);
    expect(() => verifyTdxQuote(raw, collateral, now)).toThrow("PCK CRL");
    expect(verifyTdxQuote(raw, stale, now, { collateralGraceSec: staleCollateralGraceSec(stale) }).status).toBe("UpToDate");

    // DcapQuoteVerifier passes DCAP (and then rejects this sample's non-Mochi REPORTDATA layout) inside the grace...
    const { td } = parseTdxQuote(raw);
    const quote: Quote = { kind: "tdx", raw: bytesToHex(raw), measurement: tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr }), reportData: `0x${"00".repeat(32)}` as Hex, issuedAt: 0 };
    const verifier = new DcapQuoteVerifier({ collateral: source, now: () => now });
    now = expiry + 47 * HOUR;
    expect((await verifier.verify(quote)).reason).toBe("reportData layout");
    // ...and refuses once the grace has run out.
    now = expiry + 48 * HOUR + 60;
    expect((await verifier.verify(quote)).reason).toBe("dcap: collateral unavailable");
    await expect(source.get(FMSPC, "platform")).rejects.toThrow();
  });

  test("an answer from PCS is never replaced by stale data: 4xx refuses, and fresh components win", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const newer = await readFixtureJson("tdx_quote_outdated_collateral.json") as TdxCollateral;
    const expiry = collateralNextUpdate(collateral);
    let now = FIXTURE_NOW - 24 * HOUR;
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, random: () => 0 });
    await source.get(FMSPC, "platform");

    now = expiry + HOUR;
    pcs.setAll("404");
    await expect(source.get(FMSPC, "platform")).rejects.toThrow("PCS HTTP 404");

    // PCS returns a fresh PCK CRL (which could list a revoked PCK) while the other endpoints are down.
    now += HOUR;
    pcs.setAll("down");
    pcs.modes.pckCrl = "ok";
    pcs.serve(newer);
    const merged = await source.get(FMSPC, "platform");
    expect(merged.pck_crl).toBe(newer.pck_crl);
    expect(merged.tcb_info).toBe(collateral.tcb_info);
  });

  test("an outage with nothing cached fails, and retries back off exponentially with jitter", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const start = FIXTURE_NOW - 24 * HOUR;
    let now = start;
    const pcs = pcsStub(collateral);
    pcs.setAll("down");
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, backoffBaseSec: 10, backoffMaxSec: 80, random: () => 0.5 });
    await expect(source.get(FMSPC, "platform")).rejects.toThrow("PCS unreachable");
    expect(pcs.calls).toHaveLength(4);
    // Equal jitter with random 0.5: delays of 7.5 s, 15 s, 30 s, 60 s, then capped at 60 s.
    const attemptsAt: number[] = [];
    for (let t = start + 1; t <= start + 300; t++) {
      now = t;
      const before = pcs.calls.length;
      await source.get(FMSPC, "platform").catch(() => undefined);
      if (pcs.calls.length > before) attemptsAt.push(t - start);
    }
    expect(attemptsAt.slice(0, 5)).toEqual([8, 23, 53, 113, 173]);
    pcs.setAll("ok");
    now = start + 1000;
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
  });

  test("concurrent callers share one PCS round", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => FIXTURE_NOW - HOUR * 24 });
    const results = await Promise.all(Array.from({ length: 9 }, () => source.get(FMSPC, "platform")));
    expect(results.every((value) => value === results[0])).toBe(true);
    expect(pcs.calls).toHaveLength(4);
  });

  test("refresh-ahead: a day-old entry is refreshed in the background while the cached copy keeps serving", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    let now = FIXTURE_NOW - 10 * 24 * HOUR;
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now });
    await source.get(FMSPC, "platform");
    now += 12 * HOUR;
    await source.get(FMSPC, "platform");
    expect(pcs.calls).toHaveLength(4);
    now += 13 * HOUR;
    pcs.setAll("down");
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
    await source.settled();
    expect(pcs.calls).toHaveLength(8);
    // The failed background refresh backs off instead of retrying on every call.
    await source.get(FMSPC, "platform");
    await source.settled();
    expect(pcs.calls).toHaveLength(8);
  });

  test("the persisted cache survives a restart and serves without PCS; malformed files are ignored", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const dir = await tempDir();
    const now = FIXTURE_NOW - 24 * HOUR;
    const pcs = pcsStub(collateral);
    await new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, cacheDir: dir }).get(FMSPC, "platform");
    expect(await readdir(dir)).toEqual([`${FMSPC}-platform.json`]);
    expect(JSON.parse(await readFile(join(dir, `${FMSPC}-platform.json`), "utf8")).collateral).toEqual(collateral);

    const offline = pcsStub(collateral);
    offline.setAll("down");
    const restarted = new PcsCollateralSource({ fetch: offline.fetch, now: () => now, cacheDir: dir });
    expect(await restarted.get(FMSPC, "platform")).toEqual(collateral);
    expect(offline.calls).toHaveLength(0);
    // After a restart during an outage that outlasts nextUpdate, the persisted copy is still bounded by the grace.
    const late = new PcsCollateralSource({ fetch: offline.fetch, now: () => collateralNextUpdate(collateral) + HOUR, cacheDir: dir, staleGraceSec: 24 * HOUR });
    expect(staleCollateralGraceSec(await late.get(FMSPC, "platform"))).toBe(24 * HOUR);

    await writeFile(join(dir, `${FMSPC}-processor.json`), "{not json");
    await expect(restarted.get(FMSPC, "processor")).rejects.toThrow("PCS unreachable");
  });

  test("the process-wide source is shared per PCS endpoint and the first cache directory wins", async () => {
    const dir = await tempDir();
    const a = sharedPcsCollateralSource({ baseUrl: "https://pcs-shared.test/" });
    const b = sharedPcsCollateralSource({ baseUrl: "https://pcs-shared.test", cacheDir: dir });
    const c = sharedPcsCollateralSource({ baseUrl: "https://pcs-shared.test", cacheDir: join(dir, "other") });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.persistenceDir).toBe(dir);
    expect(sharedPcsCollateralSource({ baseUrl: "https://pcs-other.test" })).not.toBe(a);
  });

  test("grace is bounded to 72 hours", () => {
    expect(() => new PcsCollateralSource({ staleGraceSec: 73 * HOUR })).toThrow(RangeError);
    expect(() => new PcsCollateralSource({ staleGraceSec: 0 })).not.toThrow();
  });
});

describe("the PCS cache trusts only Intel-signed collateral", () => {
  const entryFile = (collateral: TdxCollateral, fetchedAt: number, fmspc = FMSPC, ca = "platform") => JSON.stringify({ v: 1, fmspc, ca, fetchedAt, collateral });

  test("a poisoned, unsigned, misattributed or corrupt persisted entry is never adopted", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const now = FIXTURE_NOW - 24 * HOUR;
    const tcb = JSON.parse(collateral.tcb_info);
    tcb.nextUpdate = "2099-01-01T00:00:00Z";
    const cases: [string, string, string?][] = [
      // nextUpdate pushed out without Intel's signature: it would otherwise keep a bad copy alive for years.
      ["poisoned TCB info", entryFile({ ...collateral, tcb_info: JSON.stringify(tcb) }, now)],
      ["unsigned QE identity", entryFile({ ...collateral, qe_identity_signature: "" }, now)],
      ["root CRL in place of the PCK CRL", entryFile({ ...collateral, pck_crl: collateral.root_ca_crl }, now)],
      ["genuine collateral of another FMSPC", entryFile(collateral, now, "00906ED50000"), "00906ED50000"],
      ["platform collateral in the processor file", entryFile(collateral, now, FMSPC, "processor"), "processor"],
      ["truncated file", entryFile(collateral, now).slice(0, 500)],
      ["malformed CRL", entryFile({ ...collateral, pck_crl: "zz" }, now)],
    ];
    for (const [name, content, variant] of cases) {
      const dir = await tempDir();
      const fmspc = variant === "00906ED50000" ? variant : FMSPC;
      const ca = variant === "processor" ? "processor" : "platform";
      await writeFile(join(dir, `${fmspc}-${ca}.json`), content);
      const offline = pcsStub(collateral);
      offline.setAll("down");
      const restarted = new PcsCollateralSource({ fetch: offline.fetch, now: () => now, cacheDir: dir });
      // Nothing usable on disk, so the source asks PCS (down) and refuses rather than serving the file.
      await expect(restarted.get(fmspc, ca), name).rejects.toThrow("PCS unreachable");
      expect(offline.calls.length, name).toBe(4);
    }
    // Control: the genuine entry is adopted and served without PCS.
    const dir = await tempDir();
    await writeFile(join(dir, `${FMSPC}-platform.json`), entryFile(collateral, now));
    const offline = pcsStub(collateral);
    offline.setAll("down");
    expect(await new PcsCollateralSource({ fetch: offline.fetch, now: () => now, cacheDir: dir }).get(FMSPC, "platform")).toEqual(collateral);
    expect(offline.calls).toHaveLength(0);
  });

  test("a poisoned persisted entry is replaced by PCS's answer, and PCS answers that fail verification are refused", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const now = FIXTURE_NOW - 24 * HOUR;
    const dir = await tempDir();
    await writeFile(join(dir, `${FMSPC}-platform.json`), entryFile({ ...collateral, tcb_info_signature: collateral.qe_identity_signature }, now));
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, cacheDir: dir });
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
    expect(JSON.parse(await readFile(join(dir, `${FMSPC}-platform.json`), "utf8")).collateral).toEqual(collateral);

    // PCS itself answering with a body its signature does not cover is an answer, not an outage: refused, not cached.
    expect(collateral.tcb_info).toContain('"tcbType":0');
    const tampered = pcsStub({ ...collateral, tcb_info: collateral.tcb_info.replace('"tcbType":0', '"tcbType":1') });
    const fresh = new PcsCollateralSource({ fetch: tampered.fetch, now: () => now, random: () => 0 });
    await expect(fresh.get(FMSPC, "platform")).rejects.toThrow("PCS tcb rejected: TCB signature");
  });

  test("an older TCB evaluation never replaces a newer one, from PCS or from the persisted cache", async () => {
    // Real Intel-signed data: FMSPC 90C06F000000 at evaluation 18 (2026), and an "older" set that keeps the same TCB
    // info but carries the evaluation-17 QE identity and CRLs from 2025 (QE identity and CRLs are not per FMSPC).
    const fmspc = "90C06F000000";
    const newer = await readFixtureJson("tdx_quote_outdated_collateral.json") as TdxCollateral;
    const evaluation17 = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const older: TdxCollateral = { ...evaluation17, tcb_info: newer.tcb_info, tcb_info_signature: newer.tcb_info_signature, tcb_info_issuer_chain: newer.tcb_info_issuer_chain };
    expect(JSON.parse(older.qe_identity).tcbEvaluationDataNumber).toBe(17);
    expect(JSON.parse(newer.qe_identity).tcbEvaluationDataNumber).toBe(18);
    let now = Date.parse(JSON.parse(newer.tcb_info).issueDate) / 1000 + HOUR;
    const pcs = pcsStub(newer);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, random: () => 0 });
    expect(await source.get(fmspc, "platform")).toEqual(newer);

    // A day later PCS (a stale replica, say) serves the older evaluation: the background refresh refuses those parts.
    pcs.serve(older);
    now += 25 * HOUR;
    expect(await source.get(fmspc, "platform")).toEqual(newer);
    await source.settled();
    expect(pcs.calls).toHaveLength(8);
    expect(await source.get(fmspc, "platform")).toEqual(newer);

    // Once the newer copy has expired, the older answer is still refused rather than accepted.
    now = collateralNextUpdate(newer) + HOUR;
    await expect(source.get(fmspc, "platform")).rejects.toThrow("PCS qe older than cached");

    // The persisted cache cannot roll it back either, even with a later fetchedAt.
    const dir = await tempDir();
    now = Date.parse(JSON.parse(newer.tcb_info).issueDate) / 1000 + HOUR;
    const memory = new PcsCollateralSource({ fetch: pcsStub(newer).fetch, now: () => now });
    await memory.get(fmspc, "platform");
    await writeFile(join(dir, `${fmspc}-platform.json`), entryFile(older, now + 60, fmspc));
    now += 120;
    memory.persistTo(dir);
    expect(await memory.get(fmspc, "platform")).toEqual(newer);
  });

  test("the evaluation-number rule for TCB info of one FMSPC: lower never wins, equal falls back to the issue date", () => {
    const tcb = (evaluation: number | undefined, issueDate: string) => ({ tcb_info: JSON.stringify({ id: "TDX", version: 3, issueDate, fmspc: FMSPC, ...(evaluation === undefined ? {} : { tcbEvaluationDataNumber: evaluation }) }) });
    const current = tcb(18, "2026-02-18T10:58:51Z") as TdxCollateral;
    expect(isOlderCollateral("tcb", tcb(17, "2026-09-01T00:00:00Z"), current)).toBe(true);
    expect(isOlderCollateral("tcb", tcb(undefined, "2026-09-01T00:00:00Z"), current)).toBe(true);
    expect(isOlderCollateral("tcb", tcb(18, "2026-02-17T00:00:00Z"), current)).toBe(true);
    expect(isOlderCollateral("tcb", tcb(18, "2026-02-18T10:58:51Z"), current)).toBe(false);
    expect(isOlderCollateral("tcb", tcb(18, "2026-03-01T00:00:00Z"), current)).toBe(false);
    expect(isOlderCollateral("tcb", tcb(19, "2026-01-01T00:00:00Z"), current)).toBe(false);
  });

  test("invalidate drops the cached copy and fetches it again; a copy PCS just served backs off first", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    let now = FIXTURE_NOW - 10 * 24 * HOUR;
    const dir = await tempDir();
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, cacheDir: dir, random: () => 0 });
    const first = await source.get(FMSPC, "platform");
    expect(pcs.calls).toHaveLength(4);
    // Not the cached copy: ignored.
    source.invalidate(FMSPC, "platform", { ...first, pck_crl: first.root_ca_crl });
    expect(await source.get(FMSPC, "platform")).toBe(first);
    expect(pcs.calls).toHaveLength(4);

    now += HOUR;
    source.invalidate(FMSPC, "platform", { ...first });
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
    expect(pcs.calls).toHaveLength(8);
    // The refetched copy fails too: PCS is not asked again at once.
    source.invalidate(FMSPC, "platform", collateral);
    await expect(source.get(FMSPC, "platform")).rejects.toThrow("PCS backoff");
    expect(pcs.calls).toHaveLength(8);
    // The rejected copy on disk is not brought back while PCS is down...
    pcs.setAll("down");
    now += 60;
    await expect(source.get(FMSPC, "platform")).rejects.toThrow("PCS unreachable");
    // ...and PCS's next answer replaces it.
    pcs.setAll("ok");
    now += 600;
    expect(await source.get(FMSPC, "platform")).toEqual(collateral);
  });

  test("DcapQuoteVerifier drops collateral that fails its signature or chain checks and verifies once more with a fresh copy", async () => {
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    const raw = await readFixture("tdx_quote");
    const { td } = parseTdxQuote(raw);
    const quote: Quote = { kind: "tdx", raw: bytesToHex(raw), measurement: tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr }), reportData: `0x${"00".repeat(32)}` as Hex, issuedAt: 0 };
    let now = FIXTURE_NOW - 10 * 24 * HOUR;
    const pcs = pcsStub(collateral);
    const source = new PcsCollateralSource({ fetch: pcs.fetch, now: () => now, random: () => 0 });
    await source.get(FMSPC, "platform");
    now = FIXTURE_NOW;
    const seen: TdxCollateral[] = [];
    let failWith: string | undefined = "TCB signature";
    const verifier = new DcapQuoteVerifier({
      collateral: source, now: () => FIXTURE_NOW,
      verifyDcap: (bytes, given, at, options) => {
        seen.push(given);
        if (failWith) { const code = failWith; failWith = undefined; throw new DcapError(code); }
        return verifyTdxQuote(bytes, given, at, options);
      },
    });
    // The fixture passes DCAP on the second attempt and then fails only MOCHI's REPORTDATA layout check.
    expect((await verifier.verify(quote)).reason).toBe("reportData layout");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(pcs.calls).toHaveLength(8);

    // A failure that is about the quote (or a revocation), not the collateral, keeps the cached copy.
    for (const code of ["TCB not supported", "PCK revoked", "QE identity mismatch"]) {
      failWith = code;
      expect((await verifier.verify(quote)).reason).toBe(`dcap: ${code}`);
    }
    expect(pcs.calls).toHaveLength(8);
  });

  test("verifyWithCollateral (also used by the juror's Phala ACI check) retries once after invalidating, and only for collateral faults", async () => {
    const copies = [{ tag: 1 }, { tag: 2 }, { tag: 3 }] as unknown as TdxCollateral[];
    const make = () => {
      const log: string[] = [];
      let next = 0;
      return {
        log,
        source: {
          get: async () => { log.push("get"); return copies[next++]!; },
          invalidate: (_fmspc: string, _ca: "platform" | "processor", collateral: TdxCollateral) => { log.push(`invalidate ${(collateral as unknown as { tag: number }).tag}`); },
        },
      };
    };
    const target = { fmspc: FMSPC, ca: "platform" as const };
    const a = make();
    let calls = 0;
    expect(await verifyWithCollateral(a.source, target, (collateral) => {
      if (calls++ === 0) throw new DcapError("QE identity signature");
      return (collateral as unknown as { tag: number }).tag;
    })).toBe(2);
    expect(a.log).toEqual(["get", "invalidate 1", "get"]);

    const b = make();
    await expect(verifyWithCollateral(b.source, target, () => { throw new DcapError("PCK CRL issuer"); })).rejects.toThrow("PCK CRL issuer");
    expect(b.log).toEqual(["get", "invalidate 1", "get", "invalidate 2"]);

    const c = make();
    await expect(verifyWithCollateral(c.source, target, () => { throw new DcapError("TCB not supported"); })).rejects.toThrow("TCB not supported");
    expect(c.log).toEqual(["get"]);

    await expect(verifyWithCollateral({ get: async () => { throw new Error("PCS HTTP 503"); } }, target, () => 1)).rejects.toBeInstanceOf(CollateralUnavailableError);
  });
});
