import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { createPublicClient, createWalletClient, custom, http, defineChain, encodeFunctionData, parseAbi, toHex, fromHex, keccak256, zeroHash, formatUnits } from 'viem';
import { canonicalJson, canonicalBytes, docHash, docCommit } from '@mochi/core';
import { aad, AttestationDocSchema, IntakeResultSchema, PrivateResultPlainSchema, payerCommit } from '@mochi/protocol';
import { SCHEMAS, resolveSchema, normalizeParams, paramsHash } from '@mochi/schemas';
import { seal, open } from '../../../packages/tee/src/envelope.ts';
import { keyBinding } from '../../../packages/tee/src/provider.ts';
import { DcapQuoteVerifier } from '../../../packages/tee/src/verifier.ts';
import { recoverProvenance } from '../../../packages/tee/src/signing.ts';
import { receiptLeaf, verifyMerkleProof } from '../../../packages/receipts/src/anchor.ts';
import { QueryEscrowAbi, JurorRegistryAbi, MochiVerdictsAbi, ReceiptAnchorAbi } from '../../../packages/chain/src/abis.ts';

const erc20 = parseAbi(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)']);
const encoder = new TextEncoder();
const hex32 = /^0x[0-9a-f]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const rand = size => toHex(crypto.getRandomValues(new Uint8Array(size)));
const base64 = bytes => { let text=''; for(const byte of bytes) text+=String.fromCharCode(byte); return btoa(text); };
const unbase64 = text => Uint8Array.from(atob(text), c=>c.charCodeAt(0));
export const json = value => JSON.stringify(value, (_key,v)=>typeof v==='bigint'?v.toString():v, 2);

export function validateConfig(config) {
  if (!config || ![4663,46630,31337].includes(config.chainId)) throw new Error('A supported deployment is required.');
  for (const key of ['queryEscrow','jurorRegistry','verdicts','usdg','receiptAnchor']) {
    if (!address.test(config.contracts?.[key]) || /^0x0{40}$/i.test(config.contracts[key])) throw new Error(`Missing deployment contract: ${key}`);
  }
  if (!hex32.test(config.intakeMeasurement) || same(config.intakeMeasurement,zeroHash)) throw new Error('An approved intake measurement is required.');
  if (!address.test(config.intakeAddress)) throw new Error('An approved intake address is required.');
  if (!Array.isArray(config.jurySizes) || !config.jurySizes.length || config.jurySizes.some(n=>![3,5,7,9].includes(n))) throw new Error('Supported jury sizes are required.');
  if (typeof config.rpcUrl !== 'string' || !config.rpcUrl.startsWith('/rpc')) throw new Error('Use the same-origin read-only RPC endpoint.');
  return config;
}

export class LiveClient {
  constructor(config, {fetcher=fetch, publicClient, verifier}={}) {
    // Called as a plain function: browsers throw "Illegal invocation" when window.fetch runs with this=LiveClient.
    this.config=validateConfig(config); this.fetcher=(input,init)=>fetcher(input,init);
    const rpcUrl = new URL(config.rpcUrl, globalThis.location?.origin ?? 'http://localhost').href;
    this.chain=defineChain({id:config.chainId,name:`Mochi ${config.chainId===4663?'mainnet':'test network'}`,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});
    this.public=publicClient ?? createPublicClient({chain:this.chain,transport:http(rpcUrl)});
    this.verifier=verifier ?? new DcapQuoteVerifier({collateral:{get:(fmspc,ca)=>this.request(`/api/v1/attestation/collateral/${fmspc}/${ca}`)}});
  }
  async request(path, body, signal) {
    const response=await this.fetcher(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:json(body),signal:signal ?? AbortSignal.timeout(30000),cache:'no-store'});
    if(!response.ok) throw new Error(`Service request failed (${response.status}). Please retry or check service availability.`);
    return response.json();
  }
  read(contract,abi,functionName,args=[]) { return this.public.readContract({address:this.config.contracts[contract],abi,functionName,args}); }
  async checkNetwork() { if(await this.public.getChainId()!==this.config.chainId) throw new Error('RPC network does not match this deployment.'); }
  async connect(provider=globalThis.ethereum) {
    if(!provider) throw new Error('Open this page with an Ethereum wallet installed.');
    const accounts=await provider.request({method:'eth_requestAccounts'});
    const chainId=Number(await provider.request({method:'eth_chainId'}));
    if(chainId!==this.config.chainId) throw new Error(`Switch your wallet to chain ${this.config.chainId}, then connect again.`);
    if(!address.test(accounts[0])) throw new Error('Wallet returned an invalid account.');
    this.provider=provider; this.account=accounts[0].toLowerCase();
    this.wallet=createWalletClient({account:this.account,chain:this.chain,transport:custom(provider)});
    return this.account;
  }
  async assertWallet(account) {
    if(!this.provider) throw new Error('Connect your wallet first.');
    const [accounts,chain]=await Promise.all([this.provider.request({method:'eth_accounts'}),this.provider.request({method:'eth_chainId'})]);
    if(!same(accounts[0],account)||Number(chain)!==this.config.chainId) throw new Error('Wallet account or network changed. Reconnect and prepare a new quote.');
  }
  async prepare({bytes,contentType='text/plain',schema,n,isPublic,params={}}) {
    if(!this.account) throw new Error('Connect your wallet first.');
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>100000) throw new Error('Use a document between 1 byte and 100 KB.');
    if(!this.config.jurySizes.includes(n)) throw new Error('This jury size is not available on this deployment.');
    await this.checkNetwork(); await this.assertWallet(this.account);
    if(await this.read('queryEscrow',QueryEscrowAbi,'paused')) throw new Error('New reviews are paused. No document was uploaded.');
    const doc=AttestationDocSchema.parse(await this.request('/api/v1/intake/attestation'));
    if(doc.role!=='INTAKE'||!same(doc.address,this.config.intakeAddress)||!same(doc.measurement,this.config.intakeMeasurement)) throw new Error('Intake identity does not match the approved deployment.');
    const verified=await this.verifier.verify(doc.quote,{measurement:this.config.intakeMeasurement,reportData:keyBinding(doc.address,doc.encryptionPubKey),maxAgeSec:600});
    if(!verified.ok) throw new Error('Intake attestation failed. No document was uploaded.');
    if(!await this.read('jurorRegistry',JurorRegistryAbi,'isActive',[doc.address,2])) throw new Error('Intake is not currently active on chain.');
    const schemaId=Object.values(SCHEMAS).find(s=>s.name===schema)?.id;
    if(!schemaId) throw new Error("Unknown schema.");
    const normalized=normalizeParams(resolveSchema(schemaId,params),params); if(!normalized.ok) throw new Error('Invalid schema parameters.');
    const salt=isPublic?zeroHash:rand(32), pair=isPublic?null:x25519.keygen();
    const plain={v:1,schemaId,salt,params,contentType,docB64:base64(bytes)};
    const envelope=seal(doc.encryptionPubKey,encoder.encode(canonicalJson(plain)),aad.intake());
    const intake=IntakeResultSchema.parse(await this.request(`/api/v1/intake/upload?n=${n}`,{envelope}));
    const commitment=docCommit(salt,docHash(bytes));
    if(!same(intake.docCommit,commitment)||!same(intake.provenance.docCommit,commitment)||intake.schemaId!==schemaId||!same(intake.paramsHash,paramsHash(normalized.params))||!same(intake.intake,doc.address)||intake.tokensK!==intake.provenance.tokensK) throw new Error('Intake response does not match the submitted document.');
    const provenance={...intake.provenance,fetchedAt:BigInt(intake.provenance.fetchedAt)};
    if(!same(await recoverProvenance(this.config.chainId,this.config.contracts.queryEscrow,provenance,intake.intakeSig),doc.address)) throw new Error('Invalid intake signature.');
    const nonce=BigInt(rand(8)), pub=pair?toHex(pair.publicKey):undefined;
    const openParams={schemaId,n,isPublic,allowPanelDisclosure:false,paramsHash:intake.paramsHash,payerCommit:pub?payerCommit(pub):zeroHash,refundTo:this.account,nonce};
    const queryId=await this.read('queryEscrow',QueryEscrowAbi,'computeQueryId',[this.account,commitment,nonce]);
    const [jurorFees,protocolFee]=await this.read('queryEscrow',QueryEscrowAbi,'quote',[schemaId,n,intake.tokensK]);
    const decimals=Number(await this.read('usdg',erc20,'decimals')); if(decimals!==6) throw new Error('Unexpected USDG token decimals.');
    // The gateway stores only the result public key. Never trust its payment calldata or price.
    const relay=await this.request('/api/v1/query',{intake,n,isPublic,allowPanelDisclosure:false,refundTo:this.account,nonce:String(nonce),sender:this.account,...(pub?{payerResultPubKey:pub}:{}),pay:{path:'usdg'}});
    if(!same(relay.queryId,queryId)) throw new Error('Gateway query ID mismatch.');
    const data=encodeFunctionData({abi:QueryEscrowAbi,functionName:'openWithUSDG',args:[openParams,provenance,intake.intakeSig]});
    return {queryId,account:this.account,chainId:this.config.chainId,escrow:this.config.contracts.queryEscrow,data,schema,n,isPublic,tokensK:intake.tokensK,schemaId,amount:jurorFees+protocolFee,displayAmount:formatUnits(jurorFees+protocolFee,6),createdAt:Date.now(),secrets:{salt,...(pair?{resultPrivateKey:toHex(pair.secretKey)}:{})}};
  }
  async submit(prepared,onProgress=()=>{}) {
    if(prepared.chainId!==this.config.chainId||!same(prepared.escrow,this.config.contracts.queryEscrow)) throw new Error('Quote belongs to another deployment.');
    await this.checkNetwork(); await this.assertWallet(prepared.account);
    if(Date.now()-prepared.createdAt>5*60*1000) throw new Error('Quote expired. Prepare a new quote.');
    const [fees,protocol]=await this.read('queryEscrow',QueryEscrowAbi,'quote',[prepared.schemaId,prepared.n,prepared.tokensK]);
    if(fees+protocol!==prepared.amount) throw new Error('Price changed. Prepare a new quote before paying.');
    const send=async(to,data)=>{
      await this.assertWallet(prepared.account);
      const hash=await this.wallet.sendTransaction({account:prepared.account,to,data,chain:this.chain});
      onProgress('Transaction submitted',hash);
      const receipt=await this.public.waitForTransactionReceipt({hash,timeout:120000});
      if(receipt.status!=='success') throw new Error('Transaction reverted.'); return hash;
    };
    const allowance=await this.read('usdg',erc20,'allowance',[prepared.account,prepared.escrow]);
    if(allowance!==prepared.amount) {
      if(allowance>0n) { onProgress('Reset USDG allowance in your wallet'); await send(this.config.contracts.usdg,encodeFunctionData({abi:erc20,functionName:'approve',args:[prepared.escrow,0n]})); }
      onProgress(`Approve exactly ${prepared.displayAmount} USDG in your wallet`);
      await send(this.config.contracts.usdg,encodeFunctionData({abi:erc20,functionName:'approve',args:[prepared.escrow,prepared.amount]}));
    }
    await this.assertWallet(prepared.account);
    await this.public.call({account:prepared.account,to:prepared.escrow,data:prepared.data});
    onProgress('Confirm the review payment in your wallet');
    return send(prepared.escrow,prepared.data);
  }
  async poll(queryId,{signal,onProgress=()=>{},timeoutMs=180000}={}) {
    if(!hex32.test(queryId)) throw new Error('Invalid query ID.');
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      signal?.throwIfAborted();
      const q=await this.read('queryEscrow',QueryEscrowAbi,'getQuery',[queryId]);
      onProgress(['Unknown','Opened','Jury selected','Decided','HUNG','Escalated','Expired'][Number(q.status)]??'Pending');
      if(Number(q.status)===6) throw new Error('Query expired. Check escrow refunds.');
      const id=await this.read('verdicts',MochiVerdictsAbi,'latestVerdictOf',[queryId]);
      if(!same(id,zeroHash)) {
        const response=await this.fetcher(`/api/v1/verdict/${id}`,{signal:signal??AbortSignal.timeout(30000),cache:'no-store'});
        if(response.ok) return {verdictId:id,queryId,packet:await response.json()};
        if(response.status!==404) throw new Error('Verdict retrieval failed. Retry from the saved query ID.');
      }
      await new Promise((resolve,reject)=>{ const stop=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));}; const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},1500);signal?.addEventListener('abort',stop,{once:true}); });
    }
    throw new Error('Still awaiting a verdict. Resume using the saved query ID; do not pay again.');
  }
  async verifyResult(item,secrets) {
    const chain=await this.read('verdicts',MochiVerdictsAbi,'getVerdict',[item.verdictId]);
    if(!same(chain.queryId,item.queryId)) throw new Error('Verdict belongs to another query.');
    let answerJson, fields;
    if(!chain.isPublic) {
      if(!secrets?.resultPrivateKey) return {...item,chain,locked:true};
      const envelope=JSON.parse(new TextDecoder().decode(fromHex(item.packet.ciphertext,'bytes')));
      const result=PrivateResultPlainSchema.parse(JSON.parse(new TextDecoder().decode(open(fromHex(secrets.resultPrivateKey,'bytes'),envelope,aad.result(item.verdictId)))));
      if(!same(result.verdictId,item.verdictId)||!same(result.salt,secrets.salt)) throw new Error('Private result binding mismatch.');
      answerJson=result.answerJson; fields=result.fields;
    } else { answerJson=typeof item.packet.answer==='string'?item.packet.answer:canonicalJson(item.packet.answer); }
    if(!same(keccak256(toHex(answerJson)),chain.answerHash)) throw new Error('Answer does not match the on-chain commitment.');
    // Values are taken only from the hash-verified answer, not the unauthenticated display fields.
    return {...item,chain,answer:JSON.parse(answerJson),fields,verified:true};
  }
  async receipt(verdictId) {
    const item=await this.request(`/indexer/v1/receipts/${verdictId}`), r=item.receipt;
    const key=this.config.receiptPublicKey;
    if(!key||!hex32.test(key)||!r||r.v!==1||r.kind!=='verdict'||!same(r.id,verdictId)||r.chain_id!==this.config.chainId||!same(r.contract,this.config.contracts.verdicts)) throw new Error('Receipt identity or pinned signing key is missing.');
    if(!ed25519.verify(unbase64(item.signature),canonicalBytes(r),fromHex(key,'bytes'))) throw new Error('Invalid receipt signature.');
    const chain=await this.read('verdicts',MochiVerdictsAbi,'getVerdict',[verdictId]);
    if(!same(r.answer_hash,chain.answerHash)||!same(r.query_id,chain.queryId)) throw new Error('Receipt does not match the on-chain verdict.');
    let anchored=false;
    if(item.anchor) {
      if(!verifyMerkleProof(receiptLeaf(r),item.anchor.proof,item.anchor.root)) throw new Error('Invalid receipt anchor proof.');
      anchored=await this.read('receiptAnchor',ReceiptAnchorAbi,'isAnchored',[item.anchor.root]);
    }
    return {item,signatureVerified:true,anchored};
  }
}

export function formatValue(value) {
  if(value===null)return 'Unresolved';
  if(typeof value!=='object')return String(value);
  if(value.t==='num') {
    const n=BigInt(value.e8), a=n<0n?-n:n;
    const fraction=String(a%100000000n).padStart(8,'0').replace(/0+$/,'');
    return `${n<0n?'-':''}${a/100000000n}${fraction?'.'+fraction:''}`;
  }
  if(value.t==='bool')return value.v?'Yes':'No';
  return String(value.v??json(value));
}
