import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, encodeAbiParameters, keccak256, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { open, type Envelope } from "./envelope.ts";

export interface Quote { measurementScheme?: "dstack-config-v1"; kind: "mock" | "tdx" | "sev-snp" | "nvidia-cc"; measurement: Hex; reportData: Hex; raw: Hex; issuedAt: number; kmsSignatureChain?: Hex[]; kmsEncryptionSignatureChain?: Hex[] }
export interface TeeProvider {
  readonly kind: Quote["kind"];
  measurement(): Hex;
  signer(): LocalAccount;
  encryptionPublicKey(): Hex;
  decryptEnvelope(env: Envelope, aad: Uint8Array): Uint8Array;
  quote(): Promise<Quote>;
}
export function keyBinding(address: `0x${string}`, x25519Pub: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [address, x25519Pub]));
}
export function quoteHash(quote: Quote): Hex { return keccak256(quote.raw); }

function deterministicKey(seed: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, seed, new Uint8Array(32), new TextEncoder().encode(info), 32);
}
/** DEV ONLY. Deterministic keys and a mock-root signed quote; never use for production attestation. */
export class MockTeeProvider implements TeeProvider {
  readonly kind = "mock" as const;
  private readonly account: LocalAccount;
  private readonly encryptionPrivateKey: Uint8Array;
  private readonly encryptionPub: Hex;
  constructor(private readonly options: { seed: Hex; measurement: Hex; mockRoot: LocalAccount }) {
    if (fromHex(options.measurement, "bytes").length !== 32) throw new RangeError("measurement must be bytes32");
    const seed = fromHex(options.seed, "bytes");
    if (seed.length === 0) throw new RangeError("seed must not be empty");
    // Separate info strings prevent one key from being used across curves and purposes.
    const secp = deterministicKey(seed, "mochi/mock-tee/secp256k1/v1");
    this.account = privateKeyToAccount(toHex(secp));
    this.encryptionPrivateKey = deterministicKey(seed, "mochi/mock-tee/x25519/v1");
    this.encryptionPub = toHex(x25519.getPublicKey(this.encryptionPrivateKey));
  }
  measurement(): Hex { return this.options.measurement; }
  signer(): LocalAccount { return this.account; }
  encryptionPublicKey(): Hex { return this.encryptionPub; }
  decryptEnvelope(env: Envelope, aad: Uint8Array): Uint8Array { return open(this.encryptionPrivateKey, env, aad); }
  async quote(): Promise<Quote> {
    const reportData = keyBinding(this.account.address, this.encryptionPub);
    const issuedAt = Math.floor(Date.now() / 1000);
    const signedHash = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      ["MOCHI_MOCK_QUOTE_V1", this.options.measurement, reportData, BigInt(issuedAt)],
    ));
    const rootSig = await this.options.mockRoot.signMessage({ message: { raw: signedHash } });
    const raw = encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
      ["MOCHI_MOCK_QUOTE_V1", this.options.measurement, reportData, BigInt(issuedAt), rootSig],
    );
    return { kind: this.kind, measurement: this.options.measurement, reportData, raw, issuedAt };
  }
}
