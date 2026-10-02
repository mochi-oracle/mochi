import type { Address, Hex } from "viem";
import type { AttestationDoc, JurorAttestationDoc, Passport } from "@mochi/protocol";
import type { QuoteVerifier } from "@mochi/tee";

export interface EnrolledKey {
  key: Address;
}

export interface JurorRecord {
  operator: Address;
  measurement: Hex;
  role: number;
  jurorClass: number;
  bond: bigint;
  attestedUntil: bigint;
  delisted: boolean;
  served: number;
  timeouts: number;
}

export interface ChainPort {
  blockNumber(): Promise<bigint>;
  getEnrolled(fromBlock: bigint, toBlock: bigint): Promise<EnrolledKey[]>;
  getJuror(key: Address): Promise<JurorRecord>;
  isActive(key: Address, role: number): Promise<boolean>;
  /** JurorRegistry.allowedMeasurement(measurement, role): the governance allowlist for that role. */
  measurementAllowed(measurement: Hex, role: number): Promise<boolean>;
  refreshAttestation(keys: Address[], until: bigint): Promise<Hex>;
  reportAttestationFailure(key: Address): Promise<Hex>;
}

export interface Endpoint {
  address: string;
  role: number;
  url: string;
}

export interface Store {
  getCursor(name: string): Promise<bigint | null>;
  setCursor(name: string, block: bigint): Promise<void>;
  getEndpoint(address: string): Promise<Endpoint | null>;
  upsertEndpoint(address: string, role: number, url: string): Promise<void>;
  upsertJuror(record: {
    key: string;
    operator: string;
    measurement: string;
    class: number;
    role: number;
    bond: string;
    attestedUntil: Date;
    uptime30d: number;
    served: number;
    timeouts: number;
    slashed: string;
    delisted: boolean;
  }): Promise<void>;
  setJurorPassport(key: string, passport: Passport, passportSig: string): Promise<void>;
}

export interface EnclaveHttp {
  fetchAttestation(url: string): Promise<AttestationDoc | JurorAttestationDoc>;
}

export interface Clock {
  nowSeconds(): number;
  nowDate(): Date;
}

export interface AttestorDeps {
  chain: ChainPort;
  http: EnclaveHttp;
  store: Store;
  quoteVerifier: QuoteVerifier;
  clock: Clock;
  startBlock: bigint;
  validitySec: number;
  maxQuoteAgeSec: number;
  adminToken: string;
  dissenterExcludedLineages: string[];
  /** How long a store endpoint lookup is reused before it is read again (default 300 s). A failed read reuses it. */
  endpointCacheSec?: number;
}
