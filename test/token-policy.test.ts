import { describe, expect, test } from 'bun:test';
import { assertMochiTokenDecimals, resolveMochiTokenPolicy } from '../scripts/token-policy.ts';

describe('MOCHI external token deployment policy', () => {
  test('production requires and records a supplied external token', () => {
    expect(resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: false, chainId: 4663, tokenAddress: '0x1234567890123456789012345678901234567890' })).toEqual({ source: 'external', address: '0x1234567890123456789012345678901234567890' });
    expect(() => resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: false })).toThrow('--mochi-token is required');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: false, tokenAddress: '0x0000000000000000000000000000000000000000' })).toThrow('nonzero');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: false, tokenAddress: 'not-an-address' })).toThrow('valid nonzero');
  });

  test('local and testnet rehearsal modes select only the test deployment fallback', () => {
    expect(resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: false, chainId: 31337 })).toEqual({ source: 'test-deployment' });
    expect(resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: true, chainId: 46630 })).toEqual({ source: 'test-deployment' });
    expect(() => resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: true })).toThrow('requires --mainnet');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: true, rehearsal: true, chainId: 4663 })).toThrow('only on chainId 46630');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: false, chainId: 4663 })).toThrow('unsafe local deployment mode');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: false, chainId: 1 })).toThrow('not an approved local/test-token');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: false, chainId: 46630 })).toThrow('requires --mainnet --rehearsal');
    expect(() => resolveMochiTokenPolicy({ mainnetMode: false, rehearsal: false, tokenAddress: '0x1234567890123456789012345678901234567890' })).toThrow('only for production mainnet');
  });

  test('accepts only the 18 decimals assumed by current staking and bond amounts', () => {
    expect(() => assertMochiTokenDecimals(18)).not.toThrow();
    expect(() => assertMochiTokenDecimals(18n)).not.toThrow();
    expect(() => assertMochiTokenDecimals(6)).toThrow('must use 18 decimals');
  });
});
