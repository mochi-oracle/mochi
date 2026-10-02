import { QueryEscrowAbi, PanelEscalationAbi, MockUSDGAbi, createChain, type Deployment } from "@mochi/chain";
import { parseAbiItem, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainPort, QueryLog } from "../ports.ts";

const opened = parseAbiItem("event QueryOpened(bytes32 indexed queryId,uint8 payPath,uint32 schemaId,uint16 schemaVersion,uint8 n,bool isPublic,bytes32 docCommit,uint256 amount,uint64 sealBlock)");
const verdictPosted = parseAbiItem("event VerdictPosted(bytes32 indexed verdictId,bytes32 indexed queryId,uint8 round,uint8 status,uint16 agreementBps,uint32 dissentMask,uint32 timeoutMask,bytes32 answerHash,bytes32 payloadHash,bool isPublic)");
const expanded = parseAbiItem("event QueryExpanded(bytes32 indexed queryId,uint8 round,uint8 newN,uint256 amount,uint64 sealBlock)");
const LOG_CHUNK = BigInt(process.env.LOG_CHUNK_BLOCKS ?? "2000");
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function createChainAdapter(dep: Deployment, orchestratorKey: Hex, feedRunnerKey: Hex, transport?: Transport): ChainPort {
  const base = createChain(dep, { privateKey: orchestratorKey, ...(transport ? { transport } : {}) });
  const feed = createChain(dep, { privateKey: feedRunnerKey, ...(transport ? { transport } : {}) });
  async function write(wallet: typeof base, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) {
    const client = wallet.walletClient, account = wallet.account;
    if (!client || !account) throw new Error("wallet unavailable");
    const { request } = await wallet.publicClient.simulateContract({ account, address, abi: abi as never, functionName: functionName as never, args: args as never });
    const hash = await client.writeContract(request as never);
    const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  }
  return {
    ...base,
    async getLogs(fromBlock, toBlock) {
      // Public RPCs cap eth_getLogs ranges; scan in chunks of LOG_CHUNK blocks.
      const out: QueryLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - 1n < toBlock ? start + LOG_CHUNK - 1n : toBlock;
        const [a, b] = await Promise.all([
          base.publicClient.getLogs({ address: dep.contracts.queryEscrow, event: opened, fromBlock: start, toBlock: end }),
          base.publicClient.getLogs({ address: dep.contracts.queryEscrow, event: expanded, fromBlock: start, toBlock: end }),
        ]);
        out.push(
          ...a.map((x) => ({ queryId: x.args.queryId!, blockNumber: x.blockNumber!, kind: "opened" as const })),
          ...b.map((x) => ({ queryId: x.args.queryId!, blockNumber: x.blockNumber!, kind: "expanded" as const })),
        );
      }
      return out.sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : 1));
    },
    async latestTimestamp() {
      return (await base.publicClient.getBlock({ blockTag: "latest" })).timestamp;
    },
    async verdictTx(verdictId) {
      const logs = await base.publicClient.getLogs({
        address: dep.contracts.verdicts, event: verdictPosted, args: { verdictId }, fromBlock: BigInt(dep.startBlock), toBlock: "latest",
      }).catch(async () => {
        // Range too large for this RPC: scan backwards from head in chunks.
        const head = await base.publicClient.getBlockNumber();
        for (let end = head; end >= BigInt(dep.startBlock); end -= LOG_CHUNK) {
          const start = end - LOG_CHUNK + 1n > BigInt(dep.startBlock) ? end - LOG_CHUNK + 1n : BigInt(dep.startBlock);
          const found = await base.publicClient.getLogs({ address: dep.contracts.verdicts, event: verdictPosted, args: { verdictId }, fromBlock: start, toBlock: end });
          if (found.length) return found;
          if (start === BigInt(dep.startBlock)) break;
        }
        return [];
      });
      return (logs[0]?.transactionHash ?? null) as Hex | null;
    },
    expire: (id) => write(base, dep.contracts.queryEscrow, QueryEscrowAbi, "expire", [id]),
    panelFee: () => base.publicClient.readContract({ address: dep.contracts.panel, abi: PanelEscalationAbi, functionName: "panelFee" }),
    usdgApprove: (spender, amount) => write(feed, dep.contracts.usdg, erc20, "approve", [spender, amount]),
    escrowPanel: () => base.publicClient.readContract({ address: dep.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "panel" }),
    async panelCaseStatus(id) {
      if (!dep.contracts.panel || /^0x0{40}$/i.test(dep.contracts.panel)) return 0;
      const c = await base.publicClient.readContract({ address: dep.contracts.panel, abi: PanelEscalationAbi, functionName: "getCase", args: [id] });
      return Number(c.status);
    },
    usdgAllowance: (spender) => base.publicClient.readContract({ address: dep.contracts.usdg, abi: erc20, functionName: "allowance", args: [feed.account!.address, spender] }),
    expand: (id, n) => write(feed, dep.contracts.queryEscrow, QueryEscrowAbi, "expand", [id, n]),
    escalate: (id) => write(feed, dep.contracts.panel, PanelEscalationAbi, "escalate", [id]),
  };
}
