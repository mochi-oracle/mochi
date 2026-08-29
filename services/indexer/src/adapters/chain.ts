import {
  decodeEventLog,
  decodeFunctionData,
  parseAbiItem,
  toEventSelector,
  type Hex,
} from "viem";
import {
  MochiVerdictsAbi,
  createChain,
  FeedsAbi,
  JurorRegistryAbi,
  loadDeployment,
  PanelEscalationAbi,
  QueryEscrowAbi,
  ReceiptAnchorAbi,
  type Deployment,
} from "@mochi/chain";
import type { ChainEvent, ChainPort, ChainVote } from "../ports.ts";

const relevantEvents = new Set([
  "QueryOpened",
  "QuerySealed",
  "QueryExpanded",
  "QuerySettled",
  "QueryExpired",
  "QueryEscalated",
  "QueryDecidedByPanel",
  "AnonymaVoucherUsed",
  "VerdictPosted",
  "PanelVerdictPosted",
  "FeedUpdated",
  "Subscribed",
  "CrosscheckFailed",
  "Enrolled",
  "AttestationRefreshed",
  "Slashed",
  "Delisted",
  "Escalated",
  "Resolved",
  "Finalized",
]);

const queryEvents = new Set([
  "QueryOpened",
  "QuerySealed",
  "QueryExpanded",
  "QuerySettled",
  "QueryExpired",
  "QueryEscalated",
  "QueryDecidedByPanel",
  "VerdictPosted",
  "PanelVerdictPosted",
  "Escalated",
]);

/** Build the production chain adapter used by indexer loops. */
export function createChainAdapter(
  deployment: Deployment,
  options: { privateKey?: Hex } = {},
): ChainPort {
  const chain = createChain(deployment, options);
  const publicClient = chain.publicClient;
  const contracts = [
    { address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi },
    { address: deployment.contracts.verdicts, abi: MochiVerdictsAbi },
    { address: deployment.contracts.feeds, abi: FeedsAbi },
    { address: deployment.contracts.jurorRegistry, abi: JurorRegistryAbi },
    { address: deployment.contracts.panel, abi: PanelEscalationAbi },
  ];
  const blockTimestamps = new Map<bigint, Date>();

  /** Return a cached block timestamp, loading it from RPC only once. */
  async function timestampForBlock(blockNumber: bigint): Promise<Date> {
    const cached = blockTimestamps.get(blockNumber);
    if (cached) return cached;
    const block = await publicClient.getBlock({ blockNumber });
    const timestamp = new Date(Number(block.timestamp) * 1_000);
    blockTimestamps.set(blockNumber, timestamp);
    return timestamp;
  }

  return {
    startBlock: BigInt(deployment.startBlock),
    chainId: deployment.chainId,
    verdictContract: deployment.contracts.verdicts,
    latestBlock: () => publicClient.getBlockNumber(),

    async events(from, to) {
      const events: ChainEvent[] = [];
      for (const contract of contracts) {
        const logs = await publicClient.getLogs({
          address: contract.address,
          fromBlock: from,
          toBlock: to,
        });
        for (const entry of logs) {
          let decoded;
          try {
            decoded = decodeEventLog({
              abi: contract.abi as never,
              data: entry.data,
              topics: entry.topics as never,
            });
          } catch {
            continue;
          }
          const name = String(decoded.eventName);
          if (!relevantEvents.has(name)) continue;

          const blockNumber = entry.blockNumber ?? from;
          events.push({
            name,
            address: entry.address,
            args: decoded.args as unknown as Record<string, unknown>,
            blockNumber,
            timestamp: await timestampForBlock(blockNumber),
            transactionHash: entry.transactionHash!,
            logIndex: entry.logIndex ?? 0,
          });
        }
      }
      return events;
    },

    async eventSnapshot(event) {
      const args = event.args;
      const queryId = String(args.queryId ?? "");
      if (queryEvents.has(event.name) && /^0x[0-9a-fA-F]{64}$/.test(queryId)) {
        const query = await chain.getQuery(queryId as Hex);
        const snapshot: Record<string, unknown> = {
          query: { ...query, ts: event.timestamp },
        };
        if (event.name === "VerdictPosted" || event.name === "PanelVerdictPosted") {
          snapshot.verdict = {
            ...await chain.getVerdict(String(args.verdictId) as Hex),
            tx: event.transactionHash,
          };
          snapshot.queryId = queryId;
        }
        if (event.name === "Escalated" && typeof args.caseId === "string") {
          const caseId = args.caseId as Hex;
          const caseView = await publicClient.readContract({
            address: deployment.contracts.panel,
            abi: PanelEscalationAbi,
            functionName: "getCase",
            args: [caseId],
          }) as { queryId?: Hex; panelIndex?: number };
          snapshot.caseView = caseView;
          if (typeof caseView.panelIndex === "number") {
            snapshot.panel = [...await publicClient.readContract({
              address: deployment.contracts.panel,
              abi: PanelEscalationAbi,
              functionName: "panelOf",
              args: [caseId, caseView.panelIndex],
            }) as readonly string[]];
          }
        }
        return snapshot;
      }

      if (event.name === "FeedUpdated") {
        const feed = await publicClient.readContract({
          address: deployment.contracts.feeds,
          abi: FeedsAbi,
          functionName: "getFeed",
          args: [String(args.feedId) as Hex],
          blockNumber: event.blockNumber,
        }) as { crosscheck?: string };
        return {
          crosscheckEnabled: Boolean(
            feed.crosscheck && feed.crosscheck !== "0x0000000000000000000000000000000000000000",
          ),
        };
      }

      if (["Escalated", "Resolved", "Finalized"].includes(event.name)
        && typeof args.caseId === "string") {
        const caseId = args.caseId as Hex;
        const caseView = await publicClient.readContract({
          address: deployment.contracts.panel,
          abi: PanelEscalationAbi,
          functionName: "getCase",
          args: [caseId],
        }) as { queryId?: Hex; panelIndex?: number };
        const panelIndex = typeof args.panelIndex === "number"
          ? args.panelIndex
          : Number(caseView.panelIndex ?? 0);
        const panel = [...await publicClient.readContract({
          address: deployment.contracts.panel,
          abi: PanelEscalationAbi,
          functionName: "panelOf",
          args: [caseId, panelIndex],
        }) as readonly string[]];
        return { caseView, panel };
      }

      if (["Enrolled", "AttestationRefreshed", "Slashed", "Delisted"].includes(event.name)
        && typeof args.key === "string") {
        const juror = await chain.getJuror(args.key as `0x${string}`);
        return {
          juror: {
            ...juror,
            key: args.key,
            attestedUntil: new Date(Number(juror.attestedUntil) * 1_000),
            bond: juror.bond.toString(),
            slashed: "0",
            uptime30d: 0,
          },
        };
      }
      return {};
    },

    async verdict(id) {
      const verdict = await chain.getVerdict(id);
      const query = await chain.getQuery(verdict.queryId);
      return {
        ...query,
        ...verdict,
        id,
        tx: "0x" + "00".repeat(32) as Hex,
        ts: verdict.ts,
        queryId: verdict.queryId,
      };
    },
    async query(id) {
      return { ...await chain.getQuery(id) };
    },
    seatJurors: (id) => chain.jurorsOf(id as Hex),
    async jurorClass(key) {
      return (await chain.getJuror(key as `0x${string}`)).jurorClass;
    },
    async votesOfPostTx(txHash): Promise<ChainVote[]> {
      const transaction = await publicClient.getTransaction({ hash: txHash });
      const decoded = decodeFunctionData({ abi: MochiVerdictsAbi, data: transaction.input });
      if (decoded.functionName !== "post") {
        throw new Error(`Verdict transaction ${txHash} did not call post`);
      }
      return decoded.args[1].map((vote) => ({
        juror: vote.juror,
        quoteHash: vote.quoteHash,
      }));
    },
    async anchor(root, count) {
      const alreadyAnchored = await publicClient.readContract({
        address: deployment.contracts.receiptAnchor,
        abi: ReceiptAnchorAbi,
        functionName: "isAnchored",
        args: [root],
      });
      if (alreadyAnchored) {
        const anchoredEvent = parseAbiItem("event Anchored(bytes32 indexed root,uint32 count,uint64 ts)");
        const startBlock = BigInt(deployment.startBlock);
        let endBlock = await publicClient.getBlockNumber();
        while (endBlock >= startBlock) {
          const fromBlock = endBlock - startBlock >= 1_999n
            ? endBlock - 1_999n
            : startBlock;
          const logs = await publicClient.request({
            method: "eth_getLogs",
            params: [{
              address: deployment.contracts.receiptAnchor,
              fromBlock: `0x${fromBlock.toString(16)}`,
              toBlock: `0x${endBlock.toString(16)}`,
              topics: [toEventSelector(anchoredEvent), root],
            }],
          } as never) as Array<{ transactionHash: Hex }>;
          if (logs.length) return logs.at(-1)!.transactionHash;
          if (fromBlock === startBlock) break;
          endBlock = fromBlock - 1n;
        }
        return ("0x" + "00".repeat(32)) as Hex;
      }
      return chain.anchor(root, count);
    },
    blockTimestamp: timestampForBlock,
  };
}

/** Load a deployment file and create its RPC-backed adapter. */
export function loadChainAdapter(path: string, privateKey?: Hex): ChainPort {
  return createChainAdapter(loadDeployment(path), { privateKey });
}
