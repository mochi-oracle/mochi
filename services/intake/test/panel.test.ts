import { describe, expect, test } from "bun:test";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x25519 } from "@noble/curves/ed25519.js";
import { toHex } from "viem";
import { aad, evaluatorKeyDigest, PanelDocPlainSchema, provenanceFromJson } from "@mochi/protocol";
import { docCommit, provenanceHash, ZERO32 } from "@mochi/core";
import { MemorySealedStore, MockQuoteVerifier, MockTeeProvider, open, seal } from "@mochi/tee";
import { IntakeEnclave, IntakeError } from "../src/intake.ts";
import { createIntakeApp } from "../src/app.ts";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const measurement = `0x${"22".repeat(32)}` as Hex;
const tee = new MockTeeProvider({ seed: `0x${"33".repeat(32)}`, measurement, mockRoot: root });
const queryId = `0x${"ab".repeat(32)}` as Hex;
const doc = new TextEncoder().encode("Reserve report: supply 100, reserves 99.");

async function setup(opts: { status?: number; isPublic?: boolean; consent?: boolean; panelIndex?: number; caseStatus?: number } = {}) {
  const evaluators = [1, 2, 3].map((i) => privateKeyToAccount(`0x${String(i).repeat(64)}` as Hex));
  const isPublic = opts.isPublic ?? true;
  const salt = isPublic ? ZERO32 : `0x${"5a".repeat(32)}` as Hex;
  const commit = docCommit(salt, sha256(doc));
  let openedWith = ZERO32 as Hex;
  const chain = {
    getQuery: async () => ({
      status: opts.status ?? 5, docCommit: commit, paramsHash: ZERO32 as Hex, schemaId: 4, schemaVersion: 1,
      isPublic, allowPanelDisclosure: opts.consent ?? false, provenanceHash: openedWith,
    }),
    jurorsOf: async () => [], isActive: async () => true, getJuror: async () => ({ measurement }),
    getPanelCase: async () => ({ status: opts.caseStatus ?? 2, panelIndex: opts.panelIndex ?? 0 }),
    panelOf: async () => evaluators.map((e) => e.address as Hex),
  };
  const store = new MemorySealedStore();
  const intake = new IntakeEnclave({
    tee, chain, store, fetchPolicy: { origins: [] },
    httpGetter: { get: async () => { throw new Error("no network"); } },
    quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), chainId: 31337,
    escrowAddress: `0x${"66".repeat(20)}`, clock: { nowSeconds: () => 1_700_000_000 },
  });
  // The grant (and so the stored record) carries the payer's consent exactly as sealed with the document.
  const open = { opener: "0x00000000000000000000000000000000000000b0", payerCommit: isPublic ? ZERO32 : `0x${"88".repeat(32)}`, isPublic, allowPanelDisclosure: opts.consent ?? false, nonce: "5" };
  const plain = { v: 1, schemaId: 4, salt, params: {}, contentType: "text/plain", docB64: Buffer.from(doc).toString("base64"), open };
  const uploaded = await intake.intakeUpload(seal(tee.encryptionPublicKey(), new TextEncoder().encode(JSON.stringify(plain)), aad.intake()));
  openedWith = provenanceHash(provenanceFromJson(uploaded.provenance));
  const keys = evaluators.map(() => x25519.utils.randomSecretKey());
  const request = async (panelIndex = 0, signers = evaluators) => ({
    queryId, panelIndex: panelIndex as 0 | 1,
    evaluators: await Promise.all(signers.map(async (e, i) => {
      const pub = toHex(x25519.getPublicKey(keys[i]!));
      return { address: evaluators[i]!.address.toLowerCase(), encryptionPubKey: pub, keySig: await e.signMessage({ message: { raw: evaluatorKeyDigest(queryId, panelIndex, pub) } }) };
    })),
  });
  return { intake, evaluators, keys, request, commit, store, provenanceHash: () => openedWith };
}

describe("dispatch-panel", () => {
  test("seals the document to each drawn evaluator; each can open only their own", async () => {
    const s = await setup();
    const res = await s.intake.dispatchPanel(await s.request());
    expect(res.evaluators).toHaveLength(3);
    for (const [i, out] of res.evaluators.entries()) {
      const plain = PanelDocPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(s.keys[i]!, out.docEnvelope as never, aad.panel(queryId, out.address as Hex)))));
      expect(plain.docCommit).toBe(s.commit);
      expect(Buffer.from(plain.docB64, "base64").toString()).toBe(new TextDecoder().decode(doc));
    }
    expect(() => open(s.keys[1]!, res.evaluators[0]!.docEnvelope as never, aad.panel(queryId, res.evaluators[0]!.address as Hex))).toThrow();
  });

  test("retains the grant's record only when the escalated query may be disclosed", async () => {
    const retained: string[] = [];
    const s = await setup();
    s.store.retain = async (key: string) => { retained.push(key); };
    await s.intake.dispatchPanel(await s.request());
    // The record and its binding's grant claim (public: opener/nonce only).
    expect(retained).toEqual([`prov:${s.provenanceHash()}`, "grant:0x00000000000000000000000000000000000000b0:5"]);
    const priv = await setup({ isPublic: false, consent: false });
    const privRetained: string[] = [];
    priv.store.retain = async (key: string) => { privRetained.push(key); };
    await expect(priv.intake.dispatchPanel(await priv.request())).rejects.toMatchObject({ code: "DISCLOSURE_NOT_ALLOWED" });
    expect(privRetained).toEqual([]);
    // Evaluator checks run before retention: a forged key binding or a non-panelist keeps nothing.
    const forged = await setup();
    const forgedRetained: string[] = [];
    forged.store.retain = async (key: string) => { forgedRetained.push(key); };
    await expect(forged.intake.dispatchPanel(await forged.request(0, [privateKeyToAccount(`0x${"9".repeat(64)}`), ...forged.evaluators.slice(1)]))).rejects.toMatchObject({ code: "BAD_KEY_SIG" });
    const outsiderReq = await forged.request();
    outsiderReq.evaluators[0]!.address = privateKeyToAccount(`0x${"9".repeat(64)}`).address.toLowerCase();
    await expect(forged.intake.dispatchPanel(outsiderReq)).rejects.toMatchObject({ code: "NOT_PANELIST" });
    expect(forgedRetained).toEqual([]);
  });

  test("refuses: not escalated, private without consent, wrong panel, forged key binding, non-panelist", async () => {
    await expect((await setup({ status: 4 })).intake.dispatchPanel(await (await setup()).request())).rejects.toMatchObject({ code: "NOT_ESCALATED" });
    const priv = await setup({ isPublic: false, consent: false });
    await expect(priv.intake.dispatchPanel(await priv.request())).rejects.toMatchObject({ code: "DISCLOSURE_NOT_ALLOWED" });
    const consented = await setup({ isPublic: false, consent: true });
    expect((await consented.intake.dispatchPanel(await consented.request())).evaluators).toHaveLength(3);
    const s = await setup({ panelIndex: 1 });
    await expect(s.intake.dispatchPanel(await s.request(0))).rejects.toMatchObject({ code: "WRONG_PANEL" });
    const f = await setup();
    const outsider = privateKeyToAccount(`0x${"9".repeat(64)}`);
    const forged = await f.request(0, [outsider, f.evaluators[1]!, f.evaluators[2]!]);
    await expect(f.intake.dispatchPanel(forged)).rejects.toMatchObject({ code: "BAD_KEY_SIG" });
    const req = await f.request();
    req.evaluators[0]!.address = outsider.address.toLowerCase();
    await expect(f.intake.dispatchPanel(req)).rejects.toBeInstanceOf(IntakeError);
  });
});

describe("dispatch-panel case status and missing materials", () => {
  const post = async (s: Awaited<ReturnType<typeof setup>>) => {
    const response = await createIntakeApp(s.intake).app.request("/v1/dispatch-panel", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await s.request()),
    });
    return { status: response.status, body: await response.json() as { evaluators?: unknown[]; error?: { code: string; message: string } } };
  };

  // IPanelEscalation.CaseStatus: DRAWING 1, COMMIT 2, REVEAL 3, FINAL 7, DRAW_EXPIRED 8.
  test("serves materials only while the seated panel votes (COMMIT or REVEAL)", async () => {
    for (const caseStatus of [2, 3]) {
      const res = await post(await setup({ caseStatus }));
      expect(res.status).toBe(200);
      expect(res.body.evaluators).toHaveLength(3);
    }
    // DRAWING: a resumable draw can already show some seats in panelOf; the panel is not seated yet.
    for (const caseStatus of [7, 8, 1]) {
      const retained: string[] = [];
      const s = await setup({ caseStatus });
      s.store.retain = async (key: string) => { retained.push(key); };
      const res = await post(s);
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: "PANEL_CLOSED", message: "Panel case is not open for evaluation" });
      expect(retained).toEqual([]);
    }
  });

  test("a record that is gone is the permanent MATERIALS_UNAVAILABLE (410), so the seat can abstain", async () => {
    const s = await setup();
    s.store.get = async () => undefined; // expired from the sealed store
    const res = await post(s);
    expect(res.status).toBe(410);
    expect(res.body.error?.code).toBe("MATERIALS_UNAVAILABLE");
    await expect(s.intake.dispatchPanel(await s.request())).rejects.toMatchObject({ code: "MATERIALS_UNAVAILABLE", status: 410 });
  });
});
