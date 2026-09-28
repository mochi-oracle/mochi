import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, fromHex, type Address, type Hex, type LocalAccount } from "viem";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  DstackKeySource,
  keyBinding,
  quoteVerifierFromEnv,
  teeProviderFromEnv,
  type Env,
  type Quote,
  type QuoteVerifier,
  type TeeProvider,
} from "@mochi/tee";

/** Immutable labels: changing these labels, the role, dstack KMS namespace, or derivation version rotates keys. */
export const PRODUCTION_IDENTITY_SPECS = [
  { name: "intake", role: "intake", label: "production-intake" },
  { name: "consensus", role: "consensus", label: "production-consensus" },
  ...([2, 2, 2, 1, 2] as const).flatMap((count, jurorClass) =>
    Array.from({ length: count }, (_, seat) => ({
      name: `juror-class-${jurorClass}-seat-${seat}`,
      role: "juror" as const,
      label: `production-juror-class-${jurorClass}-seat-${seat}`,
      jurorClass,
      jurorSeat: seat,
    })),
  ),
] as const;

/** Stable EVM signers for production services; key material is only transiently used to derive the public address. */
export const PRODUCTION_SERVICE_SPECS = [
  { name: "attestor", label: "production-service-attestor", purpose: "Mochi attestor service signer" },
  { name: "indexer", label: "production-service-indexer", purpose: "Mochi indexer service signer" },
  { name: "orchestrator", label: "production-service-orchestrator", purpose: "Mochi orchestrator service signer" },
  { name: "feed-runner", label: "production-service-feed-runner", purpose: "Mochi feed-runner service signer" },
  { name: "postman", label: "production-service-postman", purpose: "Mochi postman service signer" },
] as const;

export const PRODUCTION_RECEIPT_SIGNING_SPEC = {
  name: "indexer-receipt" as const,
  path: "mochi/service/production-service-indexer/receipt-signing",
  purpose: "Mochi indexer receipt signing seed",
  info: "mochi/dstack-kms/ed25519/v1",
};

export type PublicProductionServiceSigner = {
  name: typeof PRODUCTION_SERVICE_SPECS[number]["name"];
  label: string;
  address: Address;
};

export type PublicProductionReceiptSigner = {
  name: typeof PRODUCTION_RECEIPT_SIGNING_SPEC.name;
  publicKey: Hex;
};

export type ProductionIdentityName = typeof PRODUCTION_IDENTITY_SPECS[number]["name"];

export type PublicProductionIdentity = {
  name: ProductionIdentityName;
  role: "intake" | "consensus" | "juror";
  label: string;
  jurorClass?: number;
  jurorSeat?: number;
  address: Address;
  encryptionPublicKey: Hex;
  keyBinding: Hex;
  measurement: Hex;
  quote: Quote;
  verification: { ok: true; measurement: Hex; reportData: Hex };
};

export type ProductionIdentityReadiness = {
  ready: true;
  generatedAt: number;
  identities: PublicProductionIdentity[];
  serviceSigners: PublicProductionServiceSigner[];
  receiptSigner: PublicProductionReceiptSigner;
};

/**
 * Creates the persistent identity providers once, then produces freshly quoted public readiness data on each read.
 * Provider secrets stay inside the TEE provider; this module only returns public keys and signed evidence.
 */
export async function createProductionIdentityReadiness(options: {
  env: Env;
  mock: { seed: Hex; measurement: Hex; mockRoot: LocalAccount };
  quoteVerifier?: QuoteVerifier;
  keySource?: DstackKeySource;
  providerFactory?: (spec: typeof PRODUCTION_IDENTITY_SPECS[number]) => Promise<TeeProvider>;
  now?: () => number;
  maxQuoteAgeSec?: number;
}): Promise<{ read: () => Promise<ProductionIdentityReadiness> }> {
  const { env } = options;
  if (env.TEE_MODE !== "dstack" || env.TEE_KEYS !== "kms") {
    throw new Error("production identities require TEE_MODE=dstack and TEE_KEYS=kms");
  }
  if (env.QUOTE_VERIFIER !== "dcap") {
    throw new Error("production identities require QUOTE_VERIFIER=dcap");
  }

  const verifier = options.quoteVerifier ?? quoteVerifierFromEnv(env);
  const keySource = options.keySource ?? new DstackKeySource({ socketPath: env.DSTACK_SOCKET });
  const providers = await Promise.all(PRODUCTION_IDENTITY_SPECS.map(async (spec) => {
    const provider = options.providerFactory
      ? await options.providerFactory(spec)
      : await teeProviderFromEnv({ ...env, TEE_KEY_LABEL: spec.label }, options.mock, { role: spec.role });
    if (provider.kind !== "tdx") throw new Error(`production identity ${spec.name} did not initialize as TDX`);
    return { spec, provider };
  }));

  const addresses = providers.map(({ provider }) => provider.signer().address.toLowerCase());
  const encryptionKeys = providers.map(({ provider }) => provider.encryptionPublicKey().toLowerCase());
  if (new Set(addresses).size !== providers.length || new Set(encryptionKeys).size !== providers.length) {
    throw new Error("production identity KMS keys are not distinct");
  }

  const serviceSigners = await Promise.all(PRODUCTION_SERVICE_SPECS.map(async (spec) => {
    const { key } = await keySource.derive(
      `mochi/service/${spec.label}/sign`, spec.purpose, "mochi/dstack-kms/secp256k1/v1",
    );
    return { name: spec.name, label: spec.label, address: privateKeyToAccount(key).address };
  }));
  const { key: receiptSeed } = await keySource.derive(
    PRODUCTION_RECEIPT_SIGNING_SPEC.path,
    PRODUCTION_RECEIPT_SIGNING_SPEC.purpose,
    PRODUCTION_RECEIPT_SIGNING_SPEC.info,
  );
  const receiptSigner: PublicProductionReceiptSigner = {
    name: PRODUCTION_RECEIPT_SIGNING_SPEC.name,
    publicKey: bytesToHex(ed25519.getPublicKey(fromHex(receiptSeed, "bytes"))),
  };
  const allAddresses = [...addresses, ...serviceSigners.map(({ address }) => address.toLowerCase())];
  if (new Set(allAddresses).size !== allAddresses.length) throw new Error("production KMS signer addresses are not distinct");

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAgeSec = options.maxQuoteAgeSec ?? 300;
  return {
    async read() {
      const identities = await Promise.all(providers.map(async ({ spec, provider }): Promise<PublicProductionIdentity> => {
        const address = provider.signer().address;
        const encryptionPublicKey = provider.encryptionPublicKey();
        const binding = keyBinding(address, encryptionPublicKey);
        const quote = await provider.quote();
        const verified = await verifier.verify(quote, { measurement: provider.measurement(), reportData: binding, maxAgeSec });
        if (!verified.ok || !verified.measurement || !verified.reportData) {
          throw new Error(`production identity ${spec.name} quote verification failed${verified.reason ? `: ${verified.reason}` : ""}`);
        }
        if (verified.measurement.toLowerCase() !== quote.measurement.toLowerCase()
          || verified.reportData.toLowerCase() !== binding.toLowerCase()) {
          throw new Error(`production identity ${spec.name} verified evidence does not match its public keys`);
        }
        return {
          name: spec.name,
          role: spec.role,
          label: spec.label,
          ...( "jurorClass" in spec ? { jurorClass: spec.jurorClass, jurorSeat: spec.jurorSeat } : {}),
          address,
          encryptionPublicKey,
          keyBinding: binding,
          measurement: verified.measurement,
          quote,
          verification: { ok: true, measurement: verified.measurement, reportData: verified.reportData },
        };
      }));
      return { ready: true, generatedAt: now(), identities, serviceSigners, receiptSigner };
    },
  };
}
