import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { collateralNextUpdate, parseTdxQuote, quoteVerifierFromEnv, tdxMeasurement, type TdxCollateral } from "@mochi/tee";
import { createPhalaDcap } from "../src/phala-dcap.ts";
import { PhalaAciRunner } from "../src/runner.ts";
import { warmupModel } from "../src/warmup.ts";
import { FIXTURE_NOW, readFixture, readFixtureJson } from "../../../packages/tee/test/forge-quote.ts";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => { globalThis.fetch = originalFetch; setSystemTime(); });
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

/** Intel PCS stand-in on a test-only host, so the process-wide shared source is exercised without any network. */
function stubPcs(collateral: TdxCollateral, host: string) {
  const state = { calls: 0, down: false };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== host) throw new Error(`unexpected host ${url.host}`);
    state.calls++;
    if (state.down) throw new TypeError("fetch failed");
    const ok = (body: string | Uint8Array, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
    if (url.pathname.endsWith("/tcb")) return ok(JSON.stringify({ tcbInfo: JSON.parse(collateral.tcb_info), signature: collateral.tcb_info_signature }), { "TCB-Info-Issuer-Chain": encodeURIComponent(collateral.tcb_info_issuer_chain) });
    if (url.pathname.endsWith("/qe/identity")) return ok(JSON.stringify({ enclaveIdentity: JSON.parse(collateral.qe_identity), signature: collateral.qe_identity_signature }), { "SGX-Enclave-Identity-Issuer-Chain": encodeURIComponent(collateral.qe_identity_issuer_chain) });
    if (url.pathname.endsWith("/pckcrl")) return ok(hexToBytes(`0x${collateral.pck_crl}`), { "SGX-PCK-CRL-Issuer-Chain": encodeURIComponent(collateral.pck_crl_issuer_chain) });
    return ok(hexToBytes(`0x${collateral.root_ca_crl}`));
  }) as unknown as typeof fetch;
  return state;
}

test("the juror's ACI DCAP check reuses the process-wide, persisted PCS cache and rides out a PCS outage within the grace", async () => {
  const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
  const raw = await readFixture("tdx_quote");
  const state = await mkdtemp(join(tmpdir(), "mochi-juror-dcap-"));
  dirs.push(state);
  const host = "pcs-juror-shared.test";
  const env = { PCS_BASE_URL: `https://${host}`, PCS_ROOT_CA_CRL_URL: `https://${host}/IntelSGXRootCA.der`, SEALED_STORE_DIR: join(state, "juror-0") };
  setSystemTime(new Date((FIXTURE_NOW - 86_400) * 1000));
  const pcs = stubPcs(collateral, host);

  // MOCHI's own quote check fills the shared cache (the sample quote then fails Mochi's REPORTDATA layout, after DCAP).
  const { td } = parseTdxQuote(raw);
  const quote = { kind: "tdx" as const, raw: bytesToHex(raw), measurement: tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr }), reportData: `0x${"00".repeat(32)}` as Hex, issuedAt: 0 };
  expect((await quoteVerifierFromEnv({ ...env, QUOTE_VERIFIER: "dcap" }).verify(quote)).reason).toBe("reportData layout");
  expect(pcs.calls).toBe(4);

  // Every seat's ACI check then uses it: no further PCS requests.
  for (const seat of [0, 1, 2]) {
    const result = await createPhalaDcap({ env: { ...env, SEALED_STORE_DIR: join(state, `juror-${seat}`) } })(raw);
    expect(result).toMatchObject({ ok: true, status: "UpToDate", reportType: "tdx" });
  }
  expect(pcs.calls).toBe(4);
  expect(await readdir(join(state, "dcap-collateral"))).toEqual(["B0C06F000000-platform.json"]);

  // Intel PCS goes down and the collateral passes its nextUpdate: served within the grace, refused after it.
  pcs.down = true;
  const expiry = collateralNextUpdate(collateral);
  setSystemTime(new Date((expiry + 3600) * 1000));
  expect(await createPhalaDcap({ env })(raw)).toMatchObject({ ok: true, status: "UpToDate" });
  setSystemTime(new Date((expiry + 49 * 3600) * 1000));
  await expect(createPhalaDcap({ env })(raw)).rejects.toThrow();
});

test("a forged ACI quote is refused before any collateral is requested", async () => {
  let calls = 0;
  const dcap = createPhalaDcap({ env: {}, collateral: { get: async () => { calls++; throw new Error("unreachable"); } }, now: () => FIXTURE_NOW });
  const raw = await readFixture("tdx_quote");
  const forged = raw.slice();
  const at = forged.length - 200; // inside the PEM chain
  forged[at] = forged[at]! ^ 0x01;
  expect(await dcap(forged)).toMatchObject({ ok: false, status: "Invalid" });
  expect(calls).toBe(0);
});

test("the gateway TCB policy follows TDX_ALLOWED_TCB_STATUSES; the default stays UpToDate only", async () => {
  const replies: Array<Record<string, unknown> | undefined> = [];
  const client = { chat: async (_body: unknown, options?: Record<string, unknown>) => {
    replies.push(options);
    return { json: { choices: [{ message: { content: "{}" } }] }, receipt: { receiptId: "r", sessionId: "s", workloadId: "w", modelId: "provider/model" }, established: { workloadId: "w", tcbStatus: "OutOfDate" } };
  } };
  const input = { system: "s", user: "u", document: "d", jsonSchema: {}, maxTokens: 16 };
  await expect(new PhalaAciRunner({ client: client as never, model: "provider/model", timeoutMs: 1000 }).run(input as never)).rejects.toThrow("TCB status");
  expect(replies[0]).toMatchObject({ requireUpToDate: true });
  const relaxed = new PhalaAciRunner({ client: client as never, model: "provider/model", timeoutMs: 1000, allowedTcbStatuses: ["UpToDate", "OutOfDate"] });
  expect(await relaxed.run(input as never)).toEqual({});
  expect(replies[1]).toMatchObject({ allowedTcbStatuses: ["UpToDate", "OutOfDate"] });

  const codes: string[] = [];
  const attest = async () => ({ tcbStatus: "OutOfDate" });
  await warmupModel({ attest }, "provider/model", new AbortController().signal, (event) => codes.push(event.causeCode!), { sleep: async () => {}, attempts: 1 });
  await warmupModel({ attest }, "provider/model", new AbortController().signal, (event) => codes.push(event.causeCode!), { sleep: async () => {}, attempts: 1, allowedTcbStatuses: ["UpToDate", "OutOfDate"] });
  expect(codes).toEqual(["warmup_failed", "warmup_ok"]);
});

test("a gateway that no longer matches its os: pin is reported as os_measurement, so operators know to re-pin", async () => {
  const { AciVerificationError } = await import("@mochi/aci");
  const runner = new PhalaAciRunner({ client: { chat: async () => { throw new AciVerificationError("os_measurement"); } } as never, model: "provider/model", timeoutMs: 1000, maxAttempts: 1 });
  await expect(runner.run({ system: "s", user: "u", document: "d", jsonSchema: {}, maxTokens: 16 } as never)).rejects.toThrow();
  expect(runner.lastFailure?.causeCode).toBe("os_measurement");
});
