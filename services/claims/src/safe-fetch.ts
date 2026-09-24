import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

export interface FetchedSource { url: string; title: string; text: string; publishedAt?: string }
export interface SafeFetchOptions {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}
const MAX_BYTES = 512 * 1024;
const BLOCKED = 'Source could not be safely retrieved.';

function ipv4Number(s: string): number[] | null {
  const p = s.split('.');
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.map(Number);
}
function ipv6Bytes(input: string): number[] | null {
  let s = input.toLowerCase().split('%')[0]!;
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':'); const v4 = ipv4Number(s.slice(idx + 1));
    if (!v4) return null;
    s = `${s.slice(0, idx)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const parse = (h: string) => h ? h.split(':').map(x => /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN) : [];
  const left = parse(halves[0]!); const right = parse(halves[1] ?? '');
  if ([...left, ...right].some(Number.isNaN)) return null;
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || (halves.length === 2 && zeros < 1)) return null;
  return [...left, ...Array(zeros).fill(0), ...right].flatMap(n => [n >> 8, n & 255]);
}
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4) {
    const [a,b,c] = v4;
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  const b = ipv6Bytes(address); if (!b) return false;
  const allZero = b.every(x => x === 0);
  const mapped = b.slice(0,10).every(x => x === 0) && b[10] === 255 && b[11] === 255;
  if (mapped) return isPublicAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  // Only globally routable unicast 2000::/3 is accepted. Exclude special-use blocks therein.
  if ((b[0]! & 0xe0) !== 0x20 || allZero) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2]! <= 1) || (b[2] === 0x0d && b[3] === 0xb8))) return false;
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4
  return true;
}
function canonical(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error(BLOCKED);
  u.hash = '';
  return u;
}
function textFromHtml(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '').replace(/<[^>]*>/g, '')).trim().slice(0, 500);
  const cleaned = html.replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/article|\/section|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ');
  return { title: title || 'Untitled source', text: decode(cleaned).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}
function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, v: string) => {
    if (v[0] === '#') { const n = v[1]?.toLowerCase() === 'x' ? parseInt(v.slice(2), 16) : parseInt(v.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : ' '; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string,string>)[v.toLowerCase()] ?? ' ';
  });
}
export async function safeFetchSource(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedSource> {
  const resolve = options.resolve ?? (async h => (await dnsLookup(h, { all: true, verbatim: true })).map(x => ({ address: x.address, family: x.family })));
  const req = options.request ?? httpsRequest;
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const maxRedirects = Math.min(options.maxRedirects ?? 3, 3);
  let current = canonical(rawUrl);
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  let activeRequest: ReturnType<typeof httpsRequest> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadlineFailure = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const deadlineTimer = setTimeout(() => {
    activeRequest?.destroy(new Error('Source request timed out.'));
    rejectDeadline(new Error('Source request timed out.'));
  }, Math.max(1, deadline - Date.now()));
  const run = async (): Promise<FetchedSource> => {
  for (let redirects = 0; ; redirects++) {
    if (current.hostname === 'localhost' || current.hostname.endsWith('.localhost') || current.hostname.endsWith('.local')) throw new Error(BLOCKED);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Source request timed out.');
    const answers = await Promise.race([resolve(current.hostname), deadlineFailure]);
    if (!answers.length || answers.some(x => !isPublicAddress(x.address))) throw new Error(BLOCKED);
    const pinned = answers[0]!;
    const response = await new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolveResponse, reject) => {
      const request = req({ protocol: 'https:', hostname: current.hostname, port: 443, path: `${current.pathname}${current.search}`,
        method: 'GET', headers: { 'user-agent': 'MochiResearch/1.0', accept: 'text/html, text/plain;q=0.9', 'accept-encoding': 'identity' },
        lookup: (_hostname: string, lookupOptions: { all?: boolean }, cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
          if (lookupOptions?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        servername: current.hostname, rejectUnauthorized: true, timeout: remaining,
      } as never, res => {
        const chunks: Buffer[] = []; let size = 0; let settled = false;
        const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { fail(new Error('Source body exceeds size limit.')); request.destroy(); } else chunks.push(chunk); });
        res.on('end', () => { if (!settled) { settled = true; resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }); } });
        res.on('aborted', () => fail(new Error('Source response was interrupted.')));
        res.on('error', fail);
        res.on('close', () => { if (!settled && !(res as IncomingMessage).complete) fail(new Error('Source response closed early.')); });
      });
      activeRequest = request;
      request.on('timeout', () => request.destroy(new Error('Source request timed out.')));
      request.on('error', reject); request.end();
    });
    activeRequest = undefined;
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirects >= maxRedirects) throw new Error(BLOCKED);
      current = canonical(new URL(location, current).toString()); continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(BLOCKED);
    const type = (response.headers['content-type'] ?? '').toString().split(';')[0]!.trim().toLowerCase();
    if (type !== 'text/html' && type !== 'text/plain') throw new Error(BLOCKED);
    const encoding = (response.headers['content-encoding'] ?? 'identity').toString().toLowerCase();
    if (encoding && encoding !== 'identity') throw new Error(BLOCKED);
    let title = current.hostname; let text = response.body.toString('utf8');
    if (type === 'text/html') ({ title, text } = textFromHtml(text));
    if (!text.trim()) throw new Error(BLOCKED);
    const outUrl = current.toString();
    return { url: outUrl, title, text };
  }
  };
  try { return await Promise.race([run(), deadlineFailure]); }
  finally { clearTimeout(deadlineTimer); activeRequest?.destroy(); }
}
