import { readFileSync, renameSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SqliteBuybackStore } from './buyback-sqlite-store.ts';
import { createViemReviewRevenueReader } from './settlement-ingestion.ts';
import { runRevenueWorkerCycle } from './revenue-worker.ts';
import type { BuybackAdapter, BuybackConfig, BuybackExecution, BuybackQuote, Reconciliation, TreasuryFunds } from './buybacks.ts';
import type { OperatingBudget } from './operating-policy.ts';
import type { RevenueObligations } from './revenue.ts';
import type { BurnEvidence, RevenueReportConfig, ReportReceipt } from './revenue-report.ts';
import { UniswapV3BuybackAdapter } from './uniswap-buyback-adapter.ts';

type Manifest = { mode: 'disabled' } | {
  mode: 'observe' | 'execute';
  databasePath: string;
  reportOutputPath?: string;
  burnEvidenceFile?: string;
  rpcUrl: string;
  ingestion: { chainId: string; escrowAddress: string; usdgAddress: string; recipientAddress: string; startBlock: string; chunkSize: number; maxChunks?: number };
  report: RevenueReportConfig;
  buyback: Omit<BuybackConfig, 'chainId'> & { chainId: string };
  approvedBudgetId: string;
  budget: Omit<OperatingBudget, 'uncoveredDailyOperatingCost' | 'retainedOperatingReserve'> & { uncoveredDailyOperatingCost: string | null; retainedOperatingReserve: string | null };
  obligations: { modelLiabilities: string | null; infrastructureLiabilities: string | null; refunds: string | null };
  keyFile?: string;
  journalPath?: string;
  route?: { routerAddress: string; routerVariant: 'swap-router'|'router02'; routerCodeHash: string; quoterAddress: string; quoterCodeHash: string; fee: number; maxGasCostWei: string; nativeCurrency: { name:string; symbol:string; decimals:number }; readAttributableReviewFundsSource: 'settlement-ledger-v1' };
};

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
function amount(value: string | null): bigint | null { return value === null ? null : /^\d+$/u.test(value) ? BigInt(value) : (() => { throw new Error('invalid decimal amount'); })(); }

/** Private-manifest runtime. Execute mode validates all explicit approvals before opening its keyfile. */
export async function runRevenueWorkerManifest(path: string) {
  const m = readJson<Manifest>(path);
  if (m.mode === 'disabled') return { execution: 'never', status: 'disabled' as const };
  if (!['observe', 'execute'].includes(m.mode)) throw new Error('invalid worker mode');
  if (!m.databasePath || !/^https:\/\//u.test(m.rpcUrl) || !m.approvedBudgetId || m.approvedBudgetId !== m.budget.budgetId) throw new Error('private manifest configuration is incomplete');
  if (m.mode === 'execute') validateExecuteManifest(m);
  if (m.reportOutputPath && [path,m.databasePath,m.keyFile,m.journalPath,m.burnEvidenceFile].filter((x):x is string=>!!x).some((x)=>resolve(x)===resolve(m.reportOutputPath!))) throw new Error('report output must be separate from inputs and private files');
  const burnEvidence = m.burnEvidenceFile ? readJson<BurnEvidence[]>(m.burnEvidenceFile) : undefined;
  if (burnEvidence !== undefined && !Array.isArray(burnEvidence)) throw new Error('invalid burn evidence list');
  const client = createPublicClient({ transport: http(m.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  const store = new SqliteBuybackStore(m.databasePath);
  const reader = createViemReviewRevenueReader(client);
  const readOnlyAdapter: BuybackAdapter = {
    async readTreasuryFunds(input): Promise<TreasuryFunds> {
      const [chainId, balance] = await Promise.all([client.getChainId(), client.readContract({ address: input.usdgAddress as Address, abi: ERC20, functionName: 'balanceOf', args: [input.treasuryAddress as Address] })]);
      const scoped = store.listConfirmedReviewRevenue().filter((e) => e.chainId === BigInt(chainId) && e.escrow.toLowerCase() === m.ingestion.escrowAddress.toLowerCase()
        && e.usdg.toLowerCase() === input.usdgAddress.toLowerCase() && e.recipient.toLowerCase() === m.ingestion.recipientAddress.toLowerCase()
        && e.payPath !== 'FEED' && e.verification === 'confirmed' && e.receiptStatus === 'success' && e.queryStatus === 'DECIDED');
      const eventIds = new Set(scoped.map(e => e.eventId));
      const batchIds = new Set(store.listAllocations().filter(a => a.eventIds.length > 0 && a.eventIds.every(id => eventIds.has(id))).map(a => a.batchId));
      const gross = scoped.reduce((n, e) => n + e.amount, 0n);
      const bought = store.listBuybacks().filter((b) => batchIds.has(b.settledBatchId) && b.status === 'purchased' && b.execution.chainId === BigInt(chainId)
        && b.execution.treasuryAddress.toLowerCase() === input.treasuryAddress.toLowerCase() && b.execution.inputToken.toLowerCase() === input.usdgAddress.toLowerCase()
        && b.execution.outputToken.toLowerCase() === (m.buyback.tokenAddress ?? '').toLowerCase()
        && b.execution.recipient.toLowerCase() === (m.buyback.tokenRecipientAddress ?? '').toLowerCase()).reduce((n, b) => n + b.execution.amountIn, 0n);
      return { chainId: BigInt(chainId), treasuryAddress: input.treasuryAddress, usdgAddress: input.usdgAddress,
        usdgBalance: balance, attributableReviewFunds: gross > bought ? gross - bought : 0n };
    },
    async quoteExactInput(_execution: BuybackExecution): Promise<BuybackQuote> { throw new Error('read-only worker does not quote'); },
    async submitExactInput(): Promise<{ transactionRef: string }> { throw new Error('read-only worker cannot submit'); },
    async reconcile(): Promise<Reconciliation> { return { status: 'unknown' }; },
  };
  const reportClient = client;
  const reportReader = {
    chainId: async () => Number(await reportClient.getChainId()),
    finalizedBlock: async () => { const b = await reportClient.getBlock({ blockTag: 'finalized' }); if (b.number === null || !b.hash) throw new Error('finalized checkpoint unavailable'); return { number: b.number, hash: b.hash }; },
    blockNumber: () => reportClient.getBlockNumber(),
    blockHash: async (n: bigint) => { const b = await reportClient.getBlock({ blockNumber: n }); if (!b.hash) throw new Error('block hash unavailable'); return b.hash; },
    receipt: async (hash: Hex): Promise<ReportReceipt> => { const r = await reportClient.getTransactionReceipt({ hash }); return { status: r.status === 'success' ? 'success' : 'reverted', transactionHash: r.transactionHash, from: r.from, to: r.to ?? '', blockNumber: r.blockNumber, blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex ?? -1 })) }; },
    totalSupply: (token: Address, blockNumber: bigint) => reportClient.readContract({ address: token, abi: ERC20, functionName: 'totalSupply', blockNumber }),
  };
  let adapter: BuybackAdapter = readOnlyAdapter;
  let buybackConfig: BuybackConfig = { ...m.buyback, enabled: false, chainId: BigInt(m.ingestion.chainId), usdgAddress: m.ingestion.usdgAddress, reviewTreasuryAddress: m.ingestion.recipientAddress };
  let closeAdapter: () => void = () => {};
  try {
  if (m.mode === 'execute') {
    const keyPath = m.keyFile!;
    const stat = lstatSync(keyPath);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('configured signing file permissions must be 0600');
    const keyText = readFileSync(keyPath, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/u.test(keyText)) throw new Error('configured signing file is invalid');
    const account = privateKeyToAccount(keyText as Hex);
    if (account.address.toLowerCase() !== m.buyback.reviewTreasuryAddress!.toLowerCase()) throw new Error('signer does not match configured treasury');
    const route = m.route!;
    const chain = defineChain({ id: Number(BigInt(m.ingestion.chainId)), name: `approved-${m.ingestion.chainId}`, nativeCurrency: route.nativeCurrency, rpcUrls: { default: { http: [m.rpcUrl] } } });
    const wallet = createWalletClient({ chain, transport: http(m.rpcUrl), account });
    const operationalAdapter = new UniswapV3BuybackAdapter({ chainId: BigInt(m.ingestion.chainId), routerAddress: route.routerAddress as Address,
      routerVariant: route.routerVariant, routerCodeHash: route.routerCodeHash as Hex, quoterAddress: route.quoterAddress as Address,
      quoterCodeHash: route.quoterCodeHash as Hex, usdgAddress: m.ingestion.usdgAddress as Address, mochiAddress: m.buyback.tokenAddress as Address,
      fee: route.fee, maxGasCostWei: BigInt(route.maxGasCostWei), readAttributableReviewFunds: async () => {
        const matching = store.listConfirmedReviewRevenue().filter((e) => e.chainId === BigInt(m.ingestion.chainId) && e.escrow.toLowerCase() === m.ingestion.escrowAddress.toLowerCase()
          && e.usdg.toLowerCase() === m.ingestion.usdgAddress.toLowerCase() && e.recipient.toLowerCase() === m.ingestion.recipientAddress.toLowerCase()
          && e.payPath !== 'FEED' && e.verification === 'confirmed' && e.receiptStatus === 'success' && e.queryStatus === 'DECIDED');
        const eventIds = new Set(matching.map(e => e.eventId));
        const batchIds = new Set(store.listAllocations().filter(a => a.eventIds.length > 0 && a.eventIds.every(id => eventIds.has(id))).map(a => a.batchId));
        const gross = matching.reduce((n,e)=>n+e.amount,0n);const purchased=store.listBuybacks().filter((b)=>batchIds.has(b.settledBatchId)&&b.status==='purchased'&&b.execution.chainId===BigInt(m.ingestion.chainId)
          && b.execution.treasuryAddress.toLowerCase()===m.ingestion.recipientAddress.toLowerCase()&&b.execution.inputToken.toLowerCase()===m.ingestion.usdgAddress.toLowerCase()
          &&b.execution.outputToken.toLowerCase()===(m.buyback.tokenAddress??'').toLowerCase()&&b.execution.recipient.toLowerCase()===(m.buyback.tokenRecipientAddress??'').toLowerCase()).reduce((n,b)=>n+b.execution.amountIn,0n);
        return gross > purchased ? gross-purchased : 0n;
      } }, client, wallet, m.journalPath!);
    adapter = operationalAdapter; buybackConfig = { ...m.buyback, chainId: BigInt(m.buyback.chainId) };
    closeAdapter = () => operationalAdapter.close();
  }
    const cycle = await runRevenueWorkerCycle({ mode: m.mode, store,
      ingestion: { reader, maxChunks: m.ingestion.maxChunks, config: { ...m.ingestion, chainId: BigInt(m.ingestion.chainId), startBlock: BigInt(m.ingestion.startBlock) } },
      buybackConfig, adapter,
      loadOperatingBudget: async () => ({ ...m.budget, uncoveredDailyOperatingCost: amount(m.budget.uncoveredDailyOperatingCost), retainedOperatingReserve: amount(m.budget.retainedOperatingReserve) }),
      loadObligations: async () => ({ modelLiabilities: amount(m.obligations.modelLiabilities), infrastructureLiabilities: amount(m.obligations.infrastructureLiabilities), refunds: amount(m.obligations.refunds) }),
      report: { config: m.report, reader: reportReader, burnEvidence },
    });
    if (m.reportOutputPath) {
      const output = resolve(m.reportOutputPath);
      if ([path, m.databasePath].some((input) => resolve(input) === output)) throw new Error('report output must be separate from inputs');
      const temporary = `${output}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(cycle.report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, output);
    }
    return { execution: m.mode === 'execute' ? 'approved-adapter' : 'never', cycle };
  } finally { closeAdapter(); store.close(); }
}

function validateExecuteManifest(m: Exclude<Manifest,{mode:'disabled'}>):void {
  const route=m.route;
  const address=(x:unknown):x is string=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/u.test(x)&&!/^0x0{40}$/iu.test(x);
  const hash=(x:unknown):x is string=>typeof x==='string'&&/^0x[0-9a-fA-F]{64}$/u.test(x);
  const rpcValid=(()=>{try{const u=new URL(m.rpcUrl);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}})();
  const configuredAddresses=[m.ingestion.escrowAddress,m.ingestion.usdgAddress,m.ingestion.recipientAddress,m.report.reviewEscrowAddress,m.report.usdgAddress,m.report.mochiAddress,m.report.reviewTreasuryAddress,m.report.purchaseRecipientAddress,m.buyback.tokenAddress,m.buyback.tokenRecipientAddress];
  // Fresh budget and known liabilities gate NEW spending in the cycle, not receipt recovery.
  if(!rpcValid||!/^\d+$/u.test(m.ingestion.chainId)||!/^\d+$/u.test(m.ingestion.startBlock)||!Number.isInteger(m.ingestion.chunkSize)||m.ingestion.chunkSize<1||m.ingestion.chunkSize>2000
    ||(m.ingestion.maxChunks!==undefined&&(!Number.isInteger(m.ingestion.maxChunks)||m.ingestion.maxChunks<1||m.ingestion.maxChunks>100))||!configuredAddresses.every(address)
    ||!Number.isSafeInteger(Number(m.ingestion.chainId))||Number(m.ingestion.chainId)<=0
    ||m.report.chainId!==Number(BigInt(m.ingestion.chainId))||m.report.rpcUrl!==m.rpcUrl
    ||m.report.reviewEscrowAddress.toLowerCase()!==m.ingestion.escrowAddress.toLowerCase()
    ||m.report.usdgAddress.toLowerCase()!==m.ingestion.usdgAddress.toLowerCase()
    ||m.report.reviewTreasuryAddress.toLowerCase()!==m.ingestion.recipientAddress.toLowerCase()
    ||m.report.mochiAddress.toLowerCase()!==m.buyback.tokenAddress?.toLowerCase()
    ||m.report.purchaseRecipientAddress.toLowerCase()!==m.buyback.tokenRecipientAddress?.toLowerCase()||m.report.usdgDecimals!==6||m.report.mochiDecimals!==18||!Number.isSafeInteger(m.report.minimumConfirmations)||m.report.minimumConfirmations<1
    ||m.buyback.enabled!==true||m.buyback.teamConfirmedTokenAddress!==true||!m.buyback.reviewedPolicyId?.trim()||!m.buyback.operatingBudgetId?.trim()
    ||m.buyback.operatingBudgetId!==m.approvedBudgetId||BigInt(m.ingestion.chainId)!==BigInt(m.buyback.chainId)
    ||!address(m.buyback.tokenAddress)||!address(m.buyback.routerAddress)||!address(m.buyback.reviewTreasuryAddress)
    ||m.buyback.reviewTreasuryAddress.toLowerCase()!==m.ingestion.recipientAddress.toLowerCase()
    ||m.buyback.usdgAddress?.toLowerCase()!==m.ingestion.usdgAddress.toLowerCase()
    ||!route||route.readAttributableReviewFundsSource!=='settlement-ledger-v1'||!address(route.routerAddress)||route.routerAddress.toLowerCase()!==m.buyback.routerAddress.toLowerCase()
    ||!address(route.quoterAddress)||!hash(route.routerCodeHash)||!hash(route.quoterCodeHash)||!/^\d+$/u.test(route.maxGasCostWei)||BigInt(route.maxGasCostWei)<=0n
    ||!Number.isInteger(route.fee)||route.fee<0||route.fee>1_000_000||!['swap-router','router02'].includes(route.routerVariant)
    ||!Number.isInteger(m.buyback.maxSlippageBps)||m.buyback.maxSlippageBps!<0||m.buyback.maxSlippageBps!>1000
    ||!m.keyFile||!m.journalPath||resolve(m.keyFile)===resolve(m.databasePath)||resolve(m.keyFile)===resolve(m.journalPath)||resolve(m.journalPath)===resolve(m.databasePath)) {
    throw new Error('execute mode requires explicit confirmed token, approved policy, treasury, exact chain and reviewed route');
  }
  if(!m.route?.nativeCurrency||!m.route.nativeCurrency.name?.trim()||!m.route.nativeCurrency.symbol?.trim()||!Number.isInteger(m.route.nativeCurrency.decimals)||m.route.nativeCurrency.decimals<0||m.route.nativeCurrency.decimals>36)throw new Error('approved chain currency metadata required');
}
