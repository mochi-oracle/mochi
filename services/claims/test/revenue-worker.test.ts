import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { keccak256, toHex } from 'viem';
import { SqliteBuybackStore } from '../src/buyback-sqlite-store.ts';
import { runRevenueWorkerCycle, type RevenueWorkerDependencies } from '../src/revenue-worker.ts';
import { runRevenueWorkerManifest } from '../src/revenue-worker-runtime.ts';
import type { ReviewRevenueEventLog, ReviewRevenueReader, ReviewRevenueReceipt } from '../src/settlement-ingestion.ts';
import type { BuybackAdapter, BuybackConfig, BuybackExecution, BuybackQuote, BuybackReceipt, Reconciliation } from '../src/buybacks.ts';
import type { RevenueReportConfig, RevenueReportReader, ReportReceipt } from '../src/revenue-report.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const escrow=addr(1), usdg=addr(2), recipient=addr(3), mochi=addr(4), router=addr(5), treasury=recipient, tokenRecipient=addr(6);
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function tempDb(){const root=mkdtempSync(join(tmpdir(),'mochi-revenue-worker-'));roots.push(root);return join(root,'ledger.sqlite');}
const ingestionConfig={chainId:4663n,escrowAddress:escrow,usdgAddress:usdg,recipientAddress:recipient,startBlock:5n,chunkSize:2};
const canonical=JSON.stringify({chainId:'4663',escrow,usdg,recipient,startBlock:'5',chunkSize:2,finality:'finalized'});
const streamId=createHash('sha256').update(canonical).digest('hex');
const reportConfig:RevenueReportConfig={chainId:4663,rpcUrl:'https://rpc.example',settlementStreamId:streamId,reviewEscrowAddress:escrow,usdgAddress:usdg,usdgDecimals:6,mochiAddress:mochi,mochiDecimals:18,reviewTreasuryAddress:treasury,purchaseRecipientAddress:tokenRecipient,minimumConfirmations:1};
const buybackConfig:BuybackConfig={enabled:true,reviewedPolicyId:'test-policy',operatingBudgetId:'test-budget',teamConfirmedTokenAddress:true,chainId:4663n,tokenAddress:mochi,usdgAddress:usdg,reviewTreasuryAddress:treasury,tokenRecipientAddress:tokenRecipient,routerAddress:router,maxSlippageBps:100};
const transferTopic=keccak256(toHex('Transfer(address,address,uint256)')).toLowerCase();
const topic=(a:string)=>`0x${a.slice(2).padStart(64,'0')}`;

class Reader implements ReviewRevenueReader {
  head=6n; logs:ReviewRevenueEventLog[]=[]; query=new Map<string,{payPath:number;status:number}>(); receipts=new Map<string,ReviewRevenueReceipt>();
  async chainId(){return 4663n;} async finalizedBlock(){return {number:this.head,hash:hash(Number(this.head))};}
  async blockHash(n:bigint){return hash(Number(n));}
  async reviewRevenueLogs({fromBlock,toBlock}:{escrow:string;recipient:string;fromBlock:bigint;toBlock:bigint}){return this.logs.filter(x=>x.blockNumber!==null&&x.blockNumber>=fromBlock&&x.blockNumber<=toBlock);}
  async escrowUsdgAt(){return usdg;} async reviewRecipientAt(){return recipient;}
  async queryAt(_e:string,id:string){return this.query.get(id)!;} async receipt(tx:string){return this.receipts.get(tx)!;}
  add(index:number,block:bigint,amount:bigint){const tx=hash(100+index),id=hash(200+index),eventLogIndex=index*2+1;
    const log:ReviewRevenueEventLog={address:escrow,blockNumber:block,blockHash:hash(Number(block)),transactionHash:tx,logIndex:eventLogIndex,queryId:id,recipient,amount};this.logs.push(log);this.query.set(id,{payPath:0,status:3});
    this.receipts.set(tx,{transactionHash:tx,blockNumber:block,blockHash:hash(Number(block)),status:'success',revenueEvents:[{address:escrow,queryId:id,recipient,amount,logIndex:eventLogIndex}],transfers:[{token:usdg,from:escrow,to:recipient,amount,logIndex:eventLogIndex-1}]});return log;
  }
}
class Adapter implements BuybackAdapter {
  submissions=0; state:Reconciliation={status:'pending'}; captured?:BuybackExecution;
  async readTreasuryFunds(){return {chainId:4663n,treasuryAddress:treasury,usdgAddress:usdg,usdgBalance:100_000_000n,attributableReviewFunds:100_000_000n};}
  async quoteExactInput(x:BuybackExecution):Promise<BuybackQuote>{this.captured=x;return {chainId:x.chainId,routerAddress:x.routerAddress,treasuryAddress:x.treasuryAddress,senderAddress:x.senderAddress,inputToken:x.inputToken,outputToken:x.outputToken,recipient:x.recipient,amountIn:x.amountIn,amountOut:50_000_000n,quotedAtMs:1_000_000,validUntilMs:1_090_000};}
  async submitExactInput(x:BuybackExecution & {idempotencyKey:string}){this.submissions++;this.captured=x;return {transactionRef:hash(900)};}
  async reconcile():Promise<Reconciliation>{return this.state;}
}
function reportReader(adapter:Adapter):RevenueReportReader {
  return {chainId:async()=>4663,finalizedBlock:async()=>({number:20n,hash:hash(20)}),blockNumber:async()=>20n,blockHash:async(n)=>hash(Number(n)),totalSupply:async()=>1_000_000n,
    receipt:async(tx):Promise<ReportReceipt>=>({status:'success',transactionHash:tx,from:treasury,to:router,blockNumber:15n,blockHash:hash(15),logs:[
      {address:usdg,topics:[transferTopic,topic(treasury),topic(router)],data:`0x${(adapter.captured?.amountIn ?? 25_000_000n).toString(16).padStart(64,'0')}`,logIndex:0},
      {address:mochi,topics:[transferTopic,topic(router),topic(tokenRecipient)],data:`0x${50_000_000n.toString(16).padStart(64,'0')}`,logIndex:1},
    ]})};
}
function deps(db:string, reader:Reader, adapter:Adapter, overrides:Partial<RevenueWorkerDependencies>={}):RevenueWorkerDependencies & {mode:'execute'} {
  return {store:new SqliteBuybackStore(db),ingestion:{reader,config:ingestionConfig,maxChunks:10},buybackConfig,adapter,
    loadOperatingBudget:async()=>({budgetId:'test-budget',asOfMs:1_000_000,uncoveredDailyOperatingCost:0n,retainedOperatingReserve:0n}),
    loadObligations:async()=>({modelLiabilities:0n,infrastructureLiabilities:0n,refunds:0n}),report:{config:reportConfig,reader:reportReader(adapter),burnEvidence:[]},now:()=>1_000_000,...overrides,mode:'execute'};
}

describe('runRevenueWorkerCycle',()=>{
  test('omitted mode is disabled before touching the store or RPC',async()=>{
    const path=tempDb(),reader=new Reader(),adapter=new Adapter();
    const store=new SqliteBuybackStore(path);
    const result=await runRevenueWorkerCycle({store,ingestion:{reader:{chainId:async()=>{throw new Error('must not access RPC');}} as unknown as Reader,config:ingestionConfig},buybackConfig:{},adapter,
      loadOperatingBudget:async()=>{throw new Error('must not load budget');},loadObligations:async()=>{throw new Error('must not load obligations');},report:{config:reportConfig,reader:reportReader(adapter)}});
    expect(result).toEqual({mode:'disabled',execution:'never'});expect(adapter.submissions).toBe(0);store.close();
  });

  test('minimal disabled CLI manifest exits before database, RPC, or key path access',async()=>{
    const manifest=join(dirname(tempDb()),'disabled.json');writeFileSync(manifest,'{"mode":"disabled"}');
    expect(await runRevenueWorkerManifest(manifest)).toEqual({execution:'never',status:'disabled'});
  });

  test('unknown CLI mode fails before database or RPC initialization',async()=>{
    const manifest=join(dirname(tempDb()),'invalid-mode.json');writeFileSync(manifest,JSON.stringify({mode:'anything'}));
    await expect(runRevenueWorkerManifest(manifest)).rejects.toThrow('invalid worker mode');
  });

  test('execute CLI validates team confirmation and policy before opening the configured keyfile',async()=>{
    const manifest=join(dirname(tempDb()),'execute.json');const nonexistent=join(dirname(manifest),'must-not-open.key');
    const now=Date.now();
    writeFileSync(manifest,JSON.stringify({mode:'execute',databasePath:join(dirname(manifest),'ledger.sqlite'),rpcUrl:'https://rpc.example',keyFile:nonexistent,journalPath:join(dirname(manifest),'journal.sqlite',
      ),ingestion:{chainId:'4663',escrowAddress:escrow,usdgAddress:usdg,recipientAddress:recipient,startBlock:'1',chunkSize:100},
      report:{chainId:4663,rpcUrl:'https://rpc.example',settlementStreamId:'stream',reviewEscrowAddress:escrow,usdgAddress:usdg,usdgDecimals:6,mochiAddress:mochi,mochiDecimals:18,reviewTreasuryAddress:recipient,purchaseRecipientAddress:tokenRecipient,minimumConfirmations:1},
      buyback:{enabled:true,teamConfirmedTokenAddress:false,reviewedPolicyId:'approved',operatingBudgetId:'budget',chainId:'4663',tokenAddress:mochi,usdgAddress:usdg,reviewTreasuryAddress:recipient,tokenRecipientAddress:tokenRecipient,routerAddress:router,maxSlippageBps:100},
      approvedBudgetId:'budget',budget:{budgetId:'budget',asOfMs:now,uncoveredDailyOperatingCost:'0',retainedOperatingReserve:'0'},obligations:{modelLiabilities:'0',infrastructureLiabilities:'0',refunds:'0'},route:{routerAddress:router,routerVariant:'router02',routerCodeHash:hash(1),quoterAddress:addr(8),quoterCodeHash:hash(2),fee:3000,maxGasCostWei:'1000',readAttributableReviewFundsSource:'settlement-ledger-v1',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18}}}));
    await expect(runRevenueWorkerManifest(manifest)).rejects.toThrow('explicit confirmed token');
  });

  test('ingests, accumulates to threshold, allocates once, submits once, and reports purchases after restart',async()=>{
    const path=tempDb(), reader=new Reader(), adapter=new Adapter(); reader.add(0,6n,12_500_000n);
    const first=deps(path,reader,adapter);const firstResult=await runRevenueWorkerCycle(first);
    expect(firstResult.allocation).toBeUndefined();expect(firstResult.purchase).toBeUndefined();expect(first.store.listAllocations()).toHaveLength(0);first.store.close();

    reader.head=8n;reader.add(1,8n,12_500_000n);
    const second=deps(path,reader,adapter);second.report.config={...second.report.config,settlementStreamId:'derive-from-ingestion'};adapter.state={status:'confirmed',receipt:{chainId:4663n,transactionRef:hash(900),routerAddress:router,treasuryAddress:treasury,senderAddress:treasury,recipient:tokenRecipient,inputToken:usdg,outputToken:mochi,amountIn:25_000_000n,receivedTokenAmount:50_000_000n}};
    const result=await runRevenueWorkerCycle(second);
    expect(result.allocation?.grossReviewRevenue).toBe(25_000_000n);expect(result.purchase?.status).toBe('purchased');expect(adapter.submissions).toBe(1);
    expect(result.report.status).toBe('complete');expect(result.report.accounting.purchasedReviewFundsAtomic).toBe('25000000');second.store.close();

    const restarted=deps(path,reader,adapter);const duplicate=await runRevenueWorkerCycle(restarted);
    expect(duplicate.allocation).toBeUndefined();expect(duplicate.purchase).toBeUndefined();expect(adapter.submissions).toBe(1);expect(duplicate.report.status).toBe('complete');restarted.store.close();
  });

  test('unknown operating obligations do not allocate or reserve revenue',async()=>{
    const path=tempDb(),reader=new Reader(),adapter=new Adapter();reader.add(0,6n,30_000_000n);
    const d=deps(path,reader,adapter,{loadObligations:async()=>({modelLiabilities:null,infrastructureLiabilities:0n,refunds:0n})});
    const result=await runRevenueWorkerCycle(d);
    expect(result.plan).toMatchObject({eligible:false,blockedReasons:['incomplete_obligations']});expect(result.allocation).toBeUndefined();expect(result.purchase).toBeUndefined();expect(d.store.listAllocations()).toHaveLength(0);expect(adapter.submissions).toBe(0);d.store.close();
  });

  test('does not allocate or buy from a partially ingested event horizon',async()=>{
    const path=tempDb(),reader=new Reader(),adapter=new Adapter();reader.head=8n;reader.add(0,6n,30_000_000n);
    const d=deps(path,reader,adapter);d.ingestion.maxChunks=1;
    const result=await runRevenueWorkerCycle(d);
    expect(result.ingestion.complete).toBe(false);expect(result.allocation).toBeUndefined();expect(result.purchase).toBeUndefined();expect(d.store.listAllocations()).toHaveLength(0);expect(adapter.submissions).toBe(0);d.store.close();
  });

  test('recovers a persisted in-flight purchase before loading budget and never resubmits',async()=>{
    const path=tempDb(),reader=new Reader(),adapter=new Adapter();reader.add(0,6n,30_000_000n);
    const seed=deps(path,reader,adapter);adapter.state={status:'pending'};
    const first=await runRevenueWorkerCycle(seed);
    expect(first.purchase?.status).toBe('pending_reconciliation');expect(adapter.submissions).toBe(1);seed.store.close();
    const recovered=deps(path,reader,adapter,{loadOperatingBudget:async()=>{throw new Error('must not load policy for recovery');},loadObligations:async()=>{throw new Error('must not load obligations for recovery');}});
    adapter.state={status:'confirmed',receipt:{chainId:4663n,transactionRef:hash(900),routerAddress:router,treasuryAddress:treasury,senderAddress:treasury,recipient:tokenRecipient,inputToken:usdg,outputToken:mochi,amountIn:30_000_000n,receivedTokenAmount:50_000_000n}};
    const resumed=await runRevenueWorkerCycle(recovered);
    expect(resumed.reconciliations).toHaveLength(1);expect(resumed.reconciliations[0]?.result.status).toBe('purchased');expect(adapter.submissions).toBe(1);
    expect((await recovered.store.get(resumed.reconciliations[0]!.batchId))?.status).toBe('purchased');recovered.store.close();
  });
});
