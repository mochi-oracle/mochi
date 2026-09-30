import type { Address, Hex } from "viem";
import {
  AnswerResSchema,
  JurorDocPlainSchema,
  aad,
} from "@mochi/protocol";
import { answerHash, canonicalJson, docCommit, docHash, spansRoot, Role } from "@mochi/core";
import type { AnswerReq, AnswerRes, SubmitAnswerReq, EnvelopeJson } from "@mochi/protocol";
import { PassportSchema, passportHash } from "@mochi/protocol";
import { normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { AnswerBudget } from "./budget.ts";
import { TimingEventSchema, type TimingEvent } from "@mochi/protocol";
import { extractAnswer } from "./extract.ts";
import { keyBinding, quoteHash, seal, signJurorAnswer } from "@mochi/tee";
import type { JurorDeps } from "./ports.ts";

export class JurorError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "JurorError";
  }
}

type StoredAnswer = { vote: AnswerRes["vote"]; answerEnvelope: EnvelopeJson; seat: number };

export class JurorEnclave {
  private ownQuote: { hash: Hex; expiresAt: number } | undefined;
  private passportDoc: Promise<{ passport: import("@mochi/protocol").Passport; passportSig: Hex }> | undefined;
  private readonly queryLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: JurorDeps) {}

  async attestation() {
    const signer = this.deps.tee.signer();
    const encryptionPubKey = this.deps.tee.encryptionPublicKey();
    const quote = await this.deps.tee.quote();
    this.ownQuote = { hash: quoteHash(quote), expiresAt: this.deps.clock.now() + 300_000 };
    this.passportDoc ??= (async () => {
      const audit = (this.deps.runner as typeof this.deps.runner & { lastReceipt?: { receiptId: string; sessionId: string; workloadId: string; modelId: string } }).lastReceipt;
      const passport = PassportSchema.parse({
        v: 1,
        ...this.deps.passport,
        ...(audit ? {
          // PassportSchema is shared and has no receipt fields; preserve its
          // signed model identity fields using the documented string slots.
          modelId: `${audit.modelId} [receipt=${audit.receiptId};session=${audit.sessionId};workload=${audit.workloadId}]`.slice(0, 200),
          provider: "phala-aci",
        } : {}),
        juror: signer.address.toLowerCase(),
        jurorClass: this.deps.jurorClass,
        tee: quote.kind,
      });
      const passportSig = await signer.signMessage({ message: { raw: passportHash(passport) } });
      return { passport, passportSig };
    })();
    const passport = await this.passportDoc;
    return {
      role: "JUROR" as const,
      address: signer.address.toLowerCase() as Address,
      encryptionPubKey,
      measurement: this.deps.tee.measurement(),
      jurorClass: this.deps.jurorClass,
      quote,
      ...passport,
    };
  }

  async answer(req: AnswerReq, signal?: AbortSignal): Promise<AnswerRes> {
    const budget = new AnswerBudget(Math.min(req.deadlineMs, this.deps.clock.now() + (this.deps.answerTimeoutMs ?? 125_000)), this.deps.deliveryReserveMs ?? 10_000, () => this.deps.clock.now(), signal);
    const key = `answer:${req.queryId}`;
    const previous = this.queryLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queryLocks.set(key, current);
    try {
      if (previous) await budget.wait(previous);
      return await budget.wait(this.answerOnce(req, budget));
    } finally {
      budget.dispose();
      release();
      if (this.queryLocks.get(key) === current) this.queryLocks.delete(key);
    }
  }

  private async answerOnce(req: AnswerReq, budget: AnswerBudget): Promise<AnswerRes> {
    const storeKey = `answer:${req.queryId}`;
    const cached = await budget.wait(this.deps.store.get(storeKey));
    if (cached) {
      const stored = JSON.parse(new TextDecoder().decode(cached)) as StoredAnswer;
      return this.deliver(req, stored, budget);
    }

    const q = await budget.wait(this.deps.chain.getQuery(req.queryId as Hex));
    let plain;
    try {
      const opened = this.deps.tee.decryptEnvelope(req.docEnvelope as EnvelopeJson & { epk: Hex; nonce: Hex; ct: Hex }, aad.doc(q.docCommit));
      plain = JurorDocPlainSchema.parse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
      throw new JurorError("BINDING_MISMATCH", 400, "document envelope is invalid or does not match query");
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(plain.docB64), (c) => c.charCodeAt(0));
    } catch {
      throw new JurorError("BINDING_MISMATCH", 400, "document bindings do not match query");
    }
    let def;
    let normalizedParams;
    try {
      def = resolveSchema(plain.schemaId, plain.params);
      normalizedParams = normalizeParams(def, plain.params);
    } catch {
      throw new JurorError("BINDING_MISMATCH", 400, "document bindings do not match query");
    }
    if (
      plain.queryId !== req.queryId ||
      plain.docCommit !== q.docCommit ||
      docCommit(plain.salt as Hex, docHash(bytes)) !== q.docCommit ||
      plain.schemaId !== q.schemaId ||
      def.version !== q.schemaVersion ||
      plain.paramsHash !== q.paramsHash ||
      !normalizedParams.ok ||
      paramsHash(normalizedParams.params) !== q.paramsHash
    ) {
      throw new JurorError("BINDING_MISMATCH", 400, "document bindings do not match query");
    }

    const signer = this.deps.tee.signer();
    const jurors = await budget.wait(this.deps.chain.jurorsOf(req.queryId as Hex));
    if (jurors[req.seat]?.toLowerCase() !== signer.address.toLowerCase()) {
      throw new JurorError("NOT_SELECTED", 403, "juror is not selected for this seat");
    }

    const consensus = req.consensus;
    const active = await budget.wait(this.deps.chain.isActive(consensus.address as Address, Role.CONSENSUS));
    const binding = keyBinding(consensus.address as Address, consensus.encryptionPubKey as Hex);
    // Pin the quote to the measurement registered on-chain for this key — never trust the quote's own claim.
    const registered = await budget.wait(this.deps.chain.getJuror(consensus.address as Address));
    const verified = await budget.wait(this.deps.quoteVerifier.verify(consensus.quote as import("@mochi/tee").Quote, {
      measurement: registered.measurement,
      reportData: binding,
      maxAgeSec: 300, signal: budget.signal,
    }));
    if (!active) throw new JurorError("INACTIVE_CONSENSUS", 403, "consensus key is inactive");
    if (!verified.ok) throw new JurorError("BAD_CONSENSUS_QUOTE", 403, "consensus attestation is invalid");

    let body;
    try {
      let call: "initial" | "repair" = "initial";
      const started = this.deps.clock.now();
      body = (await extractAnswer(this.deps.runner, def, plain.params, plain.text, this.deps.maxTokens ?? 4096, {
        signal: budget.modelSignal,
        remainingMs: () => budget.remaining(true),
        onCall: (next, causeCode) => {
          call = next;
          if (causeCode) this.timing(req, { call, elapsedMs: this.deps.clock.now() - started, remainingBudgetMs: budget.remaining(true), causeCode });
        },
        onAttempt: (event) => {
          const allowed = new Set(["ok", "timeout", "network", "provider_error", "inference_http", "attestation_http"]);
          this.timing(req, { call, attempt: event.attempt, elapsedMs: event.elapsedMs, remainingBudgetMs: budget.remaining(true), causeCode: (allowed.has(event.code) ? event.code : "verification_failed") as TimingEvent["causeCode"], ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }) });
        },
      })).body;
      const auditRunner = this.deps.runner as typeof this.deps.runner & { lastReceipt?: unknown };
      if (auditRunner.lastReceipt) this.passportDoc = undefined;
    } catch {
      this.timing(req, { elapsedMs: 0, remainingBudgetMs: budget.remaining(), causeCode: budget.modelSignal.aborted ? "timeout" : "runner_failed" });
      throw new JurorError("RUNNER_FAILED", 502, "model extraction failed");
    }

    const aHash = answerHash({ salt: plain.salt as Hex, schemaId: q.schemaId, schemaVersion: q.schemaVersion, fields: body.fields });
    const sRoot = spansRoot(body.spans);
    const now = this.deps.clock.now();
    if (!this.ownQuote || this.ownQuote.expiresAt <= now) {
      this.ownQuote = { hash: quoteHash(await budget.wait(this.deps.tee.quote())), expiresAt: now + 300_000 };
    }
    const vote = {
      juror: signer.address.toLowerCase() as Address,
      answerHash: aHash,
      spansRoot: sRoot,
      quoteHash: this.ownQuote.hash,
      sig: await budget.wait(signJurorAnswer(signer, this.deps.chainId, this.deps.verdictsAddress, {
        queryId: req.queryId as Hex,
        docCommit: q.docCommit,
        schemaId: q.schemaId,
        schemaVersion: q.schemaVersion,
        answerHash: aHash,
        spansRoot: sRoot,
        quoteHash: this.ownQuote.hash,
      })),
    };
    const answerEnvelope = seal(
      consensus.encryptionPubKey as Hex,
      new TextEncoder().encode(canonicalJson(body)),
      aad.answer(req.queryId as Hex, vote.juror),
    );
    const stored: StoredAnswer = { vote, answerEnvelope, seat: req.seat };
    await budget.wait(this.deps.store.put(storeKey, new TextEncoder().encode(canonicalJson(stored))));
    return this.deliver(req, stored, budget);
  }

  private timing(req: AnswerReq, event: TimingEvent): void {
    this.deps.telemetry?.(TimingEventSchema.parse({ queryId: req.queryId, round: req.round, seat: req.seat, modelId: this.deps.passport.modelId, ...event }));
  }

  private async deliver(req: AnswerReq, stored: StoredAnswer, budget: AnswerBudget): Promise<AnswerRes> {
    const submit: SubmitAnswerReq = {
      queryId: req.queryId,
      seat: stored.seat,
      vote: stored.vote,
      answerEnvelope: stored.answerEnvelope,
    };
    let delivered = false;
    const started = this.deps.clock.now();
    let late = false;
    let httpStatus: number | undefined;
    for (let attempt = 0; attempt <= 3 && budget.remaining() > 0 && !budget.signal.aborted; attempt++) {
      try {
        await budget.wait(this.deps.http.post(`${req.consensusUrl.replace(/\/$/, "")}/v1/rounds/${req.queryId}/answers`, submit, Math.min(10_000, budget.remaining()), budget.signal));
        delivered = true;
        break;
      } catch (error) {
        const failure = error as { late?: boolean; httpStatus?: number };
        late = failure?.late === true;
        httpStatus = failure?.httpStatus;
        if (late || budget.signal.aborted) break;
        const delay = 250 * 2 ** attempt;
        if (attempt < 3 && budget.remaining() > delay) await budget.wait(this.deps.clock.sleep(delay));
      }
    }
    this.timing(req, { elapsedMs: this.deps.clock.now() - started, remainingBudgetMs: budget.remaining(), causeCode: delivered ? "ok" : late ? "round_closed" : "delivery_failed", delivered, late, ...(httpStatus === undefined ? {} : { httpStatus }) });
    return AnswerResSchema.parse({ seat: stored.seat, vote: stored.vote, delivered });
  }
}
