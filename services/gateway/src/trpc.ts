import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";
import { hex32 } from "@mochi/protocol";
import { createGatewayApp, QueryRateLimited } from "./app.ts";
import type { GatewayDeps, PreparedQuery } from "./ports.ts";

/** Per-request context: the gateway deps plus /v1/query's admission (per-caller and payer-key budgets) for this caller. */
export type TrpcContext = GatewayDeps & { prepareQuery(input: unknown): Promise<PreparedQuery> };
const OPEN_ERROR_CODES = new Set(["PRIVATE_KEY_REQUIRED", "PAYER_KEY_MISMATCH", "PROVENANCE_EXPIRED", "INCONSISTENT_INTAKE", "BAD_INTAKE_SIGNATURE"]);
const t = initTRPC.context<TrpcContext>().create();
const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;
export const appRouter = t.router({
  verdict: t.procedure.input(z.object({ verdictId: hex32 })).query(async ({ input, ctx }) => {
    const response = await createGatewayApp(ctx).app.request(`/v1/verdict/${input.verdictId}`);
    return response.json();
  }),
  query: t.procedure.input(z.object({ queryId: hex32 })).query(async ({ input, ctx }) => ({
    query: toJson(await ctx.chain.getQuery(input.queryId as `0x${string}`)), latestVerdictId: await ctx.chain.latestVerdictOf(input.queryId as `0x${string}`),
  })),
  feed: t.procedure.input(z.object({ feedId: z.string(), key: z.string() })).query(async ({ input, ctx }) => {
    const response = await createGatewayApp(ctx).app.request(`/v1/feeds/${encodeURIComponent(input.feedId)}/${encodeURIComponent(input.key)}`);
    return response.json();
  }),
  disagreement: t.procedure.input(z.object({ schema: z.number().int().positive(), field: z.string().min(1), window: z.string().default("1d") })).query(({ input, ctx }) => ctx.store.disagreementSeries(input.schema, input.field, input.window)),
  stats: t.procedure.input(z.object({ from: z.string().optional(), to: z.string().optional() }).optional()).query(async ({ input, ctx }) => {
    const params = new URLSearchParams();
    if (input?.from) params.set("from", input.from);
    if (input?.to) params.set("to", input.to);
    const response = await createGatewayApp(ctx).app.request(`/v1/stats${params.size ? `?${params}` : ""}`);
    return response.json();
  }),
  disclosure: t.procedure.input(z.object({ verdictId: hex32, recipientKeyHash: hex32 })).query(async ({ input, ctx }) => {
    const response = await createGatewayApp(ctx).app.request(`/v1/disclosures/${input.verdictId}/${input.recipientKeyHash}`);
    return response.json();
  }),
  disagreementByModel: t.procedure.input(z.object({ schema: z.number().int().positive(), field: z.string().min(1), window: z.string().default("1d") })).query(({ input, ctx }) => ctx.store.modelDisagreementSeries(input.schema, input.field, input.window)),
  // Visibility, consent, opener and nonce come from the intake-signed provenance in `intake`; prepareQuery validates all,
  // including the grant's signature, under the same rate limits as POST /v1/query.
  prepareQuery: t.procedure.input(z.object({ intake: z.unknown(), n: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]), refundTo: z.string(), payerResultPubKey: z.string().optional(), pay: z.any() })).mutation(async ({ input, ctx }) => {
    try { return await ctx.prepareQuery(input); }
    catch (error) {
      if (error instanceof QueryRateLimited) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
      if (error instanceof z.ZodError) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid request" });
      if (error instanceof Error && OPEN_ERROR_CODES.has(error.message)) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
      throw error;
    }
  }),
});
export type AppRouter = typeof appRouter;

export function trpcFetchHandler(deps: GatewayDeps, req: Request, admission: Pick<TrpcContext, "prepareQuery">): Promise<Response> {
  return fetchRequestHandler({ endpoint: "/trpc", req, router: appRouter, createContext: () => ({ ...deps, prepareQuery: admission.prepareQuery }) });
}
