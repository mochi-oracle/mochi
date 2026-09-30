import { ZERO32, VerdictStatus, answerHash, canonicalJson, requiredAgree, spansRoot, verdictId, votesHash, type JurorAnswerBody, type SeatInput, type VerdictInput, type JurorVote } from "@mochi/core";
import { disagreementRecords, runConsensus, buildVerdictHashes } from "@mochi/consensus";
import { buildPayload, normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { aad, payerCommit, AttestationDocSchema, ConsensusSeedPlainSchema, DecisionResSchema, RoundOpenReqSchema, SubmitAnswerReqSchema, type DecisionRes, type RoundOpenReq, type SubmitAnswerReq } from "@mochi/protocol";
import { keyBinding, recoverJurorAnswer, signVerdictAttestation, type TeeProvider, type QuoteVerifier, type SealedStore, type Envelope } from "@mochi/tee";
import { type Address, type Hex } from "viem";
import { z } from "zod";
import type { Clock, ConsensusChainPort } from "./ports.ts";
import { log } from "./log.ts";

type Answer = { vote: SubmitAnswerReq["vote"]; body: JurorAnswerBody; jurorClass: number };
type Round = { openedAtMs: number; deadlineMs: number; closed?: DecisionRes };
type State = { seed: z.infer<typeof ConsensusSeedPlainSchema>; answers: Record<string, Answer>; rounds: Record<string, Round>; payerResultPubKey?: Hex };
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const spanSchema = z.object({ field: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), hash: hex32 });

/** Revives canonical JSON decimal strings in normalized big integer values, then validates the full shape. */
export function reviveAnswerBody(value: unknown): JurorAnswerBody {
  const raw = z.object({ schemaId: z.number().int(), schemaVersion: z.number().int(), fields: z.record(z.string(), z.unknown()), invalid: z.array(z.string()), spans: z.array(spanSchema), confidence: z.record(z.string(), z.number()) }).parse(value);
  const normalized = z.record(z.string(), z.unknown()).parse(raw.fields);
  for (const [name, field] of Object.entries(normalized)) {
    if (field === null) continue;
    const item = z.object({ t: z.enum(["num", "int", "date", "ts", "str", "enum", "bool"]), e8: z.unknown().optional(), v: z.unknown().optional() }).parse(field);
    if (item.t === "num") normalized[name] = { t: "num", e8: BigInt(z.string().regex(/^-?(0|[1-9][0-9]*)$/).parse(item.e8)) };
    else if (item.t === "int") normalized[name] = { t: "int", v: BigInt(z.string().regex(/^-?(0|[1-9][0-9]*)$/).parse(item.v)) };
    else if (item.t === "date" || item.t === "str" || item.t === "enum") normalized[name] = { t: item.t, v: z.string().parse(item.v) };
    else if (item.t === "ts") normalized[name] = { t: "ts", v: z.number().int().parse(item.v) };
    else normalized[name] = { t: "bool", v: z.boolean().parse(item.v) };
  }
  return { ...raw, fields: normalized as JurorAnswerBody["fields"], spans: raw.spans } as JurorAnswerBody;
}

export interface ConsensusEnclaveDeps {
  tee: TeeProvider;
  chain: ConsensusChainPort;
  store: SealedStore;
  quoteVerifier: QuoteVerifier;
  chainId: number;
  verdictsAddress: Address;
  clock: Clock;
  roundTimeoutMs?: number;
}

export class ConsensusError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export class ConsensusEnclave {
  private readonly timeout: number;
  private readonly answerLocks = new Map<string, Promise<void>>();
  constructor(private readonly deps: ConsensusEnclaveDeps) { this.timeout = deps.roundTimeoutMs ?? 120_000; }

  private async withQueryLock<T>(queryId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.answerLocks.get(queryId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => lock);
    this.answerLocks.set(queryId, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.answerLocks.get(queryId) === queued) this.answerLocks.delete(queryId);
    }
  }

  async attestation() {
    const quote = await this.deps.tee.quote();
    const doc = { role: "CONSENSUS" as const, address: this.deps.tee.signer().address.toLowerCase() as Address, encryptionPubKey: this.deps.tee.encryptionPublicKey(), measurement: this.deps.tee.measurement(), quote };
    const valid = await this.deps.quoteVerifier.verify(quote, { measurement: doc.measurement, reportData: keyBinding(doc.address, doc.encryptionPubKey) });
    if (!valid.ok) throw new ConsensusError(503, "ATTESTATION_FAILED", "TEE quote could not be verified");
    return AttestationDocSchema.parse(doc);
  }

  private async readState(queryId: Hex): Promise<State | undefined> {
    const bytes = await this.deps.store.get(`consensus:${queryId}`);
    if (!bytes) return undefined;
    const state = JSON.parse(new TextDecoder().decode(bytes)) as State;
    for (const answer of Object.values(state.answers)) answer.body = reviveAnswerBody(answer.body);
    return state;
  }
  private async writeState(queryId: Hex, state: State) { await this.deps.store.put(`consensus:${queryId}`, new TextEncoder().encode(canonicalJson(state))); }

  async openRound(input: RoundOpenReq) {
    const req = RoundOpenReqSchema.parse(input);
    const queryId = req.queryId as Hex;
    const q = await this.deps.chain.getQuery(queryId);
    if (q.status !== 2) throw new ConsensusError(409, "QUERY_NOT_SEALED", "query is not sealed");
    if (req.round !== q.round) throw new ConsensusError(409, "WRONG_ROUND", "round does not match query");
    const current = await this.readState(queryId);
    let seed: z.infer<typeof ConsensusSeedPlainSchema>;
    try { seed = ConsensusSeedPlainSchema.parse(JSON.parse(new TextDecoder().decode(this.deps.tee.decryptEnvelope(req.consensusSeed as Envelope, aad.consensusSeed(queryId))))); }
    catch { throw new ConsensusError(400, "INVALID_SEED", "consensus seed envelope is invalid"); }
    if (seed.queryId !== queryId || seed.docCommit !== q.docCommit || seed.schemaId !== q.schemaId || seed.paramsHash !== q.paramsHash) throw new ConsensusError(400, "SEED_MISMATCH", "consensus seed does not match query");
    if (q.isPublic && seed.salt !== ZERO32) throw new ConsensusError(400, "SALT_MISMATCH", "public query seed salt must be zero");
    let def;
    try { def = resolveSchema(seed.schemaId, seed.params); } catch { throw new ConsensusError(400, "INVALID_SCHEMA_PARAMS", "schema parameters are invalid"); }
    if (def.version !== q.schemaVersion) throw new ConsensusError(400, "SCHEMA_VERSION_MISMATCH", "query schema version is unsupported");
    const normalized = normalizeParams(def, seed.params);
    if (!normalized.ok || paramsHash(normalized.params) !== q.paramsHash) throw new ConsensusError(400, "PARAMS_HASH_MISMATCH", "query parameters do not match commitment");
    if (!q.isPublic && (!req.payerResultPubKey || payerCommit(req.payerResultPubKey as Hex) !== q.payerCommit)) throw new ConsensusError(400, "PAYER_KEY_MISMATCH", "payer result key does not match commitment");
    if (current?.rounds[String(req.round)]) {
      if (canonicalJson(current.seed) !== canonicalJson(seed) || current.payerResultPubKey !== req.payerResultPubKey) throw new ConsensusError(409, "ROUND_ALREADY_OPEN", "round was opened with different committed inputs");
      return { queryId: req.queryId, round: req.round, deadlineMs: current.rounds[String(req.round)]!.deadlineMs };
    }
    const state: State = current ?? { seed, answers: {}, rounds: {} };
    state.seed = seed;
    if (!q.isPublic) state.payerResultPubKey = req.payerResultPubKey as Hex;
    const now = this.deps.clock.now();
    state.rounds[String(req.round)] = { openedAtMs: now, deadlineMs: now + this.timeout };
    await this.writeState(queryId, state);
    log("info", "consensus.round.opened", { queryId: req.queryId, round: req.round, deadlineMs: now + this.timeout });
    return { queryId: req.queryId, round: req.round, deadlineMs: now + this.timeout };
  }

  async submitAnswer(input: SubmitAnswerReq) {
    return this.withQueryLock(input.queryId, () => this.submitAnswerLocked(input));
  }

  private async submitAnswerLocked(input: SubmitAnswerReq) {
    const req = SubmitAnswerReqSchema.parse(input);
    const queryId = req.queryId as Hex;
    const q = await this.deps.chain.getQuery(queryId);
    const state = await this.readState(queryId);
    if (!state?.rounds[String(q.round)]) throw new ConsensusError(409, "ROUND_NOT_OPEN", "round is not open");
    const round = state.rounds[String(q.round)]!;
    if (round.closed || this.deps.clock.now() > round.deadlineMs) throw new ConsensusError(409, "ROUND_CLOSED", "round is closed");
    const seats = await this.deps.chain.jurorsOf(queryId);
    const juror = seats[req.seat];
    if (!juror || juror.toLowerCase() !== req.vote.juror.toLowerCase()) throw new ConsensusError(400, "WRONG_SEAT", "vote juror does not occupy the submitted seat");
    let recovered: Address;
    try { recovered = await recoverJurorAnswer(this.deps.chainId, this.deps.verdictsAddress, { queryId, docCommit: q.docCommit, schemaId: q.schemaId, schemaVersion: q.schemaVersion, answerHash: req.vote.answerHash as Hex, spansRoot: req.vote.spansRoot as Hex, quoteHash: req.vote.quoteHash as Hex }, req.vote.sig as Hex); }
    catch { throw new ConsensusError(400, "BAD_SIGNATURE", "juror signature is invalid"); }
    if (recovered.toLowerCase() !== juror.toLowerCase()) throw new ConsensusError(400, "BAD_SIGNATURE", "juror signature is invalid");
    const old = state.answers[String(req.seat)];
    if (old) {
      if (canonicalJson(old.vote) === canonicalJson(req.vote)) return { accepted: true, duplicate: true };
      throw new ConsensusError(409, "DUPLICATE_ANSWER", "seat already submitted a different vote");
    }
    let body: JurorAnswerBody;
    try { body = reviveAnswerBody(JSON.parse(new TextDecoder().decode(this.deps.tee.decryptEnvelope(req.answerEnvelope as Envelope, aad.answer(queryId, juror))))); }
    catch { body = this.invalidBody(state.seed.schemaId, q.schemaVersion, state.seed.params); }
    const valid = body.schemaId === q.schemaId && body.schemaVersion === q.schemaVersion && answerHash({ salt: state.seed.salt as Hex, schemaId: body.schemaId, schemaVersion: body.schemaVersion, fields: body.fields }) === req.vote.answerHash && spansRoot(body.spans) === req.vote.spansRoot;
    if (!valid) body = { ...body, invalid: [...new Set([...body.invalid, ...Object.keys(body.fields)])] };
    const jurorInfo = await this.deps.chain.getJuror(juror as Address);
    state.answers[String(req.seat)] = { vote: req.vote, body, jurorClass: jurorInfo.jurorClass };
    await this.writeState(queryId, state);
    log("info", "consensus.answer.accepted", { queryId: req.queryId, round: q.round, seat: req.seat, status: valid ? "valid" : "invalid" });
    return { accepted: true, duplicate: false };
  }

  private invalidBody(schemaId: number, schemaVersion: number, params: Record<string, unknown>): JurorAnswerBody {
    const def = resolveSchema(schemaId, params);
    return { schemaId: def.id, schemaVersion, fields: Object.fromEntries(def.fields.map((field) => [field.name, null])), invalid: def.fields.map((field) => field.name), spans: [], confidence: {} };
  }

  async closeRound(queryId: Hex): Promise<DecisionRes> {
    return this.withQueryLock(queryId, () => this.closeRoundLocked(queryId));
  }

  private async closeRoundLocked(queryId: Hex): Promise<DecisionRes> {
    const q = await this.deps.chain.getQuery(queryId);
    const state = await this.readState(queryId);
    if (!state?.rounds[String(q.round)]) throw new ConsensusError(409, "ROUND_NOT_OPEN", "round is not open");
    const round = state.rounds[String(q.round)]!;
    if (round.closed) return round.closed;
    const jurors = await this.deps.chain.jurorsOf(queryId);
    if (jurors.length !== q.n) throw new Error("chain returned inconsistent juror count");
    const missing = Array.from({ length: q.n }, (_, i) => i).some((i) => !state.answers[String(i)]);
    if (missing && this.deps.clock.now() <= round.deadlineMs) throw new ConsensusError(409, "ROUND_OPEN", "round deadline has not passed and seats are missing");
    const def = resolveSchema(state.seed.schemaId, state.seed.params);
    const normalized = normalizeParams(def, state.seed.params);
    if (!normalized.ok) throw new Error("persisted schema params invalid");
    const jurorClasses = await Promise.all(jurors.map(async (juror, seat) => state.answers[String(seat)]?.jurorClass ?? (await this.deps.chain.getJuror(juror)).jurorClass));
    const seats: SeatInput[] = Array.from({ length: q.n }, (_, seat) => {
      const answer = state.answers[String(seat)];
      if (answer) return { seat, juror: jurors[seat]!, jurorClass: jurorClasses[seat]! as SeatInput["jurorClass"], timedOut: false, answer: answer.body };
      return { seat, juror: jurors[seat]!, jurorClass: jurorClasses[seat]! as SeatInput["jurorClass"], timedOut: true };
    });
    const result = runConsensus(def, seats);
    const hashes = buildVerdictHashes(def, result, seats, state.seed.salt as Hex);
    let payload: Hex = "0x";
    let payloadHash: Hex = ZERO32;
    if (result.status === VerdictStatus.VERDICT) {
      const built = buildPayload(def, result.agreed, normalized.params, { openedAt: q.openedAt });
      payload = built.payload;
      payloadHash = built.payloadHash;
    }
    const verdictInput: VerdictInput = { queryId, round: q.round, status: result.status as VerdictStatus, agreementBps: result.agreementBps, dissentMask: result.dissentMask, timeoutMask: result.timeoutMask, answerHash: hashes.answerHash, payloadHash, evidenceRoot: hashes.evidenceRoot };
    const votes: JurorVote[] = seats.map((seat) => seat.timedOut ? { juror: seat.juror.toLowerCase() as Address, answerHash: ZERO32, spansRoot: ZERO32, quoteHash: ZERO32, sig: "0x" as Hex } : state.answers[String(seat.seat)]!.vote as JurorVote);
    const k = requiredAgree(q.n);
    const responded = q.n - popcount(result.timeoutMask);
    const rules = result.status === VerdictStatus.VERDICT
      ? responded >= k && result.agreementBps * q.n >= k * 10000 - (q.n - 1) && payloadHash !== ZERO32 && (result.dissentMask & result.timeoutMask) === result.timeoutMask
      : payloadHash === ZERO32 && result.agreementBps * q.n < k * 10000 - (q.n - 1);
    if (!rules) throw new Error("verdict violates MochiVerdicts.post consistency rules");
    const consensusSig = await signVerdictAttestation(this.deps.tee.signer(), this.deps.chainId, this.deps.verdictsAddress, verdictInput, votesHash(votes));
    const id = verdictId(queryId, q.round);
    const fieldRows = result.fields.map((field) => ({ field: field.field, required: field.required, agreeBps: field.agreeBps, hung: field.hung, value: JSON.parse(canonicalJson(field.value)), dissent: Object.fromEntries(Object.entries(field.dissent).map(([seat, value]) => [seat, JSON.parse(canonicalJson(value))])) }));
    const common = { verdictId: id, verdictInput, votes, consensusSig };
    const response = q.isPublic
      ? { ...common, public: { answerJson: hashes.answerJson, payload, fields: fieldRows, disagreement: disagreementRecords(result, seats) } }
      : { ...common, privateResult: this.deps.tee && state.payerResultPubKey ? (await import("@mochi/tee")).seal(state.payerResultPubKey, new TextEncoder().encode(canonicalJson({ v: 1, verdictId: id, salt: state.seed.salt, answerJson: hashes.answerJson, payload, fields: fieldRows })), aad.result(id)) : undefined };
    const validated = DecisionResSchema.parse(response) as DecisionRes;
    round.closed = validated;
    await this.writeState(queryId, state);
    log("info", "consensus.round.closed", { queryId, round: q.round, status: result.status, agreementBps: result.agreementBps });
    return validated;
  }
}

function popcount(value: number) { let n = value >>> 0, count = 0; while (n) { n &= n - 1; count++; } return count; }
