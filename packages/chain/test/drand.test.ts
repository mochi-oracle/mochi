import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DrandClient, DRAND_QUICKNET, drandRoundMessage, drandRoundPublishedAt, ensureBeacon, g1ToEip2537, g2ToEip2537, verifyDrandBeacon } from "../src/drand.ts";
import type { Beacon } from "../src/drand.ts";
import type { Address, Hex } from "viem";

const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/test/fixtures/drand-vectors.json"), "utf8")) as { quicknet: { publicKeyG2: string; beacons: { round: number; message: string; signature: string }[] } };
const quick = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/test/fixtures/drand-quicknet.json"), "utf8")) as { beacons: Beacon[] };

describe("drand helpers", () => {
  test("encodes G1/G2 points exactly like contract vectors", () => {
    expect(g2ToEip2537(DRAND_QUICKNET.publicKey)).toBe(`0x${vectors.quicknet.publicKeyG2}`);
    for (const [i, v] of vectors.quicknet.beacons.entries()) expect(g1ToEip2537(`0x${quick.beacons[i]!.signature}`)).toBe(`0x${v.signature}`);
  });
  test("round messages are uint64 big endian and quicknet signatures verify", () => {
    expect(Buffer.from(drandRoundMessage(1)).toString("hex")).toBe(vectors.quicknet.beacons[0]!.message);
    expect(drandRoundPublishedAt(2, DRAND_QUICKNET)).toBe(DRAND_QUICKNET.genesisTime + 3);
    for (const beacon of quick.beacons) expect(verifyDrandBeacon(beacon, DRAND_QUICKNET)).toBe(true);
  });
  test("invalid first relay falls through, but a future round makes no requests", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      const b = calls === 1 ? { ...quick.beacons[0]!, signature: "00".repeat(48) } : quick.beacons[0]!;
      return new Response(JSON.stringify(b), { status: 200 });
    };
    const client = new DrandClient({ relays: ["http://one", "http://two"], chainHash: DRAND_QUICKNET.chainHash, info: DRAND_QUICKNET, fetch: fetcher as unknown as typeof fetch });
    expect(await client.getBeacon(1)).toMatchObject({ round: 1 });
    expect(calls).toBe(2);
    const future = new DrandClient({ relays: ["http://one"], chainHash: "fake", info: { ...DRAND_QUICKNET, genesisTime: 4_000_000_000 }, fetch: fetcher as unknown as typeof fetch });
    expect(await future.getBeacon(1)).toBe("not-published"); expect(calls).toBe(2);
  });
  test("ensureBeacon skips posted beacons and posts an available ticket", async () => {
    let stored = `0x${"00".repeat(32)}` as Hex; const writes: unknown[] = [];
    const chain = {
      publicClient: { readContract: async () => stored, waitForTransactionReceipt: async () => ({ status: "success" }) },
      walletClient: { writeContract: async (input: unknown) => { writes.push(input); stored = `0x${"01".repeat(32)}`; return `0x${"ab".repeat(32)}` as Hex; } }, account: {},
    };
    const client = new DrandClient({ relays: ["test"], chainHash: DRAND_QUICKNET.chainHash, info: DRAND_QUICKNET, fetch: (async () => new Response(JSON.stringify(quick.beacons[0]), { status: 200 })) as unknown as typeof fetch });
    expect(await ensureBeacon(chain, `0x${"12".repeat(20)}` as Address, 1, client)).toBe("posted");
    expect(await ensureBeacon(chain, `0x${"12".repeat(20)}` as Address, 1, client)).toBe("already");
    expect(writes).toHaveLength(1);
  });
});
