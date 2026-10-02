import { describe, expect, test } from "bun:test";
import { bytesToHex, type Hex } from "viem";
import { DcapError, verifyTdxQuote, verifyTdxQuoteEvidence } from "../src/dcap/verify.ts";
import { parseTdxQuote } from "../src/dcap/quote.ts";
import { pemChain, type Cert } from "../src/dcap/x509.ts";
import type { CollateralSource, TdxCollateral } from "../src/dcap/collateral.ts";
import { DcapQuoteVerifier } from "../src/verifier.ts";
import { tdxMeasurement, tdxReportData } from "../src/tdx-common.ts";
import type { Quote } from "../src/provider.ts";
import {
  FIXTURE_NOW, bogusFmspcQuote, buildQuote, keyPair, pem, readFixture, readFixtureJson, resignCert, selfSignedChainQuote,
} from "./forge-quote.ts";

const binding = `0x${"ab".repeat(32)}` as Hex;
const issuedAt = FIXTURE_NOW - 10;

function countingCollateral(collateral?: TdxCollateral): CollateralSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(fmspc, ca) {
      calls.push(`${fmspc}:${ca}`);
      if (!collateral) throw new Error("PCS HTTP 404");
      return collateral;
    },
  };
}

function quoteOf(raw: Uint8Array): Quote {
  const { td } = parseTdxQuote(raw);
  return { kind: "tdx", raw: bytesToHex(raw), measurement: tdxMeasurement({ mrtd: td.mrTd, rtmr: td.rtmr }), reportData: binding, issuedAt };
}

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof DcapError ? error.code : String(error); }
  return "ok";
};

describe("PCK chain is validated against the pinned Intel root before collateral", () => {
  test("the genuine fixture quote passes the collateral-free evidence checks and yields its Intel-signed FMSPC", async () => {
    const evidence = verifyTdxQuoteEvidence(await readFixture("tdx_quote"), FIXTURE_NOW);
    expect(evidence.fmspc).toBe("B0C06F000000");
    expect(evidence.ca).toBe("platform");
  });

  test("a self-made chain with Intel's names and the real FMSPC is rejected as an untrusted root, without fetching collateral", async () => {
    const raw = await selfSignedChainQuote({ reportData: tdxReportData(binding, issuedAt) });
    // The forgery is internally consistent: only the root anchors it to the attacker.
    expect(pemChain(parseTdxQuote(raw).pckPem)[0]!.sgx!.fmspc).toEqual(Uint8Array.from([0xb0, 0xc0, 0x6f, 0, 0, 0]));
    expect(codeOf(() => verifyTdxQuoteEvidence(raw, FIXTURE_NOW))).toBe("PCK untrusted root");
    const collateral = countingCollateral(await readFixtureJson("tdx_quote_collateral.json"));
    const result = await new DcapQuoteVerifier({ collateral, now: () => FIXTURE_NOW }).verify(quoteOf(raw));
    expect(result).toEqual({ ok: false, reason: "dcap: PCK untrusted root" });
    expect(collateral.calls).toEqual([]);
  });

  test("a self-made CA under the real Intel root fails the certificate signature check", async () => {
    const raw = await readFixture("tdx_quote");
    const [leaf, intermediate, root] = pemChain(parseTdxQuote(raw).pckPem) as [Cert, Cert, Cert];
    const caKey = keyPair(), pckKey = keyPair();
    const chain = pem([resignCert(leaf, caKey.secret, { publicKey: pckKey.publicKey }), resignCert(intermediate, keyPair().secret, { publicKey: caKey.publicKey }), root.der]);
    const forged = buildQuote(raw, { pckPem: chain, pckSigner: pckKey.secret });
    expect(codeOf(() => verifyTdxQuoteEvidence(forged, FIXTURE_NOW))).toBe("PCK certificate signature");
  });

  test("a bogus FMSPC is rejected as a certificate signature failure and never reaches PCS", async () => {
    for (const resign of [false, true]) {
      const raw = await bogusFmspcQuote({ resign, reportData: tdxReportData(binding, issuedAt) });
      expect(bytesToHex(pemChain(parseTdxQuote(raw).pckPem)[0]!.sgx!.fmspc)).toBe("0xdeadbeef0001");
      const collateral = countingCollateral();
      const result = await new DcapQuoteVerifier({ collateral, now: () => FIXTURE_NOW }).verify(quoteOf(raw));
      expect(result).toEqual({ ok: false, reason: "dcap: PCK certificate signature" });
      expect(collateral.calls).toEqual([]);
    }
  });

  test("a forged chain stays forged when its dates are also wrong; a genuine chain out of its window is a clock failure", async () => {
    const raw = await readFixture("tdx_quote");
    const [leaf, intermediate, root] = pemChain(parseTdxQuote(raw).pckPem) as [Cert, Cert, Cert];
    // Forged leaf under the real CA and root, with a notAfter in 2024 (the real one is 2032).
    const expire = (tbs: Uint8Array) => {
      const text = Buffer.from(tbs).toString("latin1");
      const at = text.indexOf("320206232551Z");
      if (at < 0) throw new Error("notAfter not found");
      tbs.set(new TextEncoder().encode("240206232551Z"), at);
    };
    const pckKey = keyPair();
    const forged = buildQuote(raw, { pckPem: pem([resignCert(leaf, keyPair().secret, { publicKey: pckKey.publicKey, editTbs: expire }), intermediate.der, root.der]), pckSigner: pckKey.secret });
    expect(codeOf(() => verifyTdxQuoteEvidence(forged, FIXTURE_NOW))).toBe("PCK certificate signature");
    // The genuine quote, checked in 2033 after its PCK certificate expired.
    const later = Date.UTC(2033, 0, 1) / 1000;
    expect(codeOf(() => verifyTdxQuoteEvidence(raw, later))).toBe("PCK certificate validity");
    const collateral = countingCollateral();
    expect((await new DcapQuoteVerifier({ collateral, now: () => later }).verify(quoteOf(raw))).reason).toBe("dcap: PCK certificate validity");
    expect(collateral.calls).toEqual([]);
  });

  test("a genuine chain with a forged QE report or quote signature fails before collateral", async () => {
    const raw = await readFixture("tdx_quote");
    // Copying a real PCK chain is easy (it is public); without the PCK key the QE report signature cannot match.
    const forged = buildQuote(raw, { pckSigner: keyPair().secret });
    expect(codeOf(() => verifyTdxQuoteEvidence(forged, FIXTURE_NOW))).toBe("QE report signature");
    const body = buildQuote(raw, { reportData: tdxReportData(binding, issuedAt) });
    expect(codeOf(() => verifyTdxQuoteEvidence(body, FIXTURE_NOW))).toBe("quote signature");
    const collateral = countingCollateral();
    expect((await new DcapQuoteVerifier({ collateral, now: () => FIXTURE_NOW }).verify(quoteOf(body))).reason).toBe("dcap: quote signature");
    expect(collateral.calls).toEqual([]);
  });

  test("full verification still passes for the genuine quote and keeps collateral failures distinct", async () => {
    const raw = await readFixture("tdx_quote");
    const collateral = await readFixtureJson("tdx_quote_collateral.json") as TdxCollateral;
    expect(verifyTdxQuote(raw, collateral, FIXTURE_NOW).status).toBe("UpToDate");
    // A PCK CRL issuer chain that is not anchored in the pinned root is a collateral problem, not quote forgery.
    expect(codeOf(() => verifyTdxQuote(raw, { ...collateral, pck_crl_issuer_chain: collateral.tcb_info_issuer_chain }, FIXTURE_NOW))).toBe("PCK CRL issuer");
  });
});
