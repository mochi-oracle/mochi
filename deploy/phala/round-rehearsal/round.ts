import { Role, SchemaId, QueryStatus, VerdictStatus, ZERO32, docCommit, docHash, provenanceHash } from "@mochi/core";
import type { Address, Hex } from "viem";
import { normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { aad, IntakeUploadPlainSchema, payerCommit, provenanceFromJson, provenanceMatchesBinding, type AttestationDoc, type JurorAttestationDoc, type DispatchReq, type Peer, type ProvenanceJson } from "@mochi/protocol";
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
/** Fixed open binding of the synthetic query: who would open it and with which queryId nonce. Nothing is opened (there
 *  is no chain); the intake still signs it into the Provenance grant, as in production. payerCommit comes from the
 *  payer result key of each run. */
const OPENER = `0x${"00".repeat(19)}02` as Address;
const OPEN_NONCE = "1";
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
  /** The `open` binding sealed with the upload, without payerCommit (= payerCommit(payerResultPubKey)). */
  open: Object.freeze({ opener: OPENER, isPublic: false, allowPanelDisclosure: false, nonce: OPEN_NONCE }),
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
  onDiagnostic?: (event: { stage: string; causeCode: string; seat?: number; httpStatus?: number }) => void;
}

export interface RoundRehearsalInput { envelope: Envelope; payerResultPubKey: Hex }
export interface RoundRehearsalResult {
  fixture: { schemaId: number; schemaVersion: number; queryId: Hex; chainId: number; verdictsAddress: Address; sourceProvenance: "SUBMITTED" };
  /** provenance: the full signed EIP-712 grant (15 fields, uint64 members as decimal strings). */
  intake: { docCommit: Hex; paramsHash: Hex; provenance: ProvenanceJson; intakeSig: Hex; identity: Address };
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
  // Query.provenanceHash: the struct hash of the grant the (fixture) query was opened with. Intake releases only the
  // record stored under it.
  let committedProvenance: Hex | undefined;
  const getFixtureQuery = () => ({
    status: QueryStatus.SEALED, docCommit: committedDoc!, schemaId: SchemaId.FREEFORM_FACT,
    schemaVersion: 1, paramsHash: PARAMS_HASH, n: 3, round: 0, isPublic: false,
    allowPanelDisclosure: false, payPath: 0, provenanceKind: 0, originId: ZERO32,
    tokensK: 1, provenanceHash: committedProvenance ?? ZERO32, payerCommit: committedPayer ?? ZERO32,
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
    async getQuery(id) { assertQuery(id); return { status: QueryStatus.SEALED, docCommit: committedDoc!, paramsHash: PARAMS_HASH, schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, isPublic: false, allowPanelDisclosure: false, provenanceHash: committedProvenance ?? ZERO32 }; },
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
    const diagnostic = (stage: string, causeCode: string, seat?: number, httpStatus?: number) => options.onDiagnostic?.({ stage, causeCode, ...(seat === undefined ? {} : { seat }), ...(httpStatus === undefined ? {} : { httpStatus }) });
    // Validate full fixture before intake storage or any juror runner invocation.
    let plain;
    try { plain = IntakeUploadPlainSchema.parse(JSON.parse(new TextDecoder().decode(options.tees.intake.decryptEnvelope(input.envelope, aad.intake())))); }
    catch { diagnostic("request", "fixture_rejected"); throw new TypeError("invalid intake envelope or fixture"); }
    if (plain.v !== 1 || plain.schemaId !== SchemaId.FREEFORM_FACT || plain.salt !== SALT || JSON.stringify(plain.params) !== JSON.stringify(PARAMS) || plain.contentType !== "text/plain" || plain.docB64 !== Buffer.from(FIXTURE_BYTES).toString("base64")) { diagnostic("request", "fixture_rejected"); throw new TypeError("input does not match the fixed synthetic fixture"); }
    if (!/^0x[0-9a-f]{64}$/.test(input.payerResultPubKey)) { diagnostic("request", "fixture_rejected"); throw new TypeError("invalid payer result public key"); }
    const expectedCommit = docCommit(SALT, docHash(FIXTURE_BYTES));
    const expectedPayerCommit = payerCommitment(input.payerResultPubKey);
    // The sealed open binding: a private query (salted, payer result key committed), no panel disclosure, fixed opener
    // and nonce. The intake signs exactly this into the grant.
    const open = plain.open;
    if (open.opener !== OPENER || open.isPublic || open.allowPanelDisclosure || open.nonce !== OPEN_NONCE || open.payerCommit !== expectedPayerCommit) { diagnostic("request", "fixture_rejected"); throw new TypeError("open binding does not match the fixed synthetic fixture and payer key"); }
    if (committedDoc && (committedDoc !== expectedCommit || committedPayer !== expectedPayerCommit)) { diagnostic("request", "fixture_already_bound"); throw new TypeError("query fixture is already bound to another document or payer key"); }
    committedDoc = expectedCommit;
    committedPayer = expectedPayerCommit;
    let provenance;
    try { provenance = await intake.intakeUpload(input.envelope); }
    catch { diagnostic("intake", "intake_failed"); throw new Error("intake failed"); }
    const grant = provenance.provenance;
    if (provenance.docCommit !== expectedCommit || provenance.paramsHash !== PARAMS_HASH || grant.kind !== 0 || grant.docCommit !== expectedCommit
      || grant.paramsHash !== PARAMS_HASH || grant.schemaId !== SchemaId.FREEFORM_FACT || grant.schemaVersion !== 1 || !provenanceMatchesBinding(grant, open)) { diagnostic("intake", "intake_binding_failed"); throw new Error("intake fixture binding failed"); }
    committedProvenance = provenanceHash(provenanceFromJson(grant));
    let peerDocs;
    let jurorPeers;
    try {
      peerDocs = await attestations();
      jurorPeers = await Promise.all(jurors.map(async (j, seat) => {
        const att = await j.attestation();
        return { seat, address: jurorAddresses[seat]!, encryptionPubKey: att.encryptionPubKey, quote: att.quote };
      }));
    } catch { diagnostic("attestation", "peer_attestation_failed"); throw new Error("peer attestation failed"); }
    const consensusPeer: Peer = { address: consensusAddress, encryptionPubKey: peerDocs.consensus.encryptionPubKey, quote: peerDocs.consensus.quote };
    let dispatched;
    try { dispatched = await intake.dispatch({ queryId: QUERY_ID, jurors: jurorPeers, consensus: consensusPeer } as DispatchReq); }
    catch { diagnostic("dispatch", "dispatch_failed"); throw new Error("dispatch failed"); }
    let opened;
    try { opened = await consensus.openRound({ queryId: QUERY_ID, round: 0, consensusSeed: dispatched.consensusSeed as never, payerResultPubKey: input.payerResultPubKey }); }
    catch { diagnostic("consensus_open", "consensus_open_failed"); throw new Error("consensus open failed"); }
    await Promise.all(dispatched.jurors.map(async ({ seat, docEnvelope }) => {
      try {
        // Jurors bound their work by the round's absolute deadline (AnswerReq.round/deadlineMs), as the orchestrator
        // passes them in production; without it the answer budget is already spent and nothing is delivered.
        const result = await jurors[seat]!.answer({ queryId: QUERY_ID, seat, docEnvelope, consensus: consensusPeer, consensusUrl, round: opened.round, deadlineMs: opened.deadlineMs });
        if (!result.delivered) { diagnostic("juror_delivery", "answer_not_delivered", seat); throw new Error("juror answer was not delivered to in-process consensus"); }
      } catch (error) {
        if (!(error instanceof Error && error.message === "juror answer was not delivered to in-process consensus")) {
          const runner = options.runners[seat] as ModelRunner & { lastFailure?: { causeCode: string; httpStatus?: number } };
          const failure = runner.lastFailure;
          diagnostic(failure ? "model_inference" : "juror", failure?.causeCode ?? "juror_rejected", seat, failure?.httpStatus);
        }
        throw error;
      }
    }));
    let decision;
    try { decision = await consensus.closeRound(QUERY_ID); }
    catch { diagnostic("consensus_close", "consensus_close_failed"); throw new Error("consensus close failed"); }
    if (decision.public || !decision.privateResult) { diagnostic("consensus_close", "private_result_missing"); throw new Error("private rehearsal result projection failed"); }
    return {
      fixture: { schemaId: SchemaId.FREEFORM_FACT, schemaVersion: 1, queryId: QUERY_ID, chainId: CHAIN_ID, verdictsAddress: VERDICTS, sourceProvenance: "SUBMITTED" },
      intake: { docCommit: provenance.docCommit as Hex, paramsHash: provenance.paramsHash as Hex, provenance: grant, intakeSig: provenance.intakeSig as Hex, identity: provenance.intake as Address },
      attestations: peerDocs,
      decision: { verdictId: decision.verdictId as Hex, verdictInput: decision.verdictInput, votes: decision.votes, consensusSig: decision.consensusSig as Hex, privateResult: decision.privateResult as Envelope },
    };
  }
  return { attestations, run };
}

function assertQuery(queryId: Hex) { if (queryId !== QUERY_ID) throw new Error("query is outside the fixed rehearsal fixture"); }
