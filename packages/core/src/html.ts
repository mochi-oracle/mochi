/**
 * Linear-time HTML scanning for untrusted markup (intake documents, claims source pages).
 *
 * Each helper reproduces one regular-expression replace exactly (named in its comment) with index scans instead of a
 * backtracking engine. A regex such as /<[^>]*>/g re-scans to the end of the input for every `<` that has no `>`
 * after it, which is quadratic: 390 KB of `<` took over a minute. Here every scan position only moves forward, and
 * the few searches that can fail are remembered, so each helper reads every input character O(1) times (amortized).
 *
 * Matching follows the non-unicode regex flags the replaced expressions used: tag names compare ASCII
 * case-insensitively (the /i flag, which never folds non-ASCII characters onto ASCII ones), `\b` uses ASCII word
 * characters and `\s` is the JavaScript whitespace set.
 */

const LT = 60, GT = 62, SLASH = 47, BANG = 33, DASH = 45;

/** ASCII word character, as the non-unicode `\b` sees it. */
export const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
/** JavaScript `\s` (WhiteSpace and LineTerminator). */
export const isRegexSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const fold = (c: number) => (c >= 65 && c <= 90 ? c | 32 : c);

/** A set of lowercase tag names (an alternation such as `(script|style)`), indexed by first character. */
export interface TagNames {
  readonly names: readonly string[];
  readonly byFirst: ReadonlyMap<number, readonly string[]>;
}
export function tagNames(names: readonly string[]): TagNames {
  const byFirst = new Map<number, string[]>();
  for (const name of names) {
    // Lowercase ASCII ending in a word character, so `\b` after it means "next character is not a word character".
    if (!/^[a-z0-9/_-]*[a-z0-9_]$/.test(name)) throw new Error(`invalid tag name: ${name}`);
    const list = byFirst.get(name.charCodeAt(0)) ?? [];
    list.push(name);
    byFirst.set(name.charCodeAt(0), list);
  }
  return { names: [...names], byFirst };
}

/**
 * First index >= `from` holding `code`, or -1. A plain loop rather than String.prototype.indexOf(…, from): under Bun
 * the engine's indexOf with a start offset was measured to cost O(length) per call once a scanner had been
 * JIT-compiled after certain warm-up inputs, turning a linear scan quadratic again.
 */
function find(s: string, code: number, from: number): number {
  for (let i = from; i < s.length; i++) if (s.charCodeAt(i) === code) return i;
  return -1;
}
/** First index >= `from` where `a` is immediately followed by `b`, or -1. */
function findPair(s: string, a: number, b: number, from: number): number {
  for (let i = from; i + 1 < s.length; i++) if (s.charCodeAt(i) === a && s.charCodeAt(i + 1) === b) return i;
  return -1;
}

/** `name` (lowercase ASCII) at `at`, ASCII case-insensitively. */
function nameAt(s: string, at: number, name: string): boolean {
  if (at + name.length > s.length) return false;
  for (let j = 0; j < name.length; j++) if (fold(s.charCodeAt(at + j)) !== name.charCodeAt(j)) return false;
  return true;
}
/** `<name\b` at `lt`. */
const tagAt = (s: string, lt: number, name: string) => nameAt(s, lt + 1, name) && !isWordChar(s.charCodeAt(lt + 1 + name.length));
/** The names of the set that can start at `at` (by first character, in alternation order). */
const candidates = (s: string, at: number, set: TagNames) => set.byFirst.get(fold(s.charCodeAt(at)));

/** First `</name\s*>` at or after `from`, ASCII case-insensitively: [start, end) or null. Linear in the scanned span. */
function endTag(s: string, name: string, from: number): [number, number] | null {
  for (let q = findPair(s, LT, SLASH, from); q >= 0;) {
    let k = q + 2;
    if (nameAt(s, k, name)) {
      k += name.length;
      while (k < s.length && isRegexSpace(s.charCodeAt(k))) k++;
      if (s.charCodeAt(k) === GT) return [q, k + 1];
    }
    // No `</` can start inside the name or the whitespace run just read.
    q = findPair(s, LT, SLASH, Math.max(q + 2, k));
  }
  return null;
}

/** First `<!--` at or after `from`. */
function commentOpen(s: string, from: number): number {
  for (let i = findPair(s, LT, BANG, from); i >= 0; i = findPair(s, LT, BANG, i + 1)) {
    if (s.charCodeAt(i + 2) === DASH && s.charCodeAt(i + 3) === DASH) return i;
  }
  return -1;
}
/** First `-->` at or after `from`. */
function commentClose(s: string, from: number): number {
  for (let i = findPair(s, DASH, DASH, from); i >= 0; i = findPair(s, DASH, DASH, i + 1)) if (s.charCodeAt(i + 2) === GT) return i;
  return -1;
}

/** html.replace(/<!--[\s\S]*?-->/g, replacement) */
export function replaceComments(html: string, replacement: string): string {
  const parts: string[] = [];
  let last = 0;
  for (let open = commentOpen(html, 0); open >= 0; open = commentOpen(html, last)) {
    const close = commentClose(html, open + 4);
    if (close < 0) break; // no later comment can close either
    parts.push(html.slice(last, open), replacement);
    last = close + 3;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/**
 * html.replace(/<(n1|n2|…)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, replacement): whole raw-text elements (script, style, …).
 * The first `>` after a `<` is shared by every `<` before it, so it is found once per run of start tags rather than
 * once per tag, and an end tag that does not exist is searched for once per name.
 */
export function replaceElements(html: string, names: TagNames, replacement: string): string {
  const parts: string[] = [];
  const noEndFrom = new Map<string, number>();
  let last = 0, from = 0, gt = -1;
  scan: for (let lt = find(html, LT, 0); lt >= 0; lt = find(html, LT, from)) {
    const list = candidates(html, lt + 1, names);
    for (let n = 0; list && n < list.length; n++) {
      const name = list[n]!;
      if (!tagAt(html, lt, name)) continue;
      // `[^>]*>`: the first `>` after `<name`, which is the first `>` after `lt`.
      if (gt <= lt) gt = find(html, GT, lt + 1);
      if (gt < 0) break scan; // no `>` after this point, so no element can start here or later
      if (gt + 1 >= (noEndFrom.get(name) ?? Infinity)) continue;
      const end = endTag(html, name, gt + 1);
      if (!end) { noEndFrom.set(name, gt + 1); continue; }
      parts.push(html.slice(last, lt), replacement);
      last = from = end[1];
      continue scan;
    }
    from = lt + 1;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/** `<n\b` at `lt` for a name n of the set. */
function isTag(s: string, lt: number, set: TagNames): boolean {
  const list = candidates(s, lt + 1, set);
  for (let n = 0; list && n < list.length; n++) if (tagAt(s, lt, list[n]!)) return true;
  return false;
}

/** With names: html.replace(/<(n1|n2|…)\b[^>]*>/gi, replacement). With null: html.replace(/<[^>]*>/g, replacement). */
export function replaceTags(html: string, names: TagNames | null, replacement: string): string {
  const parts: string[] = [];
  let last = 0, from = 0;
  for (let lt = find(html, LT, 0); lt >= 0; lt = find(html, LT, from)) {
    if (names && !isTag(html, lt, names)) { from = lt + 1; continue; }
    const gt = find(html, GT, lt + 1);
    if (gt < 0) break; // `[^>]*>` cannot match here or later
    parts.push(html.slice(last, lt), replacement);
    last = from = gt + 1;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/** html.replace(/<\/(?:n1|n2|…)\s*>/gi, replacement) */
export function replaceEndTags(html: string, names: TagNames, replacement: string): string {
  const parts: string[] = [];
  let last = 0, from = 0;
  for (let q = findPair(html, LT, SLASH, 0); q >= 0; q = findPair(html, LT, SLASH, from)) {
    let end = -1;
    const list = candidates(html, q + 2, names);
    for (let n = 0; list && n < list.length; n++) {
      const name = list[n]!;
      if (!nameAt(html, q + 2, name)) continue;
      let k = q + 2 + name.length;
      while (k < html.length && isRegexSpace(html.charCodeAt(k))) k++;
      if (html.charCodeAt(k) === GT) { end = k + 1; break; }
    }
    if (end < 0) { from = q + 2; continue; }
    parts.push(html.slice(last, q), replacement);
    last = from = end;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/** html.match(/<name\b[^>]*>([\s\S]*?)<\/name\s*>/i)?.[1] */
export function elementText(html: string, name: string): string | undefined {
  tagNames([name]);
  for (let lt = find(html, LT, 0); lt >= 0; lt = find(html, LT, lt + 1)) {
    if (!tagAt(html, lt, name)) continue;
    const gt = find(html, GT, lt + 1);
    if (gt < 0) return undefined;
    // Every later `<name` shares this `>` or a later one, so if no end tag follows it, none follows them.
    const end = endTag(html, name, gt + 1);
    return end ? html.slice(gt + 1, end[0]) : undefined;
  }
  return undefined;
}

/** The first `max` UTF-16 code units of `s`, one fewer if the cut would separate a surrogate pair. */
export function truncateUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  const high = s.charCodeAt(max - 1), low = s.charCodeAt(max);
  return s.slice(0, high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? max - 1 : max);
}
