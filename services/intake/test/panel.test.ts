import { describe, expect, test } from "bun:test";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x25519 } from "@noble/curves/ed25519.js";
import { toHex } from "viem";
import { aad, evaluatorKeyDigest, PanelDocPlainSchema } from "@mochi/protocol";
import { docCommit, ZERO32 } from "@mochi/core";
import { MemorySealedStore, MockQuoteVerifier, MockTeeProvider, open, seal } from "@mochi/tee";
import { IntakeEnclave, IntakeError } from "../src/intake.ts";

const root = privateKeyToAccount(`0x${"11".repeat(32)}`);
const measurement = `0x${"22".repeat(32)}` as Hex;
const tee = new MockTeeProvider({ seed: `0x${"33".repeat(32)}`, measurement, mockRoot: root });
const queryId = `0x${"ab".repeat(32)}` as Hex;
const doc = new TextEncoder().encode("Reserve report: supply 100, reserves 99.");

async function setup(opts: { status?: number; isPublic?: boolean; consent?: boolean; panelIndex?: number } = {}) {
  const evaluators = [1, 2, 3].map((i) => privateKeyToAccount(`0x${String(i).repeat(64)}` as Hex));
  const commit = docCommit(ZERO32, sha256(doc));
  const chain = {
    getQuery: async () => ({
      status: opts.status ?? 5, docCommit: commit, paramsHash: ZERO32 as Hex, schemaId: 4, schemaVersion: 1,
      isPublic: opts.isPublic ?? true, allowPanelDisclosure: opts.consent ?? false,
    }),
    jurorsOf: async () => [], isActive: async () => true, getJuror: async () => ({ measurement }),
    getPanelCase: async () => ({ status: 2, panelIndex: opts.panelIndex ?? 0 }),
    panelOf: async () => evaluators.map((e) => e.address as Hex),
  };
  const intake = new IntakeEnclave({
    tee, chain, store: new MemorySealedStore(), fetchPolicy: { origins: [] },
    httpGetter: { get: async () => { throw new Error("no network"); } },
    quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), chainId: 31337,
    escrowAddress: `0x${"66".repeat(20)}`, clock: { nowSeconds: () => 1_700_000_000 },
  });
  const plain = { v: 1, schemaId: 4, salt: ZERO32, params: {}, contentType: "text/plain", docB64: Buffer.from(doc).toString("base64") };
  await intake.intakeUpload(seal(tee.encryptionPublicKey(), new TextEncoder().encode(JSON.stringify(plain)), aad.intake()));
  const keys = evaluators.map(() => x25519.utils.randomSecretKey());
  const request = async (panelIndex = 0, signers = evaluators) => ({
    queryId, panelIndex: panelIndex as 0 | 1,
    evaluators: await Promise.all(signers.map(async (e, i) => {
      const pub = toHex(x25519.getPublicKey(keys[i]!));
      return { address: evaluators[i]!.address.toLowerCase(), encryptionPubKey: pub, keySig: await e.signMessage({ message: { raw: evaluatorKeyDigest(queryId, panelIndex, pub) } }) };
    })),
  });
  return { intake, evaluators, keys, request, commit };
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
