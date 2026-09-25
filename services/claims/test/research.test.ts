import { describe, expect, test } from 'bun:test';
import { createBraveSearch, createResearcher } from '../src/research.ts';

describe('claim research bundle', () => {
  test('deduplicates canonical URLs and identical content, bounds text, and hashes deterministically', async () => {
    const researcher = createResearcher({ now: () => new Date('2026-01-01T00:00:00.000Z'),
      fetchSource: async url => ({ url, title:'Article', text: url.includes('a.test') ? 'same content' : 'x'.repeat(18_500) }),
      search: async () => ['https://a.test/#fragment','https://b.test/'] });
    const first = await researcher({ claim:'A factual claim', sourceUrls:['https://a.test/'] });
    const second = await researcher({ claim:'A factual claim', sourceUrls:['https://a.test/'] });
    expect(first.id).toBe(second.id); expect(first.sources).toHaveLength(2);
    expect(first.sources[1]!.text).toContain('[Source text truncated at 18,000 characters.]');
    expect(first.warnings).toContain('A source was truncated at 18,000 characters.');
    expect(first.sources.every(s => s.contentHash.length === 64)).toBe(true);
  });
  test('allows abstention with gaps and rejects invalid input bounds', async () => {
    const result = await createResearcher({ search: async () => { throw new Error('private detail'); }, now: () => new Date(0) })({ claim:'A claim' });
    expect(result.sources).toHaveLength(0); expect(result.warnings).toContain('Web search was unavailable.');
    expect(result.warnings).toContain('No sources were retrieved; evidence is missing and the review must abstain.');
    const submitted = await createResearcher({ fetchSource: async url => ({url,title:'Submitted',text:'evidence'}) })({ claim:'Claim', sourceUrls:['https://example.test/doc'] });
    expect(submitted.warnings).toContain('External discovery was not configured; research used only submitted URLs.');
    const empty = await createResearcher({})({ claim:'Claim', sourceUrls:['http://localhost'] });
    expect(empty.warnings).toContain('A submitted source URL was invalid or blocked.');
    expect(empty.warnings).toContain('No sources were retrieved; evidence is missing and the review must abstain.');
    await expect(createResearcher()({ claim:'' })).rejects.toThrow();
    await expect(createResearcher()({ claim:'x'.repeat(4001) })).rejects.toThrow();
    await expect(createResearcher()({ claim:'x', sourceUrls:Array.from({length:6},()=> 'https://example.com') })).rejects.toThrow();
  });
  test('Brave adapter fixes official host, bounds results and never leaks key outside header', async () => {
    const calls: Array<{url:URL; init:RequestInit}> = [];
    const search = createBraveSearch('test-key-never-log', { fetcher: (async (input, init) => {
      calls.push({ url:new URL(input.toString()), init:init ?? {} });
      return new Response(JSON.stringify({web:{results:Array.from({length:9},(_,i)=>({url:`https://s${i}.test/`}))}}), {status:200});
    }) as typeof fetch });
    expect(await search('claim')).toHaveLength(6);
    expect(calls[0]!.url.origin).toBe('https://api.search.brave.com');
    expect(calls[0]!.url.pathname).toBe('/res/v1/web/search');
    expect(calls[0]!.init.headers).toMatchObject({'X-Subscription-Token':'test-key-never-log'});
  });
  test('aggregate source text stays within 64,000 UTF-8 bytes without splitting Unicode', async () => {
    const researcher = createResearcher({ search:async () => Array.from({length:6},(_,i)=>`https://s${i}.test/`),
      fetchSource:async url => ({url,title:'T',text:`${url.at(-7)}${'é'.repeat(17_999)}`}) });
    const bundle = await researcher({claim:'Unicode budget'});
    expect(bundle.sources).toHaveLength(6);
    expect(bundle.sources.every(s => s.text.length <= 18_000 && !s.text.includes('\uFFFD'))).toBe(true);
    expect(bundle.sources.reduce((n,s) => n + Buffer.byteLength(s.text,'utf8'),0)).toBeLessThanOrEqual(64_000);
    expect(bundle.warnings).toContain('Evidence text was truncated to the 64,000-byte bundle limit.');
  });
  test('Brave rejects oversized streamed JSON instead of buffering it unbounded', async () => {
    const search = createBraveSearch('test-key', {fetcher:(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); controller.close(); },
    }), {status:200,headers:{'content-type':'application/json'}})) as unknown as typeof fetch});
    await expect(search('claim')).rejects.toThrow('size limit');
  });
});
