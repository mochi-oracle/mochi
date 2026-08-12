import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, migrate, assertSchemaPrivacy, insertVerdict, PrivacyViolation, upsertFeed, listFeeds, storePrivateResult, purgeExpiredPrivateResults, getPrivateResult, recordDisagreement, disagreementSeries, insertQuery } from "../src/index.ts";
import { verdicts } from "../src/schema.ts";

const url = process.env.DATABASE_URL ?? "postgres://mochi:mochi@127.0.0.1:55432/mochi";
const schemaName = `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const admin = postgres(url);
const client = createDb(url, { schema: schemaName });
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const cols: Record<string, string[]> = {
  _mochi_migrations: ["name", "applied_at"],
  schemas: ["id","version","json_hash","prompt_hash","tolerances","crosschecks","active"],
  jurors: ["key","operator","measurement","class","role","bond","attested_until","uptime_30d","served","timeouts","slashed","delisted","passport","passport_sig"],
  queries: ["id","ts","doc_commit","schema_id","schema_version","n","round","is_public","pay_path","payer_commit","params_hash","provenance_kind","origin_id","tokens_k","status","payer"],
  juror_answers: ["query_id","round","seat","juror","class","answer_hash","spans_root","quote_hash","sig","timed_out","ts"],
  verdicts: ["id","ts","query_id","round","status","agreement_bps","dissent_mask","timeout_mask","evidence_root","attestation_root","answer_hash","payload_hash","is_public","escalated","tx"],
  verdict_public: ["verdict_id","answer","payload","dissent","field_agreement"],
  private_results: ["verdict_id","ciphertext","expires_at"],
  feeds: ["feed_id","key","verdict_id","as_of","updated_at"],
  disagreement: ["bucket","window","schema_id","field","class","disagree_rate","samples","disagree_count"],
  crosschecks: ["feed_id","key","verdict_id","ok","detail","ts"],
  escalations: ["query_id","round","panel","outcome","appealed","ts"],
  anonyma_vouchers: ["voucher_id","query_id","tier","usdg_amount","settled"],
  receipts: ["verdict_id","key_id","sig","payload","anchor_root","anchor_index"],
  anchors: ["root","ts","count","tx"],
  endpoints: ["address","role","url","updated_at"],
  feed_queries: ["query_id","feed_id","key","created_at"],
  query_meta: ["query_id","payer_result_pub","created_at"],
  payer_result_keys: ["payer_commit","pub","created_at"],
  chain_cursors: ["name","block"],
  disagreement_model: ["bucket","window","schema_id","field","model_id","disagree_rate","samples","disagree_count"],
  disclosures: ["verdict_id","recipient_key_hash","envelope","created_at"],
  feed_subscriptions: ["feed_id","consumer","until","paid"],
  panel_payloads: ["case_id","panel_index","evaluator","payload_hash","payload","answer_json","created_at"],
};

beforeAll(async () => {
  await migrate(admin, { schema: schemaName });
  await migrate(admin, { schema: schemaName });
});
afterAll(async () => {
  await admin`DROP SCHEMA IF EXISTS ${admin(schemaName)} CASCADE`;
  await client.close();
  await admin.end();
});

describe("database package", () => {
  test("migrations are repeatable, create hypertables, and use required primary keys", async () => {
    const migrationRows = await client.sql`SELECT name FROM _mochi_migrations`;
    expect(migrationRows.map((r) => r.name)).toEqual(["0001_init.sql", "0002_services.sql", "0003_receipt_anchor_nullable.sql", "0004_doc_completion.sql", "0005_payer_result_keys.sql"]);
    const hypertables = await client.sql`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema = ${schemaName}`;
    expect(hypertables.map((r) => r.hypertable_name).sort()).toEqual(["disagreement", "disagreement_model", "verdicts"]);
    const pks = await client.sql`
      SELECT tc.table_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu USING (constraint_catalog, constraint_schema, constraint_name, table_name)
      WHERE tc.table_schema = ${schemaName} AND tc.constraint_type = 'PRIMARY KEY'
      GROUP BY tc.table_name`;
    const byTable = Object.fromEntries(pks.map((r) => [r.table_name, r.columns]));
    expect(byTable.schemas).toEqual(["id", "version"]);
    expect(byTable.jurors).toEqual(["key"]);
    expect(byTable.queries).toEqual(["id"]);
    expect(byTable.juror_answers).toEqual(["query_id", "round", "seat"]);
    expect(byTable.verdicts).toEqual(["id", "ts"]);
    expect(byTable.verdict_public).toEqual(["verdict_id"]);
    expect(byTable.private_results).toEqual(["verdict_id"]);
    expect(byTable.anonyma_vouchers).toEqual(["voucher_id"]);
    expect(byTable.receipts).toEqual(["verdict_id"]);
    expect(byTable.anchors).toEqual(["root"]);
    expect(byTable.disagreement).toEqual(["schema_id", "field", "class", "window", "bucket"]);
    expect(byTable.feeds).toEqual(["feed_id", "key"]);
  });

  test("privacy check and exact column allowlist", async () => {
    await expect(assertSchemaPrivacy(client.sql)).resolves.toBeUndefined();
    const result = await client.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${schemaName}`;
    const actual: Record<string, string[]> = {};
    for (const row of result) (actual[row.table_name] ??= []).push(row.column_name);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(cols).sort());
    for (const [table, expected] of Object.entries(cols)) expect(actual[table]?.sort()).toEqual([...expected].sort());
    await client.sql`CREATE TABLE privacy_probe (doc_text text)`;
    await expect(assertSchemaPrivacy(client.sql)).rejects.toThrow("privacy_probe.doc_text");
    await client.sql`DROP TABLE privacy_probe`;
  });

  test("verdict privacy is enforced and public verdict data is atomic", async () => {
    const base = { id: id(1), ts: new Date(), queryId: id(2), round: 0, status: 1, agreementBps: 9000, dissentMask: 0n, timeoutMask: 0n, evidenceRoot: id(3), attestationRoot: id(4), answerHash: id(5), payloadHash: id(6), isPublic: false, escalated: false, tx: id(7) };
    await expect(insertVerdict(client.db, base, { answer: { ok: true }, payload: new Uint8Array([1]), dissent: {}, fieldAgreement: {} })).rejects.toBeInstanceOf(PrivacyViolation);
    expect(await client.db.select().from(verdicts)).toHaveLength(0);
    await insertVerdict(client.db, { ...base, isPublic: true }, { answer: { ok: true }, payload: new Uint8Array([2]), dissent: {}, fieldAgreement: {} });
    const result = await client.db.select().from(verdicts);
    expect(result).toHaveLength(1);
    const joined = await (await import("../src/repo.ts")).getVerdict(client.db, id(1));
    expect(joined?.publicPart?.answer).toEqual({ ok: true });
  });

  test("feed upserts move forward only and private results expire", async () => {
    const earlier = new Date("2026-01-01T00:00:00Z"), later = new Date("2026-02-01T00:00:00Z");
    await upsertFeed(client.db, "feed", "asset", id(10), later);
    await upsertFeed(client.db, "feed", "asset", id(11), earlier);
    expect((await listFeeds(client.db, "feed"))[0]?.verdictId).toBe(id(10));
    await upsertFeed(client.db, "feed", "asset", id(12), new Date("2026-03-01T00:00:00Z"));
    expect((await listFeeds(client.db, "feed"))[0]?.verdictId).toBe(id(12));
    await storePrivateResult(client.db, id(20), new Uint8Array([8, 9]), 1);
    expect((await getPrivateResult(client.db, id(20)))?.ciphertext).toEqual(new Uint8Array([8, 9]));
    expect(await purgeExpiredPrivateResults(client.db, new Date(Date.now() + 5000))).toBe(1);
    expect(await getPrivateResult(client.db, id(20))).toBeNull();
  });

  test("disagreement upserts merge counts and recompute the rate", async () => {
    const row = { bucket: new Date("2026-05-01T00:00:00Z"), window: "1 hour", schemaId: 1, field: "eps", class: 2, disagreeRate: 0.5, samples: 2, disagreeCount: 1 };
    await recordDisagreement(client.db, [row]);
    await recordDisagreement(client.db, [{ ...row, disagreeRate: 0.25, samples: 4, disagreeCount: 1 }]);
    const series = await disagreementSeries(client.db, 1, "eps", "1 hour");
    expect(series).toHaveLength(1);
    expect(series[0]?.samples).toBe(6);
    expect(series[0]?.disagreeCount).toBe(2);
    expect(Number(series[0]?.disagreeRate)).toBeCloseTo(1 / 3);
  });

  test("zod rejects malformed identifiers before writes", async () => {
    await expect(insertQuery(client.db, { id: "bad", ts: new Date(), docCommit: id(1), schemaId: 1, schemaVersion: 1, n: 3, round: 0, isPublic: true, payPath: 0, payerCommit: id(2), paramsHash: id(3), provenanceKind: 1, originId: id(4), tokensK: 1, status: 1 } as never)).rejects.toThrow();
  });
});
