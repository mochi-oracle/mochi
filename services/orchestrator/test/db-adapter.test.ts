import { expect, test } from "bun:test";
import { createDb, queries } from "@mochi/db";
import { openQueryFilter } from "../src/adapters/db.ts";

// Renders the listing query only: the client is lazy and never connects.
const { db } = createDb("postgres://mochi:mochi@127.0.0.1:1/mochi");
const listing = (escalatedFeed?: boolean) => db.select({ id: queries.id }).from(queries).where(openQueryFilter(escalatedFeed)).toSQL();

test("the open-query listing is unchanged without a panel", () => {
  expect(listing()).toEqual({ sql: `select "id" from "queries" where "queries"."status" not in ($1, $2, $3)`, params: [3, 5, 6] });
  expect(listing(false)).toEqual(listing());
});

test("with a panel configured it also lists ESCALATED feed queries, and only those", () => {
  expect(listing(true)).toEqual({
    sql: `select "id" from "queries" where ("queries"."status" not in ($1, $2, $3) or ("queries"."status" = $4 and "queries"."id" in (select "feed_queries"."query_id" from "feed_queries")))`,
    params: [3, 5, 6, 5],
  });
});
