const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;

export interface TokenPolicyInput {
  mainnetMode: boolean;
  rehearsal: boolean;
  chainId?: number;
  tokenAddress?: string;
}

export type MochiTokenPolicy =
  | { source: 'external'; address: `0x${string}` }
  | { source: 'test-deployment' };

export function resolveMochiTokenPolicy(input: TokenPolicyInput): MochiTokenPolicy {
  const { mainnetMode, rehearsal, chainId, tokenAddress } = input;
  if (rehearsal && !mainnetMode) throw new Error('--rehearsal requires --mainnet');
  if (chainId === 4663 && !mainnetMode) throw new Error('chainId 4663 requires --mainnet; refusing unsafe local deployment mode');
  if (chainId === 46630 && !(mainnetMode && rehearsal)) throw new Error('chainId 46630 requires --mainnet --rehearsal for test-token deployment');
  if (chainId !== undefined && !mainnetMode && chainId !== 31337) throw new Error(`chainId ${chainId} is not an approved local/test-token deployment chain`);
  if (mainnetMode && !rehearsal && chainId !== undefined && chainId !== 4663) throw new Error('--mainnet requires chainId 4663, or chainId 46630 with --rehearsal');
  if (mainnetMode && rehearsal && chainId !== undefined && chainId !== 46630) throw new Error('--rehearsal is allowed only on chainId 46630');

  if (mainnetMode && !rehearsal) {
    if (!tokenAddress) throw new Error('--mochi-token is required for production mainnet; supply the team-created MOCHI token address');
    if (!ADDRESS_RE.test(tokenAddress) || ZERO_ADDRESS.test(tokenAddress)) throw new Error('--mochi-token must be a valid nonzero external token address');
    return { source: 'external', address: tokenAddress as `0x${string}` };
  }
  if (tokenAddress) {
    // A testnet dress rehearsal may stand in a separately deployed ERC20 for the team's token, so the exact
    // external-token production path (runtime, enrollment, timelock batches) runs before mainnet.
    if (!(mainnetMode && rehearsal)) throw new Error('--mochi-token is accepted only for production mainnet or a --mainnet --rehearsal on chainId 46630; local mode deploys a test-only token');
    if (!ADDRESS_RE.test(tokenAddress) || ZERO_ADDRESS.test(tokenAddress)) throw new Error('--mochi-token must be a valid nonzero external token address');
    return { source: 'external', address: tokenAddress as `0x${string}` };
  }
  return { source: 'test-deployment' };
}

export function assertMochiTokenDecimals(decimals: number | bigint): void {
  if (decimals !== 18 && decimals !== 18n) {
    throw new Error(`MOCHI must use 18 decimals for current staking and bond amounts; supplied token reports ${String(decimals)} decimals`);
  }
}
