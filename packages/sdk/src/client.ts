import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { canonicalJson, computeQueryId, docCommit, docHash, ProvenanceKind, Role, ZERO32 } from "@mochi/core";
import { aad, AttestationDocSchema, DisclosureReqSchema, EnvelopeSchema, IntakeResultSchema, IntakeUploadPlainSchema, IntakeUrlPlainSchema, PrivateResultPlainSchema, maskDocHash, payerCommit, privateResultMismatch, provenanceFromJson, provenanceMatchesBinding, type IntakeResult, type OpenBinding, type PrivateResultPlain } from "@mochi/protocol";
import { decodePayload, getSchema, normalizeParams, paramsHash, resolveSchema, SCHEMAS } from "@mochi/schemas";
import { keyBinding, open, recoverProvenance, seal, type QuoteVerifier, type Envelope } from "@mochi/tee";
import { verifyReceipt as verifyReceiptProof, type ReceiptPublicKey } from "@mochi/receipts";
import { DisclosureRegistryAbi, JurorRegistryAbi, MochiVerdictsAbi, QueryEscrowAbi, ReceiptAnchorAbi, type Deployment } from "@mochi/chain";
import { encodeFunctionData, fromHex, keccak256, toHex, type Address, type Hex, type PublicClient, type WalletClient, publicActions, createPublicClient, http } from "viem";
import { recipientKeyHash } from "@mochi/protocol";
import { AspTree, StateTreeSync, buildWithdrawalProof, generateNote, openShieldedPaymentFor, type Deposit, type Note } from "@mochi/privacy";
import { POSTMAN_ABI } from "@mochi/privacy/postman";
import { parseAbi } from "viem";

export class AttestationError extends Error {
  constructor(message = "Intake attestation verification failed") { super(message); this.name = "AttestationError"; }
}

export type AskDocument = { bytes: Uint8Array; contentType: string } | { url: string };
export type Pay = { path: "usdg" } | { path: "shielded"; nullifier: Hex; proof: Hex } | { path: "shielded-pool"; note: Note; depositInfo: ShieldedDepositInfo };
export type ShieldedDepositInfo = { deposit: Deposit; pool?: Address; fromBlock?: bigint; newNote?: Note };
export interface PrepareQueryOptions {
  schema: string | number;
  document: AskDocument;
  params?: Record<string, unknown>;
  n?: 3 | 5 | 7 | 9;
  isPublic: boolean;
  allowPanelDisclosure?: boolean;
  sender: Address;
  refundTo?: Address;
  pay?: Pay;
}
export interface QuerySecrets { salt: Hex; resultPrivateKey?: Hex }
/** What decryptPrivateResult needs: the query the verdict must belong to and that query's secrets. */
export type PrivateQueryKeys = QuerySecrets & { queryId: Hex };
export class IntakeBindingError extends Error {
  constructor(message = "Intake result does not match the sealed request") { super(message); this.name = "IntakeBindingError"; }
}
/** The gateway answered with something other than what the signed grant and the chain determine. */
export class GatewayMismatchError extends Error {
  constructor(message: string) { super(message); this.name = "GatewayMismatchError"; }
}
/** An operation that checks grants or results against the chain was called without `options.chain`. */
export class ChainConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ChainConfigError"; }
}
export interface QueryTransaction { to: Address; data: Hex }
/** QueryEscrow.quote(schemaId, n, tokensK), read from the chain (USDG base units as decimal strings). */
export interface QueryQuote { jurorFees: string; protocolFee: string }
export interface PreparedQuery { queryId: Hex; tx: QueryTransaction; quote: QueryQuote; secrets: QuerySecrets }

type ClientOpts = {
  gatewayUrl: string;
  indexerUrl?: string;
  fetch?: typeof globalThis.fetch;
  quoteVerifier: QuoteVerifier;
  intakeMeasurement: Hex;
  /**
   * The deployment to check against, and optionally a client for its RPC (else one is made from `deployment.rpcUrl`).
   * Required to prepare, ask, wait for a verdict, decrypt or read a disclosure: the SDK takes the queryId, price, intake
   * key status, verdict id, query status and verdict commitments from the chain, never from the gateway.
   */
  chain?: { deployment: Deployment; publicClient?: PublicClient };
  buildShieldedProof?: typeof buildWithdrawalProof;
  hungGraceMs?: number;
};
type OnChainVerdict = { queryId: Hex; isPublic: boolean; answerHash: Hex; payloadHash: Hex };
/** A verdict as MochiVerdicts stores it (`getVerdict`), read from the chain: none of it comes from the gateway. */
export interface ChainVerdict extends OnChainVerdict {
  verdictId: Hex;
  round: number;
  /** MochiTypes.VerdictStatus: 1 VERDICT, 2 HUNG. */
  status: number;
  escalated: boolean;
  schemaId: number;
  schemaVersion: number;
  agreementBps: number;
  dissentMask: number;
  timeoutMask: number;
}
/** Where the envelope readDisclosure accepted came from. */
export type DisclosureSource =
  /** The envelope `discloser` recorded in DisclosureRegistry; its keccak256(canonical JSON) matched that record. */
  | { anchored: true; envelopeHash: Hex; discloser: Address; disclosedAt: number }
  /**
   * `discloser` (the trusted address that was looked up; null when no registry was read or the payer is unknown) has no
   * record, so the first stored envelope that opened and matched the on-chain verdict was taken, after `tried` attempts.
   * The chain commits to answerJson and payload only: the result's other members (`fields`) are as the poster sealed them.
   */
  | { anchored: false; envelopeHash: Hex; discloser: Address | null; tried: number };
/** A disclosed private result, checked against the on-chain verdict, and how its envelope was chosen. */
export type DisclosedResult = PrivateResultPlain & { disclosure: DisclosureSource };
export interface ReadDisclosureOptions {
  /** The address whose DisclosureRegistry record to trust. Default: QueryEscrow.getQuery(verdict.queryId).payer. */
  discloser?: Address;
  /** The DisclosureRegistry to read. Default: deployment.contracts.disclosureRegistry. */
  disclosureRegistry?: Address;
}
/** Most stored envelopes readDisclosure tries when nothing is anchored (the gateway lists at most this many). */
const DISCLOSURE_TRY_LIMIT = 256;
/** The hash MochiClient.disclose anchors in DisclosureRegistry and the gateway stores an envelope under. */
const envelopeHashOf = (envelope: unknown): Hex => keccak256(toHex(canonicalJson(envelope)));
/** MochiTypes.QueryStatus values waitForVerdict acts on. */
const QUERY_DECIDED = 3, QUERY_HUNG = 4, QUERY_ESCALATED = 5;
type ChainReader = { deployment: Deployment; client: PublicClient };
type Attestation = ReturnType<typeof AttestationDocSchema.parse>;
type Verdict = Record<string, unknown> & { chain?: Record<string, unknown>; ciphertext?: Hex; decodedPayload?: unknown };
const utf8 = new TextEncoder();
const hex32 = (value: string): value is Hex => /^0x[0-9a-f]{64}$/.test(value);
const anyHex32 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const randHex = (n: number) => toHex(randomBytes(n));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bodyJson = async (r: Response) => {
  const value: unknown = await r.json();
  if (!r.ok) throw new Error(`Mochi HTTP ${r.status} ${new URL(r.url || "http://unknown").pathname}: ${JSON.stringify(value).slice(0, 200)}`);
  return value as Record<string, any>;
};

export class MochiClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly gateway: string;
  private readonly indexer: string;
  private attestation?: { value: Attestation; expires: number };
  private defaultClient?: PublicClient;
  private network?: Promise<void>;

  constructor(private readonly options: ClientOpts) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.gateway = options.gatewayUrl.replace(/\/$/, "");
    this.indexer = (options.indexerUrl ?? options.gatewayUrl).replace(/\/$/, "");
  }

  private async request(url: string, init?: RequestInit): Promise<Record<string, any>> {
    const response = await this.fetcher(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
    return bodyJson(response);
  }

  async intakeAttestation(): Promise<Attestation> {
    if (this.attestation && this.attestation.expires > Date.now()) return this.attestation.value;
    try {
      const raw = await this.request(`${this.gateway}/v1/intake/attestation`);
      const doc = AttestationDocSchema.parse(raw);
      if (doc.role !== "INTAKE") throw new AttestationError("Attestation role is not INTAKE");
      const expected = keyBinding(doc.address as Address, doc.encryptionPubKey as Hex);
      const verified = await this.options.quoteVerifier.verify(doc.quote as never, {
        measurement: this.options.intakeMeasurement,
        reportData: expected,
        maxAgeSec: 600,
      });
      if (!verified.ok) throw new AttestationError(verified.reason);
      this.attestation = { value: doc, expires: Date.now() + 5 * 60_000 };
      return doc;
    } catch (error) {
      if (error instanceof AttestationError) throw error;
      throw new AttestationError(error instanceof Error ? error.message : undefined);
    }
  }

  private schemaIdOf(schema: string | number): number {
    const schemaId = typeof schema === "number" ? schema : Object.values(SCHEMAS).find((def) => def.name === schema)?.id;
    if (!schemaId) throw new TypeError(`Unknown schema: ${schema}`);
    getSchema(schemaId as never);
    return schemaId;
  }

  /** The paramsHash the intake must sign for these params (what jurors and the chain will see), computed locally. */
  private paramsHashOf(schemaId: number, params: Record<string, unknown>): Hex {
    let normalized: ReturnType<typeof normalizeParams>;
    try { normalized = normalizeParams(resolveSchema(schemaId as never, params), params); }
    catch { throw new TypeError("Invalid schema parameters"); }
    if (!normalized.ok) throw new TypeError(`Invalid schema parameters: ${normalized.errors.join("; ")}`);
    return paramsHash(normalized.params);
  }

  /**
   * The configured deployment and an RPC client on it (checked once to be on deployment.chainId). Everything the SDK
   * relies on to accept a grant, pay, or accept a result is read through this, so it is required for those calls.
   */
  private async chainReader(purpose: string, contracts: readonly (keyof Deployment["contracts"])[]): Promise<ChainReader> {
    const chain = this.options.chain;
    const deployment = chain?.deployment;
    if (!deployment || !Number.isSafeInteger(deployment.chainId) || deployment.chainId <= 0) {
      throw new ChainConfigError(`${purpose} requires options.chain with the deployment to check against`);
    }
    for (const name of contracts) {
      if (!isAddress(deployment.contracts?.[name])) throw new ChainConfigError(`${purpose} requires deployment.contracts.${name}`);
    }
    const client = chain.publicClient ?? (this.defaultClient ??= createPublicClient({ transport: http(deployment.rpcUrl) }));
    this.network ??= client.getChainId().then((id) => {
      if (id !== deployment.chainId) throw new ChainConfigError(`RPC is on chain ${id}, deployment is ${deployment.chainId}`);
    });
    try { await this.network; } catch (error) { this.network = undefined; throw error; }
    return { deployment, client };
  }

  /** QueryEscrow.quote for this query, from the chain (never the gateway's figure). */
  private async chainQuote({ deployment, client }: ChainReader, schemaId: number, n: number, tokensK: number): Promise<QueryQuote & { total: bigint }> {
    const [jurorFees, protocolFee] = await client.readContract({
      address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "quote", args: [schemaId, n, tokensK],
    }) as readonly [bigint, bigint];
    return { jurorFees: jurorFees.toString(), protocolFee: protocolFee.toString(), total: jurorFees + protocolFee };
  }

  /** The verdict record on chain; the gateway's copy is never used for a check. */
  private async onChainVerdict(verdictId: Hex, purpose: string): Promise<ChainVerdict> {
    const reader = await this.chainReader(purpose, ["verdicts"]);
    const record = await reader.client.readContract({
      address: reader.deployment.contracts.verdicts, abi: MochiVerdictsAbi, functionName: "getVerdict", args: [verdictId],
    }) as Partial<Record<keyof ChainVerdict, unknown>>;
    if (!anyHex32(record?.queryId) || /^0x0{64}$/.test(record.queryId) || !anyHex32(record.answerHash) || !anyHex32(record.payloadHash)) {
      throw new Error("Verdict is not recorded on chain");
    }
    const num = (value: unknown) => typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
    return {
      verdictId, queryId: record.queryId, isPublic: record.isPublic === true, answerHash: record.answerHash, payloadHash: record.payloadHash,
      round: num(record.round), status: num(record.status), escalated: record.escalated === true, schemaId: num(record.schemaId),
      schemaVersion: num(record.schemaVersion), agreementBps: num(record.agreementBps), dissentMask: num(record.dissentMask), timeoutMask: num(record.timeoutMask),
    };
  }

  /**
   * The verdict as recorded on chain by MochiVerdicts (status, schema, agreement and masks, answerHash, payloadHash).
   * Requires `chain`. Use it for anything that must not rest on the gateway's copy (getVerdict returns that copy).
   */
  async chainVerdict(verdictId: Hex): Promise<ChainVerdict> {
    if (!anyHex32(verdictId)) throw new TypeError("chainVerdict needs a bytes32 verdictId");
    return this.onChainVerdict(verdictId, "chainVerdict");
  }

  /** Fresh salt and, for a private query, a fresh result key pair; the binding the intake will sign for `opener`. */
  private newQuery(opts: PrepareQueryOptions, opener: string) {
    const salt = opts.isPublic ? ZERO32 : randHex(32);
    const secrets: QuerySecrets = { salt };
    let payerResultPubKey: Hex | undefined;
    if (!opts.isPublic) {
      const pair = x25519.keygen();
      payerResultPubKey = toHex(pair.publicKey);
      secrets.resultPrivateKey = toHex(pair.secretKey);
    }
    const binding: OpenBinding = {
      opener: opener.toLowerCase(), payerCommit: payerResultPubKey ? payerCommit(payerResultPubKey) : ZERO32,
      isPublic: opts.isPublic, allowPanelDisclosure: opts.allowPanelDisclosure ?? false, nonce: BigInt(randHex(8)).toString(),
    };
    return { salt, secrets, payerResultPubKey, binding };
  }

  /**
   * Seals the document together with the open binding to the attested intake and checks the signed grant before it can
   * be used to open: it names exactly the sealed binding, schema and params (paramsHash computed locally), commits to
   * this request's salt (docCommit from the bytes, or in URL mode from the intake's salt-masked docHash), has the kind
   * of the request, its EIP-712 signature (this deployment's escrow domain) recovers to the attested intake, and that
   * key is an active INTAKE on chain. A grant the gateway obtained for its own request fails the salt or params check.
   */
  private async intakeGrant(opts: PrepareQueryOptions, schemaId: number, salt: Hex, binding: OpenBinding, reader: ChainReader): Promise<IntakeResult> {
    const params = opts.params ?? {};
    const expectedParamsHash = this.paramsHashOf(schemaId, params);
    const attestation = await this.intakeAttestation();
    let plain: unknown, path: string;
    if ("bytes" in opts.document) {
      plain = IntakeUploadPlainSchema.parse({ v: 1, schemaId, salt, params, contentType: opts.document.contentType, docB64: b64(opts.document.bytes), open: binding });
      path = `/v1/intake/upload?n=${opts.n ?? 3}`;
    } else {
      plain = IntakeUrlPlainSchema.parse({ v: 1, schemaId, salt, params, url: opts.document.url, open: binding });
      path = `/v1/intake/url?n=${opts.n ?? 3}`;
    }
    const envelope = seal(attestation.encryptionPubKey as Hex, utf8.encode(canonicalJson(plain)), aad.intake());
    const result = IntakeResultSchema.parse(await this.request(`${this.gateway}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }),
    })) as IntakeResult;
    const prov = result.provenance;
    if (!provenanceMatchesBinding(prov, binding) || prov.schemaId !== schemaId || result.schemaId !== schemaId || result.intake !== attestation.address
      || result.docCommit !== prov.docCommit || result.paramsHash !== prov.paramsHash || result.tokensK !== prov.tokensK) throw new IntakeBindingError();
    if (prov.paramsHash !== expectedParamsHash) throw new IntakeBindingError("Intake params hash does not match the sealed params");
    const upload = "bytes" in opts.document;
    if (prov.kind !== (upload ? ProvenanceKind.SUBMITTED : ProvenanceKind.FETCHED)) throw new IntakeBindingError("Intake provenance kind does not match the request");
    let hash: Hex;
    if ("bytes" in opts.document) hash = docHash(opts.document.bytes);
    else if (result.maskedDocHash) hash = maskDocHash(salt, result.maskedDocHash as Hex);
    else throw new IntakeBindingError("Intake result has no document hash to check a URL grant against");
    if (prov.docCommit !== docCommit(salt, hash)) throw new IntakeBindingError("Intake document commitment mismatch");
    const { deployment, client } = reader;
    const signer = await recoverProvenance(deployment.chainId, deployment.contracts.queryEscrow, provenanceFromJson(prov), result.intakeSig as Hex).catch(() => undefined);
    if (!signer || !same(signer, attestation.address)) throw new IntakeBindingError("Intake provenance signature is invalid");
    const active = await client.readContract({ address: deployment.contracts.jurorRegistry, abi: JurorRegistryAbi, functionName: "isActive", args: [signer, Role.INTAKE] });
    if (active !== true) throw new IntakeBindingError("Intake key is not an active INTAKE on chain");
    return result;
  }

  /**
   * Seals the document, checks the intake's grant (see intakeGrant), and returns the open transaction, the queryId and
   * the price. queryId, calldata and price are derived locally and from the chain; the gateway's /v1/query (which also
   * stores the result public key for a private query) must agree with them or the query is refused.
   */
  async prepareQuery(opts: PrepareQueryOptions): Promise<PreparedQuery> {
    if (opts.pay?.path === "shielded-pool") throw new TypeError("shielded-pool payments are prepared and relayed by ask()");
    const reader = await this.chainReader("prepareQuery", ["queryEscrow", "jurorRegistry"]);
    const schemaId = this.schemaIdOf(opts.schema);
    const { salt, secrets, payerResultPubKey, binding } = this.newQuery(opts, opts.sender);
    const intakeResult = await this.intakeGrant(opts, schemaId, salt, binding, reader);
    const n = opts.n ?? 3;
    // The gateway accepts lowercase addresses only; wallets usually return checksummed ones.
    const refundTo = (opts.refundTo ?? opts.sender).toLowerCase() as Address;
    const pay = opts.pay ?? { path: "usdg" as const };
    const prov = provenanceFromJson(intakeResult.provenance);
    const escrow = reader.deployment.contracts.queryEscrow.toLowerCase() as Address;
    const queryId = computeQueryId({ chainId: reader.deployment.chainId, escrow, opener: prov.opener, docCommit: prov.docCommit, nonce: prov.nonce });
    const { total: _total, ...quote } = await this.chainQuote(reader, schemaId, n, prov.tokensK);
    const queryBody: Record<string, unknown> = { intake: intakeResult, n, refundTo, ...(payerResultPubKey ? { payerResultPubKey } : {}), pay };
    const query = await this.request(`${this.gateway}/v1/query`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(queryBody),
    });
    if (!hex32(query.queryId) || !/^0x[0-9a-f]{40}$/.test(query.to) || typeof query.data !== "string") {
      throw new TypeError("Gateway returned an invalid query transaction");
    }
    if (query.queryId !== queryId) throw new GatewayMismatchError("Gateway query ID does not match the signed grant");
    // The open call is fully determined by the signed grant, so never send gateway-built calldata that differs.
    const params = { n, refundTo };
    const expected = pay.path === "shielded"
      ? encodeFunctionData({ abi: QueryEscrowAbi, functionName: "openShielded", args: [params, prov, intakeResult.intakeSig as Hex, pay.nullifier, pay.proof] })
      : encodeFunctionData({ abi: QueryEscrowAbi, functionName: "openWithUSDG", args: [params, prov, intakeResult.intakeSig as Hex] });
    if (query.data !== expected || query.to !== escrow) throw new TypeError("Gateway returned an unexpected query transaction");
    return { queryId, tx: { to: escrow, data: expected }, quote, secrets };
  }

  async ask(opts: PrepareQueryOptions, wallet: WalletClient) {
    if (opts.pay?.path === "shielded-pool") return this.askShieldedPool(opts, wallet, opts.pay);
    const prepared = await this.prepareQuery(opts);
    const sender = wallet.account;
    if (!sender) throw new TypeError("WalletClient must have an account");
    const txHash = await wallet.sendTransaction({ account: sender, to: prepared.tx.to, data: prepared.tx.data, chain: wallet.chain });
    // Reuse the wallet's own transport for reads (wallet.transport is a config object, not a transport factory).
    const receiptClient = this.options.chain?.publicClient ?? wallet.extend(publicActions);
    const receipt = await receiptClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`Query transaction reverted: ${txHash}`);
    return { queryId: prepared.queryId, txHash, secrets: prepared.secrets, quote: prepared.quote };
  }

  /**
   * Pays from a privacy-pool note through the gateway relayer. The withdrawal proof is bound only to (escrow, queryId,
   * amount), so both come from the signed grant and the chain: queryId = computeQueryId(relayer, docCommit, nonce)
   * locally, amount = QueryEscrow.quote. A gateway that names another query or price is refused before proving.
   */
  private async askShieldedPool(opts: PrepareQueryOptions, wallet: WalletClient, payment: Extract<Pay, { path: "shielded-pool" }>) {
    const reader = await this.chainReader("shielded-pool payments", ["queryEscrow", "jurorRegistry"]);
    const { deployment, client: publicClient } = reader;
    if (!deployment.privacy) throw new ChainConfigError("shielded-pool payments require a privacy deployment");
    const relayer = await this.request(`${this.gateway}/v1/relayer`);
    if (typeof relayer.address !== "string" || !isAddress(relayer.address)) throw new TypeError("Gateway returned an invalid relayer address");
    relayer.address = relayer.address.toLowerCase(); // the protocol's address schema is lowercase-only
    const schemaId = this.schemaIdOf(opts.schema);
    const n = opts.n ?? 3;
    // The relayer submits openShielded, so the intake grant names the relayer as its opener.
    const { salt, secrets, payerResultPubKey, binding } = this.newQuery(opts, relayer.address);
    const intakeResult = await this.intakeGrant(opts, schemaId, salt, binding, reader);
    const prov = provenanceFromJson(intakeResult.provenance);
    const queryId = computeQueryId({ chainId: deployment.chainId, escrow: deployment.contracts.queryEscrow, opener: prov.opener, docCommit: prov.docCommit, nonce: prov.nonce });
    const { total: amount, ...quote } = await this.chainQuote(reader, schemaId, n, prov.tokensK);
    const requestBody = {
      intake: intakeResult, n, refundTo: (opts.refundTo ?? relayer.address).toLowerCase(),
      // Quote-only ask: queryId = computeQueryId(relayer, docCommit, nonce) does not depend on the pay path, and
      // the gateway rejects an empty shielded proof, so ask with the plain path and discard the returned calldata.
      ...(payerResultPubKey ? { payerResultPubKey } : {}), pay: { path: "usdg" },
    };
    // Also stores the result public key of a private query for the orchestrator; its queryId must be the grant's.
    const prepared = await this.request(`${this.gateway}/v1/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
    if (prepared.queryId !== queryId) throw new GatewayMismatchError("Gateway query ID does not match the signed grant");
    const pool = payment.depositInfo.pool ?? deployment.privacy.pool;
    const stateTree = await new StateTreeSync().rebuild(publicClient, pool, payment.depositInfo.fromBlock ?? 0n);
    const currentRoot = await publicClient.readContract({ address: pool, abi: parseAbi(["function currentRoot() view returns (uint256)"]), functionName: "currentRoot" });
    stateTree.assertRoot(currentRoot);
    const logs = await publicClient.getLogs({ address: pool, event: parseAbi(["event Deposited(address indexed _depositor,uint256 _commitment,uint256 _label,uint256 _value,uint256 _precommitmentHash)"])[0], fromBlock: payment.depositInfo.fromBlock ?? 0n });
    const aspTree = new AspTree();
    for (const log of logs) if (log.args._label !== undefined) aspTree.add(log.args._label);
    const root = await publicClient.readContract({ address: deployment.privacy.entrypoint, abi: POSTMAN_ABI, functionName: "latestRoot" });
    aspTree.assertRoot(root);
    const dummy = { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n], pubSignals: Array(8).fill(0n) };
    const withdrawal = openShieldedPaymentFor(deployment.privacy.adapter, deployment.contracts.queryEscrow, queryId, dummy).withdrawal;
    const prove = this.options.buildShieldedProof ?? buildWithdrawalProof;
    const built = await prove({ note: payment.note, deposit: payment.depositInfo.deposit, stateTree, aspTree, withdrawal, scope: BigInt(deployment.privacy.scope), withdrawnValue: amount, ...(payment.depositInfo.newNote ? { newNote: payment.depositInfo.newNote } : {}) });
    const encoded = openShieldedPaymentFor(deployment.privacy.adapter, deployment.contracts.queryEscrow, queryId, built.proof);
    const { pay: _quoteOnly, ...relayFields } = requestBody;
    const relayBody = { ...relayFields, nullifier: encoded.nullifier, proof: encoded.proof };
    const relayed = await this.request(`${this.gateway}/v1/relay/open-shielded`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(relayBody) });
    if (!hex32(relayed.queryId) || typeof relayed.txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(relayed.txHash)) throw new TypeError("Gateway returned an invalid relay receipt");
    if (relayed.queryId !== queryId) throw new GatewayMismatchError("Gateway relayed a different query");
    return { queryId, txHash: relayed.txHash as Hex, changeNote: built.newNote, secrets, quote, proofSeconds: built.seconds };
  }

  /**
   * Waits for the query's verdict and returns its id. The id and the query status are read from the chain
   * (MochiVerdicts.latestVerdictOf and QueryEscrow.getQuery), never from the gateway: the gateway is only asked whether it
   * can already serve that verdict (getVerdict and decryptPrivateResult fetch it there). Returns once the query is
   * DECIDED or ESCALATED, or after `hungGraceMs` in HUNG (it may still be expanded); with `final: false`, as soon as any
   * verdict is recorded. Requires `chain`.
   */
  async waitForVerdict(queryId: Hex, opts: { timeoutMs?: number; pollMs?: number; final?: boolean; hungGraceMs?: number } = {}): Promise<Hex> {
    if (!anyHex32(queryId)) throw new TypeError("waitForVerdict needs a bytes32 queryId");
    const { deployment, client } = await this.chainReader("waitForVerdict", ["verdicts", "queryEscrow"]);
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    const grace = opts.hungGraceMs ?? this.options.hungGraceMs ?? 30_000;
    let hungSince: number | undefined;
    // A verdict ID is on chain before the orchestrator has persisted the result; only return once the gateway serves it.
    const readable = async (id: Hex) => {
      const r = await this.fetcher(`${this.gateway}/v1/verdict/${id}`, { signal: AbortSignal.timeout(30_000) });
      return r.ok;
    };
    while (Date.now() < deadline) {
      const [latest, query] = await Promise.all([
        client.readContract({ address: deployment.contracts.verdicts, abi: MochiVerdictsAbi, functionName: "latestVerdictOf", args: [queryId] }) as Promise<unknown>,
        client.readContract({ address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "getQuery", args: [queryId] }) as Promise<{ status?: unknown }>,
      ]);
      const id = anyHex32(latest) && !/^0x0{64}$/.test(latest) ? latest.toLowerCase() as Hex : undefined;
      const status = Number(query?.status ?? 0);
      if (id && (opts.final === false || status === QUERY_DECIDED || status === QUERY_ESCALATED) && await readable(id)) return id;
      if (status === QUERY_HUNG) {
        hungSince ??= Date.now();
        if (id && Date.now() - hungSince >= grace && await readable(id)) return id;
      } else hungSince = undefined;
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1000));
    }
    throw new Error(`Timed out waiting for verdict for ${queryId}`);
  }

  async getVerdict(verdictId: Hex): Promise<Verdict> {
    const v = await this.request(`${this.gateway}/v1/verdict/${verdictId}`);
    if (v.chain && v.decodedPayload === undefined && typeof v.chain.schemaId === "number" && typeof v.chain.payload === "string" && v.chain.payload !== "0x") {
      v.decodedPayload = decodePayload(v.chain.schemaId as never, v.chain.payload as Hex);
    }
    return v as Verdict;
  }

  /**
   * Decrypts a private result and accepts it only against the chain (never the gateway's copy): the on-chain verdict
   * belongs to `query.queryId` and is private, the result names this verdict and carries this query's salt, and
   * keccak256(answerJson) == answerHash and privatePayloadHash(salt, payload) == payloadHash. The x25519 sealing is
   * unauthenticated, so without these checks anyone holding the public key could seal a result. Requires `chain`.
   */
  async decryptPrivateResult(verdictId: Hex, query: PrivateQueryKeys): Promise<ReturnType<typeof PrivateResultPlainSchema.parse>> {
    if (typeof query !== "object" || query === null) throw new TypeError("decryptPrivateResult needs the query's { queryId, salt, resultPrivateKey }");
    const { queryId, salt, resultPrivateKey } = query;
    if (!anyHex32(queryId) || !anyHex32(salt) || /^0x0{64}$/.test(salt) || !anyHex32(resultPrivateKey)) {
      throw new TypeError("decryptPrivateResult needs the private query's queryId, non-zero salt and resultPrivateKey");
    }
    const onChain = await this.onChainVerdict(verdictId, "decryptPrivateResult");
    if (!same(onChain.queryId, queryId)) throw new Error("Private result verdict belongs to another query");
    if (onChain.isPublic) throw new Error("Verdict is public: there is no private result");
    const verdict = await this.request(`${this.gateway}/v1/verdict/${verdictId}`);
    if (typeof verdict.ciphertext !== "string") throw new TypeError("Verdict has no private result ciphertext");
    const envelope = JSON.parse(new TextDecoder().decode(fromHex(verdict.ciphertext as Hex, "bytes"))) as Envelope;
    const result = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(fromHex(resultPrivateKey, "bytes"), envelope, aad.result(verdictId)))));
    if (!same(result.verdictId, verdictId)) throw new Error("Private result verdict id mismatch");
    if (!same(result.salt, salt)) throw new Error("Private result salt mismatch");
    const mismatch = privateResultMismatch(result, onChain);
    if (mismatch) throw new Error(`Private result ${mismatch} mismatch`);
    return result;
  }

  async verifyReceipt(verdictId: Hex, opts: { checkAnchorOnChain?: boolean } = {}) {
    const [item, jwks] = await Promise.all([
      this.request(`${this.indexer}/v1/receipts/${verdictId}`),
      this.request(`${this.indexer}/.well-known/mochi-receipts.json`),
    ]);
    const keys: Record<string, ReceiptPublicKey> = {};
    if (typeof jwks.key_id === "string" && typeof jwks.public_key_pem === "string") keys[jwks.key_id] = jwks.public_key_pem;
    const anchor = item.anchor as { root: Hex; proof: Hex[]; tx?: Hex } | undefined;
    const result = verifyReceiptProof({ receipt: item.receipt, signature: item.signature, publicKeys: keys, ...(anchor ? { anchor } : {}) });
    if (!result.valid) return { valid: false, keyId: result.keyId, anchored: false, reason: result.reason };
    let anchored = Boolean(anchor);
    if (anchor && opts.checkAnchorOnChain && this.options.chain?.publicClient) {
      anchored = await this.options.chain.publicClient.readContract({
        address: this.options.chain.deployment.contracts.receiptAnchor,
        abi: ReceiptAnchorAbi,
        functionName: "isAnchored", args: [anchor.root],
      });
    }
    return { valid: true, keyId: result.keyId, anchored };
  }

  async feed(feedIdOrName: string, key: Hex) {
    const res = await this.request(`${this.gateway}/v1/feeds/${encodeURIComponent(feedIdOrName)}/${key}`);
    const schema = typeof res.schemaId === "number" ? res.schemaId : Number(res.schemaId);
    // Gateway returns the raw ABI payload as `payload` (and a server-side `decodedPayload`); decode locally.
    const payload = res.payload as Hex;
    const body = payload && payload !== "0x" ? decodePayload(schema as never, payload) : undefined;
    return { verdictId: res.verdictId as Hex, asOf: res.asOf as string, updatedAt: res.updatedAt as string, verdictTs: res.verdictTs as string | undefined, body };
  }

  disagreement(schema: string | number, field: string, window?: string) {
    const q = new URLSearchParams({ schema: String(schema), field, ...(window ? { window } : {}) });
    return this.request(`${this.gateway}/v1/disagreement?${q}`);
  }
  disagreementByModel(schema: string | number, field: string, window?: string) {
    const q = new URLSearchParams({ schema: String(schema), field, ...(window ? { window } : {}) });
    return this.request(`${this.gateway}/v1/disagreement/models?${q}`);
  }
  stats() { return this.request(`${this.gateway}/v1/stats`); }

  /**
   * Seals `result` to the auditor key and posts it to the gateway. With `wallet` and `disclosureRegistry`, also records
   * its `envelopeHash` (keccak256 of the envelope's canonical JSON) in DisclosureRegistry under the wallet's address,
   * which is what readDisclosure trusts. `result` is sealed as a PrivateResultPlain (other members, such as a
   * readDisclosure result's `disclosure`, are dropped).
   */
  async disclose(input: { verdictId: Hex; result: PrivateResultPlain; auditorPublicKey: Hex; wallet?: WalletClient; disclosureRegistry?: Address }) {
    const result = PrivateResultPlainSchema.parse(input.result);
    const envelope = seal(input.auditorPublicKey, utf8.encode(canonicalJson(result)), aad.disclosure(input.verdictId, input.auditorPublicKey));
    const request = DisclosureReqSchema.parse({ verdictId: input.verdictId, recipientPubKey: input.auditorPublicKey, envelope });
    const envelopeHash = envelopeHashOf(envelope);
    const response = await this.request(`${this.gateway}/v1/disclosures`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    // Anchoring a hash the gateway does not serve the envelope under would leave the recipient nothing to open.
    if (anyHex32(response.envelopeHash) && response.envelopeHash.toLowerCase() !== envelopeHash) {
      throw new GatewayMismatchError("Gateway stored the disclosure under another envelope hash");
    }
    if (input.wallet && input.disclosureRegistry) {
      const account = input.wallet.account;
      if (!account) throw new TypeError("WalletClient must have an account");
      const txHash = await input.wallet.writeContract({ account, address: input.disclosureRegistry, abi: DisclosureRegistryAbi, functionName: "disclose", args: [input.verdictId, recipientKeyHash(input.auditorPublicKey), envelopeHash], chain: input.wallet.chain });
      const receiptClient = this.options.chain?.publicClient ?? (await import("viem")).createPublicClient({ chain: input.wallet.chain, transport: input.wallet.transport as never });
      await receiptClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    }
    return { ...response, envelopeHash } as { recipientKeyHash: Hex; envelopeHash: Hex };
  }

  /**
   * Opens a result disclosed to this auditor key and accepts it only against the on-chain verdict (answerHash and the
   * salted payloadHash; answerJson commits to the salt). Requires `chain`.
   *
   * The gateway stores every envelope anyone posts for a recipient, so which one to open is decided by the chain. The
   * trusted discloser is `opts.discloser`, else the query's payer (QueryEscrow.getQuery, read on chain). If it recorded an
   * envelope hash in DisclosureRegistry, only that envelope is accepted: it is fetched by hash, its keccak256(canonical
   * JSON) must equal the record, and it must open and match the verdict, or this throws (it never falls back to another
   * envelope). Without such a record (or without a registry in the deployment and `opts`), each stored envelope is tried,
   * oldest first, and the first that opens and matches the verdict is returned with `disclosure.anchored: false`.
   */
  async readDisclosure(verdictId: Hex, auditorPrivateKey: Hex, opts: ReadDisclosureOptions = {}): Promise<DisclosedResult> {
    if (opts.discloser !== undefined && !isAddress(opts.discloser)) throw new TypeError("readDisclosure discloser must be a non-zero address");
    if (opts.disclosureRegistry !== undefined && !isAddress(opts.disclosureRegistry)) throw new TypeError("readDisclosure disclosureRegistry must be a non-zero address");
    const onChain = await this.onChainVerdict(verdictId, "readDisclosure");
    if (onChain.isPublic) throw new Error("Disclosure visibility mismatch: the verdict is public");
    const { deployment, client } = await this.chainReader("readDisclosure", ["verdicts"]);
    const secretKey = fromHex(auditorPrivateKey, "bytes");
    const auditorPublicKey = toHex(x25519.getPublicKey(secretKey));
    const keyHash = recipientKeyHash(auditorPublicKey);
    const base = `${this.gateway}/v1/disclosures/${verdictId}/${keyHash}`;
    /** Opens one envelope and checks it against the verdict (and against `expectedHash` when one is given). */
    const accept = (envelope: unknown, expectedHash?: Hex) => {
      const envelopeHash = envelopeHashOf(envelope);
      if (expectedHash !== undefined && envelopeHash !== expectedHash) {
        throw new GatewayMismatchError(`Disclosure envelope hash mismatch: expected ${expectedHash}, got ${envelopeHash}`);
      }
      const opened = open(secretKey, EnvelopeSchema.parse(envelope) as Envelope, aad.disclosure(verdictId, auditorPublicKey));
      const plain = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(opened)));
      const mismatch = !same(plain.verdictId, verdictId) ? "verdictId" : privateResultMismatch(plain, onChain);
      if (mismatch) throw new Error(`Disclosure ${mismatch} mismatch`);
      return { plain, envelopeHash };
    };

    const registry = opts.disclosureRegistry ?? deployment.contracts.disclosureRegistry;
    let discloser: Address | null = null;
    if (!isAddress(registry)) {
      if (opts.discloser) throw new ChainConfigError("readDisclosure with a discloser requires deployment.contracts.disclosureRegistry or opts.disclosureRegistry");
    } else {
      if (opts.discloser) discloser = opts.discloser;
      else {
        if (!isAddress(deployment.contracts.queryEscrow)) throw new ChainConfigError("readDisclosure requires deployment.contracts.queryEscrow to find the payer, or opts.discloser");
        const query = await client.readContract({
          address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "getQuery", args: [onChain.queryId],
        }) as { payer?: unknown };
        discloser = isAddress(query?.payer) ? query.payer : null;
      }
      if (discloser) {
        const record = await client.readContract({
          address: registry, abi: DisclosureRegistryAbi, functionName: "disclosureOf", args: [verdictId, keyHash, discloser],
        }) as { envelopeHash?: unknown; disclosedAt?: unknown };
        if (anyHex32(record?.envelopeHash) && !/^0x0{64}$/.test(record.envelopeHash)) {
          const anchoredHash = record.envelopeHash.toLowerCase() as Hex;
          let served: Record<string, any>;
          try { served = await this.request(`${base}?envelopeHash=${anchoredHash}`); }
          catch (error) {
            throw new Error(`The disclosure ${discloser} anchored on chain (${anchoredHash}) is not available: ${error instanceof Error ? error.message : String(error)}`);
          }
          const { plain } = accept(served.envelope, anchoredHash);
          const disclosedAt = typeof record.disclosedAt === "bigint" || typeof record.disclosedAt === "number" ? Number(record.disclosedAt) : 0;
          return { ...plain, disclosure: { anchored: true, envelopeHash: anchoredHash, discloser, disclosedAt } };
        }
      }
    }

    // Nothing anchored by a trusted discloser: any poster's envelope that opens and matches the verdict will do.
    const listed = await this.request(base);
    const failures: unknown[] = [];
    const attempted = new Set<string>();
    const found = (hit: { plain: PrivateResultPlain; envelopeHash: Hex }): DisclosedResult =>
      ({ ...hit.plain, disclosure: { anchored: false, envelopeHash: hit.envelopeHash, discloser, tried: failures.length + 1 } });
    const attempt = (envelope: unknown, expectedHash?: Hex) => {
      try { return accept(envelope, expectedHash); } catch (error) { failures.push(error); return undefined; }
    };
    // The gateway's pick comes inline (an anchor it found, else the oldest); then every other listed hash, oldest first.
    if (listed.envelope !== undefined) {
      try { attempted.add(envelopeHashOf(listed.envelope)); } catch { /* not JSON-shaped: attempt() records the failure */ }
      const hit = attempt(listed.envelope);
      if (hit) return found(hit);
    }
    const hashes = (Array.isArray(listed.envelopes) ? listed.envelopes : [])
      .map((entry: unknown) => (entry as { envelopeHash?: unknown } | null)?.envelopeHash).filter(anyHex32).map((hash: Hex) => hash.toLowerCase() as Hex);
    for (const hash of hashes) {
      if (attempted.has(hash)) continue;
      if (attempted.size >= DISCLOSURE_TRY_LIMIT) break;
      attempted.add(hash);
      let served: Record<string, any>;
      try { served = await this.request(`${base}?envelopeHash=${hash}`); } catch (error) { failures.push(error); continue; }
      const hit = attempt(served.envelope, hash);
      if (hit) return found(hit);
    }
    if (failures.length === 1) throw failures[0];
    const total = typeof listed.total === "number" ? listed.total : attempted.size;
    const reasons = [...new Set(failures.map((error) => error instanceof Error ? error.message : String(error)))].slice(0, 5).join("; ");
    throw new Error(`No disclosure envelope for this key opens to a result matching the on-chain verdict (tried ${failures.length} of ${total}): ${reasons || "none stored"}`);
  }
}
