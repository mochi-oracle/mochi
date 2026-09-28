import { expect, test } from 'bun:test';
import { createRevenueStatusReader, validatePublicRevenueReport } from '../../services/claims/src/public-revenue-status.ts';
import { createWebHandler } from '../server.ts';
const h='0x'+'1'.repeat(64),a='0x'+'1'.repeat(40);
function fixture(){return {schema:'mochi-public-revenue-report-v1',status:'complete',asOf:{generatedAt:new Date(1000).toISOString(),chainId:4663,blockNumber:'50',blockHash:h,confirmations:1},assets:{reviewRevenue:{address:a,decimals:6},purchasedToken:{address:a,decimals:18}},treasury:{address:a},accounting:{source:'verified-post-panel-review-protocol-remainder',checkpointBlock:'50',purchaseEvidence:'receipt-verified',settlementEventCount:0,allocatedReviewRevenueAtomic:'0',unallocatedReviewRevenueAtomic:'100',totalVerifiedSettledReviewRevenueAtomic:'100',reservedOrInFlightReviewFundsAtomic:'0',purchasedReviewFundsAtomic:'0',remainingAttributedReviewRevenueAtomic:'100',buybackCount:{reservedOrInFlight:0,purchased:0},purchases:[],settlements:[],operatingPolicy:null},purchasedToken:{purchaseRecipient:a,purchasedAtomic:'0',ledgerReportedPurchasedAtomic:'0',manualBurnEvidence:{status:'verified',nativeSupplyBurnAtomic:'0',deadAddressTransferAtomic:'0',awaitingManualBurnAtomic:'0',records:[]}},integrity:{rejectedRecordCount:0,incompleteReasons:[]}};}
test('report endpoint has an honest unset state and never caches balances',async()=>{
 const handler=createWebHandler({dist:'/nonexistent'});
 const response=await handler(new Request('http://localhost/api/tokenomics/report'));
 expect(await response.json()).toEqual({status:'awaiting_token'});expect(response.headers.get('cache-control')).toBe('no-store');
 expect(await createRevenueStatusReader({tokenConfigured:true})()).toEqual({status:'unavailable'});
 expect(await createRevenueStatusReader({reportPath:'/nonexistent'})()).toEqual({status:'unavailable'});
});
test('public projection strips private values and rejects stale, incomplete and inconsistent totals',()=>{
 const source={...fixture(),rpcUrl:'private-provider-value',secret:'not-for-browser'};
 const result=validatePublicRevenueReport(source,1000);
 expect(result.status).toBe('ready');expect(JSON.stringify(result)).not.toContain('private-provider-value');expect(JSON.stringify(result)).not.toContain('not-for-browser');
 expect(validatePublicRevenueReport(source,86_401_001).status).toBe('stale');
 expect(validatePublicRevenueReport({...source,status:'incomplete'},1000).status).toBe('unavailable');
 const wrong=fixture();wrong.accounting.remainingAttributedReviewRevenueAtomic='101';
 expect(validatePublicRevenueReport(wrong,1000).status).toBe('unavailable');
 const future=fixture();future.asOf.generatedAt=new Date(1000000).toISOString();expect(validatePublicRevenueReport(future,1000).status).toBe('unavailable');
});
test('upstream report uses a fixed path, strips unknown fields, and hides provider errors',async()=>{
 let destination='';
 const reader=createRevenueStatusReader({upstream:'https://service.example/private?credential=hidden',now:()=>1000,fetcher:async(url,init)=>{destination=String(url);expect(init?.redirect).toBe('error');expect(init?.headers).toEqual({accept:'application/json'});return Response.json({status:'ready',report:{...fixture(),providerSecret:'hidden'}});}});
 const result=await reader();expect(destination).toBe('https://service.example/api/tokenomics/report');expect(result.status).toBe('ready');expect(JSON.stringify(result)).not.toContain('hidden');
 const failure=await createRevenueStatusReader({upstream:'https://service.example',fetcher:async()=>{throw new Error('secret URL');}})();expect(failure).toEqual({status:'unavailable'});
});
