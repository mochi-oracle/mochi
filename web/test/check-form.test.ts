import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { CLAIM_EVIDENCE_LIMITS, validateEvidence } from '../site/src/claim-protocol-client.js';
import { checkFormProblems, checkLimits, excerptBytesTotal, hasCheckDraft, sourceLinkProblem, utf8Bytes } from '../site/src/claim-form.js';

const source = (over = {}) => ({ title: 'Release', url: 'https://issuer.example/release', text: 'Revenue was 1.28 billion.', ...over });
const accepted = (claim: unknown, sources: unknown[]) => { try { validateEvidence(claim, sources); return true; } catch { return false; } };

test('the form uses the protocol client limits', () => {
  expect(checkLimits).toBe(CLAIM_EVIDENCE_LIMITS);
  expect(checkLimits).toMatchObject({ claimBytes: 4000, excerptBytes: 18000, aggregateBytes: 64000, titleBytes: 2048, urlBytes: 2048, minSources: 1, maxSources: 5 });
  expect(utf8Bytes('é')).toBe(2);
  expect(utf8Bytes(undefined)).toBe(0);
});

test('each problem names its field and source, in form order', () => {
  expect(checkFormProblems({ claim: 'A claim', sources: [source()] })).toEqual([]);
  const problems = checkFormProblems({ claim: ' ', sources: [source(), source({ title: '', url: 'http://issuer.example', text: '' })] });
  expect(problems.map(p => [p.field, p.index])).toEqual([['claim', -1], ['title', 1], ['url', 1], ['text', 1]]);
  expect(problems[2]!.message).toContain('HTTPS');
});

test('byte limits count UTF-8 bytes, not characters', () => {
  const claim = 'é'.repeat(2001); // 2,001 characters, 4,002 bytes
  expect(checkFormProblems({ claim, sources: [source()] })[0]).toMatchObject({ field: 'claim', index: -1 });
  expect(checkFormProblems({ claim: 'x'.repeat(4000), sources: [source()] })).toEqual([]);
  const over = checkFormProblems({ claim: 'ok', sources: [source({ text: 'x'.repeat(18001) })] });
  expect(over).toEqual([expect.objectContaining({ field: 'text', index: 0 })]);
  expect(over[0]!.message).toContain('18,001');
});

test('the excerpt total is checked across sources and focuses the largest excerpt', () => {
  const sources = [source({ text: 'x'.repeat(17000) }), source({ text: 'x'.repeat(18000) }), source({ text: 'x'.repeat(17000) }), source({ text: 'x'.repeat(12001) })];
  expect(excerptBytesTotal(sources)).toBe(64001);
  expect(checkFormProblems({ claim: 'ok', sources })).toEqual([expect.objectContaining({ field: 'total', index: -1, focusIndex: 1 })]);
  expect(checkFormProblems({ claim: 'ok', sources: sources.slice(0, 3) })).toEqual([]);
});

test('source links must be HTTPS without credentials', () => {
  expect(sourceLinkProblem('https://issuer.example/a')).toBe('');
  for (const bad of ['', 'issuer.example', 'http://issuer.example', 'ftp://issuer.example', 'https://user:pw@example.com', `https://issuer.example/${'a'.repeat(2048)}`]) expect(sourceLinkProblem(bad)).not.toBe('');
});

test('the form accepts exactly what the protocol client accepts', () => {
  const text = fc.oneof(fc.constantFrom('', ' ', 'é'.repeat(9001), 'x'.repeat(18001), 'x'.repeat(16000)), fc.string({ maxLength: 40 }));
  const url = fc.oneof(fc.constantFrom('', ' https://a.example', 'http://a.example', 'https://u@example.com', 'https://a.example/x', 'notaurl', `https://a.example/${'é'.repeat(1020)}`), fc.webUrl());
  const draft = fc.record({ title: text, url, text });
  fc.assert(fc.property(text, fc.array(draft, { minLength: 0, maxLength: 6 }), (claim, sources) => {
    expect(checkFormProblems({ claim, sources }).length === 0).toBe(accepted(claim, sources));
  }), { numRuns: 400 });
});

test('a draft is anything typed into the claim or a source, ignoring whitespace', () => {
  expect(hasCheckDraft('', [{ title: '', url: '', text: '' }])).toBe(false);
  expect(hasCheckDraft(' \n', [{ title: ' ', url: '', text: '\t' }])).toBe(false);
  expect(hasCheckDraft('A claim', [])).toBe(true);
  expect(hasCheckDraft('', [{ title: '', url: '', text: '' }, { title: '', url: '', text: 'excerpt' }])).toBe(true);
  expect(hasCheckDraft('', [{ title: '', url: 'https://a.example', text: '' }])).toBe(true);
});
