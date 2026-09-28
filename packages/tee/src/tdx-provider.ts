import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { bytesToHex, fromHex, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { open, type Envelope } from "./envelope.ts";
import { keyBinding, type Quote, type TeeProvider } from "./provider.ts";
import { tdxReportData, type MeasurementScheme } from "./tdx-common.ts";

/** Anything that turns 64 bytes of REPORTDATA into a raw TDX quote (e.g. a dstack guest agent). */
export interface QuoteSource {
  getQuote(reportData: Uint8Array): Promise<Uint8Array>;
}

/** Minimal configfs access used by the TDX quote provider. */
export interface TsmPort {
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
}

/** The production configfs-tsm filesystem adapter. */
export const nodeTsmPort: TsmPort = {
  async mkdir(path) { await mkdir(path); },
  async rmdir(path) { await rmdir(path); },
  async writeFile(path, data) { await writeFile(path, data); },
  async readFile(path) { return new Uint8Array(await readFile(path)); },
};

export class TsmError extends Error {
  constructor(message: string) { super(message); this.name = "TsmError"; }
}

type TdxOptions = {
  measurementOf: (rawQuote: Uint8Array) => Hex;
  quoteSource?: QuoteSource;
  tsm: TsmPort;
  tsmRoot: string;
  now: () => number;
  kmsSignatureChain?: Hex[];
  kmsEncryptionSignatureChain?: Hex[];
  measurementScheme?: MeasurementScheme;
};

/** Intel TDX quote provider backed by Linux configfs-tsm. */
export class TdxTeeProvider implements TeeProvider {
  readonly kind = "tdx" as const;
  private readonly account: LocalAccount;
  private readonly encryptionPrivateKey: Uint8Array;
  private readonly encryptionPub: Hex;
  private measurementValue: Hex | undefined;
  private quoteQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: TdxOptions, secp256k1: Uint8Array, x25519Private: Uint8Array) {
    this.account = privateKeyToAccount(bytesToHex(secp256k1));
    this.encryptionPrivateKey = x25519Private;
    this.encryptionPub = bytesToHex(x25519.getPublicKey(x25519Private));
  }

  static async create(opts: {
    measurementOf: (rawQuote: Uint8Array) => Hex;
    /** Use this instead of configfs-tsm (e.g. DstackQuoteSource on Phala Cloud / dstack CVMs). */
    quoteSource?: QuoteSource;
    tsm?: TsmPort;
    tsmRoot?: string;
    keys?: { secp256k1: Hex; x25519: Hex };
    now?: () => number;
    kmsSignatureChain?: Hex[];
    kmsEncryptionSignatureChain?: Hex[];
    measurementScheme?: MeasurementScheme;
  }): Promise<TdxTeeProvider> {
    if (opts.measurementScheme !== undefined && opts.measurementScheme !== "dstack-config-v1") throw new TsmError("unsupported TDX measurement scheme");
    let secp: Uint8Array;
    let encryption: Uint8Array;
    if (opts.keys) {
      secp = fromHex(opts.keys.secp256k1, "bytes");
      encryption = fromHex(opts.keys.x25519, "bytes");
      if (secp.length !== 32) throw new RangeError("secp256k1 key must be 32 bytes");
      if (encryption.length !== 32) throw new RangeError("x25519 key must be 32 bytes");
      // privateKeyToAccount validates that the secp256k1 scalar is in range.
      privateKeyToAccount(bytesToHex(secp));
    } else {
      secp = new Uint8Array(randomBytes(32));
      // Extremely unlikely random invalid scalars are discarded rather than escaping as startup failures.
      while (true) {
        try { privateKeyToAccount(bytesToHex(secp)); break; }
        catch { secp = new Uint8Array(randomBytes(32)); }
      }
      encryption = new Uint8Array(randomBytes(32));
    }

    const provider = new TdxTeeProvider({
      measurementOf: opts.measurementOf,
      quoteSource: opts.quoteSource,
      tsm: opts.tsm ?? nodeTsmPort,
      tsmRoot: (opts.tsmRoot ?? "/sys/kernel/config/tsm/report").replace(/\/$/, ""),
      now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
      kmsSignatureChain: opts.kmsSignatureChain,
      kmsEncryptionSignatureChain: opts.kmsEncryptionSignatureChain,
      measurementScheme: opts.measurementScheme,
    }, secp, encryption);
    const initialQuote = await provider.quote();
    provider.measurementValue = initialQuote.measurement;
    return provider;
  }

  measurement(): Hex {
    if (this.measurementValue === undefined) throw new TsmError("measurement is not initialized");
    return this.measurementValue;
  }
  signer(): LocalAccount { return this.account; }
  encryptionPublicKey(): Hex { return this.encryptionPub; }
  decryptEnvelope(env: Envelope, aad: Uint8Array): Uint8Array { return open(this.encryptionPrivateKey, env, aad); }

  /** Request a hardware quote, serializing configfs activity within this provider. */
  quote(): Promise<Quote> {
    const pending = this.quoteQueue.then(() => this.performQuote());
    this.quoteQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async performQuote(): Promise<Quote> {
    if (this.options.quoteSource) return this.quoteFromSource(this.options.quoteSource);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const name = `mochi-${bytesToHex(new Uint8Array(randomBytes(12))).slice(2)}`;
      const entry = `${this.options.tsmRoot}/${name}`;
      await this.options.tsm.mkdir(entry);
      let raced = false;
      try {
        const providerName = new TextDecoder().decode(await this.options.tsm.readFile(`${entry}/provider`)).trim();
        if (providerName !== "tdx_guest") throw new TsmError(`provider ${providerName}`);

        const issuedAt = this.options.now();
        const binding = keyBinding(this.account.address, this.encryptionPub);
        const reportData = tdxReportData(binding, issuedAt);
        // The kernel bumps `generation` on every write to the entry. Our only write is inblob, so the outblob belongs to
        // our request iff the counter moved by exactly one from before the write to after the read.
        const generationBefore = await this.readGeneration(entry);
        await this.options.tsm.writeFile(`${entry}/inblob`, reportData);
        const outblob = await this.options.tsm.readFile(`${entry}/outblob`);
        const generationAfter = await this.readGeneration(entry);
        if (generationAfter !== generationBefore + 1n) {
          raced = true;
        } else {
          if (outblob.length === 0) throw new TsmError("empty outblob");
          const actualMeasurement = this.options.measurementOf(outblob);
          if (this.measurementValue !== undefined && actualMeasurement.toLowerCase() !== this.measurementValue.toLowerCase()) {
            throw new TsmError("quote measurement changed");
          }
          return {
            kind: "tdx",
            ...(this.options.measurementScheme ? { measurementScheme: this.options.measurementScheme } : {}),
            measurement: this.measurementValue ?? actualMeasurement,
            reportData: binding,
            raw: bytesToHex(outblob),
            issuedAt,
          };
        }
      } finally {
        // Cleanup is best effort and must not replace either a quote or its original failure.
        try { await this.options.tsm.rmdir(entry); } catch { /* configfs may already have removed the entry */ }
      }
      if (raced && attempt === 3) throw new TsmError("generation changed on all 3 quote attempts");
    }
    throw new TsmError("unable to obtain TDX quote");
  }

  private async quoteFromSource(source: QuoteSource): Promise<Quote> {
    const issuedAt = this.options.now();
    const binding = keyBinding(this.account.address, this.encryptionPub);
    const raw = await source.getQuote(tdxReportData(binding, issuedAt));
    if (raw.length === 0) throw new TsmError("empty quote");
    const actualMeasurement = this.options.measurementOf(raw);
    if (this.measurementValue !== undefined && actualMeasurement.toLowerCase() !== this.measurementValue.toLowerCase()) {
      throw new TsmError("quote measurement changed");
    }
    return { kind: "tdx", ...(this.options.measurementScheme ? { measurementScheme: this.options.measurementScheme } : {}), measurement: this.measurementValue ?? actualMeasurement, reportData: binding, raw: bytesToHex(raw), issuedAt,
      ...(this.options.kmsSignatureChain ? { kmsSignatureChain: this.options.kmsSignatureChain } : {}),
      ...(this.options.kmsEncryptionSignatureChain ? { kmsEncryptionSignatureChain: this.options.kmsEncryptionSignatureChain } : {}) };
  }

  private async readGeneration(entry: string): Promise<bigint> {
    const text = new TextDecoder().decode(await this.options.tsm.readFile(`${entry}/generation`)).trim();
    if (!/^\d+$/.test(text)) throw new TsmError(`bad generation ${JSON.stringify(text)}`);
    return BigInt(text);
  }

  private publicView(): { kind: "tdx"; address: Hex; measurement: Hex | undefined } {
    return { kind: this.kind, address: this.account.address, measurement: this.measurementValue };
  }
  toJSON(): { kind: "tdx"; address: Hex; measurement: Hex | undefined } { return this.publicView(); }
  [Symbol.for("nodejs.util.inspect.custom")](): { kind: "tdx"; address: Hex; measurement: Hex | undefined } {
    return this.publicView();
  }
}
