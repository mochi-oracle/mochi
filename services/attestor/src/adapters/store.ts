import { getCursor, getEndpoint, setCursor, upsertEndpoint, setJurorPassport } from "@mochi/db";
import { upsertJuror } from "@mochi/db";
import type { Database } from "@mochi/db";
import type { Store } from "../ports.ts";

export function createStore(db: Database): Store {
  return {
    getCursor: (name) => getCursor(db, name),
    setCursor: (name, block) => setCursor(db, name, block),
    async getEndpoint(address) {
      const row = await getEndpoint(db, address.toLowerCase());
      return row ? { address: row.address, role: row.role, url: row.url } : null;
    },
    upsertEndpoint: (address, role, url) => upsertEndpoint(db, address.toLowerCase(), role, url),
    upsertJuror: (record) => upsertJuror(db, record),
    setJurorPassport: (key, passport, passportSig) => setJurorPassport(db, key.toLowerCase(), passport, passportSig),
  };
}
