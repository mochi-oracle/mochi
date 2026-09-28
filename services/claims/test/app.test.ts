import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClaimsHandler } from '../src/app.ts';
import { SqlitePublicClaimStore } from '../src/store.ts';
import { createResearcher } from '../src/research.ts';
import { reviewBundle, computeReviewIntegrityHash } from '../src/review.ts';
import type { EvidenceBundle, Juror } from '../src/types.ts';

const ACCESS = 'test-pilot-access-token-at-least-24-characters';
const privateText = 'The fictional release uses the MIT license. Unquoted private research material.';
const bundle: EvidenceBundle = { version: 1, id: 'bound-evidence', claim: 'The fictional release uses the MIT license.', asOf: '2026-09-28T00:00:00.000Z', sources: [{ id: 's1', title: 'Fictional license fixture', text: privateText, url: 'https://example.com/license', retrievedAt: '2026-09-28T00:00:00.000Z', contentHash: 'source-hash' }], warnings: [] };
const jurors: Juror[] = [1, 2, 3].map(n => ({ id: `j${n}`, model: `fixture-model-${n}`, assess: async () => ({ assessment: 'supported', explanation: 'The provided license record supports the claim.', citations: [{ sourceId: 's1', quote: 'The fictional release uses the MIT license.' }], limitations: ['Test fixture, not a real model assessment.'] }) }));
const stores: SqlitePublicClaimStore[] = [];
const makeStore = () => { const store = new SqlitePublicClaimStore(':memory:'); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const post = (path: string, data: unknown, headers: Record<string, string> = {}) => new Request(`https://mochi.test/api/claims/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mochi-access-token': ACCESS, ...headers }, body: JSON.stringify(data) });

test('configuration fails closed and never exposes server credentials', async () => {
  const handler = createClaimsHandler({ store: makeStore(), accessToken: ACCESS });
  const config: any = await (await handler(new Request('https://mochi.test/api/claims/config'))).json();
  expect(config.enabled).toBe(false);
  expect(JSON.stringify(config)).not.toContain(ACCESS);
  expect((await handler(post('research', { claim: bundle.claim, consent: true }))).status).toBe(503);
});

test('requires research consent and pilot access before any outbound work', async () => {
  let calls = 0;
  const handler = createClaimsHandler({ store: makeStore(), accessToken: ACCESS, researcher: async () => { calls++; return bundle; }, reviewer: b => reviewBundle(b, jurors) });
  expect((await handler(post('research', { claim: bundle.claim, consent: true }, { 'x-mochi-access-token': 'wrong' }))).status).toBe(401);
  expect((await handler(post('research', { claim: bundle.claim }))).status).toBe(400);
  expect((await handler(post('research', { claim: bundle.claim, consent: true }, { origin: 'https://attacker.test' }))).status).toBe(403);
  expect((await handler(post('research', { claim: 'x'.repeat(21000), consent: true }))).status).toBe(400);
  expect(calls).toBe(0);
});

test('private review stays private; duplicate concurrent approvals run models once; share requires ownership', async () => {
  let runs = 0;
  const handler = createClaimsHandler({ store: makeStore(), accessToken: ACCESS, researcher: async () => bundle, reviewer: async b => { runs++; await new Promise(resolve => setTimeout(resolve, 5)); return reviewBundle(b, jurors); } });
  const research: any = await (await handler(post('research', { claim: bundle.claim, consent: true }))).json();
  const requests = await Promise.all([1, 2].map(() => handler(post('reviews', { researchToken: research.researchToken, consent: true }))));
  const [first, second]: any[] = await Promise.all(requests.map(r => r.json()));
  expect(runs).toBe(1); expect(first.review.id).toBe(second.review.id); expect(first.reviewToken).toBe(second.reviewToken);
  expect(first.review.status).toBe('assessed');
  expect((await handler(new Request(`https://mochi.test/api/claims/shared/${first.review.id}`))).status).toBe(404);
  const sharePath = `reviews/${first.review.id}/share`;
  expect((await handler(post(sharePath, { consent: true }))).status).toBe(404);
  expect((await handler(post(sharePath, {}, { 'x-mochi-review-token': first.reviewToken }))).status).toBe(400);
  const shared: any = await (await handler(post(sharePath, { consent: true }, { 'x-mochi-review-token': first.reviewToken }))).json();
  expect(shared.url).toMatch(/^\/check\/\?share=[a-f0-9]{64}$/);
  expect(shared.url).not.toContain(first.reviewToken);
  const published: any = await (await handler(new Request(`https://mochi.test/api/claims/shared/${shared.shareId}`))).json();
  expect(published.review.sources[0].text).toBe('');
  expect(JSON.stringify(published)).not.toContain('Unquoted private research material');
  expect(computeReviewIntegrityHash(published.review)).toBe(first.review.integrityHash);
  const correctionPath = `shared/${shared.shareId}/corrections`;
  expect((await handler(post(correctionPath, { note: 'Owner correction', consent: true }))).status).toBe(404);
  expect((await handler(post(correctionPath, { note: 'Owner correction' }, { 'x-mochi-review-token': first.reviewToken }))).status).toBe(400);
  expect((await handler(post(correctionPath, { note: 'Owner correction', consent: true }, { 'x-mochi-review-token': first.reviewToken, 'x-mochi-access-token': 'wrong' }))).status).toBe(401);
  const corrected: any = await (await handler(post(correctionPath, { note: 'Owner correction', consent: true }, { 'x-mochi-review-token': first.reviewToken }))).json();
  expect(corrected.review).toEqual(published.review);
  expect(computeReviewIntegrityHash(corrected.review)).toBe(first.review.integrityHash);
  expect(corrected.corrections).toEqual([{ note: 'Owner correction', createdAt: expect.any(String) }]);
  expect(JSON.stringify(corrected)).not.toContain(first.reviewToken);
  expect((await handler(post(`shared/${shared.shareId}/unpublish`, { confirm: true }))).status).toBe(404);
  const unpublished = await handler(post(`shared/${shared.shareId}/unpublish`, { confirm: true }, { 'x-mochi-review-token': first.reviewToken }));
  expect(unpublished.status).toBe(200);
  expect((await handler(new Request(`https://mochi.test/api/claims/shared/${shared.shareId}`))).status).toBe(404);
  const again: any = await (await handler(post(sharePath, { consent: true }, { 'x-mochi-review-token': first.reviewToken }))).json();
  expect(again.shareId).not.toBe(shared.shareId);
  expect((await handler(new Request(`https://mochi.test/api/claims/shared/${again.shareId}`))).status).toBe(200);
});

test('expiry and daily limits prevent repeat expensive requests without losing published records', async () => {
  let time = Date.parse('2026-09-28T00:00:00Z');
  const handler = createClaimsHandler({ store: makeStore(), accessToken: ACCESS, researcher: async () => bundle, reviewer: b => reviewBundle(b, jurors), now: () => new Date(time), maxActionsPerDay: 1 });
  const first: any = await (await handler(post('research', { claim: bundle.claim, consent: true }))).json();
  expect((await handler(post('reviews', { researchToken: first.researchToken, consent: true }))).status).toBe(429);
  time += 31 * 60_000;
  expect((await handler(post('reviews', { researchToken: first.researchToken, consent: true }))).status).toBe(410);
});

test('durable store preserves public results and budgets across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mochi-claims-store-'));
  const path = join(dir, 'public.sqlite');
  const review = await reviewBundle(bundle, jurors);
  const publicationId = 'd'.repeat(64);
  const store = new SqlitePublicClaimStore(path);
  const recovery = 'c'.repeat(64);
  const recoveryHash = createHash('sha256').update(recovery).digest('hex');
  store.publish(publicationId, review, recoveryHash); expect(store.reserve('2026-09-28', 1)).toBe(true); store.close();
  const reopened = new SqlitePublicClaimStore(path);
  try {
    expect(reopened.shared(publicationId)?.review.id).toBe(review.id); expect(reopened.ownerHash(publicationId)).toBe(recoveryHash);
    const handler = createClaimsHandler({ store: reopened, accessToken: ACCESS, researcher: async () => bundle, reviewer: b => reviewBundle(b, jurors) });
    const manage = (secret: string) => new Request(`https://mochi.test/api/claims/shared/${publicationId}/corrections`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mochi-access-token': ACCESS, 'x-mochi-review-token': secret }, body: JSON.stringify({ note: 'Restart correction', consent: true }) });
    expect((await handler(manage('wrong'))).status).toBe(404);
    expect((await handler(manage(recovery))).status).toBe(200);
    expect(reopened.shared(publicationId)?.corrections).toHaveLength(1);
    expect(reopened.reserve('2026-09-28', 1)).toBe(false);
  }
  finally { reopened.close(); await rm(dir, { recursive: true, force: true }); }
});

test('source retrieval through independent jury to public output integrates without fabricated citations', async () => {
  const researcher = createResearcher({ fetchSource: async url => ({ url, title: 'Fixture primary source', text: privateText }) });
  const independentJurors: Juror[] = [1, 2, 3].map(n => ({ id: `model-${n}`, model: `test-${n}`, assess: async b => ({ assessment: 'supported', explanation: 'The cited license supports this fixture claim.', citations: [{ sourceId: b.sources[0]!.id, quote: 'The fictional release uses the MIT license.' }], limitations: ['Synthetic integration fixture.'] }) }));
  const handler = createClaimsHandler({ store: makeStore(), accessToken: ACCESS, researcher, reviewer: b => reviewBundle(b, independentJurors) });
  const evidence: any = await (await handler(post('research', { claim: bundle.claim, sourceUrls: ['https://example.com/license'], consent: true }))).json();
  const result: any = await (await handler(post('reviews', { researchToken: evidence.researchToken, consent: true }))).json();
  expect(result.review.assessment).toBe('supported'); expect(result.review.agreement.count).toBe(3);
  expect(result.review.execution).toBe('unattested_research');
  expect(result.review.sources[0].contentHash).toHaveLength(64);
});

 test('legacy publications migrate without granting ownership and correction history is bounded', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mochi-legacy-')),path=join(dir,'legacy.sqlite');
  const review=await reviewBundle(bundle,jurors);const id='e'.repeat(64),secret='f'.repeat(64);
  const legacy=new Database(path);legacy.exec('CREATE TABLE claim_publications(id TEXT PRIMARY KEY,review TEXT NOT NULL)');
  legacy.query('INSERT INTO claim_publications VALUES (?,?)').run(id,JSON.stringify(review));legacy.close();
  const store=new SqlitePublicClaimStore(path);
  try{
    expect(store.shared(id)?.review.id).toBe(review.id);expect(store.ownerHash(id)).toBeNull();
    const handler=createClaimsHandler({store,accessToken:ACCESS,researcher:async()=>bundle,reviewer:b=>reviewBundle(b,jurors)});
    expect((await handler(post(`shared/${id}/unpublish`,{confirm:true},{'x-mochi-review-token':secret}))).status).toBe(404);
    const owned='a'.repeat(64);store.publish(owned,review,createHash('sha256').update(secret).digest('hex'));
    for(let i=0;i<100;i++)expect(store.correct(owned,{note:`note ${i}`,createdAt:'2026-09-28T00:00:00.000Z'})).toBe(true);
    expect(store.correct(owned,{note:'overflow',createdAt:'2026-09-28T00:00:00.000Z'})).toBe(false);
    expect(store.shared(owned)?.corrections).toHaveLength(100);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
 });
