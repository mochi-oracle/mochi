import { Role, SchemaId, QueryStatus, VerdictStatus, ZERO32, docCommit, docHash } from "@mochi/core";
import type { Address, Hex } from "viem";
import { normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { aad, IntakeUploadPlainSchema, payerCommit, type AttestationDoc, type JurorAttestationDoc, type DispatchReq, type Peer } from "@mochi/protocol";
import type { QuoteVerifier, SealedStore, TeeProvider, Envelope } from "@mochi/tee";
import { IntakeEnclave } from "../../../services/intake/src/intake.ts";
import type { IntakeChainPort } from "../../../services/intake/src/ports.ts";
import { JurorEnclave } from "../../../services/juror/src/juror.ts";
import type { Clock as JurorClock, HttpPoster, JurorChainPort } from "../../../services/juror/src/ports.ts";
import type { ModelRunner } from "../../../services/juror/src/runner.ts";
import { ConsensusEnclave } from "../../../services/consensus/src/rounds.ts";
import type { ConsensusChainPort } from "../../../services/consensus/src/ports.ts";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Address;
const VERDICTS = `0x${"00".repeat(19)}01` as Address;
const CHAIN_ID = 31337;
const QUERY_ID = `0x${"91".repeat(32)}` as Hex;
const SALT = `0x${"37".repeat(32)}` as Hex;
const QUESTION = "What numeric value does the submitted synthetic record report? Return the value as a string.";
const EVIDENCE = "Synthetic submitted evidence: the recorded value is 42.";
const PARAMS = Object.freeze({ question: QUESTION, answer_type: "STRING" });
const FIXTURE_BYTES = new TextEncoder().encode(EVIDENCE);
const FETCH_DISABLED = { origins: [] };
const NO_FETCH = { async get(): Promise<never> { throw new Error("network fetch disabled in round rehearsal"); } };
const NO_PDF = undefined;
const FIXTURE_SCHEMA = resolveSchema(SchemaId.FREEFORM_FACT, PARAMS);
const NORMALIZED_PARAMS = normalizeParams(FIXTURE_SCHEMA, PARAMS);
if (!NORMALIZED_PARAMS.ok) throw new Error("invalid fixed rehearsal params");
const PARAMS_HASH = paramsHash(NORMALIZED_PARAMS.params);

/** Fixed synthetic claim/evidence. Evidence is submitted text, never fetched. */
export const ROUND_REHEARSAL_FIXTURE = Object.freeze({
  claim: QUESTION,
  evidence: EVIDENCE,
  schemaId: SchemaId.FREEFORM_FACT,
  schemaVersion: 1,
  params: PARAMS,
  salt: SALT,
  queryId: QUERY_ID,
  chainId: CHAIN_ID,
  verdictsAddress: VERDICTS,
  sourceProvenance: "SUBMITTED" as const,
});
export const ROUND_REHEARSAL_MODEL_OUTPUT = Object.freeze({
  fields: Object.freeze({ answer: "42" }),
  evidence: Object.freeze({ answer: EVIDENCE }),
  confidence: Object.freeze({ answer: 0.95 }),
});

export interface RoundRehearsalOptions {
  tees: { intake: TeeProvider; consensus: TeeProvider; jurors: readonly [TeeProvider, TeeProvider, TeeProvider] };
  quoteVerifier: QuoteVerifier;
  stores: { intake: SealedStore; consensus: SealedStore; jurors: readonly [SealedStore, SealedStore, SealedStore] };
  runners: readonly [ModelRunner, ModelRunner, ModelRunner];
  passports?: readonly [{ modelId: string; lineage: string; weightsSha256: Hex; openWeights: boolean; provider: string; zdr: boolean }, { modelId: string; lineage: string; weightsSha256: Hex; openWeights: boolean; provider: string; zdr: boolean }, { modelId: string; lineage: string; weightsSha256: Hex; openWeights: boolean; provider: string; zdr: boolean }];
  clock: JurorClock;
}

export interface RoundRehearsalInput { envelope: Envelope; payerResultPubKey: Hex }
export interface RoundRehearsalResult {
  fixture: { schemaId: number; schemaVersion: number; queryId: Hex; chainId: number; verdictsAddress: Address; sourceProvenance: "SUBMITTED" };
  intake: { docCommit: Hex; paramsHash: Hex; provenance: { kind: 0; originId: Hex; fetchedAt: string; tokensK: number; transcriptHash: Hex }; intakeSig: Hex; identity: Address };
  attestations: { intake: AttestationDoc; consensus: AttestationDoc; jurors: JurorAttestationDoc[] };
  decision: { verdictId: Hex; verdictInput: unknown; votes: unknown[]; consensusSig: Hex; privateResult: Envelope };
}

/**
 * In-process composition of the production enclaves with fixture-only chain reads.
 * The HttpPoster accepts only the fixed in-process consensus URL. No RPC, network
 * retrieval, chain writes, public result, or external model fallback is provided.
 */
export function createRoundRehearsal(options: RoundRehearsalOptions) {
  const jurorAddresses = options.tees.jurors.map(t => t.signer().address.toLowerCase() as Address) as [Address, Address, Address];
  const consensusAddress = options.tees.consensus.signer().address.toLowerCase() as Address;
  const intakeAddress = options.tees.intake.signer().address.toLowerCase() as Address;
  const allAddresses = [intakeAddress, consensusAddress, ...jurorAddresses].map(a => a.toLowerCase());
  if (new Set(allAddresses).size !== 5) throw new TypeError("rehearsal requires five distinct TEE identities");
  const measurements = new Map<string, Hex>();
  for (const tee of [options.tees.intake, options.tees.consensus, ...options.tees.jurors]) {
    measurements.set(tee.signer().address.toLowerCase(), tee.measurement());
  }
  const payerCommitment = (pub: Hex) => payerCommit(pub);
  let committedDoc: Hex | undefined;
  let committedPayer: Hex | undefined;
  const getFixtureQuery = () => ({
    status: QueryStatus.SEALED, docCommit: committedDoc!, schemaId: SchemaId.FREEFORM_FACT,
    schemaVersion: 1, paramsHash: PARAMS_HASH, n: 3, round: 0, isPublic: false,
    allowPanelDisclosure: false, payPath: 0, provenanceKind: 0, originId: ZERO32,
    tokensK: 1, provenanceHash: ZERO32, payerCommit: committedPayer ?? ZERO32,
    payer: ZERO_ADDRESS, refundTo: ZERO_ADDRESS, openedAt: 1n, deadline: 0n,
    sealBlock: 0n, seed: ZERO32, paid: 0n, protocolFee: 0n,
  });
  const jurorChain: JurorChainPort = {
    async getQuery(id) { assertQuery(id); return getFixtureQuery(); },
    async jurorsOf(id) { assertQuery(id); return jurorAddresses; },
    async isActive(key, role) { return role === Role.CONSENSUS ? key.toLowerCase() === consensusAddress : role === Role.JUROR && jurorAddresses.some(a => a.toLowerCase() === key.toLowerCase()); },
    async getJuror(key) { const measurement = measurements.get(key.toLowerCase()); if (!measurement) throw new Error("unknown fixture identity"); return { measurement }; },
  };
  const consensusChain: ConsensusChainPort = {
    async getQuery(id) { assertQuery(id); return getFixtureQuery() as never; },
    async jurorsOf(id) { assertQuery(id); return jurorAddresses; },
    async getJuror(key) { const i = jurorAddresses.findIndex(a => a.toLowerCase() === key.toLowerCase()); if (i < 0) throw new Error("unknown fixture juror"); return { jurorClass: [0, 2, 4][i] } as never; },
  };
  const intakeChain: IntakeChainPort = {
    async getQuery(id) { assertQuery(id); return { status: QueryStatus.SEALED, docCommit: committedDoc!, paramsHash: PARAMS_HASH, schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, isPublic: false }; },
    async jurorsOf(id) { assertQuery(id); return jurorAddresses; },
    async isActive(key, role) { return jurorChain.isActive(key as Address, role); },
    async getJuror(key) { return jurorChain.getJuror(key as Address); },
  };
  const clock = options.clock;
  const intake = new IntakeEnclave({ tee: options.tees.intake, chain: intakeChain, store: options.stores.intake, fetchPolicy: FETCH_DISABLED, httpGetter: NO_FETCH, quoteVerifier: options.quoteVerifier, chainId: CHAIN_ID, escrowAddress: ZERO_ADDRESS, clock: { nowSeconds: () => Math.floor(clock.now() / 1000) }, pdfTextExtractor: NO_PDF });
  const consensus = new ConsensusEnclave({ tee: options.tees.consensus, chain: consensusChain, store: options.stores.consensus, quoteVerifier: options.quoteVerifier, chainId: CHAIN_ID, verdictsAddress: VERDICTS, clock: { now: () => clock.now() }, roundTimeoutMs: 30_000 });
  const consensusUrl = "http://consensus.round-rehearsal.invalid";
  const http: HttpPoster = {
    async post(url, body) {
      const expected = `${consensusUrl}/v1/rounds/${QUERY_ID}/answers`;
      if (url !== expected) throw new Error("rehearsal HTTP poster destination rejected");
      await consensus.submitAnswer(body);
    },
  };
  const jurors = options.tees.jurors.map((tee, i) => new JurorEnclave({
    tee, jurorClass: [0, 2, 4][i]!, passport: options.passports?.[i] ?? { modelId: `synthetic-runner-${i + 1}`, lineage: "synthetic-fixture", openWeights: false, provider: "rehearsal-only", zdr: true, weightsSha256: (`0x${String(i + 1).repeat(64)}`) as Hex },
    runner: options.runners[i]!, chain: jurorChain, store: options.stores.jurors[i]!, quoteVerifier: options.quoteVerifier,
    http, chainId: CHAIN_ID, verdictsAddress: VERDICTS, clock,
  }));

  async function attestations() {
    return { intake: await intake.attestation(), consensus: await consensus.attestation(), jurors: await Promise.all(jurors.map(j => j.attestation())) };
  }

  async function run(input: RoundRehearsalInput): Promise<RoundRehearsalResult> {
    // Validate full fixture before intake storage or any juror runner invocation.
    let plain;
    try { plain = IntakeUploadPlainSchema.parse(JSON.parse(new TextDecoder().decode(options.tees.intake.decryptEnvelope(input.envelope, aad.intake())))); }
    catch { throw new TypeError("invalid intake envelope or fixture"); }
    if (plain.v !== 1 || plain.schemaId !== SchemaId.FREEFORM_FACT || plain.salt !== SALT || JSON.stringify(plain.params) !== JSON.stringify(PARAMS) || plain.contentType !== "text/plain" || plain.docB64 !== Buffer.from(FIXTURE_BYTES).toString("base64")) throw new TypeError("input does not match the fixed synthetic fixture");
    if (!/^0x[0-9a-f]{64}$/.test(input.payerResultPubKey)) throw new TypeError("invalid payer result public key");
    const expectedCommit = docCommit(SALT, docHash(FIXTURE_BYTES));
    const expectedPayerCommit = payerCommitment(input.payerResultPubKey);
    if (committedDoc && (committedDoc !== expectedCommit || committedPayer !== expectedPayerCommit)) throw new TypeError("query fixture is already bound to another document or payer key");
    committedDoc = expectedCommit;
    committedPayer = expectedPayerCommit;
    const provenance = await intake.intakeUpload(input.envelope);
    if (provenance.docCommit !== expectedCommit || provenance.paramsHash !== PARAMS_HASH || provenance.provenance.kind !== 0) throw new Error("intake fixture binding failed");
    const peerDocs = await attestations();
    const jurorPeers = await Promise.all(jurors.map(async (j, seat) => {
      const att = await j.attestation();
      return { seat, address: jurorAddresses[seat]!, encryptionPubKey: att.encryptionPubKey, quote: att.quote };
    }));
    const consensusPeer: Peer = { address: consensusAddress, encryptionPubKey: peerDocs.consensus.encryptionPubKey, quote: peerDocs.consensus.quote };
    const dispatched = await intake.dispatch({ queryId: QUERY_ID, jurors: jurorPeers, consensus: consensusPeer } as DispatchReq);
    await consensus.openRound({ queryId: QUERY_ID, round: 0, consensusSeed: dispatched.consensusSeed as never, payerResultPubKey: input.payerResultPubKey });
    await Promise.all(dispatched.jurors.map(async ({ seat, docEnvelope }) => {
      const result = await jurors[seat]!.answer({ queryId: QUERY_ID, seat, docEnvelope, consensus: consensusPeer, consensusUrl } as never);
      if (!result.delivered) throw new Error("juror answer was not delivered to in-process consensus");
    }));
    const decision = await consensus.closeRound(QUERY_ID);
    if (decision.public || !decision.privateResult) throw new Error("private rehearsal result projection failed");
    return {
      fixture: { schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, queryId: QUERY_ID, chainId: CHAIN_ID, verdictsAddress: VERDICTS, sourceProvenance: "SUBMITTED" },
      intake: { docCommit: provenance.docCommit as Hex, paramsHash: provenance.paramsHash as Hex, provenance: { kind: 0, originId: provenance.provenance.originId as Hex, fetchedAt: provenance.provenance.fetchedAt, tokensK: provenance.tokensK, transcriptHash: provenance.provenance.transcriptHash as Hex }, intakeSig: provenance.intakeSig as Hex, identity: provenance.intake as Address },
      attestations: peerDocs,
      decision: { verdictId: decision.verdictId as Hex, verdictInput: decision.verdictInput, votes: decision.votes, consensusSig: decision.consensusSig as Hex, privateResult: decision.privateResult as Envelope },
    };
  }
  return { attestations, run };
}

function assertQuery(queryId: Hex) { if (queryId !== QUERY_ID) throw new Error("query is outside the fixed rehearsal fixture"); }
