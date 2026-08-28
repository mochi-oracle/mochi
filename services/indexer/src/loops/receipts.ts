import { attestationRoot } from "@mochi/core";
import { ProvenanceKind, VerdictStatus } from "@mochi/core";
import { signVerdictReceipt } from "@mochi/receipts";
import type { ReceiptSigner } from "@mochi/receipts";
import type { Address, Hex } from "viem";
import type { ChainPort, JurorPassport, StorePort } from "../ports.ts";
import { log } from "../log.ts";
import { buildDisagreementRows, buildModelDisagreementRows } from "./disagreement.ts";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const CLASS_NAMES = ["LARGE_A", "LARGE_B", "DOC_SPECIALIST", "SMALL_FAST", "DISSENTER"] as const;

/** Map the on-chain status enum to the receipt status. */
function receiptStatus(value: number): "VERDICT" | "HUNG" {
  return value === VerdictStatus.VERDICT ? "VERDICT" : "HUNG";
}

/** Map the on-chain provenance enum to the receipt provenance string. */
function receiptProvenance(value: number): "FETCHED" | "SUBMITTED" {
  return value === ProvenanceKind.FETCHED ? "FETCHED" : "SUBMITTED";
}

/** Return a juror class name, caching the registry read for each address. */
async function jurorClassName(
  chain: ChainPort,
  address: Address,
  cache: Map<string, number>,
): Promise<string> {
  const key = address.toLowerCase();
  let jurorClass = cache.get(key);
  if (jurorClass === undefined) {
    jurorClass = await chain.jurorClass(address);
    cache.set(key, jurorClass);
  }
  return CLASS_NAMES[jurorClass] ?? `CLASS_${jurorClass}`;
}

/** Build missing receipts using the posted transaction as the vote source. */
export async function buildMissingReceipts(
  chain: ChainPort,
  store: StorePort,
  signer: ReceiptSigner,
): Promise<number> {
  const verdicts = await store.listUnreceiptedVerdicts();
  const classCache = new Map<string, number>();
  let createdCount = 0;

  for (const indexedVerdict of verdicts) {
    // One bad verdict must not block receipts for every later verdict (poison pill): log and move on.
    try {
      createdCount += await buildOne(indexedVerdict);
    } catch (error) {
      log("error", "receipt_build_failed", {
        verdictId: indexedVerdict.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return createdCount;

  async function buildOne(indexedVerdict: (typeof verdicts)[number]): Promise<number> {
    const verdictId = indexedVerdict.id as Hex;
    const verdict = await chain.verdict(verdictId);
    const query = await chain.query(verdict.queryId);
    const panelVerdict = verdict.escalated && verdict.round === 255;
    const votes = panelVerdict
      ? []
      : await chain.votesOfPostTx(indexedVerdict.tx);
    const jurorAddresses = panelVerdict
      ? await chain.seatJurors(verdict.queryId) as Address[]
      : votes.map((vote) => vote.juror);
    const quoteHashes = panelVerdict
      ? jurorAddresses.map(() => ZERO32)
      : votes.map((vote) => vote.quoteHash);
    const computedAttestationRoot = attestationRoot(quoteHashes);

    if (computedAttestationRoot.toLowerCase() !== verdict.attestationRoot.toLowerCase()) {
      log("error", "receipt_attestation_root_mismatch", {
        verdictId,
        expected: verdict.attestationRoot,
        computed: computedAttestationRoot,
      });
      return 0;
    }

    let passportRows: Awaited<ReturnType<StorePort["getJurorPassports"]>> = [];
    try {
      passportRows = await store.getJurorPassports(jurorAddresses);
    } catch (error) {
      log("warn", "receipt_passport_lookup_failed", {
        verdictId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    const passportByJuror = new Map(
      passportRows.map((row) => [row.key.toLowerCase(), parsePassport(row.passport)]),
    );
    const jurors = await Promise.all(jurorAddresses.map(async (juror, seat) => ({
      seat,
      juror,
      class: await jurorClassName(chain, juror, classCache),
      quoteHash: quoteHashes[seat]!,
      ...(passportByJuror.get(juror.toLowerCase())
        ? { passport: passportByJuror.get(juror.toLowerCase()) }
        : {}),
    })));
    const publicRow = query.isPublic ? await store.getVerdict(verdictId) : null;
    const publicPart = publicRow?.publicPart;
    if (query.isPublic && !publicPart) return 0;

    const receiptInput = {
      verdictId,
      chainId: chain.chainId,
      contract: chain.verdictContract,
      txHash: indexedVerdict.tx,
      queryId: verdict.queryId,
      round: verdict.round,
      status: receiptStatus(verdict.status),
      agreementBps: verdict.agreementBps,
      dissentMask: verdict.dissentMask,
      timeoutMask: verdict.timeoutMask,
      schemaId: verdict.schemaId,
      schemaVersion: verdict.schemaVersion,
      docCommit: verdict.docCommit,
      answerHash: verdict.answerHash,
      payloadHash: verdict.payloadHash,
      evidenceRoot: verdict.evidenceRoot,
      attestationRoot: verdict.attestationRoot,
      modelSetHash: verdict.modelSetHash,
      provenanceKind: receiptProvenance(verdict.provenanceKind),
      originId: verdict.originId,
      isPublic: verdict.isPublic,
      escalated: verdict.escalated,
      jurors,
      ...(query.isPublic && publicPart
        ? {
            answer_json: JSON.stringify(publicPart.answer),
            payload: `0x${Buffer.from(publicPart.payload).toString("hex")}`,
          }
        : {}),
    };
    const signedReceipt = signVerdictReceipt(signer, receiptInput);
    const disagreementRows = query.isPublic
      ? await buildDisagreementRows(
          store,
          verdictId,
          new Date(Number(verdict.ts) * 1_000),
          verdict.schemaId,
        )
      : [];
    const modelDisagreementRows = query.isPublic
      ? await buildModelDisagreementRows(
          store,
          verdictId,
          new Date(Number(verdict.ts) * 1_000),
          verdict.schemaId,
          jurors,
        )
      : [];

    await store.insertReceipt({
      verdictId,
      keyId: signedReceipt.key_id,
      sig: Buffer.from(signedReceipt.signature, "base64"),
      payload: signedReceipt.receipt,
      anchorRoot: ZERO32,
      anchorIndex: -1,
    }, disagreementRows);
    if (modelDisagreementRows.length > 0) {
      await store.recordModelDisagreement(modelDisagreementRows);
    }
    return 1;
  }
}

/** Copy only the public receipt Passport fields from stored JSON. */
function parsePassport(value: unknown): JurorPassport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const passport = value as Record<string, unknown>;
  if (typeof passport.modelId !== "string"
    || typeof passport.lineage !== "string"
    || typeof passport.weightsSha256 !== "string"
    || typeof passport.openWeights !== "boolean"
    || typeof passport.provider !== "string"
    || typeof passport.zdr !== "boolean"
    || typeof passport.tee !== "string") return undefined;
  return {
    modelId: passport.modelId,
    lineage: passport.lineage,
    weightsSha256: passport.weightsSha256,
    openWeights: passport.openWeights,
    provider: passport.provider,
    zdr: passport.zdr,
    tee: passport.tee,
  };
}
