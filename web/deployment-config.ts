import { readFileSync } from 'node:fs';
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine(value => !/^0x0{64}$/i.test(value));
const enabledConfig = z.object({
  enabled: z.literal(true),
  chainId: z.literal(4663),
  contracts: z.object({queryEscrow: address, jurorRegistry: address, verdicts: address, usdg: address, receiptAnchor: address}),
  intakeAddress: address,
  intakeMeasurement: bytes32,
  receiptPublicKey: bytes32,
  jurySizes: z.array(z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)])).min(1)
    .refine(values => new Set(values).size === values.length),
});

/** Public values only. Invalid enabled configs fail startup without echoing their contents. */
export function validateWebDeployment(input: unknown) {
  if (input == null || (typeof input === 'object' && 'enabled' in input && input.enabled === false)) return {enabled: false as const};
  const result = enabledConfig.safeParse(input);
  if (!result.success) throw new Error('Invalid paid-review configuration; check chain, contract addresses, intake identity, receipt key and jury sizes.');
  return {...result.data, rpcUrl: '/rpc' as const};
}

export function loadWebDeployment(env: Record<string, string | undefined>, read: (path: string) => string = path => readFileSync(path, 'utf8')) {
  const file = env.MOCHI_WEB_CONFIG;
  const inline = env.MOCHI_WEB_CONFIG_JSON;
  if (file && inline) throw new Error('Set only one of MOCHI_WEB_CONFIG and MOCHI_WEB_CONFIG_JSON.');
  let input: unknown = {enabled: false};
  try { if (inline) input = JSON.parse(inline); else if (file) input = JSON.parse(read(file)); }
  catch { throw new Error('Cannot load paid-review configuration JSON.'); }
  const config = validateWebDeployment(input);
  if (config.enabled) {
    for (const name of ['MOCHI_GATEWAY_URL', 'MOCHI_INDEXER_URL', 'RPC_URL'] as const) {
      try {
        const url = new URL(env[name] ?? '');
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
      } catch { throw new Error(`${name} must be an HTTPS upstream URL without userinfo or fragment before enabling paid reviews.`); }
    }
  }
  return config;
}
