import { z } from "zod";
import { loadDeployment } from "@mochi/chain";

const Env = z.object({
  MOCHI_DEPLOYMENT: z.string().default("deployments/local.json"), DATABASE_URL: z.string().default("postgres://mochi:mochi@127.0.0.1:55432/mochi"),
  ORCHESTRATOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/), FEED_RUNNER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  INTAKE_URL: z.string().url(), CONSENSUS_URL: z.string().url(), POLL_MS: z.coerce.number().int().positive().default(1000),
  JUROR_TIMEOUT_MS: z.coerce.number().int().positive().default(60000), ROUND_CLOSE_MAX_WAIT_MS: z.coerce.number().int().positive().default(90000),
  MAX_PARALLEL_QUERIES: z.coerce.number().int().positive().default(8),
  DRAND_RELAYS: z.string().optional(),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = Env.parse(env);
  return { ...value, drandRelays: value.DRAND_RELAYS?.split(",").map((x) => x.trim()).filter(Boolean), deployment: loadDeployment(value.MOCHI_DEPLOYMENT) };
}
