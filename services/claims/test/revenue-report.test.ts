import { describe, expect, test } from 'bun:test';
import { keccak256, toHex } from 'viem';
import { createPublicRevenueReport, type RevenueReportConfig, type RevenueReportReader, type RevenueReportStore } from '../src/revenue-report.ts';
import type { ConfirmedReviewRevenueRecord, ReviewIngestionCursor } from '../src/buyback-sqlite-store.ts';
import type { PersistedBuyback } from '../src/buybacks.ts';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const config:RevenueReportConfig={chainId:31337,rpcUrl:'https://rpc.example/path?key=hidden',settlementStreamId:'stream',reviewEscrowAddress:a(1),usdgAddress:a(2),usdgDecimals:6,mochiAddress:a(3),mochiDecimals:18,reviewTreasuryAddress:a(4),purchaseRecipientAddress:a(5),deadAddress:a(6),minimumConfirmations:2};
const cursor:ReviewIngestionCursor={streamId:'stream',configJson:JSON.stringify({chainId:'31337',escrow:a(1),usdg:a(2),recipient:a(4),startBlock:'1',chunkSize:100,finality:'finalized'}),startBlock:1n,nextBlock:11n,lastBlock:10n,lastBlockHash:h(10),finalizedBlock:10n,updatedAt:'2026-09-28T00:00:00.000Z'};
function event(overrides:Partial<ConfirmedReviewRevenueRecord>={}):ConfirmedReviewRevenueRecord{return {eventId:'event-1',chainId:31337n,escrow:a(1),usdg:a(2),recipient:a(4),blockNumber:5n,blockHash:h(5),transactionHash:h(50),logIndex:2,queryId:h(90),amount:100n,payPath:'USDG',queryStatus:'DECIDED',receiptStatus:'success',transferFrom:a(1),transferTo:a(4),transferAmount:100n,verification:'confirmed',createdAt:'private',...overrides};}
const transfer=keccak256(toHex('Transfer(address,address,uint256)')).toLowerCase();
function topic(address:string){return `0x${address.slice(2).padStart(64,'0')}`;}
const purchaseLogs=[{address:a(2),topics:[transfer,topic(a(4)),topic(a(7))],data:`0x${100n.toString(16).padStart(64,'0')}`,logIndex:0},{address:a(3),topics:[transfer,topic(a(7)),topic(a(5))],data:`0x${50n.toString(16).padStart(64,'0')}`,logIndex:1}];
function store(rows:ConfirmedReviewRevenueRecord[]=[],cursors:ReviewIngestionCursor[]=[cursor]):RevenueReportStore{return {listConfirmedReviewRevenue:()=>rows,listAllocations:()=>[],listBuybacks:()=>[],listIngestionCursors:()=>cursors};}
const purchasedRecord:PersistedBuyback={settledBatchId:'batch',grossReviewRevenue:100n,requestFingerprint:'private',status:'purchased',transactionRef:h(60),receivedTokenAmount:50n,execution:{chainId:31337n,routerAddress:a(7),treasuryAddress:a(4),senderAddress:a(4),recipient:a(5),inputToken:a(2),outputToken:a(3),amountIn:100n,minAmountOut:50n,deadlineMs:1}};
function attributedStore():RevenueReportStore{return {...store([event()]),listAllocations:()=>[{batchId:'batch',amount:100n,eventIds:['event-1']}],listBuybacks:()=>[purchasedRecord]};}
function reader(overrides:Partial<RevenueReportReader>={}):RevenueReportReader{return {chainId:async()=>31337,finalizedBlock:async()=>({number:20n,hash:h(20)}),blockNumber:async()=>20n,blockHash:async(n)=>h(Number(n)),receipt:async(hash)=>({status:'success',transactionHash:hash,from:a(4),to:a(7),blockNumber:15n,blockHash:h(15),logs:[]}),totalSupply:async()=>1000n,...overrides};}

describe('public revenue report',()=>{
  test('reports only confirmed post-panel USDG settlements and redacts private/source fields',async()=>{
    const report=await createPublicRevenueReport(config,store([event()]),reader());
    expect(report.accounting.totalVerifiedSettledReviewRevenueAtomic).toBe('100');
    expect(report.accounting.source).toBe('verified-post-panel-review-protocol-remainder');
    expect(JSON.stringify(report)).not.toContain('queryId');expect(JSON.stringify(report)).not.toContain(h(90));expect(JSON.stringify(report)).not.toContain('private');
    expect(JSON.stringify(report)).not.toContain('hidden');expect(JSON.stringify(report)).not.toContain('rpc.example');
  });
  test('does not publish zero totals without a configured ingestion cursor',async()=>{
    const report=await createPublicRevenueReport(config,store([event()],[]),reader());
    expect(report.status).toBe('incomplete');expect(report.accounting.totalVerifiedSettledReviewRevenueAtomic).toBeNull();
    expect(report.accounting.settlements).toBeNull();
  });
  test('rejects altered or replayed events and wrong eligibility metadata',async()=>{
    const report=await createPublicRevenueReport(config,store([event(),event({eventId:'altered',amount:101n}),event({eventId:'feed',logIndex:4,payPath:'FEED'})]),reader());
    expect(report.status).toBe('incomplete');expect(report.integrity.rejectedRecordCount).toBe(2);
    expect(report.accounting.totalVerifiedSettledReviewRevenueAtomic).toBeNull();
  });
  test('rejects userinfo RPC configuration before exposing it',async()=>{
    await expect(createPublicRevenueReport({...config,rpcUrl:'https://user:pass@rpc.invalid'},store(),reader())).rejects.toThrow('invalid report configuration');
  });
  test('requires confirmed canonical receipt, configured token and purchase recipient for manual burns',async()=>{
    const log={address:a(3),topics:[transfer,topic(a(5)),topic('0x0000000000000000000000000000000000000000')],data:`0x${10n.toString(16).padStart(64,'0')}`,logIndex:0};
    const badReader=reader({receipt:async(hash)=>({status:'reverted',transactionHash:hash,from:a(4),to:a(7),blockNumber:15n,blockHash:h(15),logs:[log]})});
    const report=await createPublicRevenueReport(config,store([event()]),badReader,[{transactionHash:h(70),logIndex:0,kind:'native-supply-burn'}]);
    expect(report.purchasedToken.manualBurnEvidence.nativeSupplyBurnAtomic).toBeNull();
    expect(report.integrity.incompleteReasons).toContain('burn_receipt_unconfirmed');
  });
  test('separates verified supply burns from dead-address transfers',async()=>{
    const log={address:a(3),topics:[transfer,topic(a(5)),topic('0x0000000000000000000000000000000000000000')],data:`0x${30n.toString(16).padStart(64,'0')}`,logIndex:0};
    const r=reader({receipt:async(hash)=>({status:'success',transactionHash:hash,from:a(4),to:a(7),blockNumber:hash===h(60)?15n:16n,blockHash:hash===h(60)?h(15):h(16),logs:hash===h(60)?purchaseLogs:[log]}),totalSupply:async(_token,n)=>n===15n?1000n:970n});
    const report=await createPublicRevenueReport(config,attributedStore(),r,[{transactionHash:h(70),logIndex:0,kind:'native-supply-burn'}]);
    expect(report.purchasedToken.purchasedAtomic).toBe('50');expect(report.purchasedToken.manualBurnEvidence.nativeSupplyBurnAtomic).toBe('30');
    expect(report.purchasedToken.manualBurnEvidence.deadAddressTransferAtomic).toBe('0');expect(report.purchasedToken.manualBurnEvidence.awaitingManualBurnAtomic).toBe('20');
  });
  test('rejects a transfer emitted by the wrong token even when the event topic matches',async()=>{
    const log={address:a(99),topics:[transfer,topic(a(5)),topic('0x0000000000000000000000000000000000000000')],data:`0x${10n.toString(16).padStart(64,'0')}`,logIndex:0};
    const report=await createPublicRevenueReport(config,attributedStore(),reader({receipt:async(hash)=>({status:'success',transactionHash:hash,from:a(4),to:a(7),blockNumber:hash===h(60)?15n:16n,blockHash:hash===h(60)?h(15):h(16),logs:hash===h(60)?purchaseLogs:[log]})}),[{transactionHash:h(70),logIndex:0,kind:'native-supply-burn'}]);
    expect(report.integrity.incompleteReasons).toContain('burn_wrong_token_or_event');expect(report.purchasedToken.manualBurnEvidence.nativeSupplyBurnAtomic).toBeNull();
  });
});

const burnLog=(amount:bigint,index=0,to=a(6))=>({address:a(3),topics:[transfer,topic(a(5)),topic(to)],data:`0x${amount.toString(16).padStart(64,'0')}`,logIndex:index});
function evidenceReader(native=false):RevenueReportReader {
  return reader({receipt:async(hash)=>{
    const block=hash===h(60)?15n:hash===h(70)?16n:17n;
    return {status:'success',transactionHash:hash,from:a(4),to:a(7),blockNumber:block,blockHash:h(Number(block)),
      logs:hash===h(60)?purchaseLogs:[burnLog(hash===h(70)?30n:20n,0,native?a(0):a(6))]};
  },totalSupply:async(_token,n)=>n<16n?100n:n===16n?70n:50n});
}
test('multiple burns in reverse input order consume inventory once and remain reproducible',async()=>{
  const burns=[{transactionHash:h(71),logIndex:0,kind:'dead-address-transfer' as const},{transactionHash:h(70),logIndex:0,kind:'dead-address-transfer' as const}];
  const report=await createPublicRevenueReport(config,attributedStore(),evidenceReader(),burns);
  expect(report.status).toBe('complete');
  expect(report.accounting.purchaseEvidence).toBe('receipt-verified');
  expect(report.purchasedToken.manualBurnEvidence.deadAddressTransferAtomic).toBe('50');
  expect(report.purchasedToken.manualBurnEvidence.awaitingManualBurnAtomic).toBe('0');
  expect(report.purchasedToken.manualBurnEvidence.records?.map(r=>r.transactionHash)).toEqual([h(70),h(71)]);
});
test('burns predating a purchase and replayed burn evidence cannot use future inventory',async()=>{
  const base=evidenceReader();
  const early=reader({...base,receipt:async(hash)=>{const r=await base.receipt(hash);return hash===h(60)?r:{...r,blockNumber:14n,blockHash:h(14)};}});
  const burn={transactionHash:h(70),logIndex:0,kind:'dead-address-transfer' as const};
  const report=await createPublicRevenueReport(config,attributedStore(),early,[burn]);
  expect(report.integrity.incompleteReasons).toContain('burn_exceeds_attributed_purchased_inventory');
  expect(report.purchasedToken.purchasedAtomic).toBeNull();
  const replay=await createPublicRevenueReport(config,attributedStore(),base,[burn,burn]);
  expect(replay.integrity.incompleteReasons).toContain('replayed_burn_evidence');
  expect(replay.purchasedToken.manualBurnEvidence.deadAddressTransferAtomic).toBeNull();
});
test('a purchase transaction cannot be attributed to two batches',async()=>{
  const s=attributedStore();
  s.listConfirmedReviewRevenue=()=>[event(),event({eventId:'event-2',transactionHash:h(51)})];
  s.listAllocations=()=>[{batchId:'batch',amount:100n,eventIds:['event-1']},{batchId:'batch-2',amount:100n,eventIds:['event-2']}];
  s.listBuybacks=()=>[purchasedRecord,{...purchasedRecord,settledBatchId:'batch-2'}];
  const report=await createPublicRevenueReport(config,s,evidenceReader(),[]);
  expect(report.integrity.incompleteReasons).toContain('replayed_purchase_receipt');
  expect(report.purchasedToken.purchasedAtomic).toBeNull();
});
test('reports external shielded and Anonyma settlements but nulls totals beyond the checkpoint',async()=>{
  for(const payPath of ['SHIELDED','ANONYMA'] as const){
    const report=await createPublicRevenueReport(config,store([event({payPath})]),reader(),[]);
    expect(report.status).toBe('complete');expect(report.accounting.totalVerifiedSettledReviewRevenueAtomic).toBe('100');
  }
  const beyond=await createPublicRevenueReport(config,store([event({blockNumber:11n})]),reader(),[]);
  expect(beyond.accounting.totalVerifiedSettledReviewRevenueAtomic).toBeNull();
  const behind=await createPublicRevenueReport(config,store([event()]),reader({finalizedBlock:async()=>({number:8n,hash:h(8)})}),[]);
  expect(behind.accounting.totalVerifiedSettledReviewRevenueAtomic).toBeNull();
});
test('receipt hash mismatch, changed finalized anchor, and net USDG refund fail verification',async()=>{
  const base=evidenceReader();
  const mismatch=await createPublicRevenueReport(config,attributedStore(),reader({...base,receipt:async(hash)=>({...await base.receipt(hash),transactionHash:h(99)})}),[]);
  expect(mismatch.purchasedToken.purchasedAtomic).toBeNull();
  const changed=await createPublicRevenueReport(config,store([event()]),reader({blockHash:async(n)=>n===20n?h(99):h(Number(n))}),[]);
  expect(changed.integrity.incompleteReasons).toContain('finalized_anchor_changed');
  expect(changed.accounting.totalVerifiedSettledReviewRevenueAtomic).toBeNull();
  const refund=await createPublicRevenueReport(config,attributedStore(),reader({...base,receipt:async(hash)=>{
    const r=await base.receipt(hash);return {...r,logs:[...r.logs,{address:a(2),topics:[transfer,topic(a(7)),topic(a(4))],data:`0x${1n.toString(16).padStart(64,'0')}`,logIndex:2}]};
  }}),[]);
  expect(refund.integrity.incompleteReasons).toContain('purchase_receipt_unverifiable');
  expect(refund.purchasedToken.purchasedAtomic).toBeNull();
});
test('native burns cannot reuse the same block supply decrease twice',async()=>{
  const base=evidenceReader();
  const r=reader({...base,receipt:async(hash)=>hash===h(60)?base.receipt(hash):({status:'success',transactionHash:hash,from:a(5),to:a(3),blockNumber:16n,blockHash:h(16),logs:[burnLog(20n,0,a(0)),burnLog(20n,1,a(0))]}),totalSupply:async(_token,n)=>n<16n?100n:70n});
  const report=await createPublicRevenueReport(config,attributedStore(),r,[{transactionHash:h(70),logIndex:0,kind:'native-supply-burn'},{transactionHash:h(70),logIndex:1,kind:'native-supply-burn'}]);
  expect(report.integrity.incompleteReasons).toContain('burn_supply_change_unverified');
  expect(report.purchasedToken.manualBurnEvidence.nativeSupplyBurnAtomic).toBeNull();
});
