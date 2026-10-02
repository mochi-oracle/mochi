import { recoverMessageAddress, type Address, type Hex } from "viem";
import { resolveSchema, normalizeParams, paramsHash } from "@mochi/schemas";
import {
  canonicalJson, docCommit, docHash, fetchedTranscriptHash, hashCanonical, originId, provenanceHash, submittedTranscriptHash, tlsTranscriptHash,
  ProvenanceKind, ZERO32, type Provenance,
} from "@mochi/core";
import {
  AttestationDocSchema, ConsensusSeedPlainSchema, DispatchPanelResSchema, DispatchResSchema, IntakeUploadPlainSchema,
  IntakeUrlPlainSchema, JurorDocPlainSchema, PanelDocPlainSchema, ProvenanceJsonSchema, aad, evaluatorKeyDigest, maskDocHash,
  provenanceFromJson, type AttestationDoc, type DispatchPanelReq, type DispatchReq,
  type IntakeResult, type IntakeUploadPlain, type IntakeUrlPlain, type Peer, type ProvenanceJson,
} from "@mochi/protocol";
import { keyBinding, signProvenance, type QuoteVerifier, type TeeProvider, type Envelope, seal } from "@mochi/tee";
import type { Clock, FetchPolicy, GrantClaim, HttpGetter, PdfTextExtractor, SealedStore, StoredIntake, IntakeChainPort } from "./ports.ts";
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
  /** Lifetime of a signed Provenance grant (default 15 minutes). */
  provenanceTtlSeconds?: number;
}
/** Default lifetime of a Provenance grant: long enough to review a quote, approve USDG and pay. */
export const PROVENANCE_TTL_SECONDS = 15 * 60;
const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decodeJson = <T>(value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as T;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isZero = (h: string) => /^0x0{64}$/i.test(h);
const hex32 = (h: unknown): h is Hex => typeof h === "string" && /^0x[0-9a-f]{64}$/i.test(h);
/** Same sealed upload (a retry), as opposed to different bytes or a different reading of them under one grant. */
const sameUpload = (a: StoredIntake, b: StoredIntake) =>
  a.docB64 === b.docB64 && a.contentType === b.contentType && eq(a.salt, b.salt) && canonicalJson(a.params) === canonicalJson(b.params);
const grantExists = () => new IntakeError("GRANT_EXISTS", "Another request already holds the grant for this open binding", 409);
/** IPanelEscalation.CaseStatus values in which a seated panel votes (contracts/src/interfaces/IPanelEscalation.sol). */
const PANEL_COMMIT = 2, PANEL_REVEAL = 3;
type IntakeDocument = { bytes: Uint8Array; contentType: string; fetched?: Awaited<ReturnType<typeof fetchDocument>> };

/**
 * The store keys an open binding's single grant is claimed under: (opener, nonce), plus the payer commitment for a
 * private binding (one grant per result key). Retained together with the grant's record once its query is dispatched.
 */
export function grantClaimKeys(open: { opener: string; nonce: string | bigint; isPublic: boolean; payerCommit: string }): string[] {
  return [`grant:${open.opener.toLowerCase()}:${BigInt(open.nonce)}`, ...(open.isPublic ? [] : [`grant-payer:${open.payerCommit.toLowerCase()}`])];
}

/** Fingerprint of a sealed intake request: an identical retry has the same one, any other request a different one. */
function requestHashOf(plain: IntakeUploadPlain | IntakeUrlPlain, doc: { contentType: string; docHash: Hex } | { url: string }): Hex {
  const open = plain.open;
  return hashCanonical({
    tag: "mochi/intake-request/v1", schemaId: plain.schemaId, salt: plain.salt.toLowerCase(), params: plain.params, doc,
    open: { opener: open.opener.toLowerCase(), payerCommit: open.payerCommit.toLowerCase(), isPublic: open.isPublic, allowPanelDisclosure: open.allowPanelDisclosure, nonce: BigInt(open.nonce).toString() },
  });
}

export class IntakeEnclave {
  /** Serializes the read-then-write of one key (a grant's record, or a binding's claims) within this enclave process. */
  private readonly recordLocks = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: IntakeDeps) {}

  private async withRecordLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.recordLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.recordLocks.set(key, current);
    try { return await current; }
    finally { if (this.recordLocks.get(key) === current) this.recordLocks.delete(key); }
  }

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
    const contentType = plain.contentType;
    return this.issue(plain, requestHashOf(plain, { contentType, docHash: docHash(bytes) }), async () => ({ bytes, contentType }));
  }

  async intakeUrl(envelope: Envelope): Promise<IntakeResult> {
    let plain: IntakeUrlPlain;
    try { plain = IntakeUrlPlainSchema.parse(decodeJson(this.deps.tee.decryptEnvelope(envelope, aad.intake()))); }
    catch { throw new IntakeError("BAD_ENVELOPE", "Could not open a valid intake URL request", 400); }
    return this.issue(plain, requestHashOf(plain, { url: plain.url }), async () => {
      const fetched = await fetchDocument(plain.url, this.deps.fetchPolicy, { httpGetter: this.deps.httpGetter, clock: this.deps.clock });
      return { bytes: fetched.bytes, contentType: fetched.contentType, fetched };
    });
  }

  /**
   * At most one grant per open binding: per (opener, nonce), and for a private binding also per payerCommit. The first
   * request for a binding claims it (atomic putIfAbsent, after its record is stored); an identical retry gets that same
   * grant back without a second fetch, and any other request naming the binding is refused (GRANT_EXISTS). So a relay
   * that has seen a grant cannot have the intake sign another document, URL or reading under the requester's binding.
   * Requests are serialized per binding in this process; across processes sharing the store the claims decide.
   */
  private async issue(plain: IntakeUploadPlain | IntakeUrlPlain, requestHash: Hex, load: () => Promise<IntakeDocument>): Promise<IntakeResult> {
    const checked = this.checkRequest(plain);
    const claimKeys = grantClaimKeys(plain.open);
    return this.withRecordLock(claimKeys[0]!, async () => {
      const prior = await this.priorGrant(claimKeys, requestHash);
      if (prior) return this.grantFromRecord(prior);
      const { result, record, provHash } = await this.sign(plain, checked, await load());
      // The record is stored before the claim, so a claimed grant always has its record. A request that then loses the
      // claim leaves an unreleasable record (its grant was never returned) that the upload TTL purges.
      await this.storeRecord(provHash, record);
      const granted = await this.claimGrant(claimKeys, { v: 1, provenanceHash: provHash, requestHash });
      return eq(granted, provHash) ? result : this.grantFromRecord(granted);
    });
  }

  /** Schema params and the sealed binding, checked before anything is fetched or stored. */
  private checkRequest(plain: IntakeUploadPlain | IntakeUrlPlain): { schemaVersion: number; paramsHash: Hex } {
    let def;
    let normalized;
    try {
      def = resolveSchema(plain.schemaId, plain.params);
      normalized = normalizeParams(def, plain.params);
    } catch { throw new IntakeError("BAD_PARAMS", "Parameters are invalid for the selected schema", 400); }
    if (!normalized.ok) throw new IntakeError("BAD_PARAMS", "Parameters are invalid for the selected schema", 400);
    // The binding is sealed with the document, so only its owner chooses who may open, the result key and consent.
    // Public: zero salt and zero payerCommit (no result key). Private: a salt and a payer commitment.
    const open = plain.open;
    if (open.isPublic ? !isZero(plain.salt) || !isZero(open.payerCommit) : isZero(plain.salt) || isZero(open.payerCommit)) {
      throw new IntakeError("BAD_BINDING", "Public queries need a zero salt and payer commitment; private queries need both non-zero", 400);
    }
    return { schemaVersion: def.version, paramsHash: paramsHash(normalized.params) };
  }

  /** The grant an identical earlier request already holds for this binding; refuses if another request holds it. */
  private async priorGrant(claimKeys: string[], requestHash: Hex): Promise<Hex | undefined> {
    const claims = await Promise.all(claimKeys.map((key) => this.readClaim(key)));
    if (claims.some((claim) => claim && !eq(claim.requestHash, requestHash))) throw grantExists();
    const first = claims[0];
    // Also completes a claim an interrupted first attempt did not get to write.
    return first ? this.claimGrant(claimKeys, { v: 1, provenanceHash: first.provenanceHash, requestHash }) : undefined;
  }

  /** Claims every key of the binding for `claim`; returns the binding's grant (an identical racing request's, if it won). */
  private async claimGrant(claimKeys: string[], claim: GrantClaim): Promise<Hex> {
    let granted = claim.provenanceHash;
    for (const [index, key] of claimKeys.entries()) {
      if (await this.putIfAbsent(key, encodeJson({ ...claim, provenanceHash: granted }))) continue;
      const existing = await this.readClaim(key);
      if (!existing || !eq(existing.requestHash, claim.requestHash)) throw grantExists();
      if (eq(existing.provenanceHash, granted)) continue;
      if (index !== 0) throw grantExists();
      granted = existing.provenanceHash;
    }
    return granted;
  }

  private async readClaim(key: string): Promise<GrantClaim | undefined> {
    const raw = await this.deps.store.get(key);
    if (!raw) return undefined;
    let claim: Partial<GrantClaim> | undefined;
    try { claim = decodeJson<Partial<GrantClaim>>(raw); } catch { claim = undefined; }
    // An unreadable claim still holds its binding (fail closed).
    if (claim?.v !== 1 || !hex32(claim.provenanceHash) || !hex32(claim.requestHash)) throw grantExists();
    return claim as GrantClaim;
  }

  /** The stored grant `provHash` as the intake first returned it (re-signed over the same struct, so the same grant). */
  private async grantFromRecord(provHash: Hex): Promise<IntakeResult> {
    const raw = await this.deps.store.get(this.recordKey(provHash));
    let record: StoredIntake | undefined;
    try { record = raw ? decodeJson<StoredIntake>(raw) : undefined; } catch { record = undefined; }
    if (!record || !recordMatchesGrant(record, provHash)) {
      throw new IntakeError("GRANT_UNAVAILABLE", "The grant for this open binding is no longer available; start again with a new nonce", 409);
    }
    const prov = provenanceFromJson(record.provenance);
    return {
      provenance: record.provenance, intakeSig: await signProvenance(this.deps.tee.signer(), this.deps.chainId, this.deps.escrowAddress, prov),
      intake: this.deps.tee.signer().address.toLowerCase() as Address, docCommit: record.docCommit, paramsHash: record.paramsHash,
      schemaId: record.schemaId, tokensK: prov.tokensK,
      maskedDocHash: maskDocHash(record.salt, docHash(new Uint8Array(Buffer.from(record.docB64, "base64")))),
    };
  }

  private async putIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    // Atomic where the store supports it, so first-write-wins also holds across processes; the locks cover the rest.
    if (this.deps.store.putIfAbsent) return this.deps.store.putIfAbsent(key, value);
    if (await this.deps.store.get(key)) return false;
    await this.deps.store.put(key, value);
    return true;
  }

  /**
   * One record per signed grant, keyed by the hash the escrow stores as Query.provenanceHash. First write wins: a record
   * is never replaced, so nobody can swap what the jurors of an opened query receive.
   */
  private async storeRecord(provHash: Hex, record: StoredIntake): Promise<void> {
    const key = this.recordKey(provHash);
    await this.withRecordLock(key, async () => {
      if (await this.putIfAbsent(key, encodeJson(record))) return;
      const existing = await this.deps.store.get(key);
      if (!existing || !sameUpload(decodeJson<StoredIntake>(existing), record)) {
        throw new IntakeError("PROVENANCE_EXISTS", "A different document is already recorded for this grant", 409);
      }
    });
  }

  private async sign(plain: IntakeUploadPlain | IntakeUrlPlain, checked: { schemaVersion: number; paramsHash: Hex }, doc: IntakeDocument): Promise<{ result: IntakeResult; record: StoredIntake; provHash: Hex }> {
    const { bytes, contentType, fetched } = doc;
    const open = plain.open;
    const salt = plain.salt as Hex;
    let text: string;
    try { text = await extractText(bytes, contentType, this.deps.pdfTextExtractor); }
    catch (error) {
      if (error instanceof Error && error.name === "UnsupportedContentType") throw new IntakeError("UNSUPPORTED_CONTENT_TYPE", error.message, 415);
      if (error instanceof DocumentTooLarge) throw new IntakeError("DOCUMENT_TOO_LARGE", error.message, 413);
      throw error;
    }
    const hash = docHash(bytes);
    const commitment = docCommit(salt, hash);
    const tokensK = estimateTokensK(text);
    const prov: Provenance = {
      docCommit: commitment,
      kind: fetched ? ProvenanceKind.FETCHED : ProvenanceKind.SUBMITTED,
      originId: fetched ? originId(fetched.host) : ZERO32,
      fetchedAt: fetched ? BigInt(fetched.fetchedAt) : 0n,
      tokensK,
      // FETCHED: the TLS fetch transcript, salted for a private grant so the chain cannot confirm a guessed URL and
      // document. SUBMITTED: the reading of the upload (content type, text, raw params), so the signature fixes the record
      // the jurors will get. Both are re-derived from the record before release (recordMatchesGrant).
      transcriptHash: fetched
        ? fetchedTranscriptHash({ salt, tlsTranscriptHash: fetched.transcriptHash })
        : submittedTranscriptHash({ salt, contentType, text, params: plain.params }),
      opener: open.opener as Address,
      schemaId: plain.schemaId,
      schemaVersion: checked.schemaVersion,
      paramsHash: checked.paramsHash,
      payerCommit: open.payerCommit as Hex,
      isPublic: open.isPublic,
      allowPanelDisclosure: open.allowPanelDisclosure,
      nonce: BigInt(open.nonce),
      expiry: BigInt(this.deps.clock.nowSeconds() + (this.deps.provenanceTtlSeconds ?? PROVENANCE_TTL_SECONDS)),
    };
    const intakeSig = await signProvenance(this.deps.tee.signer(), this.deps.chainId, this.deps.escrowAddress, prov);
    const provenance: ProvenanceJson = { ...prov, opener: prov.opener.toLowerCase() as Address, fetchedAt: prov.fetchedAt.toString(), nonce: prov.nonce.toString(), expiry: prov.expiry.toString() };
    const record: StoredIntake = {
      provenance, schemaId: plain.schemaId, schemaVersion: checked.schemaVersion, docCommit: commitment, salt, params: plain.params,
      paramsHash: checked.paramsHash, payerCommit: prov.payerCommit, isPublic: prov.isPublic, allowPanelDisclosure: prov.allowPanelDisclosure,
      contentType, docB64: Buffer.from(bytes).toString("base64"), text,
      ...(fetched ? { fetch: { host: fetched.host, finalUrl: fetched.finalUrl, status: fetched.status, certFingerprints: fetched.certFingerprints } } : {}),
    };
    const result: IntakeResult = {
      provenance, intakeSig, intake: this.deps.tee.signer().address.toLowerCase() as Address, docCommit: commitment,
      paramsHash: checked.paramsHash, schemaId: plain.schemaId, tokensK,
      // Lets the requester check that this grant commits to its own salt (and so to its own sealed request).
      maskedDocHash: maskDocHash(salt, hash),
    };
    return { result, record, provHash: provenanceHash(prov) };
  }

  /**
   * The sealed record of the grant this query was opened with; nothing else is ever released for it. The record is
   * re-derived against the grant before use (see `recordMatchesGrant`). Reading never retains: the caller retains the
   * record (`retain`) only after every peer it is released to has been verified.
   */
  private async recordFor(q: Awaited<ReturnType<IntakeChainPort["getQuery"]>>): Promise<{ key: string; record: StoredIntake }> {
    const key = q.provenanceHash && !isZero(q.provenanceHash) ? this.recordKey(q.provenanceHash) : undefined;
    const raw = key ? await this.deps.store.get(key) : undefined;
    if (!key || !raw) throw new IntakeError("UNKNOWN_DOC", "Document is not available in intake storage", 404);
    let record: StoredIntake;
    try { record = decodeJson<StoredIntake>(raw); } catch { throw new IntakeError("RECORD_MISMATCH", "Stored document does not match the query", 409); }
    if (!eq(record.docCommit, q.docCommit) || !eq(record.paramsHash, q.paramsHash) || record.schemaId !== q.schemaId || !recordMatchesGrant(record, q.provenanceHash)) {
      throw new IntakeError("RECORD_MISMATCH", "Stored document does not match the query", 409);
    }
    return { key, record };
  }

  /**
   * Keeps a released record past the upload TTL (a query opened with its grant has been dispatched), together with
   * its binding's grant claims, so the binding keeps refusing a second grant for as long as the record is kept.
   */
  private async retain(key: string, record: StoredIntake) {
    if (!this.deps.store.retain) return;
    await this.deps.store.retain(key);
    for (const claimKey of grantClaimKeys(record.provenance)) await this.deps.store.retain(claimKey);
  }

  /**
   * Human-panel escalation (§3.4): re-encrypt the document to the drawn evaluators. Allowed only when the query is
   * ESCALATED, its panel case is seated and voting (COMMIT or REVEAL), the query is public or the payer consented at
   * open (allowPanelDisclosure), and every evaluator is on the current panel on-chain and proves control of its x25519
   * key with a signature from its staked address. A record that is gone (expired from the sealed store) is refused
   * with the permanent MATERIALS_UNAVAILABLE (410): the seat cannot evaluate the case and should abstain on chain.
   */
  async dispatchPanel(req: DispatchPanelReq) {
    const queryId = req.queryId as Hex;
    const chain = this.deps.chain;
    if (!chain.getPanelCase || !chain.panelOf) throw new IntakeError("PANEL_UNAVAILABLE", "Panel reads are not configured", 503);
    const q = await chain.getQuery(queryId);
    if (q.status !== 5) throw new IntakeError("NOT_ESCALATED", "Query is not escalated to a panel", 409);
    if (!q.isPublic && !q.allowPanelDisclosure) throw new IntakeError("DISCLOSURE_NOT_ALLOWED", "Payer did not consent to panel disclosure", 403);
    const panelCase = await chain.getPanelCase(queryId);
    // While DRAWING, panelOf can already show seats chosen by a draw that spans calls; resolved, FINAL and DRAW_EXPIRED
    // cases have no panel voting.
    if (panelCase.status !== PANEL_COMMIT && panelCase.status !== PANEL_REVEAL) {
      throw new IntakeError("PANEL_CLOSED", "Panel case is not open for evaluation", 409);
    }
    if (panelCase.panelIndex !== req.panelIndex) throw new IntakeError("WRONG_PANEL", "Not the current panel", 409);
    const members = (await chain.panelOf(queryId, req.panelIndex)).map((a) => a.toLowerCase());
    const { key, record } = await this.recordFor(q).catch((error: unknown) => {
      if (error instanceof IntakeError && error.code === "UNKNOWN_DOC") {
        throw new IntakeError("MATERIALS_UNAVAILABLE", "The case document is no longer available; abstain on chain", 410);
      }
      throw error;
    });
    if (!record.isPublic && !record.allowPanelDisclosure) throw new IntakeError("DISCLOSURE_NOT_ALLOWED", "Payer did not consent to panel disclosure", 403);
    const out: { address: Address; docEnvelope: Envelope }[] = [];
    for (const evaluator of req.evaluators) {
      if (!members.includes(evaluator.address.toLowerCase())) throw new IntakeError("NOT_PANELIST", "Evaluator is not on the current panel", 403);
      const digest = evaluatorKeyDigest(queryId, req.panelIndex, evaluator.encryptionPubKey as Hex);
      let signer: Address;
      try { signer = await recoverMessageAddress({ message: { raw: digest }, signature: evaluator.keySig as Hex }); }
      catch { throw new IntakeError("BAD_KEY_SIG", "Evaluator key binding signature is invalid", 403); }
      if (signer.toLowerCase() !== evaluator.address.toLowerCase()) throw new IntakeError("BAD_KEY_SIG", "Evaluator key binding signature is invalid", 403);
      const plain = PanelDocPlainSchema.parse({
        v: 1, queryId: req.queryId, schemaId: q.schemaId, schemaVersion: q.schemaVersion ?? record.schemaVersion, docCommit: q.docCommit,
        salt: record.salt, params: record.params, contentType: record.contentType, docB64: record.docB64, text: record.text,
      });
      out.push({ address: evaluator.address as Address, docEnvelope: seal(evaluator.encryptionPubKey as Hex, encodeJson(plain), aad.panel(queryId, evaluator.address as Hex)) });
    }
    const response = DispatchPanelResSchema.parse({ evaluators: out });
    await this.retain(key, record);
    return response;
  }

  async dispatch(req: DispatchReq) {
    const queryId = req.queryId as Hex;
    const q = await this.deps.chain.getQuery(queryId);
    if (q.status !== 2) throw new IntakeError("QUERY_NOT_SEALED", "Query is not sealed", 409);
    const seats = await this.deps.chain.jurorsOf(queryId);
    const { key, record } = await this.recordFor(q);
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
    const response = DispatchResSchema.parse({ jurors: jurorOutputs, consensusSeed: seal(req.consensus.encryptionPubKey as Hex, encodeJson(seed), aad.consensusSeed(req.queryId as Hex)) });
    // Retained only now: a request naming an unselected, inactive or badly attested peer keeps nothing past the TTL.
    await this.retain(key, record);
    return response;
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

  private recordKey(provenanceStructHash: Hex) { return `prov:${provenanceStructHash.toLowerCase()}`; }
}

/**
 * A record belongs to the grant with struct hash `grantHash` only if it re-derives that grant: the stored provenance
 * hashes to it and agrees with the record's own fields, salt and bytes give its docCommit, the raw params give its
 * paramsHash, and its transcriptHash re-derives: for a SUBMITTED document from salt, contentType, text and raw params;
 * for a FETCHED one from the fetch metadata, contentType and bytes (the TLS transcript), salted for a private grant,
 * with originId from the fetched host. Records written before grants (or fetch metadata) were stored with them are
 * refused (fail closed).
 */
function recordMatchesGrant(record: StoredIntake, grantHash: Hex): boolean {
  try {
    const parsed = ProvenanceJsonSchema.safeParse(record.provenance);
    if (!parsed.success) return false;
    const prov = parsed.data;
    if (!eq(provenanceHash(provenanceFromJson(prov)), grantHash)) return false;
    if (!eq(prov.docCommit, record.docCommit) || !eq(prov.paramsHash, record.paramsHash) || prov.schemaId !== record.schemaId
      || prov.schemaVersion !== record.schemaVersion || !eq(prov.payerCommit, record.payerCommit) || prov.isPublic !== record.isPublic
      || prov.allowPanelDisclosure !== record.allowPanelDisclosure) return false;
    if (!eq(docCommit(record.salt, docHash(new Uint8Array(Buffer.from(record.docB64, "base64")))), prov.docCommit)) return false;
    const normalized = normalizeParams(resolveSchema(record.schemaId, record.params), record.params);
    if (!normalized.ok || !eq(paramsHash(normalized.params), prov.paramsHash)) return false;
    if (prov.kind === ProvenanceKind.SUBMITTED) {
      return eq(submittedTranscriptHash({ salt: record.salt, contentType: record.contentType, text: record.text, params: record.params }), prov.transcriptHash);
    }
    const fetched = record.fetch;
    if (prov.kind !== ProvenanceKind.FETCHED || !fetched || !eq(originId(fetched.host), prov.originId)) return false;
    const tls = tlsTranscriptHash({
      host: fetched.host, finalUrl: fetched.finalUrl, status: fetched.status, contentType: record.contentType,
      docHash: docHash(new Uint8Array(Buffer.from(record.docB64, "base64"))), certFingerprints: fetched.certFingerprints,
    });
    return eq(fetchedTranscriptHash({ salt: record.salt, tlsTranscriptHash: tls }), prov.transcriptHash);
  } catch { return false; }
}
