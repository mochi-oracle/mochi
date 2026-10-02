// dstack TDX MRCONFIGID layouts and RTMR3 runtime-event replay. Mirrors dstack-types/src/mr_config.rs and
// cc-eventlog/src/runtime_events.rs (Dstack-TEE/dstack v0.5.9 for V1/V2, v0.6.0 for V3).
//
//   V1: 0x01 ‖ compose_hash ‖ 15 zero bytes
//   V2: 0x02 ‖ keccak256(compose_hash ‖ app_id ‖ key_provider_kind ‖ key_provider_id) ‖ 15 zero bytes
//   V3: 0x03 ‖ sha256("dstack-mr-config-v3:" ‖ 0x00 ‖ JCS document) ‖ 15 zero bytes
//
// An all-zero register means "no config id". Every other first byte is unknown and rejected.
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "viem";

export const MR_CONFIG_ID_BYTES = 48;
export const DSTACK_MR_CONFIG_VERSIONS = [1, 2, 3] as const;
export type DstackMrConfigVersion = (typeof DSTACK_MR_CONFIG_VERSIONS)[number];
export type DstackKeyProvider = "none" | "kms" | "local" | "tpm";

const KEY_PROVIDER_KIND: Record<DstackKeyProvider, number> = { none: 0, local: 1, kms: 2, tpm: 3 };
const V3_DOCUMENT_DOMAIN = new TextEncoder().encode("dstack-mr-config-v3:");
const COMMITMENT_END = 33;

/** Version byte of a well-formed nonzero dstack MRCONFIGID. Throws on unknown versions and malformed layouts. */
export function dstackMrConfigVersion(mrConfigId: Uint8Array): DstackMrConfigVersion {
  if (mrConfigId.length !== MR_CONFIG_ID_BYTES) throw new RangeError("MRCONFIGID is 48 bytes");
  const version = mrConfigId[0]!;
  if (!(DSTACK_MR_CONFIG_VERSIONS as readonly number[]).includes(version)) throw new Error("unsupported dstack MRCONFIGID version");
  if (mrConfigId.subarray(1, COMMITMENT_END).every((byte) => byte === 0)) throw new Error("dstack MRCONFIGID commitment must be nonzero");
  if (mrConfigId.subarray(COMMITMENT_END).some((byte) => byte !== 0)) throw new Error("dstack MRCONFIGID padding must be zero");
  return version as DstackMrConfigVersion;
}

function register(version: DstackMrConfigVersion, commitment: Uint8Array): Uint8Array {
  const out = new Uint8Array(MR_CONFIG_ID_BYTES);
  out[0] = version;
  out.set(commitment, 1);
  return out;
}

function fixed(name: string, value: Uint8Array, length: number): Uint8Array {
  if (value.length !== length) throw new RangeError(`${name} must be ${length} bytes`);
  return value;
}

export function dstackMrConfigIdV1(composeHash: Uint8Array): Uint8Array {
  return register(1, fixed("compose hash", composeHash, 32));
}

export function dstackMrConfigIdV2(input: {
  composeHash: Uint8Array; appId: Uint8Array; keyProvider: DstackKeyProvider; keyProviderId: Uint8Array;
}): Uint8Array {
  const kind = KEY_PROVIDER_KIND[input.keyProvider];
  if (kind === undefined) throw new Error("unknown dstack key provider");
  const hash = keccak_256.create();
  hash.update(fixed("compose hash", input.composeHash, 32));
  hash.update(fixed("app id", input.appId, 20));
  hash.update(Uint8Array.of(kind));
  hash.update(input.keyProviderId);
  return register(2, hash.digest());
}

export interface DstackMrConfigV3Input {
  appId?: Uint8Array;
  composeHash: Uint8Array;
  gpuPolicyHash?: Uint8Array;
  keyProvider: DstackKeyProvider;
  keyProviderId?: Uint8Array;
  instanceId?: Uint8Array;
  /** Bound only for app-compose manifest_version >= 3. An empty list differs from an absent one. */
  initScriptHashes?: readonly Uint8Array[];
}

const bare = (bytes: Uint8Array) => bytesToHex(bytes).slice(2);

/**
 * The JCS document dstack's VMM generates for V3 (MrConfigV3::to_canonical_json): keys in code-unit order, bytes as
 * lowercase hex without 0x, empty optional byte fields omitted, version is the only number.
 */
export function dstackMrConfigV3Document(input: DstackMrConfigV3Input): string {
  if (KEY_PROVIDER_KIND[input.keyProvider] === undefined) throw new Error("unknown dstack key provider");
  const doc: Record<string, unknown> = {};
  if (input.appId?.length) doc.app_id = bare(fixed("app id", input.appId, 20));
  doc.compose_hash = bare(fixed("compose hash", input.composeHash, 32));
  if (input.gpuPolicyHash) doc.gpu_policy_hash = bare(fixed("gpu policy hash", input.gpuPolicyHash, 32));
  if (input.initScriptHashes) doc.init_script_hashes = input.initScriptHashes.map((hash) => bare(fixed("init script hash", hash, 32)));
  if (input.instanceId?.length) doc.instance_id = bare(fixed("instance id", input.instanceId, 20));
  doc.key_provider = input.keyProvider;
  if (input.keyProviderId?.length) doc.key_provider_id = bare(input.keyProviderId);
  doc.version = 3;
  return JSON.stringify(doc);
}

/** V3 hashes the document bytes exactly as supplied; generate them with dstackMrConfigV3Document. */
export function dstackMrConfigIdV3(document: string): Uint8Array {
  const hash = sha256.create();
  hash.update(V3_DOCUMENT_DOMAIN);
  hash.update(Uint8Array.of(0));
  hash.update(new TextEncoder().encode(document));
  return register(3, hash.digest());
}

/** dstack runtime event type (not a TCG type); every RTMR3 boot event carries it. */
export const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001;

export interface DstackRuntimeEvent { event: string; payload: Uint8Array }

/** sha384(event_type as u32 little-endian ‖ ":" ‖ name ‖ ":" ‖ payload) */
export function dstackRuntimeEventDigest(event: DstackRuntimeEvent): Uint8Array {
  const type = new Uint8Array(4);
  new DataView(type.buffer).setUint32(0, DSTACK_RUNTIME_EVENT_TYPE, true);
  const hash = sha384.create();
  hash.update(type);
  hash.update(new TextEncoder().encode(`:${event.event}:`));
  hash.update(event.payload);
  return hash.digest();
}

/** RTMR3 after extending 48 zero bytes with each event digest in order. */
export function replayDstackRtmr3(events: readonly DstackRuntimeEvent[]): Uint8Array {
  let rtmr: Uint8Array = new Uint8Array(48);
  for (const event of events) {
    const hash = sha384.create();
    hash.update(rtmr);
    hash.update(dstackRuntimeEventDigest(event));
    rtmr = hash.digest();
  }
  return rtmr;
}
