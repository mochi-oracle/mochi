import type { Address, Hex } from "viem";
import { createChain, loadDeployment } from "@mochi/chain";
import type { JurorChainPort } from "../ports.ts";

export function createJurorChain(path: string): JurorChainPort {
  const chain = createChain(loadDeployment(path));
  return {
    async getQuery(queryId: Hex) {
      const query = await chain.getQuery(queryId);
      return {
        status: query.status,
        docCommit: query.docCommit,
        paramsHash: query.paramsHash,
        schemaId: query.schemaId,
        schemaVersion: query.schemaVersion,
      };
    },
    jurorsOf: (queryId) => chain.jurorsOf(queryId),
    isActive: (key: Address, role: number) => chain.isActive(key, role),
    getJuror: async (key: Address) => ({ measurement: (await chain.getJuror(key)).measurement }),
  };
}
