import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { createPublicRevenueReport, type BurnEvidence, type RevenueReportConfig, type ReportReceipt, type RevenueReportStore } from '../services/claims/src/revenue-report.ts';
import type { ConfirmedReviewRevenueRecord, ReviewAllocationRecord, ReviewIngestionCursor } from '../services/claims/src/buyback-sqlite-store.ts';
import type { PersistedBuyback } from '../services/claims/src/buybacks.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined { const i=args.indexOf(name);return i<0?undefined:args[i+1]; }
function readJson<T>(path:string):T { return JSON.parse(readFileSync(path,'utf8')) as T; }
class ReadOnlyStore implements RevenueReportStore {
  private readonly db:Database;
  private readonly settlements:ConfirmedReviewRevenueRecord[];
  private readonly allocations:ReviewAllocationRecord[];
  private readonly buybacks:PersistedBuyback[];
  private readonly cursors:ReviewIngestionCursor[];
  constructor(path:string){this.db=new Database(path,{readonly:true});this.db.exec('BEGIN DEFERRED');
    this.settlements=this.loadSettlements();this.allocations=this.loadAllocations();this.buybacks=this.loadBuybacks();this.cursors=this.loadCursors();this.db.exec('COMMIT');}
  private loadSettlements():ConfirmedReviewRevenueRecord[]{
    return (this.db.query('SELECT * FROM review_chain_settlements ORDER BY chain_id,block_number,log_index').all() as Array<Record<string,unknown>>).map(r=>({
      eventId:String(r.event_id),chainId:BigInt(String(r.chain_id)),escrow:String(r.escrow),usdg:String(r.usdg),recipient:String(r.recipient),blockNumber:BigInt(String(r.block_number)),
      blockHash:String(r.block_hash),transactionHash:String(r.transaction_hash),logIndex:Number(r.log_index),queryId:String(r.query_id),amount:BigInt(String(r.amount)),
      payPath:r.pay_path as ConfirmedReviewRevenueRecord['payPath'],queryStatus:r.query_status as ConfirmedReviewRevenueRecord['queryStatus'],receiptStatus:r.receipt_status as 'success'|'reverted',
      transferFrom:String(r.transfer_from),transferTo:String(r.transfer_to),transferAmount:BigInt(String(r.transfer_amount)),verification:r.verification as 'confirmed'|'unconfirmed',createdAt:String(r.created_at)}));
  }
  private loadAllocations():ReviewAllocationRecord[]{return (this.db.query('SELECT batch_id,amount,event_ids FROM review_allocations ORDER BY created_at,batch_id').all() as Array<Record<string,unknown>>).map(r=>({batchId:String(r.batch_id),amount:BigInt(String(r.amount)),eventIds:JSON.parse(String(r.event_ids)) as string[]}));}
  private loadBuybacks():PersistedBuyback[]{return (this.db.query('SELECT payload FROM buyback_records ORDER BY batch_id').all() as Array<{payload:string}>).map(r=>JSON.parse(r.payload,(_k,v)=>v&&typeof v==='object'&&'$bigint'in v?BigInt(v.$bigint as string):v) as PersistedBuyback);}
  private loadCursors():ReviewIngestionCursor[]{return (this.db.query('SELECT * FROM review_ingestion_cursors ORDER BY stream_id').all() as Array<Record<string,unknown>>).map(r=>({streamId:String(r.stream_id),configJson:String(r.config_json),startBlock:BigInt(String(r.start_block)),nextBlock:BigInt(String(r.next_block)),lastBlock:BigInt(String(r.last_block)),lastBlockHash:String(r.last_block_hash),finalizedBlock:BigInt(String(r.finalized_block)),updatedAt:String(r.updated_at)}));}
  listConfirmedReviewRevenue(){return this.settlements;}
  listAllocations(){return this.allocations;}
  listBuybacks(){return this.buybacks;}
  listIngestionCursors(){return this.cursors;}
  close(){this.db.close();}
}
async function main(){
const configPath=option('--config'),databasePath=option('--db'),outputPath=option('--out'),burnPath=option('--burn-evidence');
if(!configPath||!databasePath||!outputPath){console.error('Usage: bun scripts/revenue-report.ts --config CONFIG.json --db STORE.sqlite --out REPORT.json [--burn-evidence BURNS.json]');process.exitCode=2;return;}
if([configPath,databasePath,burnPath].filter(Boolean).some(p=>resolve(p!)===resolve(outputPath))){console.error('Output path must be separate from its inputs.');process.exitCode=2;return;}
let store:ReadOnlyStore|undefined;
try {
  const config=readJson<RevenueReportConfig>(configPath);const evidence=burnPath?readJson<BurnEvidence[]>(burnPath):undefined;
  const client=createPublicClient({transport:http(config.rpcUrl)});const erc20=parseAbi(['function totalSupply() view returns (uint256)']);
  const reader={chainId:async()=>Number(await client.getChainId()),finalizedBlock:async()=>{const b=await client.getBlock({blockTag:'finalized'});return {number:b.number!,hash:b.hash};},blockNumber:async()=>client.getBlockNumber(),
    blockHash:async(n:bigint)=>(await client.getBlock({blockNumber:n})).hash,
    receipt:async(hash:Hex):Promise<ReportReceipt>=>{const r=await client.getTransactionReceipt({hash});return {status:r.status==='success'?'success':'reverted',transactionHash:r.transactionHash,from:r.from??'',to:r.to??'',blockNumber:r.blockNumber,blockHash:r.blockHash,logs:r.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,logIndex:l.logIndex??-1}))};},
    totalSupply:(token:Address,blockNumber:bigint)=>client.readContract({address:token,abi:erc20,functionName:'totalSupply',blockNumber}),};
  store=new ReadOnlyStore(databasePath);
  const report=await createPublicRevenueReport(config,store,reader,evidence);
  const temporary=`${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporary,`${JSON.stringify(report,null,2)}\n`,{mode:0o600,flag:'wx'});renameSync(temporary,outputPath);
  console.log(`Wrote ${report.status} public revenue report.`);
  if(report.status!=='complete')process.exitCode=1;
} catch {
  console.error('Revenue report generation failed; check the local configuration, store, and read-only RPC.');
  process.exitCode=1;
} finally { store?.close(); }
}
await main().catch(()=>{console.error('Revenue report generation failed; check the local configuration, store, and read-only RPC.');process.exitCode=1;});
