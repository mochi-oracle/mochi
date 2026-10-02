import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { createPublicClient, createWalletClient, custom, http, defineChain, encodeFunctionData, parseAbi, toHex, fromHex, keccak256, zeroHash, formatUnits } from 'viem';
import { canonicalJson, canonicalBytes, docHash, docCommit } from '@mochi/core';
import { aad, AttestationDocSchema, IntakeResultSchema, PrivateResultPlainSchema, payerCommit, privateResultMismatch, provenanceFromJson, provenanceMatchesBinding } from '@mochi/protocol';
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
/** Intel TCB statuses a deployment may accept for the intake's quote ("Revoked" never). */
const TCB_STATUSES = ['UpToDate','SWHardeningNeeded','ConfigurationNeeded','ConfigurationAndSWHardeningNeeded','OutOfDate','OutOfDateConfigurationNeeded'];
const QUERY_STATUS = ['Unknown','Opened','Jury selected','Decided','HUNG','Escalated','Expired'];

/**
 * Chain reads while waiting for a verdict: the query and its latest verdict id together, as one batched /rpc request
 * (2 calls), every POLL_INTERVAL_MS. With receipts polled at the same interval, one paid check costs at most about 120
 * RPC calls and peaks at about 30 a minute; web/server.ts sizes its /rpc limits from these numbers.
 */
export const POLL_INTERVAL_MS = 4000;
const MAX_BACKOFF_MS = 30_000;

/** The website asked this browser to slow down (HTTP 429). `retryAfterMs` is its Retry-After, when it sent one. */
export class RateLimitedError extends Error {
  constructor(retryAfterMs) { super('The service asked to slow down.'); this.name='RateLimitedError'; this.retryAfterMs=retryAfterMs; }
}
const retryAfterMs = headers => { const seconds=Number(headers?.get?.('retry-after')); return Number.isFinite(seconds)&&seconds>0?seconds*1000:undefined; };
/** Throws a RateLimitedError for an HTTP 429 response, so a polling loop backs off instead of failing. */
export function rejectRateLimited(response) {
  if(response.status===429) throw new RateLimitedError(retryAfterMs(response.headers));
  return response;
}
/** For a rate-limit refusal (an HTTP 429, directly or wrapped by viem): the wait it asked for in ms (0 if none). Else undefined. */
export function rateLimitDelay(error) {
  for(let e=error,depth=0;e&&typeof e==='object'&&depth<8;e=e.cause,depth++) {
    if(e instanceof RateLimitedError) return e.retryAfterMs??0;
    if(e.status===429) return retryAfterMs(e.headers)??0;
  }
  return undefined;
}
export const slowDownMessage = seconds => `The service is busy; checking again in ${seconds} s.`;
function pause(ms,signal) {
  return new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
/**
 * Runs `round` every `interval` ms until it returns something other than undefined (resolving {done:true,value}) or
 * `deadline` (ms since the epoch) passes ({done:false}). A round refused for rate limiting (HTTP 429) is not an error:
 * the loop waits for the server's Retry-After, at least twice the previous wait (up to 30 s), tells onBackoff how many
 * seconds, and carries on. Any other error ends the loop.
 */
export async function pollUntil(round,{deadline,signal,onBackoff=()=>{},interval=POLL_INTERVAL_MS}={}) {
  let backoff=0;
  while(Date.now()<deadline) {
    signal?.throwIfAborted();
    let wait=interval;
    try {
      const value=await round();
      if(value!==undefined) return {done:true,value};
      backoff=0;
    } catch(error) {
      const asked=rateLimitDelay(error);
      if(asked===undefined) throw error;
      backoff=Math.min(MAX_BACKOFF_MS,Math.max(asked,backoff*2,interval*2));
      wait=backoff;
      onBackoff(Math.ceil(wait/1000));
    }
    await pause(Math.min(wait,Math.max(0,deadline-Date.now())),signal);
  }
  return {done:false};
}

export function validateConfig(config) {
  if (!config || ![4663,46630,31337].includes(config.chainId)) throw new Error('A supported deployment is required.');
  for (const key of ['queryEscrow','jurorRegistry','verdicts','usdg','receiptAnchor']) {
    if (!address.test(config.contracts?.[key]) || /^0x0{40}$/i.test(config.contracts[key])) throw new Error(`Missing deployment contract: ${key}`);
  }
  if (!hex32.test(config.intakeMeasurement) || same(config.intakeMeasurement,zeroHash)) throw new Error('An approved intake measurement is required.');
  if (!address.test(config.intakeAddress)) throw new Error('An approved intake address is required.');
  if (!Array.isArray(config.jurySizes) || !config.jurySizes.length || config.jurySizes.some(n=>![3,5,7,9].includes(n))) throw new Error('Supported jury sizes are required.');
  if (typeof config.rpcUrl !== 'string' || !config.rpcUrl.startsWith('/rpc')) throw new Error('Use the same-origin read-only RPC endpoint.');
  const tcb=config.tdxAllowedTcbStatuses;
  if (tcb!==undefined && (!Array.isArray(tcb) || !tcb.includes('UpToDate') || new Set(tcb).size!==tcb.length || tcb.some(s=>!TCB_STATUSES.includes(s)))) throw new Error('Unsupported Intel TCB policy in the deployment.');
  return config;
}

/** How far a submit() call got with the escrow payment transaction itself (approvals do not move escrow funds). */
export const PAYMENT_STAGE=Object.freeze({CHECKS:'checks',REQUESTED:'payment_requested',BROADCAST:'payment_broadcast'});
function withPaymentAttempt(error,attempt) {
  const target=error instanceof Error?error:new Error(String(error));
  try { Object.defineProperty(target,'paymentAttempt',{value:{...attempt},configurable:true}); } catch {}
  return target;
}
/** EIP-1193 4001 (or viem's wrapper for it): the user declined in the wallet, so that request was not signed or sent. */
export function isUserRejection(error) {
  for(let e=error,depth=0;e&&typeof e==='object'&&depth<8;e=e.cause,depth++) if(e.code===4001||e.name==='UserRejectedRequestError') return true;
  return false;
}
/**
 * True only when a failed submit() definitely sent no escrow payment: it failed before the payment transaction was
 * requested, or the wallet rejected that request. Anything else (unknown errors, a broadcast hash) may have paid.
 */
export function paymentNotSent(error) {
  const attempt=error?.paymentAttempt;
  if(attempt?.stage===PAYMENT_STAGE.CHECKS) return true;
  return attempt?.stage===PAYMENT_STAGE.REQUESTED&&isUserRejection(error);
}

export class LiveClient {
  constructor(config, {fetcher=fetch, publicClient, verifier}={}) {
    // Called as a plain function: browsers throw "Illegal invocation" when window.fetch runs with this=LiveClient.
    this.config=validateConfig(config); this.fetcher=(input,init)=>fetcher(input,init);
    const rpcUrl = new URL(config.rpcUrl, globalThis.location?.origin ?? 'http://localhost').href;
    this.chain=defineChain({id:config.chainId,name:`Mochi ${config.chainId===4663?'mainnet':'test network'}`,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});
    // Reads issued together go out as one JSON-RPC batch (the website accepts up to 20 calls per request); receipts are
    // polled every POLL_INTERVAL_MS. viem retries a 429 after its Retry-After.
    this.public=publicClient ?? createPublicClient({chain:this.chain,pollingInterval:POLL_INTERVAL_MS,transport:http(rpcUrl,{batch:{batchSize:20}})});
    // The intake's quote is checked under the deployment's published Intel TCB policy (default UpToDate only), the
    // same list the CVM's own checks use.
    this.verifier=verifier ?? new DcapQuoteVerifier({policy:{allowedStatuses:[...(this.config.tdxAllowedTcbStatuses??['UpToDate'])]},collateral:{get:(fmspc,ca)=>this.request(`/api/v1/attestation/collateral/${fmspc}/${ca}`)}});
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
    const nonce=BigInt(rand(8)), pub=pair?toHex(pair.publicKey):undefined;
    // Sealed with the document: the intake signs it into a grant only this wallet can open, once, with this result key.
    const open={opener:this.account,payerCommit:pub?payerCommit(pub):zeroHash,isPublic,allowPanelDisclosure:false,nonce:String(nonce)};
    const plain={v:1,schemaId,salt,params,contentType,docB64:base64(bytes),open};
    const envelope=seal(doc.encryptionPubKey,encoder.encode(canonicalJson(plain)),aad.intake());
    const intake=IntakeResultSchema.parse(await this.request(`/api/v1/intake/upload?n=${n}`,{envelope}));
    const commitment=docCommit(salt,docHash(bytes)), pHash=paramsHash(normalized.params);
    if(!same(intake.docCommit,commitment)||!same(intake.provenance.docCommit,commitment)||intake.schemaId!==schemaId||intake.provenance.schemaId!==schemaId||!same(intake.paramsHash,pHash)||!same(intake.provenance.paramsHash,pHash)||!same(intake.intake,doc.address)||intake.tokensK!==intake.provenance.tokensK) throw new Error('Intake response does not match the submitted document.');
    if(!provenanceMatchesBinding(intake.provenance,open)) throw new Error('Intake grant does not match this wallet or result key.');
    const provenance=provenanceFromJson(intake.provenance);
    if(!same(await recoverProvenance(this.config.chainId,this.config.contracts.queryEscrow,provenance,intake.intakeSig),doc.address)) throw new Error('Invalid intake signature.');
    const openParams={n,refundTo:this.account};
    const queryId=await this.read('queryEscrow',QueryEscrowAbi,'computeQueryId',[this.account,commitment,nonce]);
    const [jurorFees,protocolFee]=await this.read('queryEscrow',QueryEscrowAbi,'quote',[schemaId,n,intake.tokensK]);
    const decimals=Number(await this.read('usdg',erc20,'decimals')); if(decimals!==6) throw new Error('Unexpected USDG token decimals.');
    // The gateway stores only the result public key. Never trust its payment calldata or price.
    const relay=await this.request('/api/v1/query',{intake,n,refundTo:this.account,...(pub?{payerResultPubKey:pub}:{}),pay:{path:'usdg'}});
    if(!same(relay.queryId,queryId)) throw new Error('Gateway query ID mismatch.');
    const data=encodeFunctionData({abi:QueryEscrowAbi,functionName:'openWithUSDG',args:[openParams,provenance,intake.intakeSig]});
    return {queryId,account:this.account,chainId:this.config.chainId,escrow:this.config.contracts.queryEscrow,data,schema,n,isPublic,tokensK:intake.tokensK,schemaId,amount:jurorFees+protocolFee,displayAmount:formatUnits(jurorFees+protocolFee,6),createdAt:Date.now(),grantExpiry:Number(provenance.expiry),secrets:{salt,...(pair?{resultPrivateKey:toHex(pair.secretKey)}:{})}};
  }
  async submit(prepared,onProgress=()=>{}) {
    // Errors carry how far the escrow payment got (see paymentNotSent), so callers can tell a failure before
    // the payment transaction was requested from the wallet from one where it may have been broadcast.
    const attempt={stage:PAYMENT_STAGE.CHECKS};
    try {
      if(prepared.chainId!==this.config.chainId||!same(prepared.escrow,this.config.contracts.queryEscrow)) throw new Error('Quote belongs to another deployment.');
      await this.checkNetwork(); await this.assertWallet(prepared.account);
      if(Date.now()-prepared.createdAt>5*60*1000||(prepared.grantExpiry&&Date.now()/1000>prepared.grantExpiry-30)) throw new Error('Quote expired. Prepare a new quote.');
      const [fees,protocol]=await this.read('queryEscrow',QueryEscrowAbi,'quote',[prepared.schemaId,prepared.n,prepared.tokensK]);
      if(fees+protocol!==prepared.amount) throw new Error('Price changed. Prepare a new quote before paying.');
      const send=async(to,data,payment=false)=>{
        await this.assertWallet(prepared.account);
        if(payment) attempt.stage=PAYMENT_STAGE.REQUESTED;
        const hash=await this.wallet.sendTransaction({account:prepared.account,to,data,chain:this.chain});
        if(payment) Object.assign(attempt,{stage:PAYMENT_STAGE.BROADCAST,hash});
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
      return await send(prepared.escrow,prepared.data,true);
    } catch(error) { throw withPaymentAttempt(error,attempt); }
  }
  /** The query and its latest verdict id, read together (one batched /rpc request of two calls). */
  queryStatus(queryId) {
    return Promise.all([this.read('queryEscrow',QueryEscrowAbi,'getQuery',[queryId]),this.read('verdicts',MochiVerdictsAbi,'latestVerdictOf',[queryId])]);
  }
  async poll(queryId,{signal,onProgress=()=>{},timeoutMs=180000}={}) {
    if(!hex32.test(queryId)) throw new Error('Invalid query ID.');
    const outcome=await pollUntil(async()=>{
      const [q,id]=await this.queryStatus(queryId);
      onProgress(QUERY_STATUS[Number(q.status)]??'Pending');
      if(Number(q.status)===6) throw new Error('Query expired. Check escrow refunds.');
      if(!same(id,zeroHash)) {
        const response=rejectRateLimited(await this.fetcher(`/api/v1/verdict/${id}`,{signal:signal??AbortSignal.timeout(30000),cache:'no-store'}));
        if(response.ok) return {verdictId:id,queryId,packet:await response.json()};
        if(response.status!==404) throw new Error('Verdict retrieval failed. Retry from the saved query ID.');
      }
      return undefined;
    },{deadline:Date.now()+timeoutMs,signal,onBackoff:seconds=>onProgress(slowDownMessage(seconds))});
    if(outcome.done) return outcome.value;
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
      // A private verdict's payloadHash is salted with the query salt; check it as well as the answerHash.
      if(privateResultMismatch(result,chain)==='payloadHash') throw new Error('Payload does not match the on-chain commitment.');
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
