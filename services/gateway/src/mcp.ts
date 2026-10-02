import { z } from "zod";
import { zeroHash, type Hex } from "viem";
import { SchemaId } from "@mochi/core";
import { IntakeResultSchema, provenanceFromJson, type OpenBinding } from "@mochi/protocol";
import { getSchema } from "@mochi/schemas";
import { prepareQuery } from "./app.ts";
import type { GatewayDeps } from "./ports.ts";

const JsonRpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
const VoucherSchema = z.object({ voucherId: z.string().regex(/^0x[0-9a-f]{64}$/), queryId: z.string().regex(/^0x[0-9a-f]{64}$/), schemaId: z.number().int().positive(), n: z.number().int().min(3).max(9), maxAmount: z.string().regex(/^\d+$/), tier: z.number().int().nonnegative(), expiry: z.string().regex(/^\d+$/) });
const AskSchema = z.object({ schema: z.string().min(1), docUrl: z.string().url(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]).optional(), params: z.record(z.string(), z.unknown()).optional(), voucher: VoucherSchema.optional(), voucherSig: z.string().regex(/^0x([0-9a-f]{2})*$/).optional(), sender: z.string().regex(/^0x[0-9a-f]{40}$/).optional(), refundTo: z.string().regex(/^0x[0-9a-f]{40}$/).optional() });
const randomNonce = () => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`);
const idFor = (name: string): SchemaId => {
  const found = Object.values(SchemaId).find((value) => typeof value === "number" && getSchema(value as SchemaId).name === name.toUpperCase());
  if (typeof found !== "number") throw new Error("Unknown schema");
  return found as SchemaId;
};

export function createMcpHandler(deps: GatewayDeps) {
  return async (req: Request): Promise<Response> => {
    const respond = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id: id ?? null, result });
    const fail = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
    let rpc: z.infer<typeof JsonRpcSchema>;
    try { rpc = JsonRpcSchema.parse(await req.json()); } catch { return fail(null, -32700, "Parse error"); }
    const id = rpc.id;
    try {
      if (rpc.method === "initialize") return respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mochi", version: "0.1.0" } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") return respond(id, { tools: [
        { name: "mochi.verdict", description: "Read a Mochi verdict", inputSchema: { type: "object", properties: { verdictId: { type: "string" } }, required: ["verdictId"] } },
        { name: "mochi.ask", description: "Prepare a public document query", inputSchema: { type: "object", properties: { schema: { type: "string" }, docUrl: { type: "string" }, n: { type: "integer" }, params: { type: "object" }, voucher: { type: "object" }, voucherSig: { type: "string" } }, required: ["schema", "docUrl"] } },
        { name: "mochi.stats", description: "Read Mochi activity and kill-criteria statistics", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } } },
      ] });
      if (rpc.method !== "tools/call") return fail(id, -32601, "Method not found");
      const params = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(rpc.params ?? {});
      if (params.name === "mochi.stats") {
        const args = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(params.arguments);
        const query = new URLSearchParams();
        if (args.from) query.set("from", args.from);
        if (args.to) query.set("to", args.to);
        const response = await (await import("./app.ts")).createGatewayApp(deps).app.request(`/v1/stats${query.size ? `?${query}` : ""}`);
        return respond(id, { content: [{ type: "text", text: JSON.stringify(await response.json()) }] });
      }
      if (params.name === "mochi.verdict") {
        const verdictId = z.object({ verdictId: z.string().regex(/^0x[0-9a-f]{64}$/) }).parse(params.arguments).verdictId;
        const result = await deps.store.getVerdict(verdictId);
        if (!result) throw new Error("Verdict not found");
        const response = await (await import("./app.ts")).createGatewayApp(deps).app.request(`/v1/verdict/${verdictId}`);
        const value = await response.json();
        return respond(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
      }
      if (params.name !== "mochi.ask") return fail(id, -32602, "Unknown tool");
      const args = AskSchema.parse(params.arguments);
      if (deps.mcpVoucherMode && !args.voucher) return fail(id, -32602, "Voucher required");
      if (!deps.sealForIntake) throw new Error("MCP intake sealing is not configured");
      const schemaId = idFor(args.schema);
      const n = args.n ?? 3;
      const voucher = args.voucher;
      if (deps.mcpVoucherMode && (!deps.relayer || !voucher || !args.voucherSig || voucher.schemaId !== schemaId || voucher.n !== n)) throw new Error("Invalid MCP voucher");
      // Without a voucher the caller's wallet pays, so the caller must say which address sends and gets refunds.
      if (!deps.mcpVoucherMode && (!args.sender || !args.refundTo)) return fail(id, -32602, "sender and refundTo are required without a voucher");
      // The intake signs who may open (relayer for vouchers, else the caller's wallet) into the provenance grant.
      const opener = (deps.mcpVoucherMode ? deps.relayer!.sender : args.sender!).toLowerCase();
      const nonce = deps.mcpVoucherMode ? BigInt(voucher!.voucherId) & ((1n << 64n) - 1n) : randomNonce();
      const open: OpenBinding = { opener, payerCommit: zeroHash, isPublic: true, allowPanelDisclosure: false, nonce: nonce.toString() };
      const attestation = await deps.intake.attestation();
      const envelope = await deps.sealForIntake(attestation, { v: 1, schemaId, salt: zeroHash, params: args.params ?? {}, url: args.docUrl, open });
      const intake = IntakeResultSchema.parse(await deps.intake.request("/v1/intake/url", { envelope }));
      if (intake.provenance.opener !== opener || BigInt(intake.provenance.nonce) !== nonce || !intake.provenance.isPublic) throw new Error("Intake grant does not match the request");
      if (deps.mcpVoucherMode) {
        const relayer = deps.relayer!;
        const prov = intake.provenance;
        const queryId = await deps.chain.computeQueryId(relayer.sender, prov.docCommit as Hex, BigInt(prov.nonce));
        // The voucher is signed for exactly one query (QueryEscrow enforces it too).
        if (voucher!.queryId.toLowerCase() !== queryId.toLowerCase()) throw new Error("Invalid MCP voucher");
        const quote = await deps.chain.quote(schemaId, n, prov.tokensK);
        // ANONYMA-path refunds go back into the float; refundTo must still be non-zero for the contract.
        const txHash = await relayer.openWithVoucher({ n, refundTo: relayer.sender }, provenanceFromJson(prov), intake.intakeSig as Hex, { ...voucher!, maxAmount: BigInt(voucher!.maxAmount), expiry: BigInt(voucher!.expiry) }, args.voucherSig as Hex);
        await deps.store.insertAnonymaVoucher({ voucherId: voucher!.voucherId as string, queryId, tier: Number(voucher!.tier), usdgAmount: String(quote.jurorFees + quote.protocolFee), settled: false });
        return respond(id, { content: [{ type: "text", text: JSON.stringify({ queryId, txHash, quote: { jurorFees: quote.jurorFees.toString(), protocolFee: quote.protocolFee.toString() } }) }] });
      }
      const query = await prepareQuery(deps, { intake, n, refundTo: args.refundTo!, pay: { path: "usdg" } });
      return respond(id, { content: [{ type: "text", text: JSON.stringify(query) }] });
    } catch (error) {
      return fail(id, -32602, error instanceof z.ZodError ? "Invalid parameters" : error instanceof Error && ["Unknown schema", "Verdict not found", "Invalid MCP voucher"].includes(error.message) ? error.message : "Request failed");
    }
  };
}
