import type { Chain } from "@mochi/chain";
import type { ConsensusChainPort } from "../ports.ts";

export function consensusChain(chain: Chain): ConsensusChainPort {
  return {
    getQuery: (queryId) => chain.getQuery(queryId),
    jurorsOf: (queryId) => chain.jurorsOf(queryId),
    getJuror: (juror) => chain.getJuror(juror),
  };
}
