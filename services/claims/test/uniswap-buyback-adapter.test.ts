import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { UniswapV3BuybackAdapter } from '../src/uniswap-buyback-adapter.ts';
import type { BuybackExecution } from '../src/buybacks.ts';

const router = '0x1111111111111111111111111111111111111111' as Address;
const quoter = '0x2222222222222222222222222222222222222222' as Address;
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const treasury = signer.address;
const usdg = '0x4444444444444444444444444444444444444444' as Address;
const mochi = '0x5555555555555555555555555555555555555555' as Address;
const recipient = '0x6666666666666666666666666666666666666666' as Address;
const pool = '0x7777777777777777777777777777777777777777' as Address;
const otherToken = '0x8888888888888888888888888888888888888888' as Address;
const transferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const code = '0x6001' as Hex;
const codeHash = keccak256(code);
const roots: string[] = [];

function setup(overrides: { chainId?: number; allowance?: bigint; broadcastFails?: boolean; routerCode?: Hex; receiptStatus?: 'success' | 'reverted'; logs?: unknown[]; finalizedNumber?: bigint; gas?: bigint; preparedChain?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mochi-uniswap-buyback-')); roots.push(root);
  const calls: string[] = [];
  let swapData: Hex = '0x';
  let signedRaw: Hex = '0x';
  const blockHash = `0x${'ab'.repeat(32)}` as Hex;
  const client = {
    chain: undefined,
    getChainId: async () => overrides.chainId ?? 4663,
    getCode: async ({ address }: { address: string }) => address.toLowerCase() === router.toLowerCase() ? (overrides.routerCode ?? code) : code,
    readContract: async (args: { functionName: string; address: string }) => {
      if (args.functionName === 'balanceOf') return 5_000_000n;
      if (args.functionName === 'decimals') return args.address.toLowerCase() === mochi.toLowerCase() ? 18 : 6;
      if (args.functionName === 'allowance') return overrides.allowance ?? 10_000_000n;
      if (args.functionName === 'quoteExactInputSingle') return [2_000_000_000_000_000_000n, 0n, 0, 0n];
      throw new Error(`unexpected contract read ${args.functionName}`);
    },
    prepareTransactionRequest: async (request: Record<string, unknown>) => { swapData = request.data as Hex; return { ...request, chainId: overrides.preparedChain ?? 4663, gas: overrides.gas ?? 100_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, nonce: 0, type: 'eip1559' }; },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { calls.push('broadcast'); signedRaw = serializedTransaction; if (overrides.broadcastFails) throw new Error('RPC timed out'); return keccak256(serializedTransaction); },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ transactionHash: hash, status: overrides.receiptStatus ?? 'success', blockNumber: 1n, blockHash, logs: overrides.logs ?? [] }),
    getTransaction: async ({ hash }: { hash: Hex }) => ({ hash, to: router, from: treasury, chainId: 4663, value: 0n, input: swapData }),
    getBlock: async ({blockTag,blockNumber}: {blockTag?:string;blockNumber?:bigint}) => ({ hash: blockHash, number: blockTag==='finalized' ? overrides.finalizedNumber ?? 20n : blockNumber ?? 20n }),
    getBlockNumber: async () => 20n,
  };
  const wallet = { chain: undefined, account: signer, signTransaction: signer.signTransaction };
  const adapterConfig = { chainId: 4663n, routerAddress: router, routerCodeHash: codeHash,
    routerVariant: 'router02', maxGasCostWei: 2_000_000_000_000_000n,
    quoterAddress: quoter, quoterCodeHash: codeHash, usdgAddress: usdg, mochiAddress: mochi, fee: 3000,
    readAttributableReviewFunds: async () => 5_000_000n } as const;
  const journalPath = join(root, 'private.sqlite');
  const createAdapter = () => new UniswapV3BuybackAdapter(adapterConfig, client as unknown as PublicClient, wallet as unknown as WalletClient, journalPath);
  const adapter = createAdapter();
  const execution: BuybackExecution = { chainId: 4663n, routerAddress: router, treasuryAddress: treasury,
    senderAddress: treasury, recipient, inputToken: usdg, outputToken: mochi,
    amountIn: 1_000_000n, minAmountOut: 1_500_000_000_000_000_000n, deadlineMs: Date.now() + 60_000 };
  return { adapter, createAdapter, execution, calls, journalPath };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('UniswapV3BuybackAdapter', () => {
  test('rejects wrong chain and insufficient allowance before quoting', async () => {
    const wrongChain = setup({ chainId: 1 });
    await expect(wrongChain.adapter.quoteExactInput(wrongChain.execution)).rejects.toThrow('RPC chain');
    wrongChain.adapter.close();
    const noAllowance = setup({ allowance: 0n });
    await expect(noAllowance.adapter.quoteExactInput(noAllowance.execution)).rejects.toThrow('insufficient router allowance');
    noAllowance.adapter.close();
  });

  test('persists a private signed transaction before broadcast and never rebroadcasts uncertain retries', async () => {
    const { adapter, createAdapter, execution, calls, journalPath } = setup({ broadcastFails: true });
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    await expect(adapter.submitExactInput({ ...execution, idempotencyKey: 'batch-1' })).rejects.toThrow('RPC timed out');
    expect(calls).toEqual(['broadcast']);
    adapter.close();
    const restartedAdapter = createAdapter();
    const retry = await restartedAdapter.submitExactInput({ ...execution, idempotencyKey: 'batch-1' });
    expect(retry.transactionRef).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(calls).toEqual(['broadcast']);
    await expect(restartedAdapter.submitExactInput({ ...execution, amountIn: 2n, idempotencyKey: 'batch-1' })).rejects.toThrow('execution conflict');
    restartedAdapter.close();
  });

  test('rejects a quote when approved router code integrity differs', async () => {
    const { adapter, execution } = setup({ routerCode: '0x6002' });
    await expect(adapter.quoteExactInput(execution)).rejects.toThrow('router bytecode integrity');
    await expect(adapter.quoteExactInput({ ...execution, routerAddress: quoter })).rejects.toThrow('approved route policy');
    adapter.close();
  });

  test('rejects direct submissions with zero min output or expired deadline', async () => {
    const { adapter, execution, calls } = setup();
    await expect(adapter.submitExactInput({ ...execution, minAmountOut: 0n, idempotencyKey: 'zero-min' })).rejects.toThrow('deadline and minimum output');
    await expect(adapter.submitExactInput({ ...execution, deadlineMs: 0, idempotencyKey: 'zero-deadline' })).rejects.toThrow('deadline and minimum output');
    expect(calls).toEqual([]);
    adapter.close();
  });

  test('waits for finalized canonical receipt before marking revert failed', async () => {
    const { adapter, execution } = setup({ receiptStatus: 'reverted' });
    const submitted = await adapter.submitExactInput({ ...execution, idempotencyKey: 'reverted-batch' });
    const result = await adapter.reconcile({ idempotencyKey: 'reverted-batch', transactionRef: submitted.transactionRef });
    expect(result).toEqual({ status: 'failed', transactionRef: submitted.transactionRef });
    adapter.close();
  });

  test('does not confirm when output transfers fail the minimum output requirement', async () => {
    const inputLog = transferLog(usdg, treasury, pool, executionAmount);
    const outputLog = transferLog(mochi, pool, recipient, 1_000_000_000_000_000_000n);
    const { adapter, execution } = setup({ receiptStatus: 'success', logs: [inputLog, outputLog] });
    const submitted = await adapter.submitExactInput({ ...execution, idempotencyKey: 'short-output' });
    expect(await adapter.reconcile({ idempotencyKey: 'short-output', transactionRef: submitted.transactionRef })).toEqual({ status: 'pending' });
    adapter.close();
  });

  test('does not count transfers of an unapproved output token', async () => {
    const { adapter, execution } = setup({ receiptStatus: 'success', logs: [transferLog(usdg, treasury, pool, executionAmount), transferLog(otherToken, pool, recipient, 2_000_000_000_000_000_000n)] });
    const submitted = await adapter.submitExactInput({ ...execution, idempotencyKey: 'wrong-output-token' });
    expect(await adapter.reconcile({ idempotencyKey: 'wrong-output-token', transactionRef: submitted.transactionRef })).toEqual({ status: 'pending' });
    adapter.close();
  });
});

const executionAmount = 1_000_000n;
function transferLog(token: Address, from: Address, to: Address, value: bigint) {
  const topics = encodeEventTopics({ abi: [transferEvent], args: { from, to } });
  return { address: token, topics, data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockNumber: 1n,
    blockHash: `0x${'ab'.repeat(32)}`, transactionHash: `0x${'cd'.repeat(32)}`, transactionIndex: 0, logIndex: 0, removed: false };
}

test('unfinalized reverts retain reservations; excessive gas and wrong prepared chain never broadcast', async () => {
  const unfinalized=setup({receiptStatus:'reverted',finalizedNumber:0n});
  const submitted=await unfinalized.adapter.submitExactInput({...unfinalized.execution,idempotencyKey:'unfinalized'});
  expect(await unfinalized.adapter.reconcile({idempotencyKey:'unfinalized',transactionRef:submitted.transactionRef})).toEqual({status:'pending'});
  unfinalized.adapter.close();
  for(const overrides of [{gas:10_000_000n},{preparedChain:1}]){
    const f=setup(overrides);
    await expect(f.adapter.submitExactInput({...f.execution,idempotencyKey:'gas-cap'})).rejects.toThrow('chain or gas ceiling');
    expect(f.calls).toEqual([]);f.adapter.close();
  }
});
test('a finalized signed Router02 purchase confirms only exact net input and minimum output',async()=>{
  const f=setup({logs:[transferLog(usdg,treasury,pool,executionAmount),transferLog(mochi,pool,recipient,2_000_000_000_000_000_000n)]});
  const submitted=await f.adapter.submitExactInput({...f.execution,idempotencyKey:'confirmed'});
  expect(await f.adapter.reconcile({idempotencyKey:'confirmed',transactionRef:submitted.transactionRef})).toMatchObject({status:'confirmed',receipt:{amountIn:executionAmount,receivedTokenAmount:2_000_000_000_000_000_000n}});
  f.adapter.close();
  const r=setup({logs:[transferLog(usdg,treasury,pool,executionAmount),transferLog(usdg,pool,treasury,1n),transferLog(mochi,pool,recipient,2_000_000_000_000_000_000n)]});
  const sent=await r.adapter.submitExactInput({...r.execution,idempotencyKey:'refunded'});
  expect(await r.adapter.reconcile({idempotencyKey:'refunded',transactionRef:sent.transactionRef})).toEqual({status:'pending'});r.adapter.close();
});
