import {test,expect} from 'bun:test';
import {LiveClient,validateConfig,formatValue} from '../site/src/live-client.js';
import {MockTeeProvider,MockQuoteVerifier,signProvenance,seal,open} from '@mochi/tee';
import {privateKeyToAccount} from 'viem/accounts';
import {toHex,fromHex,keccak256,zeroHash} from 'viem';
import {docHash,docCommit,canonicalJson} from '@mochi/core';
import {aad} from '@mochi/protocol';
const h=(c:string)=>`0x${c.repeat(64)}` as `0x${string}`;
const a=(c:string)=>`0x${c.repeat(40)}` as `0x${string}`;
const root=privateKeyToAccount(h('1'));
const tee=new MockTeeProvider({seed:h('2'),measurement:h('3'),mockRoot:root});
const config={chainId:31337,contracts:{queryEscrow:a('1'),jurorRegistry:a('2'),verdicts:a('3'),usdg:a('4'),receiptAnchor:a('5')},intakeAddress:tee.signer().address.toLowerCase(),intakeMeasurement:h('3'),jurySizes:[3,5],rpcUrl:'/rpc'};
async function setup(tamper='') {
 const sent:any[]=[];let plain:any;let amount=20000n;
 const publicClient:any={getChainId:async()=>31337,readContract:async({functionName}:any)=>{
   if(functionName==='paused')return false;if(functionName==='isActive')return true;
   if(functionName==='computeQueryId')return h('8');if(functionName==='quote')return [amount,1000n];if(functionName==='decimals')return 6;
   if(functionName==='allowance')return 999999n;
 }};
 const client=new LiveClient(config,{publicClient,verifier:new MockQuoteVerifier({mockRootAddress:root.address}),fetcher:async(path:any,init:any)=>{
   sent.push({path,body:init.body});
   if(path.endsWith('/attestation'))return Response.json({role:'INTAKE',address:config.intakeAddress,encryptionPubKey:tee.encryptionPublicKey(),measurement:h('3'),quote:await tee.quote()});
   if(path.includes('/upload')){
     const envelope=JSON.parse(init.body).envelope;plain=JSON.parse(new TextDecoder().decode(tee.decryptEnvelope(envelope,aad.intake())));
     const bytes=Uint8Array.from(atob(plain.docB64),(c:string)=>c.charCodeAt(0));
     const commit=tamper==='document'?h('9'):docCommit(plain.salt,docHash(bytes));
     const prov={docCommit:commit,kind:0,originId:zeroHash,fetchedAt:BigInt(Math.floor(Date.now()/1000)),tokensK:1,transcriptHash:zeroHash};
     const sig=await signProvenance(tee.signer(),31337,config.contracts.queryEscrow as any,prov as any);
     return Response.json({provenance:{...prov,fetchedAt:String(prov.fetchedAt)},docCommit:commit,paramsHash:zeroHash,intake:config.intakeAddress,intakeSig:tamper==='signature'?`0x${'00'.repeat(65)}`:sig,schemaId:plain.schemaId,tokensK:1});
   }
   return Response.json({queryId:h('8'),to:a('9'),data:'0xdeadbeef',quote:{jurorFees:'1',protocolFee:'0'}});
 }});
 client.account=a('6');client.provider={request:async({method}:any)=>method==='eth_chainId'?'0x7a69':[a('6')]};
 return {client,sent,plain:()=>plain,changePrice:()=>amount=40000n};
}
const input={bytes:new TextEncoder().encode('Private source document'),schema:'SPLIT',n:3,isPublic:false};
test('encrypted browser request is bound to source; payment uses local calldata and on-chain quote',async()=>{
 const {client,sent,plain}=await setup();const result=await client.prepare(input);
 expect(result.displayAmount).toBe('0.021');expect(result.data).not.toBe('0xdeadbeef');expect(result.escrow).toBe(config.contracts.queryEscrow);
 expect(plain().salt).not.toBe(zeroHash);expect(result.secrets.resultPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
 expect(JSON.stringify(sent)).not.toContain('Private source document');expect(JSON.stringify(sent)).not.toContain(result.secrets.resultPrivateKey);
});
test('forged document or provenance signatures fail before query preparation',async()=>{
 for(const kind of ['document','signature']){const {client,sent}=await setup(kind);await expect(client.prepare(input)).rejects.toThrow();expect(sent.some(x=>x.path==='/api/v1/query')).toBe(false)}
});
test('failed attestation blocks all uploads',async()=>{
 const {client,sent}=await setup();client.verifier={verify:async()=>({ok:false})};await expect(client.prepare(input)).rejects.toThrow('attestation failed');expect(sent.length).toBe(1);
});
test('wallet/network changes and price changes fail before any payment',async()=>{
 const {client,changePrice}=await setup();const prepared=await client.prepare(input);changePrice();await expect(client.submit(prepared)).rejects.toThrow('Price changed');
 client.provider={request:async({method}:any)=>method==='eth_chainId'?'0x1':[a('6')]};await expect(client.submit(prepared)).rejects.toThrow('network changed');
});
test('excess allowance is reset and bounded; reverted approval prevents query submission',async()=>{
 const {client}=await setup();const p=await client.prepare(input);const txs:any[]=[];
 client.wallet={sendTransaction:async(tx:any)=>{txs.push(tx);return h('7')}};
 client.public.waitForTransactionReceipt=async()=>({status:'reverted'});
 await expect(client.submit(p)).rejects.toThrow('reverted');expect(txs.length).toBe(1);expect(txs[0].to).toBe(config.contracts.usdg);
 expect(txs[0].data.endsWith('0'.repeat(64))).toBe(true);
});
test('private answers decrypt only locally and must match the direct chain commitment',async()=>{
 const {client}=await setup();const p=await client.prepare(input);
 const {x25519}=await import('@noble/curves/ed25519.js');
 const answer=canonicalJson({fields:{ratio:2},salt:p.secrets.salt});
 const v={v:1,verdictId:h('a'),salt:p.secrets.salt,answerJson:answer,payload:'0x',fields:[]};
 const env=seal(toHex(x25519.getPublicKey(fromHex(p.secrets.resultPrivateKey,'bytes'))),new TextEncoder().encode(JSON.stringify(v)),aad.result(h('a')));
 const item={queryId:h('8'),verdictId:h('a'),packet:{ciphertext:toHex(new TextEncoder().encode(JSON.stringify(env))),chain:{answerHash:h('f')}}};
 client.public.readContract=async()=>({queryId:h('8'),isPublic:false,answerHash:keccak256(toHex(answer))});
 expect((await client.verifyResult(item,p.secrets)).verified).toBe(true);
 client.public.readContract=async()=>({queryId:h('8'),isPublic:false,answerHash:h('f')});await expect(client.verifyResult(item,p.secrets)).rejects.toThrow('on-chain commitment');
});
test('deployment rejects missing identity and unavailable jury sizes',async()=>{
 expect(()=>validateConfig({...config,intakeMeasurement:zeroHash})).toThrow();const {client}=await setup();await expect(client.prepare({...input,n:9})).rejects.toThrow('not available');
});

test('renders protocol fixed-point values without floating point loss',()=>{
 expect(formatValue({t:'num',e8:'211000000'})).toBe('2.11');
 expect(formatValue({t:'num',e8:'-1'})).toBe('-0.00000001');
 expect(formatValue({t:'num',e8:'900719925474099300000000'})).toBe('9007199254740993');
});

test('the default fetch is never invoked with the client as this (browsers throw Illegal invocation)',async()=>{
 const original=globalThis.fetch;const seen:unknown[]=[];
 globalThis.fetch=(function(this:unknown){seen.push(this);if(this!==undefined&&this!==globalThis)throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");return Promise.resolve(Response.json({ok:true}));}) as any;
 try{
  const client=new LiveClient(config,{publicClient:{} as any,verifier:new MockQuoteVerifier({mockRootAddress:root.address})});
  expect(await client.request('/api/v1/intake/attestation')).toEqual({ok:true});
  expect(await (client as any).fetcher('/api/v1/verdict/x',{})).toBeInstanceOf(Response);
  expect(seen.every(value=>value===undefined||value===globalThis)).toBe(true);
 }finally{globalThis.fetch=original;}
});
