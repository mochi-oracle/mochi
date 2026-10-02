import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { staleCollateralGraceSec, type TdxCollateral } from "../src/dcap/collateral.ts";
import { PcsCollateralSource, collateralNextUpdate, sharedPcsCollateralSource } from "../src/dcap/pcs.ts";
import { verifyTdxQuote } from "../src/dcap/verify.ts";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { DcapQuoteVerifier } from "../src/verifier.ts";
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
