import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { AspTree, STATE_ABI } from "./index.ts";

export const POSTMAN_ABI = parseAbi(["function updateRoot(uint256 _root,string _ipfsCID) returns (uint256)", "function latestRoot() view returns (uint256)", "function scopeToPool(uint256) view returns (address)", "function assetConfig(address) view returns (address pool,uint16 vettingFeeBPS,uint16 maxRelayFeeBPS,uint256 minimumDepositAmount)"]);
// Entrypoint validates only length (32..64 bytes); fixed 46-byte placeholder intentionally makes no content claim.
export const PLACEHOLDER_ASP_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3ozf3v2x5b7v4z5q";
export type PostmanOptions = { client: PublicClient; wallet: WalletClient; entrypoint: Address; pool: Address; fromBlock: bigint; approvalDelaySeconds?: number; pollMs?: number; signal?: AbortSignal };
export async function runPostman(options: PostmanOptions) {
  const { client, wallet, entrypoint, pool } = options;
  const tree = new AspTree();
  let cursor = options.fromBlock;
  // A fresh Entrypoint reverts latestRoot() with NoRootsAvailable until the first root is posted: start from 0.
  let lastRoot = await client.readContract({ address: entrypoint, abi: POSTMAN_ABI, functionName: "latestRoot" }).catch(() => 0n);
  const account = wallet.account; if (!account) throw new Error("postman wallet account required");
  while (!options.signal?.aborted) {
    const tip = await client.getBlockNumber();
    if (tip >= cursor) {
      const logs = await client.getLogs({ address: pool, event: STATE_ABI[1], fromBlock: cursor, toBlock: tip });
      logs.sort((a,b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : a.logIndex! - b.logIndex!);
      for (const log of logs) {
        if (options.approvalDelaySeconds) {
          const block = await client.getBlock({ blockNumber: log.blockNumber! });
          const dueAt = Number(block.timestamp) + options.approvalDelaySeconds;
          while (!options.signal?.aborted && Math.floor(Date.now()/1000) < dueAt) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, dueAt-Math.floor(Date.now()/1000))));
        }
        tree.add(log.args._label!);
      }
      if (tree.tree.size && tree.root !== lastRoot) {
        const hash = await wallet.writeContract({ address: entrypoint, abi: POSTMAN_ABI, functionName: "updateRoot", args: [tree.root, PLACEHOLDER_ASP_CID], account, chain: null });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Entrypoint.updateRoot reverted");
        lastRoot = tree.root;
      }
      cursor = tip + 1n;
    }
    if (!options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
  return tree;
}
