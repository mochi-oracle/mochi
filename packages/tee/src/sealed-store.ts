import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, toHex } from "viem";
import type { TeeProvider } from "./provider.ts";
import { seal, type Envelope } from "./envelope.ts";

export interface SealedStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
}
export class MemorySealedStore implements SealedStore {
  private readonly entries = new Map<string, Uint8Array>();
  async get(key: string) { const value = this.entries.get(key); return value === undefined ? undefined : value.slice(); }
  async put(key: string, value: Uint8Array) { this.entries.set(key, value.slice()); }
  async has(key: string) { return this.entries.has(key); }
}
/** File-backed store encrypting every value to the provider's enclave key before writing ciphertext. */
export class FileSealedStore implements SealedStore {
  constructor(private readonly dir: string, private readonly provider: TeeProvider) {}
  private file(key: string): string { return join(this.dir, `${sha256(toHex(new TextEncoder().encode(key)))}.json`); }
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.file(key), "utf8")) as Envelope;
      return this.provider.decryptEnvelope(parsed, new TextEncoder().encode(key));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const envelope = seal(this.provider.encryptionPublicKey(), value, new TextEncoder().encode(key));
    await writeFile(this.file(key), JSON.stringify(envelope), { mode: 0o600 });
  }
  async has(key: string): Promise<boolean> { return (await this.get(key)) !== undefined; }
}
