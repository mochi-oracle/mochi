import { fromHex, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { resolveSchema, normalizeParams, paramsHash } from "@mochi/schemas";
import { docCommit, docHash, originId, ZERO32 } from "@mochi/core";
import {
  AttestationDocSchema, ConsensusSeedPlainSchema, DispatchPanelResSchema, DispatchResSchema, IntakeUploadPlainSchema,
  IntakeUrlPlainSchema, JurorDocPlainSchema, PanelDocPlainSchema, aad, evaluatorKeyDigest, type AttestationDoc,
  type DispatchPanelReq, type DispatchReq,
  type IntakeResult, type IntakeUploadPlain, type IntakeUrlPlain, type Peer,
} from "@mochi/protocol";
import { keyBinding, signProvenance, type QuoteVerifier, type TeeProvider, type Envelope, seal } from "@mochi/tee";
import type { Clock, FetchPolicy, HttpGetter, PdfTextExtractor, SealedStore, StoredIntake, IntakeChainPort } from "./ports.ts";
import { DocumentTooLarge, extractText, estimateTokensK } from "./extract.ts";
import { fetchDocument } from "./fetcher.ts";
import { Role } from "@mochi/core";

export class IntakeError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = "IntakeError"; }
}
export interface IntakeDeps {
  tee: TeeProvider;
  chain: IntakeChainPort;
  store: SealedStore;
  fetchPolicy: FetchPolicy;
  httpGetter: HttpGetter;
  quoteVerifier: QuoteVerifier;
  chainId: number;
  escrowAddress: Address;
  clock: Clock;
  pdfTextExtractor?: PdfTextExtractor;
}
const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decodeJson = <T>(value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as T;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class IntakeEnclave {
  constructor(private readonly deps: IntakeDeps) {}

  async attestation(): Promise<AttestationDoc> {
    const [quote, signer] = await Promise.all([this.deps.tee.quote(), Promise.resolve(this.deps.tee.signer())]);
    return AttestationDocSchema.parse({ role: "INTAKE", address: signer.address.toLowerCase(), encryptionPubKey: this.deps.tee.encryptionPublicKey().toLowerCase(), measurement: this.deps.tee.measurement().toLowerCase(), quote });
  }

  async intakeUpload(envelope: Envelope): Promise<IntakeResult> {
    let plain: IntakeUploadPlain;
    try { plain = IntakeUploadPlainSchema.parse(decodeJson(this.deps.tee.decryptEnvelope(envelope, aad.intake()))); }
    catch { throw new IntakeError("BAD_ENVELOPE", "Could not open a valid intake upload", 400); }
    let bytes: Uint8Array;
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(plain.docB64)) throw new Error("invalid base64");
      bytes = new Uint8Array(Buffer.from(plain.docB64, "base64"));
    } catch { throw new IntakeError("BAD_UPLOAD", "Document encoding is invalid", 400); }
    return this.ingest(plain, bytes, plain.contentType);
  }

  async intakeUrl(envelope: Envelope): Promise<IntakeResult> {
    let plain: IntakeUrlPlain;
    try { plain = IntakeUrlPlainSchema.parse(decodeJson(this.deps.tee.decryptEnvelope(envelope, aad.intake()))); }
    catch { throw new IntakeError("BAD_ENVELOPE", "Could not open a valid intake URL request", 400); }
    const fetched = await fetchDocument(plain.url, this.deps.fetchPolicy, { httpGetter: this.deps.httpGetter, clock: this.deps.clock });
    return this.ingest(plain, fetched.bytes, fetched.contentType, fetched);
  }

  private async ingest(plain: IntakeUploadPlain | IntakeUrlPlain, bytes: Uint8Array, contentType: string, fetched?: Awaited<ReturnType<typeof fetchDocument>>): Promise<IntakeResult> {
    let def;
    let normalized;
    try {
      def = resolveSchema(plain.schemaId, plain.params);
      normalized = normalizeParams(def, plain.params);
    } catch { throw new IntakeError("BAD_PARAMS", "Parameters are invalid for the selected schema", 400); }
    if (!normalized.ok) throw new IntakeError("BAD_PARAMS", "Parameters are invalid for the selected schema", 400);
    const pHash = paramsHash(normalized.params);
    let text: string;
    try { text = await extractText(bytes, contentType, this.deps.pdfTextExtractor); }
    catch (error) {
      if (error instanceof Error && error.name === "UnsupportedContentType") throw new IntakeError("UNSUPPORTED_CONTENT_TYPE", error.message, 415);
      if (error instanceof DocumentTooLarge) throw new IntakeError("DOCUMENT_TOO_LARGE", error.message, 413);
      throw error;
    }
    const commitment = docCommit(plain.salt as Hex, docHash(bytes));
    const tokensK = estimateTokensK(text);
    const prov = {
      docCommit: commitment,
      kind: fetched ? 1 as const : 0 as const,
      originId: fetched ? originId(fetched.host) : ZERO32,
      fetchedAt: fetched ? BigInt(fetched.fetchedAt) : 0n,
      tokensK,
      transcriptHash: fetched?.transcriptHash ?? ZERO32,
    };
    const intakeSig = await signProvenance(this.deps.tee.signer(), this.deps.chainId, this.deps.escrowAddress, prov);
    const record: StoredIntake = { schemaId: plain.schemaId, salt: plain.salt as Hex, params: plain.params, paramsHash: pHash, contentType, docB64: Buffer.from(bytes).toString("base64"), text };
    await this.deps.store.put(this.storeKey(commitment, pHash), encodeJson(record));
    return {
      provenance: { ...prov, fetchedAt: prov.fetchedAt.toString() }, intakeSig,
      intake: this.deps.tee.signer().address.toLowerCase() as Address, docCommit: commitment,
      paramsHash: pHash, schemaId: plain.schemaId, tokensK,
    };
  }

  /**
   * Human-panel escalation (§3.4): re-encrypt the document to the drawn evaluators. Allowed only when the query is
   * ESCALATED, is public or the payer consented at open (allowPanelDisclosure), and every evaluator is on the current
   * panel on-chain and proves control of its x25519 key with a signature from its staked address.
   */
  async dispatchPanel(req: DispatchPanelReq) {
    const queryId = req.queryId as Hex;
    const chain = this.deps.chain;
    if (!chain.getPanelCase || !chain.panelOf) throw new IntakeError("PANEL_UNAVAILABLE", "Panel reads are not configured", 503);
    const q = await chain.getQuery(queryId);
    if (q.status !== 5) throw new IntakeError("NOT_ESCALATED", "Query is not escalated to a panel", 409);
    if (!q.isPublic && !q.allowPanelDisclosure) throw new IntakeError("DISCLOSURE_NOT_ALLOWED", "Payer did not consent to panel disclosure", 403);
    const panelCase = await chain.getPanelCase(queryId);
    if (panelCase.panelIndex !== req.panelIndex) throw new IntakeError("WRONG_PANEL", "Not the current panel", 409);
    const members = (await chain.panelOf(queryId, req.panelIndex)).map((a) => a.toLowerCase());
    const raw = await this.deps.store.get(this.storeKey(q.docCommit, q.paramsHash));
    if (!raw) throw new IntakeError("UNKNOWN_DOC", "Document is not available in intake storage", 404);
    const record = decodeJson<StoredIntake>(raw);
    const out: { address: Address; docEnvelope: Envelope }[] = [];
    for (const evaluator of req.evaluators) {
      if (!members.includes(evaluator.address.toLowerCase())) throw new IntakeError("NOT_PANELIST", "Evaluator is not on the current panel", 403);
      const digest = evaluatorKeyDigest(queryId, req.panelIndex, evaluator.encryptionPubKey as Hex);
      let signer: Address;
      try { signer = await recoverMessageAddress({ message: { raw: digest }, signature: evaluator.keySig as Hex }); }
      catch { throw new IntakeError("BAD_KEY_SIG", "Evaluator key binding signature is invalid", 403); }
      if (signer.toLowerCase() !== evaluator.address.toLowerCase()) throw new IntakeError("BAD_KEY_SIG", "Evaluator key binding signature is invalid", 403);
      const plain = PanelDocPlainSchema.parse({
        v: 1, queryId: req.queryId, schemaId: q.schemaId, schemaVersion: q.schemaVersion ?? 1, docCommit: q.docCommit,
        salt: record.salt, params: record.params, contentType: record.contentType, docB64: record.docB64, text: record.text,
      });
      out.push({ address: evaluator.address as Address, docEnvelope: seal(evaluator.encryptionPubKey as Hex, encodeJson(plain), aad.panel(queryId, evaluator.address as Hex)) });
    }
    return DispatchPanelResSchema.parse({ evaluators: out });
  }

  async dispatch(req: DispatchReq) {
    const queryId = req.queryId as Hex;
    const q = await this.deps.chain.getQuery(queryId);
    if (q.status !== 2) throw new IntakeError("QUERY_NOT_SEALED", "Query is not sealed", 409);
    const seats = await this.deps.chain.jurorsOf(queryId);
    const raw = await this.deps.store.get(this.storeKey(q.docCommit, q.paramsHash));
    if (!raw) throw new IntakeError("UNKNOWN_DOC", "Document is not available in intake storage", 404);
    const record = decodeJson<StoredIntake>(raw);
    const jurorOutputs: { seat: number; address: Address; docEnvelope: Envelope }[] = [];
    const seenSeats = new Set<number>();
    for (const peer of req.jurors) {
      if (seenSeats.has(peer.seat) || !seats[peer.seat] || !eq(seats[peer.seat]!, peer.address)) throw new IntakeError("NOT_SELECTED", "Requested juror does not occupy the selected seat", 403);
      seenSeats.add(peer.seat);
      await this.verifyPeer(peer, Role.JUROR);
      const plain = JurorDocPlainSchema.parse({ v: 1, queryId: req.queryId, schemaId: q.schemaId, docCommit: q.docCommit, paramsHash: q.paramsHash, salt: record.salt, params: record.params, contentType: record.contentType, docB64: record.docB64, text: record.text });
      jurorOutputs.push({ seat: peer.seat, address: peer.address as Address, docEnvelope: seal(peer.encryptionPubKey as Hex, encodeJson(plain), aad.doc(q.docCommit as Hex)) });
    }
    await this.verifyPeer(req.consensus, Role.CONSENSUS);
    const seed = ConsensusSeedPlainSchema.parse({ v: 1, queryId: req.queryId, schemaId: q.schemaId, docCommit: q.docCommit, paramsHash: q.paramsHash, salt: record.salt, params: record.params });
    return DispatchResSchema.parse({ jurors: jurorOutputs, consensusSeed: seal(req.consensus.encryptionPubKey as Hex, encodeJson(seed), aad.consensusSeed(req.queryId as Hex)) });
  }

  private async verifyPeer(peer: Peer, role: Role.JUROR | Role.CONSENSUS): Promise<void> {
    const address = peer.address as Address;
    if (!(await this.deps.chain.isActive(address, role))) throw new IntakeError(role === Role.JUROR ? "INACTIVE_JUROR" : "INACTIVE_CONSENSUS", "Peer is not active for the required role", 403);
    const binding = keyBinding(peer.address as Address, peer.encryptionPubKey as Hex);
    const quote = peer.quote as unknown as import("@mochi/tee").Quote;
    const verified = await this.deps.quoteVerifier.verify(quote, { reportData: binding });
    let measurement: Hex;
    try { measurement = (await this.deps.chain.getJuror(address)).measurement; } catch { throw new IntakeError("BAD_ATTESTATION", "Peer attestation does not match its registered measurement", 403); }
    if (!verified.ok || quote.reportData.toLowerCase() !== binding.toLowerCase() || quote.measurement.toLowerCase() !== measurement.toLowerCase()) {
      throw new IntakeError("BAD_ATTESTATION", "Peer attestation is invalid", 403);
    }
  }

  private storeKey(docCommitHex: Hex, pHash: Hex) { return `doc:${docCommitHex}:${pHash}`; }
}
