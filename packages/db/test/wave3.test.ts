import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, migrate } from "../src/index.ts";
import {
  activeFeedSubscribers, getDisclosure, getPanelPayloadByHash, insertDisclosure, insertPanelPayload,
  modelDisagreementSeries, paidVerdictCounts, recordModelDisagreement, upsertFeedSubscription,
} from "../src/wave3-repo.ts";

const schema = `t_w3_${Math.random().toString(36).slice(2, 10)}`;
const handle = createDb(undefined, { schema });
const h = (b: string) => `0x${b.repeat(32)}`;
beforeAll(async () => { await migrate(handle.sql, { schema }); });
afterAll(async () => { await handle.sql`DROP SCHEMA IF EXISTS ${handle.sql(schema)} CASCADE`; await handle.close(); });

test("per-model disagreement merges exactly", async () => {
  const base = { bucket: new Date("2026-09-26T00:00:00Z"), window: "1 day", schemaId: 3, field: "eps_gaap_diluted", modelId: "qwen3-72b" };
  await recordModelDisagreement(handle.db, [{ ...base, samples: 4, disagreeCount: 1 }]);
  await recordModelDisagreement(handle.db, [{ ...base, samples: 4, disagreeCount: 3 }]);
  const rows = await modelDisagreementSeries(handle.db, 3, "eps_gaap_diluted", "1 day");
  expect(rows[0]?.samples).toBe(8);
  expect(Number(rows[0]?.disagreeRate)).toBeCloseTo(0.5);
});

test("disclosures, subscriptions, panel payloads", async () => {
  await insertDisclosure(handle.db, h("01"), h("02"), new Uint8Array([1, 2, 3]));
  expect((await getDisclosure(handle.db, h("01"), h("02")))?.envelope).toEqual(new Uint8Array([1, 2, 3]));
  await upsertFeedSubscription(handle.db, h("03"), `0x${"ab".repeat(20)}`, new Date(Date.now() + 86400e3), 10n);
  expect(await activeFeedSubscribers(handle.db, new Date())).toBe(1);
  await insertPanelPayload(handle.db, { caseId: h("04"), panelIndex: 0, evaluator: `0x${"cd".repeat(20)}`, payloadHash: h("05"), payload: new Uint8Array([9]) });
  expect((await getPanelPayloadByHash(handle.db, h("04"), h("05")))?.payload).toEqual(new Uint8Array([9]));
});

test("paid verdict counts exclude feed queries and internal payers", async () => {
  const q = (id: string, payPath: number, payer: string | null) => handle.sql`
    INSERT INTO queries (id, ts, doc_commit, schema_id, schema_version, n, round, is_public, pay_path, payer_commit, params_hash, provenance_kind, origin_id, tokens_k, status, payer)
    VALUES (${id}, now(), ${h("00")}, 2, 1, 3, 0, true, ${payPath}, ${h("00")}, ${h("00")}, 0, ${h("00")}, 1, 3, ${payer})`;
  const v = (id: string, qid: string) => handle.sql`
    INSERT INTO verdicts (id, ts, query_id, round, status, agreement_bps, dissent_mask, timeout_mask, evidence_root, attestation_root, answer_hash, payload_hash, is_public, escalated, tx)
    VALUES (${id}, now(), ${qid}, 0, 1, 10000, 0, 0, ${h("00")}, ${h("00")}, ${h("00")}, ${h("00")}, true, false, ${h("00")})`;
  await q(h("a1"), 0, `0x${"11".repeat(20)}`); await v(h("b1"), h("a1"));
  await q(h("a2"), 0, `0x${"22".repeat(20)}`); await v(h("b2"), h("a2"));
  await q(h("a3"), 3, null); await v(h("b3"), h("a3"));
  const counts = await paidVerdictCounts(handle.db, new Date(Date.now() - 86400e3), new Date(Date.now() + 1000), [`0x${"22".repeat(20)}`]);
  expect(counts).toEqual({ external: 1, total: 3 });
});

test("anonyma vouchers: duplicate insert is a no-op; settle marks by id", async () => {
  const { insertAnonymaVoucher, markVouchersSettled, anonymaVouchers } = await import("../src/index.ts");
  const v = { voucherId: h("0a"), queryId: h("0b"), tier: 2, usdgAmount: "23300", settled: false };
  await insertAnonymaVoucher(handle.db, v);
  await insertAnonymaVoucher(handle.db, v);
  await markVouchersSettled(handle.db, [h("0a")]);
  const rows = await handle.db.select().from(anonymaVouchers);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.settled).toBe(true);
});
