import { isCrossOriginPost } from '../../services/claims/src/origin.ts';

const gatewayGet = /^\/v1\/(?:intake\/attestation|stats|queries\/0x[0-9a-f]{64}|verdict\/0x[0-9a-f]{64}|feeds\/[^/]+\/[^/]+|disagreement(?:\/models)?)$/;
const gatewayPost = /^\/v1\/(?:intake\/upload|query)$/;
const indexerGet = /^\/v1\/receipts\/0x[0-9a-f]{64}$/;

/** Route only the existing public protocol surface; never expose attestor/admin/internal ports. */
export function createProductionProxy(options: {ready(): boolean; gatewayPort: number; indexerPort: number; fetcher?: typeof fetch}) {
  for (const port of [options.gatewayPort,options.indexerPort]) if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid internal protocol port');
  return async (request: Request): Promise<Response> => {
    const url=new URL(request.url), path=url.pathname;
    const gateway=request.method==='GET'&&gatewayGet.test(path)||request.method==='POST'&&gatewayPost.test(path);
    const indexer=request.method==='GET'&&indexerGet.test(path);
    const error=(status:number,message:string)=>Response.json({error:message},{status,headers:{'cache-control':'no-store'}});
    if (!gateway&&!indexer) return error(404,'Not found');
    if (!options.ready()) return error(503,'Production protocol is not active');
    if(isCrossOriginPost(request)) return error(403,'Cross-origin request refused');
    try {
      let body: Uint8Array | undefined;
      if(request.method==='POST') {
        const reader=request.body?.getReader(), chunks:Uint8Array[]=[];let length=0;
        if(reader) for(;;) {const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>1_048_576){await reader.cancel();return error(413,'Request too large')}chunks.push(value)}
        body=Buffer.concat(chunks);
      }
      const response=await (options.fetcher??fetch)(`http://127.0.0.1:${indexer?options.indexerPort:options.gatewayPort}${path}${url.search}`,{
        method:request.method,headers:{'content-type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(30_000),
      });
      if(!response.ok)return error(response.status>=400?response.status:502,'Protocol request failed');
      return new Response(response.body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    } catch {return error(502,'Protocol service unavailable')}
  };
}

/** Public possession proofs are bound by each juror to its configured operator and registry. */
export function createEnrollmentEndpoint(options: {ready():boolean;jurorPorts:readonly number[];fetcher?:typeof fetch}) {
  if(options.jurorPorts.length!==9||options.jurorPorts.some((p,i)=>p!==3100+i))throw new Error('Enrollment requires fixed juror ports');
  return async(request:Request)=>{
    const headers={'cache-control':'no-store'};
    if(request.method!=='GET')return new Response(null,{status:405,headers:{...headers,Allow:'GET'}});
    if(!options.ready())return Response.json({error:'Production enrollment is not prepared'},{status:503,headers});
    try {
      const proofs=await Promise.all(options.jurorPorts.map(async port=>{
        const response=await(options.fetcher??fetch)(`http://127.0.0.1:${port}/v1/enrollment`,{redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('Proof unavailable');
        return response.json();
      }));
      return Response.json({proofs},{headers});
    } catch {return Response.json({error:'Enrollment proofs unavailable'},{status:503,headers})}
  };
}
