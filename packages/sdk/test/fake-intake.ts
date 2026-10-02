// Test doubles for the intake enclave, the gateway's /v1/query and the chain, shared by the SDK tests.
import { encodeFunctionData, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { computeQueryId, docCommit, docHash, fetchedTranscriptHash, submittedTranscriptHash, ZERO32 } from "@mochi/core";
import { aad, maskDocHash, provenanceFromJson, type IntakeResult, type ProvenanceJson } from "@mochi/protocol";
import { normalizeParams, paramsHash, resolveSchema } from "@mochi/schemas";
import { QueryEscrowAbi, type Deployment } from "@mochi/chain";
import { signProvenance, type MockTeeProvider } from "@mochi/tee";

export const TEST_CHAIN_ID = 31337;
export const TEST_ESCROW = "0x0000000000000000000000000000000000000e5c" as Address;
export const TEST_REGISTRY = "0x0000000000000000000000000000000000000e6c" as Address;
export const TEST_VERDICTS = "0x0000000000000000000000000000000000000e7c" as Address;
export const TEST_DISCLOSURES = "0x0000000000000000000000000000000000000e8c" as Address;

/** The bytes the fake intake "fetches" for a URL request. */
export const fetchedBytes = (url: string) => new TextEncoder().encode(`fetched:${url}`);

export type IntakeReplyOptions = {
  /** Overrides of the signed provenance members (the signature covers the overridden grant). */
  tamper?: Partial<ProvenanceJson>;
  /** Overrides of the unsigned top-level result fields, applied after signing. */
  result?: Partial<IntakeResult> & Record<string, unknown>;
  /** Signs for another escrow domain. */
  escrow?: Address;
  /** Signs with another enclave's key (the result still names `intake`). */
  signer?: MockTeeProvider;
  /** Rewrites the opened request before the "intake" processes it (a relay substituting its own request). */
  substitute?: (plain: Record<string, any>) => Record<string, any>;
};

/** What the intake returns for a sealed request: a grant signing the sealed open binding (as services/intake does). */
export async function fakeIntakeReply(intake: MockTeeProvider, requestBody: string, options: IntakeReplyOptions = {}): Promise<IntakeResult> {
  const { envelope } = JSON.parse(requestBody);
  let plain = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
  if (options.substitute) plain = options.substitute(plain);
  const upload = plain.docB64 !== undefined;
  const bytes = upload ? new Uint8Array(Buffer.from(plain.docB64, "base64")) : fetchedBytes(plain.url);
  const hash = docHash(bytes);
  const normalized = normalizeParams(resolveSchema(plain.schemaId, plain.params ?? {}), plain.params ?? {});
  if (!normalized.ok) throw new Error("fake intake: bad params");
  const provenance: ProvenanceJson = {
    docCommit: docCommit(plain.salt, hash), kind: upload ? 0 : 1, originId: upload ? ZERO32 : keccak256(toHex("docs.test")),
    fetchedAt: upload ? "0" : "1700000000", tokensK: 1,
    transcriptHash: upload ? submittedTranscriptHash({ salt: plain.salt, contentType: plain.contentType, text: new TextDecoder().decode(bytes), params: plain.params ?? {} }) : fetchedTranscriptHash({ salt: plain.salt, tlsTranscriptHash: keccak256(toHex(`tls:${plain.url}`)) }),
    schemaId: plain.schemaId, schemaVersion: 1, paramsHash: paramsHash(normalized.params), expiry: "4000000000", ...plain.open, ...options.tamper,
  };
  const signer = (options.signer ?? intake).signer();
  const intakeSig = await signProvenance(signer, TEST_CHAIN_ID, options.escrow ?? TEST_ESCROW, provenanceFromJson(provenance));
  return {
    provenance, intakeSig, intake: intake.signer().address.toLowerCase(), docCommit: provenance.docCommit,
    paramsHash: provenance.paramsHash, schemaId: provenance.schemaId, tokensK: provenance.tokensK,
    maskedDocHash: maskDocHash(plain.salt, hash), ...options.result,
  };
}

/** The calldata an honest gateway returns for a /v1/query body. */
export function honestOpenData(requestBody: string): Hex {
  const body = JSON.parse(requestBody);
  const prov = provenanceFromJson(body.intake.provenance);
  const params = { n: body.n, refundTo: body.refundTo };
  return body.pay.path === "shielded"
    ? encodeFunctionData({ abi: QueryEscrowAbi, functionName: "openShielded", args: [params, prov, body.intake.intakeSig, body.pay.nullifier, body.pay.proof] })
    : encodeFunctionData({ abi: QueryEscrowAbi, functionName: "openWithUSDG", args: [params, prov, body.intake.intakeSig] });
}

/** The queryId QueryEscrow assigns to the grant in a /v1/query body (what an honest gateway reads from the chain). */
export function honestQueryId(requestBody: string): Hex {
  const prov = JSON.parse(requestBody).intake.provenance;
  return computeQueryId({ chainId: TEST_CHAIN_ID, escrow: TEST_ESCROW, opener: prov.opener, docCommit: prov.docCommit, nonce: BigInt(prov.nonce) });
}

/** An honest gateway's /v1/query reply. */
export const honestQuery = (init?: RequestInit) => ({
  queryId: honestQueryId(String(init?.body)), to: TEST_ESCROW.toLowerCase(), data: honestOpenData(String(init?.body)), quote: { jurorFees: "300", protocolFee: "30" },
});

/** QueryEscrow.quote on the fake chain: 100 per seat and tokensK, 10% protocol fee. */
export const chainQuote = (n: number, tokensK: number) => [100n * BigInt(n) * BigInt(tokensK), 10n * BigInt(n) * BigInt(tokensK)] as const;

export type OnChainVerdictRecord = {
  queryId: Hex; isPublic: boolean; answerHash: Hex; payloadHash: Hex;
  /** MochiTypes.Verdict members the tests set when they matter (defaults: VERDICT, round 0, schema 0, zero masks). */
  status?: number; round?: number; schemaId?: number; agreementBps?: number; dissentMask?: number; timeoutMask?: number;
};

/**
 * A deployment plus a fake RPC client: registry INTAKE status, escrow quotes, query status and payer, the verdict records
 * with MochiVerdicts.latestVerdictOf, and DisclosureRegistry records (omitted from the deployment with
 * `disclosureRegistry: false`).
 */
export function fakeChain(options: { activeIntakes: Address[]; rpcChainId?: number; privacy?: Deployment["privacy"]; disclosureRegistry?: boolean }) {
  const verdicts = new Map<string, OnChainVerdictRecord>();
  /** MochiVerdicts.latestVerdictOf(queryId) and QueryEscrow.getQuery(queryId).status and .payer, by lowercase queryId. */
  const latest = new Map<string, Hex>();
  const queryStatus = new Map<string, number>();
  const queryPayer = new Map<string, Address>();
  /** DisclosureRegistry.disclosureOf records by `${verdictId}:${recipientKeyHash}:${discloser}` (all lowercase). */
  const disclosures = new Map<string, { envelopeHash: Hex; disclosedAt: bigint }>();
  const disclosureKey = (verdictId: string, keyHash: string, discloser: string) => `${verdictId}:${keyHash}:${discloser}`.toLowerCase();
  const active = new Set(options.activeIntakes.map((a) => a.toLowerCase()));
  const reads: string[] = [];
  const deployment = {
    chainId: TEST_CHAIN_ID, rpcUrl: "http://127.0.0.1:1", startBlock: "0",
    contracts: {
      queryEscrow: TEST_ESCROW, jurorRegistry: TEST_REGISTRY, verdicts: TEST_VERDICTS, receiptAnchor: TEST_VERDICTS,
      ...(options.disclosureRegistry === false ? {} : { disclosureRegistry: TEST_DISCLOSURES }),
    },
    ...(options.privacy ? { privacy: options.privacy } : {}),
  } as unknown as Deployment;
  const publicClient = {
    getChainId: async () => options.rpcChainId ?? TEST_CHAIN_ID,
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
      reads.push(functionName);
      if (functionName === "isActive" && address === TEST_REGISTRY) return args[1] === 2 && active.has(String(args[0]).toLowerCase());
      if (functionName === "quote" && address === TEST_ESCROW) return chainQuote(Number(args[1]), Number(args[2]));
      if (functionName === "getVerdict" && address === TEST_VERDICTS) {
        const record = verdicts.get(String(args[0]).toLowerCase());
        const empty = { queryId: ZERO32, isPublic: false, answerHash: ZERO32, payloadHash: ZERO32, status: 0 };
        return { round: 0, schemaId: 0, agreementBps: 0, dissentMask: 0, timeoutMask: 0, ...(record ? { status: 1, ...record } : empty) };
      }
      if (functionName === "latestVerdictOf" && address === TEST_VERDICTS) return latest.get(String(args[0]).toLowerCase()) ?? ZERO32;
      if (functionName === "getQuery" && address === TEST_ESCROW) {
        const id = String(args[0]).toLowerCase();
        return { status: queryStatus.get(id) ?? 0, payer: queryPayer.get(id) ?? "0x0000000000000000000000000000000000000000" };
      }
      if (functionName === "disclosureOf" && address === TEST_DISCLOSURES) {
        return disclosures.get(disclosureKey(String(args[0]), String(args[1]), String(args[2]))) ?? { envelopeHash: ZERO32, disclosedAt: 0n };
      }
      if (functionName === "currentRoot" || functionName === "latestRoot") return 0n;
      throw new Error(`fake chain: unexpected read ${functionName}`);
    },
    getLogs: async () => [],
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as PublicClient;
  /** DisclosureRegistry.disclose as `discloser` (first record per slot wins, as on chain). */
  const anchor = (verdictId: Hex, keyHash: Hex, discloser: Address, envelopeHash: Hex) => {
    const key = disclosureKey(verdictId, keyHash, discloser);
    if (!disclosures.has(key)) disclosures.set(key, { envelopeHash, disclosedAt: 1_700_000_000n + BigInt(disclosures.size) });
  };
  return { deployment, publicClient, verdicts, latest, queryStatus, queryPayer, disclosures, anchor, active, reads };
}
