import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8090),
  rpcUrl: z.string().url(),
  deploymentPath: z.string().default("../../deployments/local.json"),
  databaseUrl: z.string().url().default("postgres://mochi:mochi@127.0.0.1:55432/mochi"),
  keeperKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  intakeUrl: z.string().url(),
  pollMs: z.coerce.number().int().min(100).default(5000),
  confirmations: z.coerce.number().int().min(1).default(1),
  drandRelays: z.string().optional(),
});

export type PanelDeskConfig = Omit<z.infer<typeof ConfigSchema>, "drandRelays"> & { drandRelays?: string[] };
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PanelDeskConfig {
  const value = ConfigSchema.parse({
    port: env.PORT,
    rpcUrl: env.RPC_URL,
    deploymentPath: env.MOCHI_DEPLOYMENT,
    databaseUrl: env.DATABASE_URL,
    keeperKey: env.KEEPER_KEY,
    intakeUrl: env.INTAKE_URL,
    pollMs: env.POLL_MS,
    confirmations: env.CONFIRMATIONS,
    drandRelays: env.DRAND_RELAYS,
  });
  return { ...value, drandRelays: value.drandRelays?.split(",").map((x) => x.trim()).filter(Boolean) };
}
