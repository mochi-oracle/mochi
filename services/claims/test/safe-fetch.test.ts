import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { isPublicAddress, safeFetchSource, type SafeFetchOptions } from '../src/safe-fetch.ts';

function transport(responses: Array<{ status: number; headers: Record<string,string>; body: string }>, seen: unknown[] = []): SafeFetchOptions['request'] {
  return ((opts: unknown, callback: (res: unknown) => void) => {
    seen.push(opts); const req = new EventEmitter() as EventEmitter & { end(): void; destroy(e?: Error): void };
    req.end = () => { const item = responses.shift()!; const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string,string> };
      res.statusCode = item.status; res.headers = item.headers; callback(res); queueMicrotask(() => { res.emit('data', Buffer.from(item.body)); res.emit('end'); }); };
    req.destroy = (e?: Error) => { if (e) req.emit('error', e); };
    return req as never;
  }) as unknown as SafeFetchOptions['request'];
}
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

describe('safe source retrieval', () => {
  test('blocks loopback, private, metadata, mapped IPv6, and mixed DNS answers', async () => {
    for (const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) expect(isPublicAddress(ip)).toBe(false);
    const seen: unknown[] = [];
    await expect(safeFetchSource('https://example.com', { resolve: async () => [{ address:'93.184.216.34',family:4 },{ address:'192.168.0.1',family:4 }], request: transport([], seen) })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test('pins the validated address and extracts readable HTML without scripts and styles', async () => {
    const seen: Array<Record<string,unknown>> = [];
    const result = await safeFetchSource('https://example.com/story', { resolve: publicDns, request: transport([{ status:200, headers:{'content-type':'text/html'}, body:'<html><title>Example &amp; News</title><style>bad css</style><script>secret()</script><h1>Hello</h1><p>World &amp; friends</p></html>' }], seen) });
    expect(result.title).toBe('Example & News'); expect(result.text).toContain('Hello'); expect(result.text).toContain('World & friends');
    expect(result.text).not.toContain('secret'); expect(result.text).not.toContain('bad css');
    const opts = seen[0]!; expect(opts.lookup).toBeFunction();
    let pinned = ''; (opts.lookup as Function)('example.com', {}, (_e: unknown, a: string) => { pinned = a; }); expect(pinned).toBe('93.184.216.34');
    let allPinned: unknown; (opts.lookup as Function)('example.com', { all:true }, (_e: unknown, a: unknown) => { allPinned = a; });
    expect(allPinned).toEqual([{address:'93.184.216.34',family:4}]);
  });

  test('revalidates HTTPS redirects and rejects private destinations and oversized bodies', async () => {
    const responses = [{status:302,headers:{location:'https://private.test/path'},body:''}];
    await expect(safeFetchSource('https://example.com', { resolve: async h => h === 'private.test' ? [{address:'10.0.0.1',family:4}] : await publicDns(), request: transport(responses) })).rejects.toThrow();
    await expect(safeFetchSource('https://example.com', { resolve: publicDns, maxBytes:5, request: transport([{status:200,headers:{'content-type':'text/plain'},body:'far too large'}]) })).rejects.toThrow();
    await expect(safeFetchSource('https://user:pass@example.com', { resolve:publicDns, request:transport([]) })).rejects.toThrow();
  });

  test('absolute deadline bounds a hung DNS lookup and a slow-drip response', async () => {
    await expect(safeFetchSource('https://example.com', { timeoutMs:15, resolve:() => new Promise(() => {}) })).rejects.toThrow('timed out');
    const fakeRequest = ((_: unknown, callback: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & {end():void; destroy(e?:Error):void};
      let drip: ReturnType<typeof setInterval>;
      req.end = () => { const res = new EventEmitter() as EventEmitter & {statusCode:number;headers:Record<string,string>;complete:boolean};
        res.statusCode=200; res.headers={'content-type':'text/plain'}; res.complete=false; callback(res);
        drip=setInterval(() => res.emit('data', Buffer.from('x')), 5); };
      req.destroy = (e?:Error) => { clearInterval(drip!); if (e) req.emit('error',e); };
      return req as never;
    }) as unknown as SafeFetchOptions['request'];
    await expect(safeFetchSource('https://example.com', { timeoutMs:35, resolve:publicDns, request:fakeRequest })).rejects.toThrow('timed out');
  });
});
