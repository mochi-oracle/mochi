import { createChain, loadDeployment, QueryEscrowAbi, StockTokenCrosscheckAbi } from "@mochi/chain";
import type { ChainPort } from "../ports.ts";
import { erc20Abi, type Address, type Hex } from "viem";

export function createFeedChain(deploymentPath: string, privateKey: Hex, confirmations = 1): ChainPort {
  const dep = loadDeployment(deploymentPath);
  const chain = createChain(dep, { privateKey });
  const account = chain.account!;
  const publicClient = chain.publicClient;
  const wallet = chain.walletClient!;
  async function write(address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
    const { request } = await publicClient.simulateContract({ account, address, abi: abi as never, functionName: functionName as never, args: args as never });
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  }
  return {
    isActive: (address, role) => chain.isActive(address, role),
    getJuror: async (address) => ({ measurement: (await chain.getJuror(address)).measurement }),
    computeQueryId: (sender, docCommit, nonce) => chain.computeQueryId(sender, docCommit, nonce),
    openFeed: async (params, provenance, signature) => {
      const hash = await chain.openFeed(params, provenance, signature);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
      if (receipt.status !== "success") throw new Error("openFeed reverted");
      return hash;
    },
    feedBudget: () => publicClient.readContract({ address: dep.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "feedBudget" }),
    usdgBalance: (address) => publicClient.readContract({ address: dep.contracts.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    approveUsdg: (amount) => write(dep.contracts.usdg, erc20Abi, "approve", [dep.contracts.queryEscrow, amount]),
    fundFeedBudget: (amount) => write(dep.contracts.queryEscrow, QueryEscrowAbi, "fundFeedBudget", [amount]),
  };
}

const multiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Stock Token reads (ABI verified on RHC testnet; see IStockTokenMultiplier). With a key, also records the pre-change
 *  multiplier on StockTokenCrosscheck while a change is pending (permissionless; the contract reads the token itself). */
export function createStockTokenReader(deploymentPath: string, privateKey?: Hex, confirmations = 1): import("../ports.ts").StockTokenReader {
  const dep = loadDeployment(deploymentPath);
  const chain = createChain(dep, privateKey ? { privateKey } : undefined);
  const client = chain.publicClient;
  const crosscheck = dep.contracts.stockTokenCrosscheck;
  return {
    readMultiplierSchedule: async (token) => {
      const [uiMultiplier, newUIMultiplier, effectiveAt] = await Promise.all([
        client.readContract({ address: token, abi: multiplierAbi, functionName: "uiMultiplier" }),
        client.readContract({ address: token, abi: multiplierAbi, functionName: "newUIMultiplier" }),
        client.readContract({ address: token, abi: multiplierAbi, functionName: "effectiveAt" }),
      ]);
      return { uiMultiplier, newUIMultiplier, effectiveAt };
    },
    ...(privateKey ? {
      recordBaseline: async (tickerKey: Hex, effectiveAt: bigint) => {
        const recorded = await client.readContract({ address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "baselineOf", args: [tickerKey, effectiveAt] });
        if (recorded !== 0n) return false;
        const { request } = await client.simulateContract({ account: chain.account!, address: crosscheck, abi: StockTokenCrosscheckAbi, functionName: "recordBaseline", args: [tickerKey] });
        const hash = await chain.walletClient!.writeContract(request as never);
        const receipt = await client.waitForTransactionReceipt({ hash, confirmations });
        if (receipt.status !== "success") throw new Error("recordBaseline reverted");
        return true;
      },
    } : {}),
  };
}
