// Exercised by scripts/e2e.ts against real local contracts/services. Only enclave/model hardware is mocked.
import {LiveClient} from '../site/src/live-client.js';
import {toHex} from 'viem';
export async function browserFlow({dep,gw,indexer,publicClient,wallet,verifier,measurement,ok}) {
 const att=await (await fetch(`${gw}/v1/intake/attestation`)).json();
 const keys=await (await fetch(`${indexer}/.well-known/mochi-receipts.json`)).json();
 const key=toHex(Uint8Array.from(atob(keys.jwk.x.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));
 const client=new LiveClient({chainId:31337,contracts:dep.contracts,intakeAddress:att.address,intakeMeasurement:measurement,receiptPublicKey:key,jurySizes:[3,5],rpcUrl:'/rpc'},{publicClient,verifier,fetcher:(path,init)=>fetch(path.startsWith('/indexer')?indexer+path.slice(8):gw+path.slice(4),init)});
 client.account=wallet.account.address.toLowerCase();client.wallet=wallet;
 client.provider={request:async({method})=>method==='eth_chainId'?'0x7a69':[client.account]};
 for(const isPublic of [true,false]) {
   const prepared=await client.prepare({bytes:new TextEncoder().encode('Browser Co (NASDAQ: WEBX) today announced a 2-for-1 stock split, effective December 15, 2026.'),schema:'SPLIT',n:3,isPublic});
   await client.submit(prepared);
   const item=await client.poll(prepared.queryId);
   const result=await client.verifyResult(item,prepared.secrets);
   ok(result.verified&&JSON.stringify(result.answer).includes('WEBX'),`browser ${isPublic?'public':'private'} quote → bounded approval → payment → verified answer`);
   let receipt;
   for(let attempt=0;attempt<60;attempt++){try{receipt=await client.receipt(item.verdictId);break}catch{await new Promise(r=>setTimeout(r,1000))}}
   ok(receipt?.signatureVerified===true,`browser ${isPublic?'public':'private'} receipt verifies against pinned Ed25519 key`);
 }
}
