import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { canonicalJson, ZERO32 } from "@mochi/core";
import { aad, AttestationDocSchema, DisclosureReqSchema, IntakeResultSchema, IntakeUploadPlainSchema, IntakeUrlPlainSchema, PrivateResultPlainSchema, type IntakeResult } from "@mochi/protocol";
import { decodePayload, getSchema, SCHEMAS } from "@mochi/schemas";
import { keyBinding, open, seal, type QuoteVerifier, type Envelope } from "@mochi/tee";
import { verifyReceipt as verifyReceiptProof, type ReceiptPublicKey } from "@mochi/receipts";
import { MochiVerdictsAbi, ReceiptAnchorAbi, type Deployment } from "@mochi/chain";
import { fromHex, keccak256, toHex, type Address, type Hex, type PublicClient, type WalletClient, publicActions, createPublicClient, http } from "viem";
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
export interface QueryTransaction { to: Address; data: Hex }
export interface PreparedQuery { queryId: Hex; tx: QueryTransaction; quote: unknown; secrets: QuerySecrets }

type ClientOpts = {
  gatewayUrl: string;
  indexerUrl?: string;
  fetch?: typeof globalThis.fetch;
  quoteVerifier: QuoteVerifier;
  intakeMeasurement: Hex;
  chain?: { deployment: Deployment; publicClient?: PublicClient };
  buildShieldedProof?: typeof buildWithdrawalProof;
  hungGraceMs?: number;
};
type Attestation = ReturnType<typeof AttestationDocSchema.parse>;
type Verdict = Record<string, unknown> & { chain?: Record<string, unknown>; ciphertext?: Hex; decodedPayload?: unknown };
const utf8 = new TextEncoder();
const hex32 = (value: string): value is Hex => /^0x[0-9a-f]{64}$/.test(value);
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

  async prepareQuery(opts: PrepareQueryOptions): Promise<PreparedQuery> {
    const schemaId = typeof opts.schema === "number"
      ? opts.schema
      : Object.values(SCHEMAS).find((schema) => schema.name === opts.schema)?.id;
    if (!schemaId) throw new TypeError(`Unknown schema: ${opts.schema}`);
    getSchema(schemaId as never);
    const intake = await this.intakeAttestation();
    const salt = opts.isPublic ? ZERO32 : randHex(32);
    const secrets: QuerySecrets = { salt };
    let payerResultPubKey: Hex | undefined;
    if (!opts.isPublic) {
      const pair = x25519.keygen();
      payerResultPubKey = toHex(pair.publicKey);
      secrets.resultPrivateKey = toHex(pair.secretKey);
    }
    const params = opts.params ?? {};
    let intakePath: string;
    let plain: unknown;
    if ("bytes" in opts.document) {
      const data = { v: 1 as const, schemaId, salt, params, contentType: opts.document.contentType, docB64: b64(opts.document.bytes) };
      plain = IntakeUploadPlainSchema.parse(data);
      intakePath = `/v1/intake/upload?n=${opts.n ?? 3}`;
    } else {
      const data = { v: 1 as const, schemaId, salt, params, url: opts.document.url };
      plain = IntakeUrlPlainSchema.parse(data);
      intakePath = `/v1/intake/url?n=${opts.n ?? 3}`;
    }
    const envelope = seal(intake.encryptionPubKey as Hex, utf8.encode(canonicalJson(plain)), aad.intake());
    const intakeResult = IntakeResultSchema.parse(await this.request(`${this.gateway}${intakePath}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }),
    })) as IntakeResult;
    const nonce = BigInt(randHex(8));
    const queryBody: Record<string, unknown> = {
      intake: intakeResult, n: opts.n ?? 3, isPublic: opts.isPublic,
      ...(opts.allowPanelDisclosure === undefined ? {} : { allowPanelDisclosure: opts.allowPanelDisclosure }),
      refundTo: opts.refundTo ?? opts.sender, nonce: nonce.toString(), sender: opts.sender,
      ...(payerResultPubKey ? { payerResultPubKey } : {}), pay: opts.pay ?? { path: "usdg" },
    };
    const query = await this.request(`${this.gateway}/v1/query`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(queryBody),
    });
    if (!hex32(query.queryId) || !/^0x[0-9a-f]{40}$/.test(query.to) || typeof query.data !== "string") {
      throw new TypeError("Gateway returned an invalid query transaction");
    }
    return { queryId: query.queryId as Hex, tx: { to: query.to as Address, data: query.data as Hex }, quote: query.quote, secrets };
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
    return { queryId: prepared.queryId, txHash, secrets: prepared.secrets };
  }

  private async askShieldedPool(opts: PrepareQueryOptions, wallet: WalletClient, payment: Extract<Pay, { path: "shielded-pool" }>) {
    const deployment = this.options.chain?.deployment;
    const publicClient = this.options.chain?.publicClient ?? (deployment ? createPublicClient({ transport: http(deployment.rpcUrl) }) : undefined);
    if (!deployment?.privacy || !publicClient) throw new TypeError("shielded-pool payments require a privacy deployment and public client");
    const relayer = await this.request(`${this.gateway}/v1/relayer`);
    if (typeof relayer.address !== "string") throw new TypeError("Gateway returned an invalid relayer address");
    relayer.address = relayer.address.toLowerCase(); // the protocol's address schema is lowercase-only
    const schemaId = typeof opts.schema === "number" ? opts.schema : Object.values(SCHEMAS).find((schema) => schema.name === opts.schema)?.id;
    if (!schemaId) throw new TypeError(`Unknown schema: ${opts.schema}`);
    getSchema(schemaId as never);
    const attestation = await this.intakeAttestation();
    const salt = opts.isPublic ? ZERO32 : randHex(32);
    const secrets: QuerySecrets = { salt };
    let payerResultPubKey: Hex | undefined;
    if (!opts.isPublic) {
      const pair = x25519.keygen(); payerResultPubKey = toHex(pair.publicKey); secrets.resultPrivateKey = toHex(pair.secretKey);
    }
    const params = opts.params ?? {};
    let plain: unknown, path: string;
    if ("bytes" in opts.document) {
      plain = IntakeUploadPlainSchema.parse({ v: 1, schemaId, salt, params, contentType: opts.document.contentType, docB64: b64(opts.document.bytes) });
      path = `/v1/intake/upload?n=${opts.n ?? 3}`;
    } else {
      plain = IntakeUrlPlainSchema.parse({ v: 1, schemaId, salt, params, url: opts.document.url });
      path = `/v1/intake/url?n=${opts.n ?? 3}`;
    }
    const envelope = seal(attestation.encryptionPubKey as Hex, utf8.encode(canonicalJson(plain)), aad.intake());
    const intakeResult = IntakeResultSchema.parse(await this.request(`${this.gateway}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) })) as IntakeResult;
    const nonce = BigInt(randHex(8));
    const requestBody = {
      intake: intakeResult, n: opts.n ?? 3, isPublic: opts.isPublic,
      ...(opts.allowPanelDisclosure === undefined ? {} : { allowPanelDisclosure: opts.allowPanelDisclosure }),
      refundTo: opts.refundTo ?? relayer.address as Address, nonce: nonce.toString(), sender: relayer.address,
      // Quote-only ask: queryId = computeQueryId(sender = relayer, docCommit, nonce) does not depend on the pay path, and
      // the gateway rejects an empty shielded proof, so ask with the plain path and discard the returned calldata.
      ...(payerResultPubKey ? { payerResultPubKey } : {}), pay: { path: "usdg" },
    };
    const prepared = await this.request(`${this.gateway}/v1/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
    if (!hex32(prepared.queryId) || typeof prepared.quote?.jurorFees !== "string" || typeof prepared.quote?.protocolFee !== "string") throw new TypeError("Gateway returned an invalid shielded quote");
    const amount = BigInt(prepared.quote.jurorFees) + BigInt(prepared.quote.protocolFee);
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
    const withdrawal = openShieldedPaymentFor(deployment.privacy.adapter, deployment.contracts.queryEscrow, prepared.queryId as Hex, dummy).withdrawal;
    const prove = this.options.buildShieldedProof ?? buildWithdrawalProof;
    const built = await prove({ note: payment.note, deposit: payment.depositInfo.deposit, stateTree, aspTree, withdrawal, scope: BigInt(deployment.privacy.scope), withdrawnValue: amount, ...(payment.depositInfo.newNote ? { newNote: payment.depositInfo.newNote } : {}) });
    const encoded = openShieldedPaymentFor(deployment.privacy.adapter, deployment.contracts.queryEscrow, prepared.queryId as Hex, built.proof);
    const relayBody = { ...requestBody, nullifier: encoded.nullifier, proof: encoded.proof };
    const relayed = await this.request(`${this.gateway}/v1/relay/open-shielded`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(relayBody) });
    if (!hex32(relayed.queryId) || typeof relayed.txHash !== "string") throw new TypeError("Gateway returned an invalid relay receipt");
    return { queryId: relayed.queryId as Hex, txHash: relayed.txHash as Hex, changeNote: built.newNote, secrets, quote: prepared.quote, proofSeconds: built.seconds };
  }

  async waitForVerdict(queryId: Hex, opts: { timeoutMs?: number; pollMs?: number; final?: boolean; hungGraceMs?: number } = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    const grace = opts.hungGraceMs ?? this.options.hungGraceMs ?? 30_000;
    let hungSince: number | undefined;
    // A verdict ID appears on-chain before the orchestrator has persisted the result; only return once readable.
    const readable = async (id: string) => {
      const r = await this.fetcher(`${this.gateway}/v1/verdict/${id}`, { signal: AbortSignal.timeout(30_000) });
      return r.ok;
    };
    while (Date.now() < deadline) {
      const q = await this.request(`${this.gateway}/v1/queries/${queryId}`);
      const id = q.latestVerdictId;
      if (typeof id === "string" && hex32(id) && !/^0x0{64}$/.test(id)) {
        if (opts.final === false && await readable(id)) return id as Hex;
        const status = q.query?.status;
        if ((status === 3 || status === 5 || status === "DECIDED" || status === "ESCALATED") && await readable(id)) return id as Hex;
      }
      if (q.query?.status === "HUNG" || q.query?.status === 4) {
        if (typeof id === "string" && hex32(id) && !/^0x0{64}$/.test(id) && opts.final === false && await readable(id)) return id as Hex;
        hungSince ??= Date.now();
        if (Date.now() - hungSince >= grace && typeof id === "string" && hex32(id) && !/^0x0{64}$/.test(id) && await readable(id)) return id as Hex;
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

  private async answerHash(verdictId: Hex, verdict: Verdict): Promise<string | undefined> {
    const fromGateway = verdict.chain?.answerHash ?? verdict.chain?.answer_hash;
    if (typeof fromGateway === "string") return fromGateway;
    const chain = this.options.chain;
    if (!chain) return undefined;
    const client = chain.publicClient ?? createPublicClient({ transport: http(chain.deployment.rpcUrl) });
    const onChain = await client.readContract({
      address: chain.deployment.contracts.verdicts,
      abi: MochiVerdictsAbi,
      functionName: "getVerdict",
      args: [verdictId],
    }) as { answerHash?: string; answer_hash?: string };
    return onChain.answerHash ?? onChain.answer_hash;
  }

  async decryptPrivateResult(verdictId: Hex, resultPrivateKey: Hex): Promise<ReturnType<typeof PrivateResultPlainSchema.parse>> {
    const verdict = await this.getVerdict(verdictId);
    if (typeof verdict.ciphertext !== "string") throw new TypeError("Verdict has no private result ciphertext");
    const envelope = JSON.parse(new TextDecoder().decode(fromHex(verdict.ciphertext as Hex, "bytes"))) as Envelope;
    const result = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(fromHex(resultPrivateKey, "bytes"), envelope, aad.result(verdictId)))));
    if (result.verdictId.toLowerCase() !== verdictId.toLowerCase()) throw new Error("Private result verdict id mismatch");
    const expected = await this.answerHash(verdictId, verdict);
    if (typeof expected !== "string" || keccak256(toHex(result.answerJson)).toLowerCase() !== expected.toLowerCase()) {
      throw new Error("Private result answerHash mismatch");
    }
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
    return { verdictId: res.verdictId as Hex, asOf: res.asOf as string, updatedAt: res.updatedAt as string, body };
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

  async disclose(input: { verdictId: Hex; result: ReturnType<typeof PrivateResultPlainSchema.parse>; auditorPublicKey: Hex; wallet?: WalletClient; disclosureRegistry?: Address }) {
    const envelope = seal(input.auditorPublicKey, utf8.encode(canonicalJson(input.result)), aad.disclosure(input.verdictId, input.auditorPublicKey));
    const request = DisclosureReqSchema.parse({ verdictId: input.verdictId, recipientPubKey: input.auditorPublicKey, envelope });
    const response = await this.request(`${this.gateway}/v1/disclosures`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    if (input.wallet && input.disclosureRegistry) {
      const account = input.wallet.account;
      if (!account) throw new TypeError("WalletClient must have an account");
      const registryAbi = [{ type: "function", name: "disclose", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], outputs: [] }] as const;
      const hash = keccak256(toHex(canonicalJson(envelope)));
      const txHash = await input.wallet.writeContract({ account, address: input.disclosureRegistry, abi: registryAbi, functionName: "disclose", args: [input.verdictId, recipientKeyHash(input.auditorPublicKey), hash], chain: input.wallet.chain });
      const receiptClient = this.options.chain?.publicClient ?? (await import("viem")).createPublicClient({ chain: input.wallet.chain, transport: input.wallet.transport as never });
      await receiptClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    }
    return response as { recipientKeyHash: Hex };
  }

  async readDisclosure(verdictId: Hex, auditorPrivateKey: Hex) {
    const result = await this.request(`${this.gateway}/v1/disclosures/${verdictId}/${recipientKeyHash(toHex(x25519.getPublicKey(fromHex(auditorPrivateKey, "bytes"))))}`);
    const envelope = result.envelope as Envelope;
    const plain = PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(fromHex(auditorPrivateKey, "bytes"), envelope, aad.disclosure(verdictId, toHex(x25519.getPublicKey(fromHex(auditorPrivateKey, "bytes"))))))));
    const verdict = await this.getVerdict(verdictId);
    const expected = await this.answerHash(verdictId, verdict);
    if (plain.verdictId.toLowerCase() !== verdictId.toLowerCase() || typeof expected !== "string" || keccak256(toHex(plain.answerJson)).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error("Disclosure answerHash mismatch");
    }
    return plain;
  }
}
