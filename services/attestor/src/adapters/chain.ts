import { JurorRegistryAbi, createChain, type Deployment } from "@mochi/chain";
import type { Address } from "viem";
import type { ChainPort } from "../ports.ts";

export function createChainAdapter(deployment: Deployment, privateKey?: `0x${string}`): ChainPort {
  const chain = createChain(deployment, privateKey ? { privateKey } : {});
  const enrolledEvent = JurorRegistryAbi.find((item) => item.type === "event" && item.name === "Enrolled");
  if (!enrolledEvent) throw new Error("JurorRegistryAbi is missing Enrolled");
  return {
    blockNumber: () => chain.blockNumber(),
    async getEnrolled(fromBlock, toBlock) {
      const logs = await chain.publicClient.getLogs({
        address: deployment.contracts.jurorRegistry,
        event: enrolledEvent as never,
        fromBlock,
        toBlock,
      });
      return logs.flatMap((log) => {
        const args = (log as { args?: { key?: Address } }).args;
        return args?.key ? [{ key: args.key }] : [];
      });
    },
    getJuror: (key) => chain.getJuror(key),
    isActive: (key, role) => chain.isActive(key, role),
    measurementAllowed: (measurement, role) => chain.publicClient.readContract({
      address: deployment.contracts.jurorRegistry,
      abi: JurorRegistryAbi,
      functionName: "allowedMeasurement",
      args: [measurement, role],
    }) as Promise<boolean>,
    refreshAttestation: (keys, until) => chain.refreshAttestation(keys, until),
    reportAttestationFailure: (key) => chain.reportAttestationFailure(key),
  };
}
