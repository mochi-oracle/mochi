import { createDb, insertFeedQuery, type Database } from "@mochi/db";
import type { FeedQueryRepo } from "../ports.ts";
import type { Hex } from "viem";

export function createFeedQueryRepo(db: Database): FeedQueryRepo {
  return { insertFeedQuery: (queryId: Hex, feedId: Hex, key: Hex) => insertFeedQuery(db, queryId, feedId, key) };
}
export { createDb };
