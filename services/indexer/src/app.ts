import { Hono } from "hono";
import { z } from "zod";
import type { IndexerDeps } from "./ports.ts";

const verdictIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Convert bigint fields to decimal strings for JSON responses. */
function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, child: unknown) =>
    typeof child === "bigint" ? child.toString() : child));
}

/** Convert a binary signature to its base64 receipt representation. */
function signatureBase64(signature: Uint8Array | string): string {
  return typeof signature === "string" ? signature : Buffer.from(signature).toString("base64");
}

/** Create the public indexer HTTP endpoints. */
export function createIndexerApp(deps: IndexerDeps) {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ ok: true }));
  app.get("/v1/indexer/status", async (context) => context.json({
    ok: true,
    cursors: await deps.store.status(),
  }));
  app.get("/.well-known/mochi-receipts.json", (context) => context.json({
    key_id: deps.signer.keyId,
    algorithm: deps.signer.algorithm,
    public_key_pem: deps.signer.publicKeyPem,
    jwk: deps.signer.jwk,
  }));

  app.get("/v1/receipts/:verdictId", async (context) => {
    const parsedId = verdictIdSchema.safeParse(context.req.param("verdictId"));
    if (!parsedId.success) {
      return context.json({
        error: {
          code: "INVALID_VERDICT_ID",
          message: "verdictId must be a 32-byte hex value",
        },
      }, 400);
    }

    const receipt = await deps.store.getReceipt(parsedId.data.toLowerCase());
    if (!receipt) {
      return context.json({
        error: { code: "NOT_FOUND", message: "Receipt not found" },
      }, 404);
    }

    const anchor = await deps.store.getReceiptAnchor(receipt.verdictId);
    return context.json(toJsonValue({
      receipt: receipt.payload,
      signature: signatureBase64(receipt.sig),
      key_id: receipt.keyId,
      ...(anchor
        ? { anchor: { root: anchor.root, proof: anchor.proof, tx: anchor.tx } }
        : {}),
    }));
  });

  app.onError((_error, context) => context.json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  }, 500));

  return { app };
}
