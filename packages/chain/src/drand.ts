import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { DrandRandomnessAbi } from "./abis.ts";

export interface DrandInfo { chainHash: string; publicKey: string; genesisTime: number; period: number; dst?: string }
export interface Beacon { round: number; randomness: string; signature: string; publishedAt?: number }
export const DRAND_QUICKNET: DrandInfo = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367, period: 3, dst: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
};
const DEFAULT_RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];
const asHex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}` as Hex;
const toField = (n: bigint) => n.toString(16).padStart(128, "0");
export function drandRoundMessage(round: number | bigint): Uint8Array {
  const n = BigInt(round); if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError("round must fit uint64");
  const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, n, false); return sha256(out);
}
export function drandRoundPublishedAt(round: number | bigint, info: Pick<DrandInfo, "genesisTime" | "period">): number {
  const r = BigInt(round); if (r < 1n) throw new RangeError("round must be positive");
  return info.genesisTime + Number(r - 1n) * info.period;
}
export function g1ToEip2537(compressedSigHex: string): Hex {
  const point = bls12_381.shortSignatures.Signature.fromHex(compressedSigHex.replace(/^0x/, ""));
  const { x, y } = point.toAffine();
  return (`0x${toField(x)}${toField(y)}`) as Hex;
}
export function g2ToEip2537(compressedPkHex: string): Hex {
  const point = bls12_381.G2.Point.fromHex(compressedPkHex.replace(/^0x/, ""));
  const { x, y } = point.toAffine();
  return (`0x${toField(x.c0)}${toField(x.c1)}${toField(y.c0)}${toField(y.c1)}`) as Hex;
}
export function verifyDrandBeacon(beacon: Beacon, info: DrandInfo): boolean {
  try {
    if (!Number.isSafeInteger(beacon.round) || beacon.round < 1) return false;
    const msg = bls12_381.shortSignatures.hash(drandRoundMessage(beacon.round), info.dst ?? DRAND_QUICKNET.dst);
    return bls12_381.shortSignatures.verify(hexToBytes(`0x${beacon.signature.replace(/^0x/, "")}`), msg, hexToBytes(`0x${info.publicKey.replace(/^0x/, "")}`));
  } catch { return false; }
}

export class DrandClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: { relays?: string[]; chainHash: string; info: DrandInfo; fetch?: typeof fetch; timeoutMs?: number; currentTime?: () => Promise<number> }) {
    this.fetcher = options.fetch ?? fetch;
  }
  async getBeacon(round: number | bigint): Promise<Beacon | "not-published"> {
    const r = Number(round);
    const now = this.options.currentTime ? await this.options.currentTime() : Math.floor(Date.now() / 1000);
    if (drandRoundPublishedAt(r, this.options.info) > now) return "not-published";
    let lastError: unknown;
    for (const relay of this.options.relays ?? DEFAULT_RELAYS) {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 5000);
      try {
        const response = await this.fetcher(`${relay.replace(/\/$/, "")}/${this.options.chainHash}/public/${r}`, { signal: abort.signal });
        if (!response.ok) throw new Error(`drand relay HTTP ${response.status}`);
        const raw = await response.json() as Record<string, unknown>;
        const beacon: Beacon = { round: Number(raw.round), randomness: String(raw.randomness), signature: String(raw.signature), publishedAt: Number(raw.publishedAt) };
        if (beacon.round !== r || !verifyDrandBeacon(beacon, this.options.info)) throw new Error("invalid drand beacon");
        return beacon;
      } catch (error) { lastError = error; }
      finally { clearTimeout(timer); }
    }
    throw new Error(`unable to retrieve a valid drand beacon for round ${r}: ${String(lastError ?? "no relays configured")}`);
  }
}

type BeaconChain = { publicClient: { readContract(args: never): Promise<unknown> }; walletClient?: { writeContract(args: never): Promise<Hex> }; account?: unknown };
export async function ensureBeacon(chain: BeaconChain, randomnessAddress: Address, round: number | bigint, client: DrandClient): Promise<"already" | "posted" | "not-published"> {
  const r = BigInt(round);
  const read = () => chain.publicClient.readContract({ address: randomnessAddress, abi: DrandRandomnessAbi, functionName: "beaconOf", args: [r] } as never) as Promise<Hex>;
  if (!/^0x0+$/.test(await read())) return "already";
  const beacon = await client.getBeacon(r); if (beacon === "not-published") return beacon;
  try {
    if (!chain.walletClient || !chain.account) throw new Error("ensureBeacon requires a wallet client");
    const hash = await chain.walletClient.writeContract({ account: chain.account, address: randomnessAddress, abi: DrandRandomnessAbi, functionName: "postBeacon", args: [r, g1ToEip2537(beacon.signature)] } as never);
    const receipt = await (chain.publicClient as unknown as { waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }> }).waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("postBeacon transaction reverted");
    return "posted";
  } catch (error) {
    if (!/^0x0+$/.test(await read())) return "already";
    throw error;
  }
}
