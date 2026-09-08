import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment, chainFor, PanelEscalationAbi, QueryEscrowAbi, MochiVerdictsAbi, FeedsAbi } from "@mochi/chain";
import type { ChainPort, PanelCase } from "../ports.ts";

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

export function createPanelChain(options: { deploymentPath: string; rpcUrl: string; keeperKey: Hex; confirmations: number }): ChainPort {
  const dep = loadDeployment(options.deploymentPath);
  const chain = chainFor({ ...dep, rpcUrl: options.rpcUrl });
  const transport = http(options.rpcUrl, { timeout: 15_000 });
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(options.keeperKey);
  const wallet = createWalletClient({ chain, transport, account });
  const c = dep.contracts;
  const read = async <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  const write = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<Hex> => {
    const { request } = await publicClient.simulateContract({ account, address, abi: abi as never, functionName: functionName as never, args: args as never });
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: options.confirmations });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction reverted`);
    return hash;
  };
  const toPanelCase = (raw: Record<string, unknown>) => ({
    queryId: raw.queryId as Hex, status: Number(raw.status), panelIndex: Number(raw.panelIndex), sealBlock: BigInt(raw.sealBlock as bigint),
    commitDeadline: BigInt(raw.commitDeadline as bigint), revealDeadline: BigInt(raw.revealDeadline as bigint), appealDeadline: BigInt(raw.appealDeadline as bigint),
    payer: raw.payer as Address, fee: BigInt(raw.fee as bigint), outcomeAnswerHash: raw.outcomeAnswerHash as Hex, outcomePayloadHash: raw.outcomePayloadHash as Hex,
  });
  return {
    dep: { startBlock: dep.startBlock, randomness: dep.randomness, contracts: { panel: c.panel, feeds: c.feeds, randomness: c.randomness } },
    beaconChain: { publicClient: publicClient as never, walletClient: wallet as never, account },
    blockNumber: () => publicClient.getBlockNumber(),
    timestamp: async () => BigInt((await publicClient.getBlock()).timestamp),
    async getPanelEvents(from, to) {
      const logs = await publicClient.getLogs({ address: c.panel, events: [
        { type: "event", name: "Escalated", inputs: [{ indexed: true, name: "caseId", type: "bytes32" }, { indexed: true, name: "queryId", type: "bytes32" }, { indexed: false, name: "payer", type: "address" }, { indexed: false, name: "fee", type: "uint256" }] },
        { type: "event", name: "Appealed", inputs: [{ indexed: true, name: "caseId", type: "bytes32" }, { indexed: false, name: "payer", type: "address" }, { indexed: false, name: "fee", type: "uint256" }] },
      ], fromBlock: from, toBlock: to });
      return [...new Set(logs.map((entry) => (entry.args as { caseId?: Hex }).caseId).filter((id): id is Hex => !!id))];
    },
    async getCase(caseId) { return toPanelCase(await read<Record<string, unknown>>(c.panel, PanelEscalationAbi, "getCase", [caseId])); },
    panelOf: (caseId, panelIndex) => read<Address[]>(c.panel, PanelEscalationAbi, "panelOf", [caseId, panelIndex]),
    async getQuery(queryId) { const q = await read<Record<string, unknown>>(c.queryEscrow, QueryEscrowAbi, "getQuery", [queryId]); return { schemaId: Number(q.schemaId), schemaVersion: Number(q.schemaVersion), isPublic: Boolean(q.isPublic), status: Number(q.status) }; },
    latestVerdictOf: (queryId) => read<Hex>(c.verdicts, MochiVerdictsAbi, "latestVerdictOf", [queryId]),
    async simulateResolve(caseId) {
      try {
        await publicClient.simulateContract({ account, address: c.panel, abi: PanelEscalationAbi, functionName: "resolve", args: [caseId] });
        return true;
      } catch { return false; }
    },
    draw: (caseId) => write(c.panel, PanelEscalationAbi, "draw", [caseId]),
    reseal: (caseId) => write(c.panel, PanelEscalationAbi, "reseal", [caseId]),
    resolve: (caseId) => write(c.panel, PanelEscalationAbi, "resolve", [caseId]),
    finalize: (caseId) => write(c.panel, PanelEscalationAbi, "finalize", [caseId]),
    feedsUpdate: (feedId, key, verdictId, payload) => write(c.feeds, FeedsAbi, "update", [feedId, key, verdictId, payload]),
    async feedLatest(feedId, key) {
      const result = await read<{ verdictId?: Hex } | readonly unknown[]>(c.feeds, FeedsAbi, "latest", [feedId, key]);
      if (Array.isArray(result)) return { verdictId: result[0] as Hex };
      const entry = result as { verdictId?: Hex };
      return entry.verdictId ? { verdictId: entry.verdictId } : null;
    },
    panelStake: (evaluator) => read<bigint>(c.panel, PanelEscalationAbi, "stakeOf", [evaluator]),
    approvePanel: (amount) => write(c.usdg, erc20Abi, "approve", [c.panel, amount]),
    stake: (amount) => write(c.panel, PanelEscalationAbi, "stake", [amount]),
    commit: (caseId, value) => write(c.panel, PanelEscalationAbi, "commit", [caseId, value]),
    reveal: (caseId, answerHash, payloadHash, salt) => write(c.panel, PanelEscalationAbi, "reveal", [caseId, answerHash, payloadHash, salt]),
  };
}
