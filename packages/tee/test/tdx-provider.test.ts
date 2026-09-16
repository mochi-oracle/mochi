import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { bytesToHex, fromHex, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { seal } from "../src/envelope.ts";
import { keyBinding } from "../src/provider.ts";
import { parseTdxReportData, tdxReportData } from "../src/tdx-common.ts";
import { TdxTeeProvider, TsmError, type TsmPort } from "../src/tdx-provider.ts";

const fixture = new Uint8Array(await readFile(new URL("./fixtures/intel-tdx/tdx_quote", import.meta.url)));
const measurementOf = (raw: Uint8Array): Hex => keccak256(raw);
const ROOT = "/fake/tsm/report";

class FakeTsm implements TsmPort {
  readonly calls: string[] = [];
  readonly entries = new Map<string, { generation: number; inblob?: Uint8Array }>();
  readonly writtenInblobs: Uint8Array[] = [];
  readonly removed: string[] = [];
  providerName = "tdx_guest";
  raceOnce = false;
  alwaysRace = false;
  active = 0;
  maxActive = 0;

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`);
    if (this.entries.has(path)) throw new Error("entry exists");
    this.entries.set(path, { generation: 0 });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
  }
  async rmdir(path: string): Promise<void> {
    this.calls.push(`rmdir:${path}`);
    this.entries.delete(path);
    this.removed.push(path);
    this.active -= 1;
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.calls.push(`write:${path}`);
    const [entry, leaf] = this.split(path);
    const state = this.mustEntry(entry);
    if (leaf !== "inblob") throw new Error(`unexpected write ${leaf}`);
    state.inblob = new Uint8Array(data);
    state.generation += 1;
    this.writtenInblobs.push(new Uint8Array(data));
  }
  async readFile(path: string): Promise<Uint8Array> {
    this.calls.push(`read:${path}`);
    const [entry, leaf] = this.split(path);
    const state = this.mustEntry(entry);
    if (leaf === "provider") return new TextEncoder().encode(`${this.providerName}\n`);
    if (leaf === "generation") return new TextEncoder().encode(`${state.generation}\n`);
    if (leaf === "outblob") {
      if (this.alwaysRace || this.raceOnce) {
        if (this.raceOnce) this.raceOnce = false;
        state.generation += 1;
      }
      return new Uint8Array(fixture);
    }
    throw new Error(`unexpected read ${leaf}`);
  }
  private split(path: string): [string, string] {
    const slash = path.lastIndexOf("/");
    return [path.slice(0, slash), path.slice(slash + 1)];
  }
  private mustEntry(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`missing entry ${path}`);
    return entry;
  }
}

async function create(tsm: FakeTsm, overrides: Partial<Parameters<typeof TdxTeeProvider.create>[0]> = {}) {
  return TdxTeeProvider.create({ measurementOf, tsm, tsmRoot: ROOT, now: () => 1_700_000_123, ...overrides });
}

describe("TdxTeeProvider", () => {
  test("creates fresh keys and accepts valid injected keys", async () => {
    const first = await create(new FakeTsm());
    const second = await create(new FakeTsm());
    expect(first.signer().address).not.toBe(second.signer().address);
    expect(first.encryptionPublicKey()).not.toBe(second.encryptionPublicKey());

    const secp = `0x${"11".repeat(32)}` as Hex;
    const xpriv = `0x${"22".repeat(32)}` as Hex;
    const tsm = new FakeTsm();
    const injected = await create(tsm, { keys: { secp256k1: secp, x25519: xpriv } });
    expect(injected.signer().address).toBe(privateKeyToAccount(secp).address);
    expect(injected.encryptionPublicKey()).toBe(bytesToHex((await import("@noble/curves/ed25519.js")).x25519.getPublicKey(fromHex(xpriv, "bytes"))));
    await expect(create(new FakeTsm(), { keys: { secp256k1: `0x${"00".repeat(32)}` as Hex, x25519: xpriv } })).rejects.toThrow();
    await expect(create(new FakeTsm(), { keys: { secp256k1: secp, x25519: "0x1234" as Hex } })).rejects.toThrow("x25519 key must be 32 bytes");
  });

  test("binds key and issued time in REPORTDATA and returns the fixture quote", async () => {
    const tsm = new FakeTsm();
    const provider = await create(tsm);
    const quoted = await provider.quote();
    const expectedBinding = keyBinding(provider.signer().address, provider.encryptionPublicKey());
    expect(tsm.writtenInblobs.at(-1)).toEqual(tdxReportData(expectedBinding, 1_700_000_123));
    expect(parseTdxReportData(tsm.writtenInblobs.at(-1)!)).toEqual({ keyBinding: expectedBinding, issuedAt: 1_700_000_123 });
    expect(quoted).toEqual({
      kind: "tdx", measurement: measurementOf(fixture), reportData: expectedBinding,
      raw: bytesToHex(fixture), issuedAt: 1_700_000_123,
    });
    expect(provider.measurement()).toBe(measurementOf(fixture));
    expect(tsm.entries.size).toBe(0);
    expect(tsm.removed.length).toBe(2); // create's bootstrap quote and this quote
  });

  test("rejects a non-TDX provider and removes the entry", async () => {
    const tsm = new FakeTsm();
    tsm.providerName = "other_guest";
    await expect(create(tsm)).rejects.toThrow(new TsmError("provider other_guest"));
    expect(tsm.entries.size).toBe(0);
    expect(tsm.removed).toHaveLength(1);
  });

  test("retries generation races and cleans every entry", async () => {
    const tsm = new FakeTsm();
    const provider = await create(tsm);
    tsm.raceOnce = true;
    await expect(provider.quote()).resolves.toMatchObject({ kind: "tdx", raw: bytesToHex(fixture) });
    expect(tsm.entries.size).toBe(0);
    expect(tsm.removed).toHaveLength(3); // bootstrap, raced attempt, successful retry

    const racingTsm = new FakeTsm();
    const racingProvider = await create(racingTsm);
    racingTsm.alwaysRace = true;
    await expect(racingProvider.quote()).rejects.toThrow("generation changed on all 3 quote attempts");
    expect(racingTsm.entries.size).toBe(0);
    expect(racingTsm.removed).toHaveLength(4);
  });

  test("rejects a quote whose runtime measurement changes", async () => {
    const tsm = new FakeTsm();
    let calls = 0;
    const provider = await create(tsm, { measurementOf: (raw) => (++calls === 1 ? keccak256(raw) : `0x${"ab".repeat(32)}` as Hex) });
    await expect(provider.quote()).rejects.toThrow("quote measurement changed");
    expect(tsm.entries.size).toBe(0);
  });

  test("serializes concurrent quote calls", async () => {
    const tsm = new FakeTsm();
    const provider = await create(tsm);
    await Promise.all(Array.from({ length: 5 }, () => provider.quote()));
    expect(tsm.maxActive).toBe(1);
    expect(tsm.entries.size).toBe(0);
  });

  test("decrypts an envelope sealed to its encryption key", async () => {
    const provider = await create(new FakeTsm());
    const plaintext = new TextEncoder().encode("private result");
    const aad = new TextEncoder().encode("associated data");
    expect(provider.decryptEnvelope(seal(provider.encryptionPublicKey(), plaintext, aad), aad)).toEqual(plaintext);
  });

  test("does not expose private keys through JSON or inspection", async () => {
    const secp = `0x${"11".repeat(32)}` as Hex;
    const xpriv = `0x${"22".repeat(32)}` as Hex;
    const provider = await create(new FakeTsm(), { keys: { secp256k1: secp, x25519: xpriv } });
    expect(JSON.stringify(provider)).not.toContain(secp.slice(2));
    expect(JSON.stringify(provider)).not.toContain(xpriv.slice(2));
    expect(Bun.inspect(provider)).not.toContain(secp.slice(2));
    expect(Bun.inspect(provider)).not.toContain(xpriv.slice(2));
  });
});
