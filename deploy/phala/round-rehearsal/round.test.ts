import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type Hex } from "viem";
import { x25519 } from "@noble/curves/ed25519.js";
import { aad, PrivateResultPlainSchema, type IntakeUploadPlain } from "@mochi/protocol";
import { MemorySealedStore, MockQuoteVerifier, MockTeeProvider, open, recoverProvenance, recoverVerdictAttestation, seal } from "@mochi/tee";
import { ROUND_REHEARSAL_FIXTURE, ROUND_REHEARSAL_MODEL_OUTPUT, createRoundRehearsal, type RoundRehearsalOptions } from "./round.ts";

const root = privateKeyToAccount(`0x${"aa".repeat(32)}`);
const payer = x25519.keygen();
const now = () => 1_800_000_000_000;

function makeOptions(overrides: Partial<RoundRehearsalOptions> = {}, outputs: unknown[] = [ROUND_REHEARSAL_MODEL_OUTPUT, ROUND_REHEARSAL_MODEL_OUTPUT, ROUND_REHEARSAL_MODEL_OUTPUT]): RoundRehearsalOptions {
  const tees = ["11", "22", "33", "44", "55"].map((byte, i) => new MockTeeProvider({ seed: (`0x${String(i + 1).repeat(64)}`) as Hex, measurement: (`0x${byte.repeat(32)}`) as Hex, mockRoot: root }));
  const stores = () => new MemorySealedStore();
  const defaults: RoundRehearsalOptions = {
    tees: { intake: tees[0]!, consensus: tees[1]!, jurors: [tees[2]!, tees[3]!, tees[4]!] },
    quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
    stores: { intake: stores(), consensus: stores(), jurors: [stores(), stores(), stores()] },
    runners: outputs.map(value => ({ async run() { return value; } })) as unknown as RoundRehearsalOptions["runners"],
    clock: { now, async sleep() {} },
  };
  return { ...defaults, ...overrides };
}

function uploadEnvelope(recipient: Hex, value: Partial<IntakeUploadPlain> = {}) {
  const plain: IntakeUploadPlain = {
    v: 1, schemaId: ROUND_REHEARSAL_FIXTURE.schemaId, salt: ROUND_REHEARSAL_FIXTURE.salt,
    params: { ...ROUND_REHEARSAL_FIXTURE.params }, contentType: "text/plain",
    docB64: Buffer.from(ROUND_REHEARSAL_FIXTURE.evidence).toString("base64"), ...value,
  };
  return seal(recipient, new TextEncoder().encode(JSON.stringify(plain)), aad.intake());
}

describe("Phala synthetic private round composition", () => {
  test("runs submitted fixture through intake, peer verification, three jurors and private consensus", async () => {
    const options = makeOptions();
    const flow = createRoundRehearsal(options);
    const result = await flow.run({ envelope: uploadEnvelope(options.tees.intake.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex });
    expect(result.decision.verdictInput).toMatchObject({ status: 1, agreementBps: 10_000 });
    expect(result.decision.votes).toHaveLength(3);
    expect(result.decision.privateResult).toBeDefined();
    expect("public" in result.decision).toBe(false);
    expect(result.intake.provenance.kind).toBe(0);
    expect(result.intake.provenance.originId).toBe(`0x${"00".repeat(32)}`);
    expect(result.attestations.jurors).toHaveLength(3);
    expect(new Set([result.attestations.intake.address, result.attestations.consensus.address, ...result.attestations.jurors.map((j: any) => j.address)]).size).toBe(5);
    expect(JSON.stringify(result)).not.toContain(ROUND_REHEARSAL_FIXTURE.evidence);
    expect(JSON.stringify(result)).not.toContain(ROUND_REHEARSAL_FIXTURE.claim);
    const privatePlain = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(payer.secretKey, result.decision.privateResult, aad.result(result.decision.verdictId)))));
    expect(privatePlain.verdictId).toBe(result.decision.verdictId);
    expect(privatePlain.answerJson).toContain('"v":"42"');
    const provenanceSigner = await recoverProvenance(31337, `0x${"00".repeat(20)}` as Hex, {
      docCommit: result.intake.docCommit, kind: 0, originId: result.intake.provenance.originId,
      fetchedAt: BigInt(result.intake.provenance.fetchedAt), tokensK: result.intake.provenance.tokensK,
      transcriptHash: result.intake.provenance.transcriptHash,
    }, result.intake.intakeSig);
    expect(provenanceSigner.toLowerCase()).toBe(result.intake.identity.toLowerCase());
    const consensusSigner = await recoverVerdictAttestation(31337, ROUND_REHEARSAL_FIXTURE.verdictsAddress, result.decision.verdictInput as never, (await import("@mochi/core")).votesHash(result.decision.votes as never), result.decision.consensusSig);
    expect(consensusSigner.toLowerCase()).toBe(result.attestations.consensus.address.toLowerCase());
  });

  test("preserves N=3 seat classes and returns HUNG for disagreement", async () => {
    const options = makeOptions({}, [ROUND_REHEARSAL_MODEL_OUTPUT, ROUND_REHEARSAL_MODEL_OUTPUT, { ...ROUND_REHEARSAL_MODEL_OUTPUT, fields: { answer: "43" } }]);
    const result = await createRoundRehearsal(options).run({ envelope: uploadEnvelope(options.tees.intake.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex });
    expect(result.decision.verdictInput).toMatchObject({ status: 2, agreementBps: 6666 });
    expect(result.decision.privateResult).toBeDefined();
  });

  test("rejects tampered quote, malformed fixture and envelope sealed to another recipient", async () => {
    const good = makeOptions();
    const original = good.tees.intake;
    const juror = good.tees.jurors[1];
    const broken = { kind: juror.kind, measurement: () => juror.measurement(), signer: () => juror.signer(), encryptionPublicKey: () => juror.encryptionPublicKey(), decryptEnvelope: (env: any, aad_: Uint8Array) => juror.decryptEnvelope(env, aad_), async quote() { const quote = await juror.quote(); return { ...quote, reportData: `0x${"00".repeat(32)}` as Hex }; } };
    const tamperedOptions = { ...good, tees: { ...good.tees, jurors: [good.tees.jurors[0], broken, good.tees.jurors[2]] } } as unknown as RoundRehearsalOptions;
    await expect(createRoundRehearsal(tamperedOptions).run({ envelope: uploadEnvelope(original.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex })).rejects.toThrow();
    await expect(createRoundRehearsal(good).run({ envelope: uploadEnvelope(original.encryptionPublicKey(), { params: { ...ROUND_REHEARSAL_FIXTURE.params, question: "tampered" } }), payerResultPubKey: toHex(payer.publicKey) as Hex })).rejects.toThrow("fixed synthetic fixture");
    const other = new MockTeeProvider({ seed: `0x${"66".repeat(32)}`, measurement: `0x${"66".repeat(32)}`, mockRoot: root });
    await expect(createRoundRehearsal(good).run({ envelope: uploadEnvelope(other.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex })).rejects.toThrow("invalid intake envelope");
  });

  test("reports only safe stage, provider cause code and HTTP status on juror failure", async () => {
    const diagnostics: unknown[] = [];
    const options = makeOptions({ onDiagnostic: (event) => diagnostics.push(event) });
    const privateFailure = new Error("private prompt and provider response body");
    const failedRunner = { lastFailure: { causeCode: "inference_http", httpStatus: 429 }, async run() { throw privateFailure; } };
    const runners = [failedRunner, options.runners[1], options.runners[2]] as unknown as RoundRehearsalOptions["runners"];
    const flow = createRoundRehearsal({ ...options, runners });
    await expect(flow.run({ envelope: uploadEnvelope(options.tees.intake.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex })).rejects.toBeDefined();
    expect(diagnostics).toContainEqual({ stage: "model_inference", causeCode: "inference_http", seat: 0, httpStatus: 429 });
    expect(JSON.stringify(diagnostics)).not.toContain("private prompt");
    expect(JSON.stringify(diagnostics)).not.toContain("provider response body");
  });

  test("private result is bound to payer key; a wrong key cannot decrypt it", async () => {
    const options = makeOptions();
    const flow = createRoundRehearsal(options);
    const result = await flow.run({ envelope: uploadEnvelope(options.tees.intake.encryptionPublicKey()), payerResultPubKey: toHex(payer.publicKey) as Hex });
    const other = x25519.keygen();
    expect(() => open(other.secretKey, result.decision.privateResult, aad.result(result.decision.verdictId))).toThrow();
    await expect(flow.run({ envelope: uploadEnvelope(options.tees.intake.encryptionPublicKey()), payerResultPubKey: toHex(other.publicKey) as Hex })).rejects.toThrow("already bound");
  });
});
