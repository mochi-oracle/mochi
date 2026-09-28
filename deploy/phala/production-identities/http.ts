/** Public, cached attestation endpoint. No caller input reaches the KMS or quote provider. */
export function createIdentityEndpoint(create: () => Promise<{read(): Promise<unknown>}>, now = Date.now) {
  let reader: Promise<{read(): Promise<unknown>}> | undefined;
  let pending: Promise<Response> | undefined;
  let cached: {body: string; status: number; until: number} | undefined;
  const response = () => new Response(cached!.body, {status:cached!.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  return async (request: Request) => {
    if (request.method !== 'GET') return new Response(null,{status:405,headers:{Allow:'GET'}});
    if (cached && cached.until > now()) return response();
    if (pending) return (await pending).clone();
    pending = (async () => {
      try {
        reader ??= create();
        const value = await (await reader).read();
        cached = {body:JSON.stringify(value),status:200,until:now()+60_000};
      } catch {
        reader = undefined;
        cached = {body:JSON.stringify({ready:false,error:'Production identity verification unavailable.'}),status:503,until:now()+10_000};
      }
      return response();
    })();
    try { return (await pending).clone(); } finally { pending = undefined; }
  };
}
