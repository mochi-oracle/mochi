/**
 * Caller identity for per-client limits, shared by the website, the CVM public proxy and the protocol gateway. Each
 * server states which proxies it trusts: X-Forwarded-For only behind proxies that write its last entries, and how many
 * they write; the transport peer otherwise.
 */
import { createHmac, randomBytes } from 'node:crypto';

const MAX_ADDRESS = 64;
/** Longest X-Forwarded-For entry read, whitespace included. No address is this long, so a longer entry keys as "invalid". */
const MAX_FORWARDED_ENTRY = 256;
/** Most trusted hops a policy may name, and most entries the diagnostics describe. */
export const MAX_FORWARDED_HOPS = 4;
const INVALID = 'invalid';
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

type Parsed = { kind: 'v4'; value: string } | { kind: 'v6'; groups: string[] };
/** IPv4 (with an optional proxy-appended port, or IPv4-mapped IPv6) or IPv6 expanded to eight groups; else undefined. */
function parseAddress(address: string): Parsed | undefined {
  let value = address.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (ipv4WithPort) value = ipv4WithPort[1]!;
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1]!;
  if (!value || value.length > MAX_ADDRESS || !/^[0-9a-f:.]+$/.test(value)) return undefined;
  if (!value.includes(':')) return IPV4.test(value) ? { kind: 'v4', value } : undefined;
  if (value.indexOf('::') !== value.lastIndexOf('::')) return undefined;
  const [head = '', tail] = value.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const parts = [...left, ...right];
  // Hex groups of at most four digits; only the final group may be an embedded IPv4 address.
  if (parts.length > (tail === undefined ? 8 : 7) || !parts.every((group, i) => /^[0-9a-f]{1,4}$/.test(group) || (i === parts.length - 1 && IPV4.test(group)))) return undefined;
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return { kind: 'v6', groups: groups.map(group => group.replace(/^0+(?=.)/, '')) };
}

/** IPv6 grouping for one limiter: /64 (one host can rotate addresses inside its prefix) or a site allocation. */
export type Ipv6Grouping = 64 | 56 | 48;

/**
 * Rate-limit key for one address: IPv4 as is, IPv6 grouped by its prefix (/64 by default; /56 or /48 for limiters where
 * one site's allocation, not one host, should share a budget). IPv4-mapped IPv6 is treated as IPv4, and a port appended
 * by a proxy is ignored so it cannot vary the key. Anything else is "invalid", which all such callers share.
 */
export function clientPrefix(address: string, ipv6Bits: Ipv6Grouping = 64): string {
  const parsed = parseAddress(address);
  if (!parsed) return 'invalid';
  if (parsed.kind === 'v4') return parsed.value;
  const [a, b, c, d] = parsed.groups as [string, string, string, string];
  if (ipv6Bits === 48) return `${a}:${b}:${c}::/48`;
  if (ipv6Bits === 56) return `${a}:${b}:${c}:${(parseInt(d, 16) & 0xff00).toString(16)}::/56`;
  return `${a}:${b}:${c}:${d}::/64`;
}

/** Proxy trust for one server. X-Forwarded-For is caller-settable except for the entries the trusted proxies write. */
export type ForwardingPolicy = {
  /**
   * Only where reverse proxies that always write the caller's address front every request: Railway's edge for the
   * website (with Railway's CDN off), or an ingress the CVM rehearsal has shown to append it.
   */
  trustForwardedFor?: boolean;
  /**
   * How many X-Forwarded-For entries, counted from the right, those proxies write: an integer from 1 to
   * MAX_FORWARDED_HOPS, default 1. The client is the entry at index `len - hops`, the right-most counting as 1; why that
   * is safe, and what a wrong count does, is in forwardedAddress.
   */
  forwardedForHops?: number;
};

/** The policy's hop count (1 when unset). Anything but an integer from 1 to MAX_FORWARDED_HOPS is a configuration error. */
export function forwardedHops(policy: ForwardingPolicy = {}): number {
  const hops = policy.forwardedForHops ?? 1;
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_FORWARDED_HOPS) throw new RangeError(`forwardedForHops must be an integer from 1 to ${MAX_FORWARDED_HOPS}.`);
  return hops;
}

/**
 * Up to `count` (1 to MAX_FORWARDED_HOPS) X-Forwarded-For entries, right-most first, trimmed; fewer when the header
 * has fewer. Only the last `count * (MAX_FORWARDED_ENTRY + 1)` characters are read, so a caller who pads the header
 * cannot change which entries these are, and the work is bounded. An entry longer than MAX_FORWARDED_ENTRY, or one
 * that begins before the part read, is returned as "invalid" (never cut down to something that parses), and an empty
 * entry as "". Separators at the very end of the header are ignored.
 */
export function forwardedEntries(header: string | null | undefined, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_FORWARDED_HOPS) throw new RangeError(`count must be an integer from 1 to ${MAX_FORWARDED_HOPS}.`);
  if (!header) return [];
  const span = count * (MAX_FORWARDED_ENTRY + 1);
  const tail = header.slice(-span);
  // The left-most piece read is a whole entry only if the header starts there or a comma precedes it.
  const cut = header.length > span && header[header.length - span - 1] !== ',';
  let end = tail.length;
  while (end > 0 && /[\s,]/.test(tail[end - 1]!)) end--;
  if (end === 0) return [];
  const pieces = tail.slice(0, end).split(',');
  const entries: string[] = [];
  for (let i = pieces.length - 1; i >= 0 && entries.length < count; i--) {
    const piece = pieces[i]!;
    entries.push((i === 0 && cut) || piece.length > MAX_FORWARDED_ENTRY ? INVALID : piece.trim());
  }
  return entries;
}

/** The right-most X-Forwarded-For entry (forwardedEntries with a count of 1), or undefined when there is none. */
export function lastForwardedEntry(header: string | null | undefined): string | undefined {
  return forwardedEntries(header, 1)[0];
}

/**
 * The caller address: with `trustForwardedFor`, the X-Forwarded-For entry at index `len - hops` (hops is
 * `forwardedForHops`, default 1; the right-most entry counts as 1), else the transport peer the server passes. A
 * present header with fewer than `hops` entries, or whose selected entry is empty, over-long or not read whole, gives
 * "invalid": never another entry, never X-Real-IP or another header, never the peer. X-Real-IP, CF-Connecting-IP and
 * other caller-settable headers are never used.
 *
 * hops = 1: one proxy that appends the address it sees. Entries to the left of its entry are whatever the caller sent.
 * Railway documents the left-most entry as the client, but behind an appending proxy a caller who sends
 * `X-Forwarded-For: 192.0.2.1` arrives as `192.0.2.1, <caller>`, and keying on the left-most entry would let one caller
 * choose a fresh key per request.
 *
 * hops = 2: Railway's edge in front of the website (measured 2026-10-02, CDN off). It writes `<visitor>, <edge node>`;
 * the right-most entry names whichever of a few edge nodes handled the request, so keying on it put every visitor into
 * one of a few shared buckets. Railway rewrites the header rather than appending to the caller's: a caller who sends
 * `X-Forwarded-For: 192.0.2.1` still arrives with two entries. Position `len - 2` is the visitor either way. Rewriting,
 * the header holds only Railway's two entries. Appending, should Railway switch, the caller's entries come first
 * (`192.0.2.1, <visitor>, <edge node>`), so position `len - 2` is still the address Railway's first hop recorded. A
 * caller can only add entries to the left of the ones the trusted proxies write, and so cannot move the entry at
 * `len - hops`. The tail-only read keeps that true for a padded header.
 *
 * A wrong count: too few hops keys on a proxy's own address, so visitors behind it share a budget (coarse, never
 * caller-chosen). Too many, behind proxies that rewrite, leaves too few entries and keys everyone as "invalid"; behind
 * proxies that append, it would select an entry the caller wrote. The website's activation check
 * (deploy/production/WEBSITE-ACTIVATION.md) rules out both: the key must not move when the caller sends its own header.
 */
export function forwardedAddress(request: Request, peer?: string, policy: ForwardingPolicy = {}): string | undefined {
  const hops = forwardedHops(policy);
  if (policy.trustForwardedFor) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded !== null) return forwardedEntries(forwarded, hops)[hops - 1] || INVALID;
  }
  return peer?.trim() || undefined;
}

/**
 * Per-client rate-limit key: clientPrefix(forwardedAddress(...)), or "unknown" when the server knows no address.
 * Callers that cannot be told apart share one key, so global limits remain the actual bound.
 */
export function forwardedClient(request: Request, peer?: string, policy: ForwardingPolicy = {}, ipv6Bits: Ipv6Grouping = 64): string {
  const address = forwardedAddress(request, peer, policy);
  return address === undefined ? 'unknown' : clientPrefix(address, ipv6Bits);
}

export type AddressClass = 'loopback' | 'private' | 'public' | 'invalid';
/** Content-free class of an address, for diagnostics and the loopback check; never the address itself. */
export function addressClass(address: string): AddressClass {
  const parsed = parseAddress(address);
  if (!parsed) return 'invalid';
  if (parsed.kind === 'v4') {
    const [a, b] = parsed.value.split('.').map(Number) as [number, number];
    if (a === 127) return 'loopback';
    if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
    return 'public';
  }
  if (parsed.groups.slice(0, 7).every(group => group === '0') && parsed.groups[7] === '1') return 'loopback';
  const first = parseInt(parsed.groups[0]!, 16);
  // Unspecified/IPv4-compatible (::/8), unique local (fc00::/7) and link-local (fe80::/10).
  return first < 0x100 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ? 'private' : 'public';
}
export const isLoopback = (address: string | undefined): boolean => address !== undefined && addressClass(address) === 'loopback';

/**
 * Set by the CVM public proxy on its loopback hop to the gateway: the proxy's per-client key for the caller. The
 * gateway honours it only from a loopback peer; the proxy never forwards a caller's copy.
 */
export const TRUSTED_CLIENT_HEADER = 'x-mochi-client';
const TRUSTED_CLIENT_VALUE = /^[A-Za-z0-9:._/-]{1,96}$/;
export const validTrustedClient = (value: string | null | undefined): value is string => typeof value === 'string' && TRUSTED_CLIENT_VALUE.test(value);

/**
 * Content-free view of what a server can see about a caller, for the rehearsal: how many X-Forwarded-For entries
 * arrived and the class of the last one, and the class of the transport peer. With `tag` (a keyTagger), also salted
 * tags of the last entry's and the peer's keys, so callers on two networks can be compared. No address, header value
 * or secret.
 */
export function forwardingFacts(request: Request, peer?: string, tag?: (key: string) => string) {
  const header = request.headers.get('x-forwarded-for');
  let entries = 0;
  if (header !== null) { entries = 1; for (let i = 0; i < header.length && entries < 64; i++) if (header.charCodeAt(i) === 44) entries++; }
  const last = lastForwardedEntry(header);
  return {
    forwardedFor: {
      entries, last: header === null ? 'absent' : last === undefined ? 'invalid' : addressClass(last),
      ...(tag ? { lastTag: last === undefined ? null : tag(clientPrefix(last)) } : {}),
    },
    realIpHeader: request.headers.has('x-real-ip'),
    peer: peer ? addressClass(peer) : 'absent',
    ...(tag ? { peerTag: peer ? tag(clientPrefix(peer)) : null } : {}),
  } as const;
}

/**
 * forwardingFacts plus what the website's activation check compares, still content-free: the policy's hop count, the
 * class and salted tag of each of the last MAX_FORWARDED_HOPS X-Forwarded-For entries (right-most first, so entry
 * `hops - 1` is the one keyed on), and the class and tag of X-Real-IP. X-Real-IP never keys anything; it is shown only
 * so the operator can compare it with the key. Tags are of the /64 key, as the website's keyTag is.
 */
export function forwardingDiagnostics(request: Request, peer: string | undefined, policy: ForwardingPolicy, tag: (key: string) => string) {
  const facts = forwardingFacts(request, peer, tag);
  const header = request.headers.get('x-forwarded-for'), realIpHeader = request.headers.get('x-real-ip');
  const realIp = realIpHeader === null ? undefined : realIpHeader.length > MAX_FORWARDED_ENTRY ? INVALID : realIpHeader;
  return {
    ...facts,
    forwardedFor: {
      ...facts.forwardedFor, hops: forwardedHops(policy),
      fromRight: forwardedEntries(header, MAX_FORWARDED_HOPS).map(entry => ({ class: addressClass(entry), tag: tag(clientPrefix(entry)) })),
    },
    realIp: realIp === undefined ? 'absent' : addressClass(realIp),
    realIpTag: realIp === undefined ? null : tag(clientPrefix(realIp)),
  } as const;
}

/** Keyed, per-process tags so the rehearsal can compare two callers' keys without either key being shown. */
export function keyTagger(): (key: string) => string {
  const salt = randomBytes(32);
  return (key: string) => createHmac('sha256', salt).update(key).digest('hex').slice(0, 8);
}
