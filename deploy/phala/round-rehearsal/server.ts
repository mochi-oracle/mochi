import { join } from 'node:path';
import { DcapQuoteVerifier, DstackQuoteSource, FileSealedStore, PcsCollateralSource, TdxTeeProvider, tdxQuoteMeasurement, type QuoteVerifier } from '@mochi/tee';
import type { ModelRunner } from '../../../services/juror/src/runner.ts';
import { boundedHttpsFetch } from '../rehearsal/http.ts';
import { createRoundHandler } from './app.ts';
import { createRoundRehearsal, ROUND_REHEARSAL_FIXTURE, ROUND_REHEARSAL_MODEL_OUTPUT, type RoundRehearsalInput } from './round.ts';

// This entry point deliberately cannot run a production review or spend model credits.
if (process.env.TEE_MODE !== 'dstack' || process.env.TEE_KEYS !== 'ephemeral' || process.env.MOCHI_ROUND_MODE !== 'synthetic-only') {
  throw new Error('Round rehearsal requires dstack, ephemeral keys and explicit synthetic-only mode.');
}
const quoteSource = new DstackQuoteSource({ socketPath: process.env.DSTACK_SOCKET ?? '/var/run/dstack.sock' });
const tees: TdxTeeProvider[] = [];
for (let i = 0; i < 5; i++) tees.push(await TdxTeeProvider.create({ measurementOf: tdxQuoteMeasurement, quoteSource }));
const [intake, consensus, one, two, three] = tees as [TdxTeeProvider,TdxTeeProvider,TdxTeeProvider,TdxTeeProvider,TdxTeeProvider];
if (new Set(tees.map(tee => tee.measurement())).size !== 1) throw new Error('Co-resident rehearsal measurements differ.');
const dcap = new DcapQuoteVerifier({
  collateral: new PcsCollateralSource({ fetch: boundedHttpsFetch as typeof fetch }),
  policy: { allowedStatuses: ['UpToDate'], allowDebug: false },
});
const quoteVerifier: QuoteVerifier = {
  async verify(quote, expected) {
    const result = await dcap.verify(quote, { ...expected, maxAgeSec: 300 });
    if (!result.ok || result.tcbStatus !== 'UpToDate' || result.advisoryIds.length) return { ok: false, reason: 'Strict rehearsal attestation policy rejected quote.' };
    return result;
  },
};
// Fixed outputs exercise the protocol handoffs, not model quality or model independence.
const runner = (): ModelRunner => ({
  async run(input) {
    if (input.document !== ROUND_REHEARSAL_FIXTURE.evidence) throw new Error('Synthetic runner accepts only the fixed fixture.');
    return ROUND_REHEARSAL_MODEL_OUTPUT;
  },
});
const directory = process.env.SEALED_STORE_DIR ?? '/tmp/round';
const service = createRoundRehearsal({
  tees: { intake, consensus, jurors: [one,two,three] }, quoteVerifier,
  stores: {
    intake: new FileSealedStore(join(directory,'intake'),intake),
    consensus: new FileSealedStore(join(directory,'consensus'),consensus),
    jurors: [one,two,three].map((tee,i) => new FileSealedStore(join(directory,`juror-${i}`),tee)) as [FileSealedStore,FileSealedStore,FileSealedStore],
  },
  runners: [runner(),runner(),runner()],
  clock: { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve,ms)) },
});
const handler = createRoundHandler({
  attestations: () => service.attestations(),
  run: input => service.run(input as RoundRehearsalInput),
});
const server = Bun.serve({
  hostname: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? '8080'),
  maxRequestBodySize: 24*1024, idleTimeout: 120, fetch: handler,
});
const timer = setTimeout(() => { server.stop(true); process.exit(0); },30*60*1000);
timer.unref();
console.info('Mochi synthetic confidential round rehearsal ready');
