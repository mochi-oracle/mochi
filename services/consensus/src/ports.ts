import type { Address, Hex } from "viem";
import type { QueryView, JurorView } from "@mochi/chain";

export interface ConsensusChainPort {
  getQuery(queryId: Hex): Promise<QueryView>;
  jurorsOf(queryId: Hex): Promise<Address[]>;
  getJuror(juror: Address): Promise<JurorView>;
}

export interface Clock { now(): number }
