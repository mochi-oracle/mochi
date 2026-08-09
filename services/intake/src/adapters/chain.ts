import { createChain, PanelEscalationAbi, type Deployment } from "@mochi/chain";
import type { Hex } from "viem";
import type { IntakeChainPort } from "../ports.ts";
import { Role } from "@mochi/core";

export function createIntakeChain(dep: Deployment): IntakeChainPort {
  const chain = createChain(dep);
  return {
    async getQuery(queryId: Hex) {
      const q = await chain.getQuery(queryId);
      return {
        status: q.status, docCommit: q.docCommit, paramsHash: q.paramsHash, schemaId: q.schemaId,
        schemaVersion: q.schemaVersion, isPublic: q.isPublic, allowPanelDisclosure: q.allowPanelDisclosure,
      };
    },
    async getPanelCase(queryId) {
      const c = await chain.publicClient.readContract({
        address: dep.contracts.panel, abi: PanelEscalationAbi, functionName: "getCase", args: [queryId],
      }) as { status: number; panelIndex: number };
      return { status: Number(c.status), panelIndex: Number(c.panelIndex) };
    },
    async panelOf(queryId, panelIndex) {
      return await chain.publicClient.readContract({
        address: dep.contracts.panel, abi: PanelEscalationAbi, functionName: "panelOf", args: [queryId, panelIndex],
      }) as unknown as Hex[];
    },
    jurorsOf: (queryId) => chain.jurorsOf(queryId),
    isActive: (key, role) => chain.isActive(key, role),
    async getJuror(key) { return { measurement: (await chain.getJuror(key)).measurement }; },
  };
}
