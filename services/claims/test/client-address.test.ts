import { expect, test } from 'bun:test';
import { MAX_FORWARDED_HOPS, addressClass, clientPrefix, forwardedAddress, forwardedClient, forwardedEntries, forwardedHops, forwardingDiagnostics, forwardingFacts, isLoopback, keyTagger, lastForwardedEntry, validTrustedClient } from '../src/client-address.ts';
import { forwardedClient as quotaForwardedClient } from '../src/quota.ts';
import { VISITOR_MAX_AGE_SEC, keyCheckHeader, visitorKey, visitorSecretFromEnv } from '../src/visitor-key.ts';
import { BodyReadError, abandonedBodyResponse, closeAbandonedConnection, readBoundedBody } from '../src/bounded-body.ts';

const request = (headers: Record<string, string>) => new Request('https://public.example/v1/query', { headers });
const trusted = { trustForwardedFor: true };

test('behind a trusted proxy the right-most X-Forwarded-For entry identifies the caller; caller-supplied entries never do', () => {
  expect(forwardedClient(request({ 'x-forwarded-for': '10.9.9.9, 203.0.113.1' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 203.0.113.1' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.1, ' }), undefined, trusted)).toBe('203.0.113.1');
  expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '192.0.2.1' }), undefined, trusted)).toBe('203.0.113.1');
  // X-Real-IP and CF-Connecting-IP are caller-settable; they are never used, with or without a trusted proxy.
  expect(forwardedClient(request({ 'cf-connecting-ip': '192.0.2.1' }), undefined, trusted)).toBe('unknown');
  expect(forwardedClient(request({ 'x-real-ip': ' 198.51.100.9 ' }), undefined, trusted)).toBe('unknown');
  expect(forwardedClient(request({ 'x-real-ip': '198.51.100.9' }), '192.0.2.44', trusted)).toBe('192.0.2.44');
  expect(forwardedClient(request({}), '192.0.2.44', trusted)).toBe('192.0.2.44');
  expect(forwardedClient(request({}))).toBe('unknown');
  expect(forwardedAddress(request({ 'x-forwarded-for': '10.0.0.1, [2001:db8::1]:443' }), undefined, trusted)).toBe('[2001:db8::1]:443');
  // A present but unusable header keys as "invalid" and never falls back to the peer or another header.
  expect(forwardedClient(request({ 'x-forwarded-for': ' , ', 'x-real-ip': '198.51.100.9' }), '192.0.2.44', trusted)).toBe('invalid');
  expect(quotaForwardedClient).toBe(forwardedClient);
});

test('an over-long X-Forwarded-For is read from its tail: padding cannot select X-Real-IP or another entry', () => {
  const padded = `${'1.1.1.1, '.repeat(300)}203.0.113.1`;
  expect(padded.length).toBeGreaterThan(2048);
  for (const realIp of ['10.0.0.1', '10.0.0.2']) expect(forwardedClient(request({ 'x-forwarded-for': padded, 'x-real-ip': realIp }), undefined, trusted)).toBe('203.0.113.1');
  // One huge entry is not an address.
  expect(forwardedClient(request({ 'x-forwarded-for': `203.0.113.1${'0'.repeat(5000)}`, 'x-real-ip': '10.0.0.1' }), undefined, trusted)).toBe('invalid');
  expect(lastForwardedEntry(`${'x'.repeat(4000)},198.51.100.7`)).toBe('198.51.100.7');
  expect(lastForwardedEntry('')).toBeUndefined();
});

test('a trusted hop count keys on the entry at len - hops: Railway rewriting and appending give the same visitor', () => {
  const railway = { trustForwardedFor: true, forwardedForHops: 2 };
  // Rewritten by the edge: `<visitor>, <edge node>`, the edge node varying between requests.
  for (const edge of ['10.1.0.3', '10.1.0.4', '100.64.9.9', '2001:db8:ffff::1']) {
    expect(forwardedClient(request({ 'x-forwarded-for': `203.0.113.7, ${edge}` }), '10.0.0.1', railway)).toBe('203.0.113.7');
  }
  // Appended to a caller's own header: the caller's entries are to the left, so len - 2 is still the visitor.
  for (const sent of ['192.0.2.1', '192.0.2.1, 198.51.100.1', '203.0.113.99,', ' , ']) {
    expect(forwardedClient(request({ 'x-forwarded-for': `${sent}, 203.0.113.7, 10.1.0.3` }), undefined, railway)).toBe('203.0.113.7');
  }
  expect(forwardedClient(request({ 'x-forwarded-for': '2001:db8:1:2::9, [2001:db8:ffff::1]:443' }), undefined, railway)).toBe('2001:db8:1:2::/64');
  expect(forwardedClient(request({ 'x-forwarded-for': '198.51.100.20, 10.1.0.3' }), undefined, railway)).toBe('198.51.100.20');
  // hops = 1 is the previous behaviour, and the default: the right-most entry, here the edge node.
  for (const policy of [trusted, { trustForwardedFor: true, forwardedForHops: 1 }]) {
    expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.7, 10.1.0.3' }), undefined, policy)).toBe('10.1.0.3');
  }
  const four = request({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7, 10.0.0.1, 10.0.0.2' });
  expect([1, 2, 3, 4].map(forwardedForHops => forwardedAddress(four, undefined, { trustForwardedFor: true, forwardedForHops }))).toEqual(['10.0.0.2', '10.0.0.1', '203.0.113.7', '198.51.100.1']);
  // Without trust the hop count changes nothing: the transport peer.
  expect(forwardedClient(request({ 'x-forwarded-for': '203.0.113.7, 10.1.0.3' }), '192.0.2.44', { forwardedForHops: 2 })).toBe('192.0.2.44');
});

test('fewer entries than hops key as "invalid": never a caller-chosen entry, X-Real-IP or the peer', () => {
  const railway = { trustForwardedFor: true, forwardedForHops: 2 };
  for (const xff of ['203.0.113.7', '203.0.113.7, ', ' , 10.1.0.3', ',10.1.0.3', '203.0.113.7,,10.1.0.3', '203.0.113.7, , 10.1.0.3', '', ' ']) {
    expect(forwardedClient(request({ 'x-forwarded-for': xff, 'x-real-ip': '198.51.100.9' }), '192.0.2.44', railway)).toBe('invalid');
  }
  expect(forwardedClient(request({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1, 10.0.0.2' }), '192.0.2.44', { trustForwardedFor: true, forwardedForHops: 4 })).toBe('invalid');
  // No header at all keeps the existing rule: the transport peer (on Railway, the edge always sends one).
  expect(forwardedClient(request({ 'x-real-ip': '198.51.100.9' }), '192.0.2.44', railway)).toBe('192.0.2.44');
  for (const forwardedForHops of [0, 5, 1.5, -1, Number.NaN]) {
    expect(() => forwardedHops({ forwardedForHops })).toThrow(RangeError);
    expect(() => forwardedAddress(request({ 'x-forwarded-for': '203.0.113.7, 10.1.0.3' }), undefined, { trustForwardedFor: true, forwardedForHops })).toThrow('1 to 4');
  }
  expect(forwardedHops({})).toBe(1);
  expect(MAX_FORWARDED_HOPS).toBe(4);
});

test('hop counts read a bounded tail: padding cannot move the selected entry and an over-long entry is invalid', () => {
  const railway = { trustForwardedFor: true, forwardedForHops: 2 };
  const padded = `${'1.1.1.1, '.repeat(2000)}203.0.113.7, 10.1.0.3`;
  for (const realIp of ['10.0.0.1', '10.0.0.2']) expect(forwardedClient(request({ 'x-forwarded-for': padded, 'x-real-ip': realIp }), undefined, railway)).toBe('203.0.113.7');
  const tail = ['198.51.100.4', '198.51.100.3', '198.51.100.2', '198.51.100.1'];
  for (const forwardedForHops of [1, 2, 3, 4]) {
    expect(forwardedAddress(request({ 'x-forwarded-for': `${'x'.repeat(9000)},${tail.join(', ')}` }), undefined, { trustForwardedFor: true, forwardedForHops })).toBe(tail[4 - forwardedForHops]);
  }
  // An over-long selected entry is invalid, even when it would trim or truncate to an address. (Request strips
  // whitespace at the ends of a header value, so the padded entry here is not the first.)
  for (const xff of [`203.0.113.7${'0'.repeat(300)}, 10.1.0.3`, `192.0.2.1,${' '.repeat(300)}203.0.113.7, 10.1.0.3`, `${'x'.repeat(5000)} 203.0.113.7, 10.1.0.3`, `evil${' '.repeat(600)}203.0.113.7, 10.1.0.3`]) {
    expect(forwardedClient(request({ 'x-forwarded-for': xff, 'x-real-ip': '203.0.113.7' }), '203.0.113.7', railway)).toBe('invalid');
  }
  // The limit is exact: 256 characters of entry, whitespace included.
  expect(lastForwardedEntry(`${' '.repeat(245)}203.0.113.7`)).toBe('203.0.113.7');
  expect(lastForwardedEntry(`${' '.repeat(246)}203.0.113.7`)).toBe('invalid');
  // An entry is used only if it was read whole: one that starts right after a comma at the edge of the read is.
  const longEdge = 'x'.repeat(502);
  expect(forwardedEntries(`9.9.9.9,203.0.113.7,${longEdge}`, 2)).toEqual(['invalid', '203.0.113.7']);
  expect(forwardedEntries(`9.9.9.9Z203.0.113.7,${longEdge}`, 2)).toEqual(['invalid', 'invalid']);
  expect(forwardedEntries('203.0.113.7, 10.1.0.3', 4)).toEqual(['10.1.0.3', '203.0.113.7']);
  expect(forwardedEntries(null, 2)).toEqual([]);
  for (const count of [0, 5, 2.5]) expect(() => forwardedEntries('203.0.113.7', count)).toThrow(RangeError);
});

test('without a trusted proxy X-Forwarded-For is ignored and the transport peer identifies the caller', () => {
  for (const xff of ['203.0.113.1', '10.9.9.9, 203.0.113.2']) {
    expect(forwardedClient(request({ 'x-forwarded-for': xff }))).toBe('unknown');
    expect(forwardedClient(request({ 'x-forwarded-for': xff }), '192.0.2.44')).toBe('192.0.2.44');
  }
  expect(forwardedClient(request({}), '2001:db8:1:2::99')).toBe('2001:db8:1:2::/64');
});

test('IPv6 callers share their /64; mapped IPv4 and proxy-appended ports cannot vary the key', () => {
  for (const address of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff::9', '[2001:db8:1:2::abcd]', '[2001:db8:1:2::abcd]:8443', '2001:DB8:1:2:0:0:0:1']) {
    expect(clientPrefix(address)).toBe('2001:db8:1:2::/64');
  }
  expect(clientPrefix('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  expect(clientPrefix('::1')).toBe('0:0:0:0::/64');
  // Wider groupings for limiters where one site's allocation should share a budget.
  for (const address of ['2001:db8:1:200::1', '2001:db8:1:2ff:ffff::9', '[2001:db8:1:2ab::1]:443']) expect(clientPrefix(address, 56)).toBe('2001:db8:1:200::/56');
  expect(clientPrefix('2001:db8:1:300::1', 56)).toBe('2001:db8:1:300::/56');
  expect(clientPrefix('2001:db8:1:ff::1', 56)).toBe('2001:db8:1:0::/56');
  for (const address of ['2001:db8:1::1', '2001:db8:1:ffff:1::1']) expect(clientPrefix(address, 48)).toBe('2001:db8:1::/48');
  expect(clientPrefix('2001:db8:2::1', 48)).not.toBe(clientPrefix('2001:db8:1::1', 48));
  for (const bits of [48, 56, 64] as const) {
    expect(clientPrefix('203.0.113.7', bits)).toBe('203.0.113.7');
    expect(clientPrefix('::ffff:203.0.113.7', bits)).toBe('203.0.113.7');
    expect(clientPrefix('nonsense', bits)).toBe('invalid');
  }
  expect(forwardedClient(request({ 'x-forwarded-for': '2001:db8:1:2ff::1' }), undefined, trusted, 56)).toBe('2001:db8:1:200::/56');
  for (const address of ['203.0.113.7', '::ffff:203.0.113.7', '0:0:0:0:0:ffff:203.0.113.7', '203.0.113.7:1234', '203.0.113.7:65535']) {
    expect(clientPrefix(address)).toBe('203.0.113.7');
  }
  for (const address of ['', 'unknown', 'example.com', '1.2.3', '1.2.3.4.5', '[::1', '2001:db8::1%eth0', 'x'.repeat(65), '203.0.113.7:123456', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::1', '1.2.3.4::1']) {
    expect(clientPrefix(address)).toBe('invalid');
  }
});

test('address classes are content-free and only true loopback counts as loopback', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '[::1]:3200', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) expect(isLoopback(address)).toBe(true);
  for (const address of [undefined, '', '10.0.0.1', '::2', '::', 'localhost', '203.0.113.1']) expect(isLoopback(address)).toBe(false);
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', 'fd00::1', 'fe80::1']) expect(addressClass(address)).toBe('private');
  for (const address of ['203.0.113.1', '172.32.0.1', '8.8.8.8', '2001:db8::1']) expect(addressClass(address)).toBe('public');
  expect(addressClass('not-an-address')).toBe('invalid');
});

test('forwarding facts and key tags reveal no address', () => {
  const facts = forwardingFacts(request({ 'x-forwarded-for': '198.51.100.1, 10.0.0.9', 'x-real-ip': '198.51.100.2' }), '172.18.0.1');
  expect(facts).toEqual({ forwardedFor: { entries: 2, last: 'private' }, realIpHeader: true, peer: 'private' });
  expect(JSON.stringify(facts)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  expect(forwardingFacts(request({}))).toEqual({ forwardedFor: { entries: 0, last: 'absent' }, realIpHeader: false, peer: 'absent' });
  // An over-long last entry is described as before: class "invalid", tagged as the "invalid" key.
  const tagged = keyTagger();
  expect(forwardingFacts(request({ 'x-forwarded-for': '9'.repeat(400) }), undefined, tagged).forwardedFor).toEqual({ entries: 1, last: 'invalid', lastTag: tagged('invalid') });
  const tag = keyTagger(), other = keyTagger();
  expect(tag('203.0.113.1')).toMatch(/^[0-9a-f]{8}$/);
  expect(tag('203.0.113.1')).toBe(tag('203.0.113.1'));
  expect(tag('203.0.113.1')).not.toBe(tag('203.0.113.2'));
  expect(other('203.0.113.1')).not.toBe(tag('203.0.113.1')); // salted per process
  expect(validTrustedClient('visitor:AbC_-012345678901234567')).toBe(true);
  expect(validTrustedClient('2001:db8:1:2::/64')).toBe(true);
  for (const value of [null, '', 'a b', 'x'.repeat(97), 'v\n1']) expect(validTrustedClient(value)).toBe(false);
});

test('forwarding diagnostics show each entry and X-Real-IP as a class and a salted tag, never an address', () => {
  const tag = keyTagger(), railway = { trustForwardedFor: true, forwardedForHops: 2 };
  const facts = forwardingDiagnostics(request({ 'x-forwarded-for': '192.0.2.1, 2001:db8:1:2::9, 10.1.0.3', 'x-real-ip': '[2001:db8:1:2::abcd]' }), '100.64.0.2', railway, tag);
  expect(facts).toEqual({
    forwardedFor: {
      entries: 3, last: 'private', lastTag: tag('10.1.0.3'), hops: 2,
      fromRight: [{ class: 'private', tag: tag('10.1.0.3') }, { class: 'public', tag: tag('2001:db8:1:2::/64') }, { class: 'public', tag: tag('192.0.2.1') }],
    },
    realIpHeader: true, realIp: 'public', realIpTag: tag('2001:db8:1:2::/64'),
    peer: 'private', peerTag: tag('100.64.0.2'),
  });
  // The entry at hops - 1 carries the tag of the key forwardedClient uses.
  expect(facts.forwardedFor.fromRight[1]!.tag).toBe(tag(forwardedClient(request({ 'x-forwarded-for': '192.0.2.1, 2001:db8:1:2::9, 10.1.0.3' }), undefined, railway)));
  const text = JSON.stringify(facts);
  expect(text).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  expect(text).not.toMatch(/[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}/i);
  for (const literal of ['192.0.2.1', '2001:db8', '10.1.0.3', '100.64.0.2', 'abcd']) expect(text).not.toContain(literal);
  // At most four entries, right-most first; X-Real-IP absent or unusable.
  const many = forwardingDiagnostics(request({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3, 198.51.100.4, 198.51.100.5, 198.51.100.6' }), undefined, {}, tag);
  expect(many.forwardedFor.entries).toBe(6);
  expect(many.forwardedFor.hops).toBe(1);
  expect(many.forwardedFor.fromRight.map(entry => entry.tag)).toEqual(['198.51.100.6', '198.51.100.5', '198.51.100.4', '198.51.100.3'].map(tag));
  expect(many).toMatchObject({ realIpHeader: false, realIp: 'absent', realIpTag: null, peer: 'absent', peerTag: null });
  expect(forwardingDiagnostics(request({ 'x-real-ip': `203.0.113.7${'0'.repeat(300)}` }), undefined, railway, tag)).toMatchObject({ forwardedFor: { entries: 0, last: 'absent', hops: 2, fromRight: [] }, realIp: 'invalid', realIpTag: tag('invalid') });
  expect(() => forwardingDiagnostics(request({}), undefined, { forwardedForHops: 9 }, tag)).toThrow(RangeError);
});

test('visitor keys: signed by the website, checked by the CVM, short-lived, and opaque', () => {
  const token = 'test-invitation-token-at-least-24-characters';
  const website = visitorKey(token)!, cvm = visitorKey(token)!, other = visitorKey('another-invitation-token-of-24-chars')!;
  expect(visitorKey(undefined)).toBeUndefined();
  expect(visitorKey('too-short')).toBeUndefined();
  // Nothing derived from the secret is exposed: no fingerprint to guess the token against offline.
  expect(Object.keys(website).sort()).toEqual(['checkKey', 'sign', 'verify']);
  const now = 1_700_000_000;
  const header = website.sign('203.0.113.7', now);
  expect(header).not.toContain('203.0.113');
  expect(header).not.toContain(token);
  const check = cvm.verify(header, now + 5);
  expect(check.status).toBe('valid');
  // One stable pseudonym per visitor prefix within one website process.
  expect(cvm.verify(website.sign('203.0.113.7', now + 60), now + 60)).toEqual(check);
  expect((cvm.verify(website.sign('203.0.113.8', now), now) as { visitor: string }).visitor).not.toBe((check as { visitor: string }).visitor);
  // The pseudonym is keyed by a per-process random key, not the shared secret: a token holder (the CVM) cannot
  // recover the address by trying addresses, and another website process names the same visitor differently.
  expect((cvm.verify(cvm.sign('203.0.113.7', now), now) as { visitor: string }).visitor).not.toBe((check as { visitor: string }).visitor);
  expect(cvm.verify(header, now + VISITOR_MAX_AGE_SEC + 1).status).toBe('expired');
  expect(cvm.verify(header, now - VISITOR_MAX_AGE_SEC - 1).status).toBe('expired');
  expect(other.verify(header, now).status).toBe('invalid');
  const [v, visitor, ts, mac] = header.split('.');
  expect(cvm.verify([v, visitor, String(Number(ts) + 1), mac].join('.'), now).status).toBe('invalid');
  expect(cvm.verify([v, `${visitor!.slice(0, -1)}${visitor!.endsWith('A') ? 'B' : 'A'}`, ts, mac].join('.'), now).status).toBe('invalid');
  for (const bad of ['', 'v1', `${header}x`, header.replace('v1.', 'v2.'), 'v1.a.b.c']) expect(cvm.verify(bad, now).status).toBe(bad ? 'invalid' : 'absent');
  expect(cvm.verify(null, now).status).toBe('absent');
});

test('the operator key check answers only match or mismatch, and every proof is fresh', () => {
  const token = 'test-invitation-token-at-least-24-characters';
  const cvm = visitorKey(token)!;
  const proof = keyCheckHeader(token), again = keyCheckHeader(token);
  expect(proof).not.toBe(again);
  expect(proof).not.toContain(token);
  expect(cvm.checkKey(proof)).toBe('match');
  expect(cvm.checkKey(again)).toBe('match');
  expect(cvm.checkKey(keyCheckHeader('another-invitation-token-of-24-chars'))).toBe('mismatch');
  // A proof's MAC is bound to its nonce.
  const [, nonce, mac] = proof.split('.');
  const otherNonce = again.split('.')[1]!;
  expect(cvm.checkKey(`v1.${otherNonce}.${mac}`)).toBe('mismatch');
  expect(cvm.checkKey(`v1.${nonce}.${mac}`)).toBe('match');
  for (const bad of ['v1', 'v1.a.b', `${proof}x`, proof.replace('v1.', 'v2.')]) expect(cvm.checkKey(bad)).toBe('invalid');
  expect(cvm.checkKey(null)).toBe('absent');
  expect(() => keyCheckHeader('too-short')).toThrow('24 characters');
  expect(() => keyCheckHeader(token, 'not-a-nonce')).toThrow('base64url');
  // The secret's source is named in one place.
  expect(visitorSecretFromEnv({ MOCHI_CLAIMS_ACCESS_TOKEN: token })).toBe(token);
  expect(visitorSecretFromEnv({})).toBeUndefined();
});

test('bounded body reads stop at the size cap and the deadline', async () => {
  const stream = (chunks: string[], close: boolean) => new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); if (close) c.close(); } });
  const post = (body: ReadableStream | string, headers: Record<string, string> = {}) => new Request('https://public.example/', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  expect(new TextDecoder().decode(await readBoundedBody(post(stream(['{"a":', '1}'], true)), { maxBytes: 100 }))).toBe('{"a":1}');
  await expect(readBoundedBody(post('x'.repeat(101)), { maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
  await expect(readBoundedBody(post(stream(['x'.repeat(60), 'x'.repeat(60)], true)), { maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
  const started = performance.now();
  const stalled = readBoundedBody(post(stream(['{'], false)), { maxBytes: 100, deadlineMs: 50 });
  await expect(stalled).rejects.toBeInstanceOf(BodyReadError);
  await expect(stalled).rejects.toMatchObject({ status: 408 });
  expect(performance.now() - started).toBeLessThan(1000);
  const seen: number[] = [];
  await expect(readBoundedBody(post(stream(['ab', 'cd'], true)), { maxBytes: 100, onChunk: bytes => { seen.push(bytes); if (seen.length > 1) throw new BodyReadError(503, 'busy'); } })).rejects.toMatchObject({ status: 503 });
  expect(seen).toEqual([2, 2]);
});

test('a response to an abandoned body closes its connection with the shortest idle timeout', () => {
  const timeouts: Array<[Request, number]> = [];
  const server = { timeout: (request: Request, seconds: number) => { timeouts.push([request, seconds]); } };
  const request = new Request('https://public.example/', { method: 'POST', body: '{' });
  const refused = abandonedBodyResponse(Response.json({ error: 'Request body was not received in time' }, { status: 408 }));
  expect(refused.headers.get('connection')).toBe('close');
  expect(closeAbandonedConnection(server, request, refused)).toBe(refused);
  expect(timeouts).toEqual([[request, 1]]);
  closeAbandonedConnection(server, request, Response.json({ ok: true }));
  expect(timeouts).toHaveLength(1);
});
