import { getPanelPayloadByHash, insertPanelPayload, getVerdict, getCursor, getFeedQuery, setCursor, type Database } from "@mochi/db";
import type { Store } from "../ports.ts";

export function createPanelStore(db: Database): Store {
  return {
    getCursor: (name) => getCursor(db, name),
    setCursor: (name, block) => setCursor(db, name, block),
    getFeedQuery: async (queryId) => {
      const result = await getFeedQuery(db, queryId);
      return result ? { feedId: result.feedId, key: result.key } : null;
    },
    getPanelPayloadByHash: async (caseId, payloadHash) => {
      const result = await getPanelPayloadByHash(db, caseId, payloadHash);
      return result ? { payload: result.payload } : null;
    },
    insertPanelPayload: (input) => insertPanelPayload(db, input),
    getVerdict: async (id) => {
      const result = await getVerdict(db, id);
      return result ? { verdict: result.verdict as unknown as Record<string, unknown>, publicPart: result.publicPart ? { dissent: result.publicPart.dissent, fieldAgreement: result.publicPart.fieldAgreement } : null } : null;
    },
  };
}
