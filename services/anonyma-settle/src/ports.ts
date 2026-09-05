export type Hex32 = `0x${string}`;
export interface VoucherEvent { voucherId: Hex32; queryId: Hex32; tier: number; amount: bigint; timestamp: number }
export interface RefundEvent { queryId: Hex32; amount: bigint; timestamp: number }
export interface OpenEvent { queryId: Hex32; payPath: number; timestamp: number }
export interface SettlePorts {
  chain: {
    voucherEvents(start: number, end: number): Promise<VoucherEvent[]>;
    openEvents(start: number, end: number): Promise<OpenEvent[]>;
    refundEvents(start: number, end: number): Promise<RefundEvent[]>;
    floatBalance(): Promise<bigint>;
  };
  vouchers: {
    insert(voucher: { voucherId: Hex32; queryId: Hex32; tier: number; usdgAmount: string; settled: false }): Promise<void>;
    markSettled(ids: string[]): Promise<void>;
  };
  ledger(): Promise<Array<{ voucherId: Hex32; usdgEquiv: string }>>;
  clock: { now(): Date };
  files: { writeStatement(periodEnd: string, body: string, signature: string): Promise<void>; readStatement(periodEnd: string): Promise<string | null> };
}
