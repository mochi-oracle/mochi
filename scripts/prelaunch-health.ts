/** Read-only probe suitable for an existing monitor. No credentials or inference requests. */
export async function checkPrelaunchHealth(origin: string, fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Supply a public HTTPS origin');
  const checks = await Promise.all(['/health','/api/claims/config','/api/tokenomics/report'].map(async path => {
    try {
      const response = await fetcher(new URL(path,base), {redirect:'error',signal:AbortSignal.timeout(10_000),headers:{accept:'application/json'}});
      if (!response.ok) return {path,ok:false};
      const reader=response.body?.getReader();if(!reader)return {path,ok:false};let bytes=0;const chunks:Uint8Array[]=[];
      for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.length;if(bytes>2*1024*1024){await reader.cancel();return {path,ok:false};}chunks.push(x.value);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ok=path==='/health'?body.ok===true:path==='/api/claims/config'?body.enabled===true&&body.mode==='research-preview'&&body.requiresAccessToken===true&&body.price?.amountUsd==='0.00':['awaiting_token','ready'].includes(body.status);
      return {path,ok};
    }catch{return {path,ok:false};}
  }));
  return {ok:checks.every(x=>x.ok),checks};
}
if(import.meta.main){try{if(process.argv.length!==3)throw new Error();const result=await checkPrelaunchHealth(process.argv[2]!);console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;}catch{console.error('Health probe requires a public HTTPS origin; no endpoint details logged.');process.exitCode=2;}}
