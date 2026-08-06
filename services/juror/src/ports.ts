import type { Address, Hex } from "viem";
import type { Quote, TeeProvider, QuoteVerifier, SealedStore } from "@mochi/tee";
import type { Peer, SubmitAnswerReq } from "@mochi/protocol";
import type { Passport } from "@mochi/protocol";

export interface JurorChainPort {
  getQuery(queryId: Hex): Promise<{
    status: number;
    docCommit: Hex;
    paramsHash: Hex;
    schemaId: number;
    schemaVersion: number;
  }>;
  jurorsOf(queryId: Hex): Promise<Hex[]>;
  isActive(key: Address, role: number): Promise<boolean>;
  /** Measurement the key was registered under on-chain (the quote must match it). */
  getJuror(key: Address): Promise<{ measurement: Hex }>;
}

export interface HttpPoster {
  post(url: string, body: SubmitAnswerReq, timeoutMs: number): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface JurorDeps {
  tee: TeeProvider;
  jurorClass: number;
  passport: Omit<Passport, "v" | "juror" | "jurorClass" | "tee" | "weightsSha256"> & { weightsSha256: Hex };
  maxTokens?: number;
  runner: import("./runner.ts").ModelRunner;
  chain: JurorChainPort;
  store: SealedStore;
  quoteVerifier: QuoteVerifier;
  http: HttpPoster;
  chainId: number;
  verdictsAddress: Address;
  clock: Clock;
}

export type { Peer, Quote };
