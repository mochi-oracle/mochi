import { createHash } from 'node:crypto';
import type { EvidenceBundle, EvidenceSource, ResearchInput, Researcher } from './types.ts';
import { safeFetchSource, type FetchedSource } from './safe-fetch.ts';

export interface ResearcherOptions {
  search?: (claim: string) => Promise<string[]>;
  fetchSource?: (url: string) => Promise<FetchedSource>;
  now?: () => Date;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_CLAIM = 4000, MAX_INPUT_SOURCES = 5, MAX_SOURCES = 6, MAX_SOURCE_TEXT = 18_000;
const MAX_SOURCE_BYTES = 512 * 1024, MAX_BUNDLE_TEXT_BYTES = 64_000;
const RETRIEVAL_TIMEOUT_MS = 8500;
function truncateUnicode(text: string, maxUnits: number): string {
  let result = '', units = 0;
  for (const point of text) {
    if (units + point.length > maxUnits) break;
    result += point; units += point.length;
  }
  return result;
}
function truncateUtf8(text: string, maxBytes: number): string {
  let result = '', bytes = 0;
  for (const point of text) {
    const n = Buffer.byteLength(point, 'utf8');
    if (bytes + n > maxBytes) break;
    result += point; bytes += n;
  }
  return result;
}
function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer!));
}
const canonicalUrl = (raw: string): string => {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Only public HTTPS sources are accepted.');
  u.hash = ''; return u.toString();
};

export function createResearcher(options: ResearcherOptions = {}): Researcher {
  const fetchSource = options.fetchSource ?? safeFetchSource;
  const now = options.now ?? (() => new Date());
  return async (input: ResearchInput): Promise<EvidenceBundle> => {
    if (!input || typeof input.claim !== 'string' || !input.claim.trim() || input.claim.length > MAX_CLAIM) throw new TypeError(`claim must contain 1 to ${MAX_CLAIM} characters.`);
    const claim = input.claim.trim();
    const submitted = input.sourceUrls ?? [];
    if (!Array.isArray(submitted) || submitted.length > MAX_INPUT_SOURCES || submitted.some(x => typeof x !== 'string' || !x.trim())) throw new TypeError(`sourceUrls must contain at most ${MAX_INPUT_SOURCES} URLs.`);
    const warnings: string[] = [];
    const candidates: string[] = [];
    for (const raw of submitted) {
      try { candidates.push(canonicalUrl(raw)); } catch { warnings.push('A submitted source URL was invalid or blocked.'); }
    }
    if (options.search) {
      try {
        const found = await bounded(options.search(claim), RETRIEVAL_TIMEOUT_MS, 'Search timed out.');
        for (const raw of found.slice(0, MAX_SOURCES)) {
          try { candidates.push(canonicalUrl(raw)); } catch { warnings.push('A search result URL was invalid or blocked.'); }
        }
      } catch { warnings.push('Web search was unavailable.'); }
    } else warnings.push('External discovery was not configured; research used only submitted URLs.');
    const urls = [...new Set(candidates)].slice(0, MAX_SOURCES);
    const asOf = now().toISOString();
    const sources: EvidenceSource[] = [];
    const seenContent = new Set<string>();
    const fetchedResults = await Promise.all(urls.map(url => bounded(fetchSource(url), RETRIEVAL_TIMEOUT_MS, 'Source retrieval timed out.')
      .then(fetched => ({ url, fetched }), () => ({ url, error: true as const }))));
    let remainingBytes = MAX_BUNDLE_TEXT_BYTES;
    let bundleTextTruncated = false;
    for (const result of fetchedResults) {
      if ('error' in result) { warnings.push('A source was inaccessible or blocked.'); continue; }
      try {
        const { url, fetched } = result;
        const normalizedUrl = canonicalUrl(fetched.url || url);
        const byteTruncated = Buffer.byteLength(fetched.text, 'utf8') > MAX_SOURCE_BYTES;
        const boundedText = byteTruncated ? truncateUtf8(fetched.text, MAX_SOURCE_BYTES) : fetched.text;
        const fullHash = hash(boundedText);
        if (sources.some(s => canonicalUrl(s.url) === normalizedUrl) || seenContent.has(fullHash)) continue;
        seenContent.add(fullHash);
        const truncated = boundedText.length > MAX_SOURCE_TEXT;
        let text = truncated ? `${truncateUnicode(boundedText, MAX_SOURCE_TEXT - 80).trimEnd()}\n\n[Source text truncated at 18,000 characters.]` : boundedText;
        if (truncated) warnings.push('A source was truncated at 18,000 characters.');
        if (byteTruncated) warnings.push('A source exceeded the 512 KiB retrieval limit and was truncated.');
        const textBytes = Buffer.byteLength(text, 'utf8');
        if (textBytes > remainingBytes) {
          text = truncateUtf8(text, remainingBytes);
          remainingBytes -= Buffer.byteLength(text, 'utf8');
          bundleTextTruncated = true;
        } else remainingBytes -= textBytes;
        const contentHash = hash(text);
        sources.push({ id: hash(`${normalizedUrl}\n${contentHash}`).slice(0, 32), url: normalizedUrl,
          title: (fetched.title || normalizedUrl).slice(0, 500), text, retrievedAt: asOf,
          ...(fetched.publishedAt ? { publishedAt: fetched.publishedAt } : {}), contentHash });
      } catch { warnings.push('A source was inaccessible or blocked.'); }
    }
    if (bundleTextTruncated) warnings.push('Evidence text was truncated to the 64,000-byte bundle limit.');
    if (sources.length === 0) warnings.push('No sources were retrieved; evidence is missing and the review must abstain.');
    const uniqueWarnings = [...new Set(warnings)];
    // Domain diversity is intentionally not described as independent corroboration.
    const material = JSON.stringify({ version: 1, claim, asOf, sources: sources.map(({ id,url,title,text,retrievedAt,publishedAt,contentHash }) => ({ id,url,title,text,retrievedAt,publishedAt,contentHash })), warnings: uniqueWarnings });
    return { version: 1, id: hash(material), claim, asOf, sources, warnings: uniqueWarnings };
  };
}

export interface BraveSearchOptions { fetcher?: typeof fetch }
/** Creates a bounded Brave Search API adapter. Never logs or returns the API key. */
export function createBraveSearch(apiKey: string, options: BraveSearchOptions = {}): (claim: string) => Promise<string[]> {
  if (!apiKey.trim()) throw new TypeError('Brave API key is required.');
  const fetcher = options.fetcher ?? fetch;
  return async (claim: string): Promise<string[]> => {
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
    endpoint.searchParams.set('q', claim.slice(0, 600));
    endpoint.searchParams.set('count', '6');
    const controller = new AbortController();
    let readerRef: { cancel: () => Promise<void> } | undefined;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort(); void readerRef?.cancel(); rejectDeadline(new Error('Search timed out.'));
    }, 8000);
    try {
      const response = await Promise.race([fetcher(endpoint, { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json', 'Accept-Encoding': 'identity' }, signal: controller.signal, redirect: 'manual' }), deadline]);
      if (!response.ok || response.status >= 300 && response.status < 400 || !response.body) throw new Error('Search failed.');
      const reader = response.body.getReader(); readerRef = reader; const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); throw new Error('Search response exceeded size limit.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const json = JSON.parse(new TextDecoder().decode(bytes)) as { web?: { results?: Array<{ url?: unknown }> } };
      return (json.web?.results ?? []).slice(0, 6).map(x => x.url).filter((x): x is string => typeof x === 'string');
    } finally { clearTimeout(timer); void readerRef?.cancel(); }
  };
}
