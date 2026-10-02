/**
 * Caller identity for per-client limits, shared by the website, the CVM public proxy and the protocol gateway. Each
 * server states which proxy it trusts: X-Forwarded-For only behind one that appends it, the transport peer otherwise.
 */
import { createHmac, randomBytes } from 'node:crypto';

const MAX_ADDRESS = 64;
const MAX_FORWARDED_TAIL = 256;
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

/**
 * Rate-limit key for one address: IPv4 as is, IPv6 grouped by /64 (a single host can rotate addresses inside its
 * prefix). IPv4-mapped IPv6 is treated as IPv4, and a port appended by a proxy is ignored so it cannot vary the key.
 * Anything else is "invalid", which all such callers share.
 */
export function clientPrefix(address: string): string {
  const parsed = parseAddress(address);
  if (!parsed) return 'invalid';
  return parsed.kind === 'v4' ? parsed.value : `${parsed.groups.slice(0, 4).join(':')}::/64`;
}

/** Proxy trust for one server. X-Forwarded-For is caller-settable unless a proxy that appends it fronts every request. */
export type ForwardingPolicy = {
  /** Only where a reverse proxy that always appends the caller's address fronts the server (Railway for the website). */
  trustForwardedFor?: boolean;
};

/**
 * The right-most X-Forwarded-For entry: the one the nearest proxy appended (entries to its left are caller-supplied).
 * Only the tail of the header is read, so a caller who pads the header cannot change which entry is used; an entry
 * longer than an address is returned as is and keys as "invalid".
 */
export function lastForwardedEntry(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const tail = header.slice(-MAX_FORWARDED_TAIL).replace(/[\s,]+$/, '');
  if (!tail) return undefined;
  const comma = tail.lastIndexOf(',');
  if (comma < 0 && header.length > MAX_FORWARDED_TAIL) return tail;
  return tail.slice(comma + 1).trim() || undefined;
}

/**
 * The caller address: with `trustForwardedFor`, the right-most X-Forwarded-For entry, else the transport peer the
 * server passes. X-Real-IP, CF-Connecting-IP and other caller-settable headers are never used, and a header that is
 * present but malformed never falls back to another header.
 */
export function forwardedAddress(request: Request, peer?: string, policy: ForwardingPolicy = {}): string | undefined {
  if (policy.trustForwardedFor) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded !== null) return lastForwardedEntry(forwarded) ?? 'invalid';
  }
  return peer?.trim() || undefined;
}

/**
 * Per-client rate-limit key: clientPrefix(forwardedAddress(...)), or "unknown" when the server knows no address.
 * Callers that cannot be told apart share one key, so global limits remain the actual bound.
 */
export function forwardedClient(request: Request, peer?: string, policy: ForwardingPolicy = {}): string {
  const address = forwardedAddress(request, peer, policy);
  return address === undefined ? 'unknown' : clientPrefix(address);
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

/** Keyed, per-process tags so the rehearsal can compare two callers' keys without either key being shown. */
export function keyTagger(): (key: string) => string {
  const salt = randomBytes(32);
  return (key: string) => createHmac('sha256', salt).update(key).digest('hex').slice(0, 8);
}
