import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { PersistedBuyback } from './buybacks.ts';
import type { ConfirmedReviewRevenueRecord, ReviewAllocationRecord, ReviewIngestionCursor } from './buyback-sqlite-store.ts';

export interface RevenueReportStore {
  listConfirmedReviewRevenue(): ConfirmedReviewRevenueRecord[];
  listAllocations(): ReviewAllocationRecord[];
  listBuybacks(): PersistedBuyback[];
  listIngestionCursors(): ReviewIngestionCursor[];
}
export type BurnEvidence = { transactionHash: string; logIndex: number; kind: 'native-supply-burn' | 'dead-address-transfer' };
export type RevenueReportConfig = {
  chainId: number; rpcUrl: string; settlementStreamId: string; reviewEscrowAddress: string;
  usdgAddress: string; usdgDecimals: number; mochiAddress: string; mochiDecimals: number;
  reviewTreasuryAddress: string; purchaseRecipientAddress: string; deadAddress?: string | null;
  minimumConfirmations: number;
};
export type ReportLog = { address: string; topics: readonly string[]; data: string; logIndex: number };
export type ReportReceipt = { status: 'success' | 'reverted'; transactionHash: string; from: string; to: string; blockNumber: bigint; blockHash: string; logs: readonly ReportLog[] };
export interface RevenueReportReader {
  chainId(): Promise<number>; finalizedBlock(): Promise<{number:bigint;hash:string}>; blockNumber(): Promise<bigint>; blockHash(blockNumber: bigint): Promise<string>;
  receipt(transactionHash: Hex): Promise<ReportReceipt>; totalSupply(token: Address, blockNumber: bigint): Promise<bigint>;
}
const ZERO = '0x0000000000000000000000000000000000000000';
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)')).toLowerCase();
const lower = (s: string) => s.toLowerCase();
const atomic = (n: bigint) => n.toString(10);
const validHash = (s: string) => HASH.test(s);

export type RevenueReportResult = {
  schema: 'mochi-public-revenue-report-v1'; status: 'complete' | 'incomplete';
  asOf: { generatedAt: string; chainId: number; blockNumber: string; blockHash: string; confirmations: number };
  assets: { reviewRevenue: { address: string; decimals: number }; purchasedToken: { address: string; decimals: number } };
  treasury: { address: string };
  accounting: {
    source: 'verified-post-panel-review-protocol-remainder'; checkpointBlock: string | null; purchaseEvidence: 'receipt-verified' | 'ledger-reported-unverified';
    settlementEventCount: number | null; allocatedReviewRevenueAtomic: string | null; unallocatedReviewRevenueAtomic: string | null;
    totalVerifiedSettledReviewRevenueAtomic: string | null; reservedOrInFlightReviewFundsAtomic: string | null;
    purchasedReviewFundsAtomic: string | null; remainingAttributedReviewRevenueAtomic: string | null;
    buybackCount: { reservedOrInFlight: number; purchased: number } | null;
    purchases: Array<{ transactionHash: string; blockNumber: string; amountInAtomic: string; receivedTokenAtomic: string }> | null;
    settlements: Array<{ transactionHash: string; logIndex: number; blockNumber: string; blockHash: string; amountAtomic: string }> | null;
    operatingPolicy: { asOfMs: number; reserveTargetAtomic: string; retainedReserveSnapshotAtomic: string; requiredTopUpAtomic: string } | null;
  };
  purchasedToken: {
    purchaseRecipient: string; purchasedAtomic: string | null;
    ledgerReportedPurchasedAtomic: string | null;
    manualBurnEvidence: { status: 'verified' | 'unconfigured'; nativeSupplyBurnAtomic: string | null; deadAddressTransferAtomic: string | null; awaitingManualBurnAtomic: string | null; records: Array<{ kind: BurnEvidence['kind']; transactionHash: string; logIndex: number; blockNumber: string; amountAtomic: string }> | null };
  };
  integrity: { rejectedRecordCount: number; incompleteReasons: string[] };
};

function validateConfig(c: RevenueReportConfig): void {
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0 || !c.settlementStreamId || c.usdgDecimals !== 6 || !Number.isSafeInteger(c.mochiDecimals) || c.mochiDecimals < 0 || c.mochiDecimals > 36
    || ![c.reviewEscrowAddress,c.usdgAddress,c.mochiAddress,c.reviewTreasuryAddress,c.purchaseRecipientAddress].every(x=>ADDRESS.test(x)&&lower(x)!==ZERO)
    || (c.deadAddress != null && (!ADDRESS.test(c.deadAddress)||lower(c.deadAddress)===ZERO))
    || !Number.isSafeInteger(c.minimumConfirmations)||c.minimumConfirmations<1) throw new Error('invalid report configuration');
  let u: URL; try { u=new URL(c.rpcUrl); } catch { throw new Error('invalid report configuration'); }
  if (u.protocol!=='https:'||u.username||u.password) throw new Error('invalid report configuration');
}
function parseCursorConfig(cursor: ReviewIngestionCursor, c: RevenueReportConfig): boolean {
  try {
    const x=JSON.parse(cursor.configJson) as Record<string, unknown>;
    const get=(...keys:string[])=>keys.map(k=>x[k]).find(v=>v!==undefined);
    return Number(get('chainId'))===c.chainId
      && typeof get('escrow','escrowAddress')==='string' && lower(String(get('escrow','escrowAddress')))==lower(c.reviewEscrowAddress)
      && typeof get('usdg','usdgAddress')==='string' && lower(String(get('usdg','usdgAddress')))==lower(c.usdgAddress)
      && typeof get('recipient','recipientAddress')==='string' && lower(String(get('recipient','recipientAddress')))==lower(c.reviewTreasuryAddress)
      && String(get('startBlock'))===cursor.startBlock.toString() && Number(get('chunkSize'))>0 && get('finality')==='finalized';
  } catch { return false; }
}
function validEvent(e: ConfirmedReviewRevenueRecord,c:RevenueReportConfig):boolean {
  return typeof e.eventId==='string'&&!!e.eventId&&Number(e.chainId)===c.chainId
    && lower(e.escrow)===lower(c.reviewEscrowAddress)&&lower(e.usdg)===lower(c.usdgAddress)
    && lower(e.recipient)===lower(c.reviewTreasuryAddress)&&['USDG','SHIELDED','ANONYMA'].includes(e.payPath)&&e.queryStatus==='DECIDED'
    && e.verification==='confirmed'&&e.receiptStatus==='success'
    && lower(e.transferFrom)===lower(c.reviewEscrowAddress)&&lower(e.transferTo)===lower(c.reviewTreasuryAddress)
    && e.transferAmount===e.amount&&e.amount>0n&&e.blockNumber>=0n&&validHash(e.blockHash)&&validHash(e.transactionHash)
    && Number.isSafeInteger(e.logIndex)&&e.logIndex>=0;
}
function summarize(c:RevenueReportConfig,s:RevenueReportStore,cursor:ReviewIngestionCursor|undefined) {
  const reasons:string[]=[];let rejected=0;
  if(!cursor||cursor.streamId!==c.settlementStreamId||!parseCursorConfig(cursor,c)) reasons.push('settlement_ingestion_not_configured');
  const events=s.listConfirmedReviewRevenue();const eventMap=new Map<string,ConfirmedReviewRevenueRecord>();const logSet=new Set<string>();
  for(const e of events){const key=`${lower(e.transactionHash)}:${e.logIndex}`;if(!validEvent(e,c)||eventMap.has(e.eventId)||logSet.has(key)||(cursor&&(e.blockNumber>cursor.lastBlock||e.blockNumber<cursor.startBlock))){rejected++;reasons.push('invalid_or_replayed_settlement_record');continue;}eventMap.set(e.eventId,e);logSet.add(key);}
  const allocated=new Set<string>();const batches=new Map<string,bigint>();let allocatedTotal=0n;
  for(const a of s.listAllocations()){
    const rows=a.eventIds.map(id=>eventMap.get(id));const amount=rows.every(Boolean)?rows.reduce((n,e)=>n+e!.amount,0n):-1n;
    if(!a.batchId||a.amount<=0n||amount!==a.amount||new Set(a.eventIds).size!==a.eventIds.length||a.eventIds.some(id=>allocated.has(id))||batches.has(a.batchId)){rejected++;reasons.push('invalid_or_replayed_review_allocation');continue;}
    batches.set(a.batchId,a.amount);allocatedTotal+=a.amount;a.eventIds.forEach(id=>allocated.add(id));
  }
  let reserved=0n,purchasedUsd=0n,purchasedMochi=0n,inflightCount=0,purchasedCount=0;
  const policy:NonNullable<RevenueReportResult['accounting']['operatingPolicy']>[]=[];const seen=new Set<string>();
  for(const b of s.listBuybacks()){
    const x=b.execution;const allocation=batches.get(b.settledBatchId);
    const ok=!!allocation&&allocation===b.grossReviewRevenue&&x.chainId===BigInt(c.chainId)&&lower(x.treasuryAddress)===lower(c.reviewTreasuryAddress)
      &&lower(x.senderAddress)===lower(c.reviewTreasuryAddress)&&lower(x.inputToken)===lower(c.usdgAddress)&&lower(x.outputToken)===lower(c.mochiAddress)&&lower(x.recipient)===lower(c.purchaseRecipientAddress)
      &&x.amountIn>0n&&x.amountIn<=allocation&&!seen.has(b.settledBatchId);
    if(!ok){rejected++;reasons.push('invalid_or_unattributed_buyback_record');continue;}seen.add(b.settledBatchId);
    if(b.operatingPolicy)policy.push({asOfMs:b.operatingPolicy.asOfMs,reserveTargetAtomic:atomic(b.operatingPolicy.reserveTarget),retainedReserveSnapshotAtomic:atomic(b.operatingPolicy.retainedReserve),requiredTopUpAtomic:atomic(b.operatingPolicy.requiredTopUp)});
    if(b.status==='submitting'||b.status==='submitted'){reserved+=x.amountIn;inflightCount++;}
    else if(b.status==='purchased'){
      if(!b.transactionRef||!validHash(b.transactionRef)||b.receivedTokenAmount==null||b.receivedTokenAmount<=0n){rejected++;reasons.push('invalid_purchase_confirmation');continue;}
      purchasedUsd+=x.amountIn;purchasedMochi+=b.receivedTokenAmount;purchasedCount++;
    }
  }
  const total=[...eventMap.values()].reduce((n,e)=>n+e.amount,0n);const remaining=total-purchasedUsd-reserved;
  if(allocatedTotal>total||remaining<0n){rejected++;reasons.push('attributed_revenue_below_allocations_or_commitments');}
  if(cursor&&cursor.lastBlock>0n&&!validHash(cursor.lastBlockHash)){reasons.push('invalid_ingestion_checkpoint');}
  if(cursor&&(cursor.nextBlock!==cursor.lastBlock+1n||cursor.lastBlock<cursor.startBlock))reasons.push('invalid_ingestion_cursor');
  policy.sort((a,b)=>a.asOfMs-b.asOfMs);
  if(policy.length>1){const last=policy.at(-1)!;if(policy.some(p=>p.asOfMs===last.asOfMs&&JSON.stringify(p)!==JSON.stringify(last)))reasons.push('operating_policy_snapshot_conflict');}
  return {ready:!!cursor&&parseCursorConfig(cursor,c)&&!reasons.includes('invalid_ingestion_checkpoint')&&!reasons.includes('invalid_ingestion_cursor'),events:[...eventMap.values()],allocatedTotal,total,reserved,purchasedUsd,purchasedMochi,inflightCount,purchasedCount,remaining,rejected,reasons,policy:policy.at(-1)??null};
}
function topicAddress(topic:string|undefined){return topic&&/^0x[0-9a-fA-F]{64}$/u.test(topic)?`0x${topic.slice(-40)}`.toLowerCase():undefined;}
type VerifiedPurchase={transactionHash:string;amountIn:bigint;amount:bigint;blockNumber:bigint;logIndex:number};
async function verifyPurchases(c:RevenueReportConfig,records:PersistedBuyback[],reader:RevenueReportReader,anchor:bigint){
  const verified:VerifiedPurchase[]=[];let amount=0n;const reasons:string[]=[];let rejected=0;const seen=new Set<string>();
  for(const b of records.filter(x=>x.status==='purchased')){
    const ref=b.transactionRef;if(!ref||!validHash(ref)||b.receivedTokenAmount==null||b.receivedTokenAmount<=0n){reasons.push('purchase_receipt_unverifiable');continue;}
    if(seen.has(lower(ref))){reasons.push('replayed_purchase_receipt');continue;}seen.add(lower(ref));
    let r:ReportReceipt;try{r=await reader.receipt(ref as Hex);}catch{reasons.push('purchase_receipt_unverifiable');continue;}
    if(r.status!=='success'||lower(r.transactionHash)!==lower(ref)||lower(r.from)!==lower(c.reviewTreasuryAddress)||lower(b.execution.senderAddress)!==lower(c.reviewTreasuryAddress)||lower(r.to)!==lower(b.execution.routerAddress)||r.blockNumber>anchor||anchor-r.blockNumber+1n<BigInt(c.minimumConfirmations)){reasons.push('purchase_receipt_unverifiable');continue;}
    let canonical:string;try{canonical=await reader.blockHash(r.blockNumber);}catch{reasons.push('purchase_receipt_unverifiable');continue;}
    if(lower(canonical)!==lower(r.blockHash)){reasons.push('purchase_receipt_unverifiable');continue;}
    let input=0n,output=0n;let outIndex=-1;
    for(const l of r.logs){if(lower(l.topics[0]??'')!==TRANSFER_TOPIC)continue;const from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);const n=/^0x[0-9a-fA-F]{64}$/u.test(l.data)?BigInt(l.data):0n;
      if(lower(l.address)===lower(c.usdgAddress)){if(from===lower(c.reviewTreasuryAddress))input+=n;if(to===lower(c.reviewTreasuryAddress))input-=n;}
      if(lower(l.address)===lower(c.mochiAddress)){if(to===lower(c.purchaseRecipientAddress)){output+=n;outIndex=Math.max(outIndex,l.logIndex);}if(from===lower(c.purchaseRecipientAddress))output-=n;}}
    if(input!==b.execution.amountIn||output!==b.receivedTokenAmount||output<b.execution.minAmountOut||outIndex<0){reasons.push('purchase_receipt_unverifiable');continue;}
    amount+=output;verified.push({transactionHash:lower(ref),amountIn:input,amount:output,blockNumber:r.blockNumber,logIndex:outIndex});
  }
  return {amount,verified,reasons,rejected:rejected+reasons.length};
}
async function verifyBurns(c:RevenueReportConfig,evidence:readonly BurnEvidence[]|undefined,purchases:readonly VerifiedPurchase[],reader:RevenueReportReader,anchor:bigint){
  if(evidence===undefined)return {status:'unconfigured' as const,native:0n,dead:0n,remaining:null as bigint|null,records:null,rejected:0,reasons:['manual_burn_evidence_not_configured']};
  let native=0n,dead=0n,rejected=0;const records:NonNullable<RevenueReportResult['purchasedToken']['manualBurnEvidence']['records']>=[];const reasons:string[]=[];const seen=new Map<string,string>();
  const head=anchor;
  const receiptCache=new Map<string,ReportReceipt>();
  for(const item of evidence){if(validHash(item.transactionHash)&&!receiptCache.has(lower(item.transactionHash))){try{receiptCache.set(lower(item.transactionHash),await reader.receipt(item.transactionHash as Hex));}catch{ /* Mark unavailable below without exposing provider errors. */ }}}
  const ordered=[...evidence].sort((a,b)=>{const x=receiptCache.get(lower(a.transactionHash))?.blockNumber??0n,y=receiptCache.get(lower(b.transactionHash))?.blockNumber??0n;return x===y?a.logIndex-b.logIndex:x<y?-1:1;});
  const supplyByBlock=new Map<bigint,bigint>();
  for(const item of ordered){const tx=typeof item.transactionHash==='string'?lower(item.transactionHash):'';const key=`${tx}:${item.logIndex}`;
    if(!validHash(tx)||!Number.isSafeInteger(item.logIndex)||item.logIndex<0){rejected++;reasons.push('invalid_burn_evidence');continue;}
    const prior=seen.get(key);if(prior){rejected++;reasons.push(prior===item.kind?'replayed_burn_evidence':'altered_burn_evidence');continue;}seen.set(key,item.kind);
    const receipt=receiptCache.get(tx);if(!receipt){rejected++;reasons.push('burn_receipt_unavailable');continue;}
    if(receipt.status!=='success'||lower(receipt.transactionHash)!==tx||receipt.blockNumber>head||head-receipt.blockNumber+1n<BigInt(c.minimumConfirmations)){rejected++;reasons.push('burn_receipt_unconfirmed');continue;}
    let canonical:string;try{canonical=await reader.blockHash(receipt.blockNumber);}catch{rejected++;reasons.push('burn_block_unavailable');continue;}
    if(lower(canonical)!==lower(receipt.blockHash)){rejected++;reasons.push('burn_receipt_noncanonical');continue;}
    const log=receipt.logs.find(l=>l.logIndex===item.logIndex);if(!log||lower(log.address)!==lower(c.mochiAddress)||lower(log.topics[0]??'')!==TRANSFER_TOPIC){rejected++;reasons.push('burn_wrong_token_or_event');continue;}
    const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);const amount=/^0x[0-9a-fA-F]{64}$/u.test(log.data)?BigInt(log.data):0n;
    if(from!==lower(c.purchaseRecipientAddress)||amount<=0n){rejected++;reasons.push('burn_wrong_source_or_amount');continue;}
    if(!['native-supply-burn','dead-address-transfer'].includes(item.kind)){rejected++;reasons.push('burn_kind_mismatch');continue;}
    if(item.kind==='native-supply-burn'){
      if(to!==ZERO||receipt.blockNumber===0n){rejected++;reasons.push('burn_kind_mismatch');continue;}
      try{const [before,after]=await Promise.all([reader.totalSupply(c.mochiAddress as Address,receipt.blockNumber-1n),reader.totalSupply(c.mochiAddress as Address,receipt.blockNumber)]);if(before<=after||before-after<amount+(supplyByBlock.get(receipt.blockNumber)??0n))throw new Error();}catch{rejected++;reasons.push('burn_supply_change_unverified');continue;}native+=amount;
    }else{if(!c.deadAddress||to!==lower(c.deadAddress)){rejected++;reasons.push('dead_address_transfer_mismatch');continue;}dead+=amount;}
    const available=purchases.filter(p=>p.blockNumber<receipt.blockNumber||(p.blockNumber===receipt.blockNumber&&p.logIndex<item.logIndex)).reduce((n,p)=>n+p.amount,0n);
    if(native+dead>available){native-=item.kind==='native-supply-burn'?amount:0n;dead-=item.kind==='dead-address-transfer'?amount:0n;rejected++;reasons.push('burn_exceeds_attributed_purchased_inventory');continue;}
    if(item.kind==='native-supply-burn')supplyByBlock.set(receipt.blockNumber,(supplyByBlock.get(receipt.blockNumber)??0n)+amount);
    records.push({kind:item.kind,transactionHash:tx,logIndex:item.logIndex,blockNumber:receipt.blockNumber.toString(),amountAtomic:atomic(amount)});
  }
  const purchased=purchases.reduce((n,p)=>n+p.amount,0n);
  return {status:'verified' as const,native,dead,remaining:purchased-native-dead,rejected,reasons,records};
}

export async function createPublicRevenueReport(c:RevenueReportConfig,s:RevenueReportStore,reader:RevenueReportReader,burnEvidence?:readonly BurnEvidence[]):Promise<RevenueReportResult>{
  validateConfig(c);let chain:number;try{chain=await reader.chainId();}catch{throw new Error('report chain read failed');}if(chain!==c.chainId)throw new Error('report chain mismatch');
  const cursors=s.listIngestionCursors().filter(x=>x.streamId===c.settlementStreamId);const cursor=cursors.length===1?cursors[0]:undefined;
  const data=summarize(c,s,cursor);let anchor:{number:bigint;hash:string};try{anchor=await reader.finalizedBlock();}catch{throw new Error('finalized report checkpoint unavailable');}
  const checkpoint=anchor.number;const blockHash=anchor.hash;if(checkpoint<0n||!validHash(blockHash))throw new Error('finalized report checkpoint unavailable');
  if(cursor){if(cursor.lastBlock>checkpoint)data.reasons.push('ingestion_checkpoint_after_finalized_anchor');try{const canonical=await reader.blockHash(cursor.lastBlock);if(lower(canonical)!==lower(cursor.lastBlockHash))data.reasons.push('ingestion_checkpoint_noncanonical');}catch{data.reasons.push('ingestion_checkpoint_unavailable');}}
  const buybackRecords=s.listBuybacks();const purchases=await verifyPurchases(c,buybackRecords,reader,checkpoint);data.reasons.push(...purchases.reasons);
  const burn=await verifyBurns(c,burnEvidence,purchases.verified,reader,checkpoint);data.reasons.push(...burn.reasons);
  if(lower(await reader.blockHash(checkpoint))!==lower(blockHash))data.reasons.push('finalized_anchor_changed');
  const ready=data.ready&&data.reasons.every(reason=>reason==='manual_burn_evidence_not_configured');
  const integrityRejected=data.rejected+burn.rejected+purchases.rejected>0;
  const amount=(n:bigint)=>ready&&!integrityRejected?atomic(n):null;
  return {schema:'mochi-public-revenue-report-v1',status:data.reasons.length||data.rejected||burn.rejected?'incomplete':'complete',
    asOf:{generatedAt:new Date().toISOString(),chainId:chain,blockNumber:checkpoint.toString(),blockHash:lower(blockHash),confirmations:c.minimumConfirmations},
    assets:{reviewRevenue:{address:lower(c.usdgAddress),decimals:c.usdgDecimals},purchasedToken:{address:lower(c.mochiAddress),decimals:c.mochiDecimals}},treasury:{address:lower(c.reviewTreasuryAddress)},
    accounting:{source:'verified-post-panel-review-protocol-remainder',checkpointBlock:cursor?.lastBlock.toString()??null,purchaseEvidence:ready&&purchases.rejected===0?'receipt-verified':'ledger-reported-unverified',settlementEventCount:ready&&!integrityRejected?data.events.length:null,
      allocatedReviewRevenueAtomic:amount(data.allocatedTotal),unallocatedReviewRevenueAtomic:amount(data.total-data.allocatedTotal),totalVerifiedSettledReviewRevenueAtomic:amount(data.total),
      reservedOrInFlightReviewFundsAtomic:amount(data.reserved),purchasedReviewFundsAtomic:amount(data.purchasedUsd),remainingAttributedReviewRevenueAtomic:amount(data.remaining),
      buybackCount:ready&&!integrityRejected?{reservedOrInFlight:data.inflightCount,purchased:data.purchasedCount}:null,
      purchases:ready&&!integrityRejected?purchases.verified.map(p=>({transactionHash:p.transactionHash,blockNumber:p.blockNumber.toString(),amountInAtomic:atomic(p.amountIn),receivedTokenAtomic:atomic(p.amount)})):null,
      settlements:ready&&!integrityRejected?data.events.map(e=>({transactionHash:lower(e.transactionHash),logIndex:e.logIndex,blockNumber:e.blockNumber.toString(),blockHash:lower(e.blockHash),amountAtomic:atomic(e.amount)})):null,operatingPolicy:ready&&!integrityRejected?data.policy:null},
    purchasedToken:{purchaseRecipient:lower(c.purchaseRecipientAddress),purchasedAtomic:ready&&!integrityRejected?atomic(purchases.amount):null,ledgerReportedPurchasedAtomic:amount(data.purchasedMochi),manualBurnEvidence:{status:burn.status,
      nativeSupplyBurnAtomic:ready&&!integrityRejected&&burn.status==='verified'?atomic(burn.native):null,deadAddressTransferAtomic:ready&&!integrityRejected&&burn.status==='verified'?atomic(burn.dead):null,
      awaitingManualBurnAtomic:ready&&!integrityRejected&&burn.remaining!==null?atomic(burn.remaining):null,records:ready&&!integrityRejected?burn.records:null}},
    integrity:{rejectedRecordCount:data.rejected+burn.rejected+purchases.rejected,incompleteReasons:[...new Set(data.reasons)]}};
}
