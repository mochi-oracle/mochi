import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import { isPublicAddress, safeFetchSource, textFromHtml, type SafeFetchOptions } from '../src/safe-fetch.ts';

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

// The previous regex extractor, kept only as the reference for ordinary-sized input.
function regexReference(html: string): { title: string; text: string } {
  const decode = (v: string) => v.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, x: string) => {
    if (x[0] === '#') { const n = x[1]?.toLowerCase() === 'x' ? parseInt(x.slice(2), 16) : parseInt(x.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : ' '; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[x.toLowerCase()] ?? ' ';
  });
  const title = decode((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '').replace(/<[^>]*>/g, '')).trim().slice(0, 500);
  const cleaned = html.replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/article|\/section|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ');
  return { title: title || 'Untitled source', text: decode(cleaned).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** Fastest of a few runs, so a GC pause or JIT compile is not measured. */
function fastest(run: () => unknown, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) { const started = performance.now(); run(); best = Math.min(best, performance.now() - started); }
  return best;
}

describe('HTML text extraction', () => {
  test('pathological pages finish quickly instead of freezing the event loop', () => {
    const attacks = [
      '<'.repeat(512 * 1024), '<title>'.repeat(80_000), '<!--'.repeat(130_000), '<script>'.repeat(65_000), '<SCRIPT x'.repeat(58_000),
      // nosemgrep: html-in-template-string -- hostile HTML fixtures for the extractor under test
      '<br'.repeat(170_000), '</title '.repeat(65_000), `<title>${' '.repeat(500_000)}`, `<style>${'</style'.repeat(70_000)}`, '&#x'.repeat(170_000) + '1'.repeat(10_000),
      `${'<svg'.repeat(130_000)}>`, `${'<script'.repeat(70_000)}>`,
    ];
    for (const page of attacks) {
      textFromHtml(page); // the first call also pays for compilation
      expect(fastest(() => textFromHtml(page))).toBeLessThan(250);
    }
  });

  test('doubling a hostile page at most triples the extraction time (linear, not quadratic)', () => {
    const shapes: Array<(n: number) => string> = [n => '<'.repeat(n), n => `${'<svg'.repeat(n / 4)}>`, n => `${'<script'.repeat(n / 7)}>`, n => '<style>'.repeat(n / 7),
      n => `<p${' '.repeat(n)}`, n => '<!--'.repeat(n / 4), n => '&#1'.repeat(n / 3)];
    for (const make of shapes) {
      const small = make(256 * 1024), large = make(512 * 1024);
      textFromHtml(small); textFromHtml(large);
      const a = fastest(() => textFromHtml(small)), b = fastest(() => textFromHtml(large));
      expect(b).toBeLessThanOrEqual(3 * a + 5);
    }
  });

  test('caps the extracted text at 128 KiB, after stripping', () => {
    // nosemgrep: html-in-template-string -- HTML fixture for the extractor under test
    const page = `<p>${'a'.repeat(200 * 1024)}</p><p>tail-marker</p>`;
    const { text } = textFromHtml(page);
    expect(text).not.toContain('tail-marker');
    expect(text.length).toBeLessThanOrEqual(128 * 1024);
  });

  test('a long style or script before the body is stripped, not truncated into the evidence', () => {
    const css = '.a{color:red}\n'.repeat(Math.ceil(130 * 1024 / 14));
    const js = 'var x = 1;\n'.repeat(Math.ceil(200 * 1024 / 11));
    // nosemgrep: html-in-template-string -- HTML fixture for the extractor under test
    const page = `<html><head><title>Real title</title><style>${css}</style><script>${js}</script></head><body><p>The CEO resigned on 3 March.</p></body></html>`;
    expect(page.length).toBeGreaterThan(256 * 1024);
    const { title, text } = textFromHtml(page);
    expect(title).toBe('Real title');
    expect(text).toContain('The CEO resigned on 3 March.');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('var x');
  });

  test('capping never splits a surrogate pair', () => {
    const { text } = textFromHtml(`${'a'.repeat(128 * 1024 - 1)}\ud83d\ude00tail`);
    expect(text.length).toBe(128 * 1024 - 1);
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    const { title } = textFromHtml(`<title>${'b'.repeat(499)}\ud83d\ude00</title>`);
    expect(title).toBe('b'.repeat(499));
  });

  test('normal HTML output is unchanged from the previous extractor', () => {
    const pages = [
      '<html><head><title>Example &amp; News</title><style>bad css</style><script>secret()</script></head><body><h1>Hello</h1><p>World &amp; friends</p></body></html>',
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><TITLE data-x="1">Report <b>2026</b> &#8212; Q3</TITLE></head><body><!-- nav --><nav><ul><li>Home</li><li>About</li></ul></nav>'
        + '<article><h2>Revenue rose</h2><p>Revenue rose 12%<br/>year over year.</p><table><tr><td>Q3</td><td>$4.1B</td></tr><tr><td>Q2</td><td>$3.7B</td></tr></table></article>'
        + '<svg viewBox="0 0 1 1"><text>chart</text></svg><noscript>enable js</noscript><template><p>hidden</p></template><SCRIPT type="module">x()</SCRIPT ><section><p>&quot;Quoted&quot; &apos;text&apos;&nbsp;here &#x41;&#66;</p></section></body></html>',
      'plain text without tags',
      '<p>Unclosed <script>tail text',
      '<div>a</div><div>b</div>\n\n\n\n<div>c</div><title>late</title>',
    ];
    for (const page of pages) expect(textFromHtml(page)).toEqual(regexReference(page));
  });

  test('matches the previous extractor on generated markup', () => {
    const token = fc.constantFrom('<', '>', '</', '<!--', '-->', '<title>', '</title >', '<TITLE x>', '<script>', '</script>', '</SCRIPT\t>', '<style a="b">', '</style>',
      '<svg>', '</svg>', '<noscript>', '</noscript>', '<template>', '</template>', '<br>', '<BR/>', '</p>', '</div>', '</li>', '</h3>', '</article>', '</section>', '</tr>', '<p>', '<scripts>',
      '&amp;', '&lt;', '&#65;', '&#x42;', '&nbsp;', '&bogus;', ' ', '\n', '\t', '\r', 'word', 'Ünï', '\u2028', '\u00a0');
    fc.assert(fc.property(fc.array(token, { maxLength: 40 }), parts => {
      const page = parts.join('');
      expect(textFromHtml(page)).toEqual(regexReference(page));
    }), { numRuns: 2000 });
  });
});
