// Production launch tools run on Robinhood Chain mainnet (4663). The only alternative is an explicit testnet dress
// rehearsal (46630 with rehearsal=true) that exercises the same external-token path before mainnet. Every signed
// digest binds the deployment's own chain ID, so rehearsal material can never validate on mainnet or the reverse.

export const MAINNET_CHAIN_ID = 4663;
export const REHEARSAL_CHAIN_ID = 46630;
export const PRODUCTION_TIMELOCK_DELAY = 60;
export const MAX_TIMELOCK_DELAY = 3600;
/** Bond used by deployments made before the bond became a deploy-time parameter. */
export const DEFAULT_MIN_JUROR_BOND = 25_000n * 10n ** 18n;

type DeploymentLike = { chainId?: unknown; rehearsal?: unknown; tokenSource?: { kind?: unknown } | null; minJurorBond?: unknown; timelockDelay?: unknown } | null | undefined;

export function isProductionRehearsal(deployment: DeploymentLike): boolean {
  return deployment?.chainId === REHEARSAL_CHAIN_ID && deployment.rehearsal === true;
}

/** Chain rule only: mainnet 4663 (not marked rehearsal) or an explicit 46630 rehearsal; undefined otherwise. */
export function productionChainRule(deployment: DeploymentLike): 4663 | 46630 | undefined {
  if (deployment?.chainId === MAINNET_CHAIN_ID && deployment.rehearsal !== true) return MAINNET_CHAIN_ID;
  if (isProductionRehearsal(deployment)) return REHEARSAL_CHAIN_ID;
  return undefined;
}

/** Chain ID of a reviewed external-token production deployment (or its explicit testnet rehearsal); throws otherwise. */
export function productionChainId(deployment: DeploymentLike): 4663 | 46630 {
  if (deployment?.tokenSource?.kind !== "external") throw new Error("deployment must use the external MOCHI token");
  const chainId = productionChainRule(deployment);
  if (chainId === undefined) throw new Error("deployment must be Robinhood Chain mainnet 4663, or an explicit testnet rehearsal on 46630 with rehearsal=true");
  return chainId;
}

/** Per-juror bond in MOCHI wei recorded at deployment. */
export function deploymentMinJurorBond(deployment: DeploymentLike): bigint {
  const value = deployment?.minJurorBond;
  if (value === undefined) return DEFAULT_MIN_JUROR_BOND;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,40})$/.test(value)) throw new Error("deployment.minJurorBond must be a nonnegative integer string");
  return BigInt(value);
}

/** Shared deploy/batch policy on every chain: whole seconds from zero through one hour. */
export function validateTimelockDelay(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error("timelock delay must be whole seconds from 0 to 3600");
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_TIMELOCK_DELAY) throw new Error("timelock delay must be whole seconds from 0 to 3600");
  return delay;
}

/** Honour the recorded deployment delay, including rehearsal; new deployments default to 60 seconds. */
export function productionTimelockDelay(deployment: DeploymentLike): number {
  return validateTimelockDelay(deployment?.timelockDelay ?? PRODUCTION_TIMELOCK_DELAY);
}
