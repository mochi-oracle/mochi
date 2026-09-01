import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, migrate } from "../src/index.ts";
import { getCursor, getEndpoint, getFeedQuery, getPayerResultKey, insertFeedQuery, setCursor, putPayerResultKey, upsertEndpoint } from "../src/services-repo.ts";

const schema = `t_svc_${Math.random().toString(36).slice(2, 10)}`;
const handle = createDb(undefined, { schema });

beforeAll(async () => {
  await migrate(handle.sql, { schema });
});
afterAll(async () => {
  await handle.sql`DROP SCHEMA IF EXISTS ${handle.sql(schema)} CASCADE`;
  await handle.close();
});

test("endpoint directory upsert", async () => {
  const addr = `0x${"ab".repeat(20)}`;
  await upsertEndpoint(handle.db, addr, 1, "http://127.0.0.1:9001");
  await upsertEndpoint(handle.db, addr, 1, "http://127.0.0.1:9002");
  expect((await getEndpoint(handle.db, addr))?.url).toBe("http://127.0.0.1:9002");
});

test("feed query, payer key, cursor", async () => {
  const q = `0x${"01".repeat(32)}`;
  await insertFeedQuery(handle.db, q, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`);
  expect((await getFeedQuery(handle.db, q))?.feedId).toBe(`0x${"02".repeat(32)}`);
  await putPayerResultKey(handle.db, q, `0x${"04".repeat(32)}`);
  expect(await getPayerResultKey(handle.db, q)).toBe(`0x${"04".repeat(32)}`);
  // First write wins: a second key under the same commitment is ignored (no overwrite/DoS of someone else's query).
  await putPayerResultKey(handle.db, q, `0x${"05".repeat(32)}`);
  expect(await getPayerResultKey(handle.db, q)).toBe(`0x${"04".repeat(32)}`);
  await setCursor(handle.db, "indexer", 123n);
  await setCursor(handle.db, "indexer", 456n);
  expect(await getCursor(handle.db, "indexer")).toBe(456n);
});

test("schema ids above 7 are accepted after 0002", async () => {
  await handle.sql`INSERT INTO schemas (id, version, json_hash, prompt_hash, tolerances, crosschecks, active)
    VALUES (8, 1, ${`0x${"00".repeat(32)}`}, ${`0x${"00".repeat(32)}`}, '{}'::jsonb, '{}'::jsonb, true)`;
});
