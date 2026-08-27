import { aad, AttestationDocSchema, IntakeResultSchema, IntakeUrlPlainSchema, type AttestationDoc, type IntakeResult } from "@mochi/protocol";
import { SchemaId, ZERO32 } from "@mochi/core";
import { keyBinding, seal, type Quote } from "@mochi/tee";
import { keccak256, toBytes, type Hex } from "viem";
import type { ExecuteDeps, FeedJob } from "./ports.ts";

export class IntakeHttpError extends Error {
  constructor(readonly status: number) { super(`intake returned HTTP ${status}`); this.name = "IntakeHttpError"; }
}
const INTAKE_ROLE = 2;

export class FeedQueryExecutor {
  private attestationCache?: { att: AttestationDoc; expires: number };
  private lastNonce = 0n;
  constructor(private readonly deps: ExecuteDeps) {}

  private async verifiedAttestation(): Promise<AttestationDoc> {
    const now = this.deps.clock.now();
    if (this.attestationCache && this.attestationCache.expires > now) return this.attestationCache.att;
    const att = AttestationDocSchema.parse(await this.deps.http.getAttestation(`${this.deps.intakeUrl}/v1/attestation`, this.deps.attestationTimeoutMs ?? 10_000));
    if (att.role !== "INTAKE") throw new Error("intake attestation has wrong role");
    const binding = keyBinding(att.address as `0x${string}`, att.encryptionPubKey as Hex);
    // Pin to the measurement registered on-chain for this key; never trust the attestation's own claim.
    const registered = await this.deps.chain.getJuror(att.address as `0x${string}`);
    const result = await this.deps.quoteVerifier.verify(att.quote as Quote, { measurement: registered.measurement, reportData: binding, maxAgeSec: 300 });
    if (!result.ok || att.quote.reportData !== binding) throw new Error("intake quote verification failed");
    if (!(await this.deps.chain.isActive(att.address as `0x${string}`, INTAKE_ROLE))) throw new Error("intake key is not active on chain");
    this.attestationCache = { att, expires: now + 5 * 60_000 };
    return att;
  }

  private async ensureBudget(): Promise<void> {
    const available = await this.deps.chain.feedBudget();
    if (available >= this.deps.feedBudgetMin || !this.deps.autoFund) return;
    const amount = this.deps.feedBudgetTarget > available ? this.deps.feedBudgetTarget - available : 0n;
    if (amount <= 0n) return;
    const balance = await this.deps.chain.usdgBalance(this.deps.feedRunnerAddress);
    if (balance < amount) throw new Error("insufficient USDG balance to fund feed budget");
    await this.deps.chain.approveUsdg(amount);
    await this.deps.chain.fundFeedBudget(amount);
  }

  async execute(job: FeedJob): Promise<{ queryId: Hex; txHash: Hex }> {
    const att = await this.verifiedAttestation();
    const plain = IntakeUrlPlainSchema.parse({ v: 1, schemaId: job.schemaId, salt: ZERO32, params: job.params, url: job.url });
    const envelope = seal(att.encryptionPubKey as Hex, toBytes(JSON.stringify(plain)), aad.intake());
    let result: IntakeResult;
    try { result = IntakeResultSchema.parse(await this.deps.http.postIntake(`${this.deps.intakeUrl}/v1/intake/url`, envelope, this.deps.intakeTimeoutMs ?? 30_000)); }
    catch (error) { if (error instanceof IntakeHttpError) throw error; throw new Error("invalid intake response"); }
    if (result.provenance.kind !== 1) throw new Error("intake did not fetch the URL");
    if (result.schemaId !== job.schemaId) throw new Error("intake schema mismatch");
    if (result.intake.toLowerCase() !== att.address.toLowerCase()) throw new Error("intake signer does not match attestation");
    if (result.docCommit !== result.provenance.docCommit) throw new Error("intake document commitment mismatch");
    await this.ensureBudget();
    const timestampNonce = BigInt(this.deps.clock.now());
    const nonce = timestampNonce > this.lastNonce ? timestampNonce : this.lastNonce + 1n;
    this.lastNonce = nonce;
    const params = { schemaId: job.schemaId, n: job.n, isPublic: true, allowPanelDisclosure: true, paramsHash: result.paramsHash as Hex, payerCommit: ZERO32, refundTo: this.deps.refundTo, nonce };
    const queryId = await this.deps.chain.computeQueryId(this.deps.feedRunnerAddress, result.docCommit as Hex, nonce);
    const feedId = keccak256(toBytes(job.feedName));
    await this.deps.repo.insertFeedQuery(queryId, feedId, job.key);
    const txHash = await this.deps.chain.openFeed(params, {
      docCommit: result.provenance.docCommit as Hex, kind: result.provenance.kind,
      originId: result.provenance.originId as Hex, fetchedAt: BigInt(result.provenance.fetchedAt),
      tokensK: result.provenance.tokensK, transcriptHash: result.provenance.transcriptHash as Hex,
    }, result.intakeSig as Hex);
    return { queryId, txHash };
  }
}
