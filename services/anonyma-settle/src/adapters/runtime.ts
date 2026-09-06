import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { QueryEscrowAbi, createChain, loadDeployment } from "@mochi/chain";
import { anonymaVouchers, createDb, insertAnonymaVoucher, markVouchersSettled } from "@mochi/db";
import type { Address, Hex } from "viem";
import { decodeEventLog } from "viem";
import type { SettleConfig } from "../config.ts";
import type { Hex32, SettlePorts } from "../ports.ts";

export function createRuntimePorts(config: SettleConfig): { ports: SettlePorts; close(): Promise<void> } {
  const deployment = loadDeployment(config.MOCHI_DEPLOYMENT);
  const chain = createChain(deployment);
  const dbClient = createDb();
  const db = dbClient.db;
  const getLogs = async (eventName: string) => {
    const latest = await chain.blockNumber();
    if (latest < config.START_BLOCK) return [];
    const logs = await chain.publicClient.getLogs({ address: deployment.contracts.queryEscrow as Address, event: QueryEscrowAbi.find((item) => item.type === "event" && item.name === eventName) as never, fromBlock: config.START_BLOCK, toBlock: latest }) as Array<{ blockNumber: bigint | null; data: Hex; topics: readonly Hex[] }>;
    const blockTimes = new Map<bigint, number>();
    await Promise.all([...new Set(logs.map((log) => log.blockNumber).filter((n): n is bigint => n !== null))].map(async (blockNo) => {
      const block = await chain.publicClient.getBlock({ blockNumber: blockNo });
      blockTimes.set(blockNo, Number(block.timestamp) * 1000);
    }));
    return logs.flatMap((log) => {
      if (log.blockNumber === null) return [];
      const decoded = decodeEventLog({ abi: QueryEscrowAbi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: false });
      return [{ args: decoded.args as Record<string, unknown>, timestamp: blockTimes.get(log.blockNumber)! }];
    });
  };
  const inRange = (timestamp: number, start: number, end: number) => timestamp >= start && timestamp < end;
  const ports: SettlePorts = {
    chain: {
      async voucherEvents(start, end) { return (await getLogs("AnonymaVoucherUsed")).filter((x) => inRange(x.timestamp, start, end)).map(({ args, timestamp }) => ({ voucherId: String(args.voucherId).toLowerCase() as Hex32, queryId: String(args.queryId).toLowerCase() as Hex32, tier: Number(args.tier), amount: args.amount as bigint, timestamp })); },
      async openEvents(_start, end) { return (await getLogs("QueryOpened")).filter((x) => x.timestamp < end).map(({ args, timestamp }) => ({ queryId: String(args.queryId).toLowerCase() as Hex32, payPath: Number(args.payPath), timestamp })); },
      async refundEvents(start, end) { return (await getLogs("Refunded")).filter((x) => inRange(x.timestamp, start, end)).map(({ args, timestamp }) => ({ queryId: String(args.queryId).toLowerCase() as Hex32, amount: args.amount as bigint, timestamp })); },
      async floatBalance() { return chain.publicClient.readContract({ address: deployment.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "anonymaFloat" }); },
    },
    vouchers: {
      async insert(input) {
        const [existing] = await db.select({ voucherId: anonymaVouchers.voucherId }).from(anonymaVouchers).where(eq(anonymaVouchers.voucherId, input.voucherId)).limit(1);
        if (!existing) await insertAnonymaVoucher(db, input);
      },
      markSettled(ids) { return markVouchersSettled(db, ids); },
    },
    ledger: () => fetchLedger(config),
    clock: { now: () => new Date() },
    files: {
      async writeStatement(periodEnd, body, signature) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) throw new Error("invalid statement period end");
        await mkdir(config.STATEMENTS_DIR, { recursive: true });
        await writeFile(`${config.STATEMENTS_DIR}/${periodEnd}.json`, body, { mode: 0o600 });
        await writeFile(`${config.STATEMENTS_DIR}/${periodEnd}.sig`, `${signature}\n`, { mode: 0o600 });
      },
      async readStatement(name) {
        if (!/^\d{4}-\d{2}-\d{2}(?:\.sig)?$/.test(name)) return null;
        try { return await readFile(`${config.STATEMENTS_DIR}/${name}`, "utf8"); } catch { return null; }
      },
    },
  };
  return { ports, close: () => dbClient.close() };
}

async function fetchLedger(config: SettleConfig): Promise<Array<{ voucherId: Hex32; usdgEquiv: string }>> {
  let body: string;
  if (config.ANONYMA_LEDGER_FILE) {
    body = await readFile(config.ANONYMA_LEDGER_FILE, "utf8");
  } else {
    if (!config.ANONYMA_LEDGER_URL || !config.ANONYMA_LEDGER_HMAC_SECRET) throw new Error("Configure ANONYMA_LEDGER_FILE or the ledger URL/HMAC pair");
    const response = await fetch(config.ANONYMA_LEDGER_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Anonyma ledger returned HTTP ${response.status}`);
    body = await response.text();
    const signature = response.headers.get("x-mochi-signature") ?? "";
    if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error("Anonyma ledger signature is missing or malformed");
    const expected = createHmac("sha256", config.ANONYMA_LEDGER_HMAC_SECRET).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("Anonyma ledger signature is invalid");
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("Anonyma ledger must be a JSON array");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Anonyma ledger row is invalid");
    const row = item as Record<string, unknown>;
    if (typeof row.voucherId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.voucherId) || typeof row.usdgEquiv !== "string" || !/^\d+$/.test(row.usdgEquiv)) throw new Error("Anonyma ledger row is invalid");
    return { voucherId: row.voucherId.toLowerCase() as Hex32, usdgEquiv: row.usdgEquiv };
  });
}
