import { describe, expect, it } from "bun:test";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import {
  dstackConfigMeasurement,
  dstackMrConfigIdV1,
  dstackMrConfigIdV2,
  dstackMrConfigIdV3,
  dstackMrConfigV3Document,
  dstackMrConfigVersion,
  dstackRuntimeEventDigest,
  replayDstackRtmr3,
} from "../src/index.ts";

const b = (hex: string) => hexToBytes(`0x${hex.replace(/^0x/, "")}` as Hex);
const fill = (byte: number, length: number) => new Uint8Array(length).fill(byte);
const padded = (hex: string) => `0x${hex}${"00".repeat(15)}` as Hex;
// Phala KMS root CA public key (SubjectPublicKeyInfo DER), the key_provider_id dstack binds for KMS-backed apps.
const PHALA_KMS_ID = "3059301306072a8648ce3d020106082a8648ce3d030107034200048844eb42ccdf8c52fd4f174f362fcb9bbd19c45fd48f1edec2d8f1ca23536ec1a74021b4cee610c074f8294d431b2b7fee2c39e5333fdaf0a4522d43fb159d9f";

describe("dstack MRCONFIGID layouts", () => {
  it("V1 is the compose hash, as in a production quote", () => {
    const compose = "e7d11bff53f19b79df321af3f64e8108e19b22c1fc72d979ca1508457a1579d0";
    const id = dstackMrConfigIdV1(b(compose));
    expect(bytesToHex(id)).toBe(padded(`01${compose}`));
    expect(dstackMrConfigVersion(id)).toBe(1);
  });

  it("V2 matches dstack's keccak layout (vectors printed by dstack-types)", () => {
    const id = dstackMrConfigIdV2({
      composeHash: b("4f475ed201ac079f2e4760fb7554763edcc97c48132d554666a2ec3fd2c9e099"),
      appId: b("8d8f406cf93e1cf54207fbf99c9bc437dd4d6aef"), keyProvider: "kms", keyProviderId: b(PHALA_KMS_ID),
    });
    expect(bytesToHex(id)).toBe(padded("02dd0db3893b8c47b5e4098d7630d22959a1423af536890d10aaf3f0a7b169921b"));
    const base = { composeHash: b("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), appId: b("000102030405060708090a0b0c0d0e0f10111213") };
    expect(bytesToHex(dstackMrConfigIdV2({ ...base, keyProvider: "kms", keyProviderId: b("aabbccdd") })))
      .toBe(padded("02e472ed80a08042f044ba63b53b798e98e3ea5219cd078007b1ac8b3dfc762b94"));
    expect(bytesToHex(dstackMrConfigIdV2({ ...base, keyProvider: "none", keyProviderId: new Uint8Array() })))
      .toBe(padded("02b21a3a65891c2c3955d82000b30fab13f4adc1a12dc4a84793ea322b71f1882a"));
    expect(dstackMrConfigVersion(id)).toBe(2);
  });

  it("V3 hashes dstack's JCS launch document", () => {
    const kms = { appId: fill(0x11, 20), composeHash: fill(0x22, 32), keyProvider: "kms" as const, keyProviderId: fill(0x33, 32), instanceId: fill(0x44, 20) };
    const document = dstackMrConfigV3Document(kms);
    expect(document).toBe(
      `{"app_id":"${"11".repeat(20)}","compose_hash":"${"22".repeat(32)}","instance_id":"${"44".repeat(20)}",`
      + `"key_provider":"kms","key_provider_id":"${"33".repeat(32)}","version":3}`,
    );
    const id = dstackMrConfigIdV3(document);
    expect(bytesToHex(id)).toBe(padded("0350fc88d0a462b6a0b06ba25859abc02e98c2a8d9bd000b7dc0d8bae65e71ecbb"));
    expect(dstackMrConfigVersion(id)).toBe(3);
    // dstack-types' own JCS test document, with a GPU policy hash between compose_hash and instance_id.
    expect(dstackMrConfigV3Document({ ...kms, gpuPolicyHash: fill(0x55, 32) })).toBe(
      `{"app_id":"${"11".repeat(20)}","compose_hash":"${"22".repeat(32)}","gpu_policy_hash":"${"55".repeat(32)}",`
      + `"instance_id":"${"44".repeat(20)}","key_provider":"kms","key_provider_id":"${"33".repeat(32)}","version":3}`,
    );
    const scripts = dstackMrConfigV3Document({
      appId: fill(0x11, 20), composeHash: fill(0x22, 32), keyProvider: "local", keyProviderId: fill(0x55, 20), instanceId: fill(0x44, 20),
      initScriptHashes: [fill(0xaa, 32), fill(0xbb, 32)],
    });
    expect(bytesToHex(dstackMrConfigIdV3(scripts))).toBe(padded("039af46bdc5deb1ea74f2c77b4f83165f1f3e4e37e3ce15462b5fee0d235912390"));
    const none = dstackMrConfigV3Document({ appId: fill(0x11, 20), composeHash: fill(0x22, 32), keyProvider: "none", keyProviderId: new Uint8Array(), instanceId: new Uint8Array() });
    expect(none).toBe(`{"app_id":"${"11".repeat(20)}","compose_hash":"${"22".repeat(32)}","key_provider":"none","version":3}`);
    expect(bytesToHex(dstackMrConfigIdV3(none))).toBe(padded("0301d4d7e6ca2922bb80683c27fe1f4da318cf14d1c38db97563c2b6209af7dba5"));
    const emptyScripts = dstackMrConfigV3Document({ ...kms, initScriptHashes: [] });
    expect(emptyScripts).toContain('"init_script_hashes":[]');
    expect(bytesToHex(dstackMrConfigIdV3(emptyScripts))).toBe(padded("03ce2f8b8e4aa4cccdae73fb3a118047726b77d70b1e47bb0e3e48600603fd612c"));
    expect(() => dstackMrConfigV3Document({ ...kms, instanceId: fill(1, 19) })).toThrow();
  });

  it("the stable measurement accepts V1, V2 and V3 and still hashes the whole register", () => {
    const r = (byte: number) => fill(byte, 48);
    const regs = { mrtd: r(1), rtmr: [r(2), r(3), r(4), r(5)] as const };
    const v1 = dstackMrConfigIdV1(fill(0x22, 32));
    const v2 = dstackMrConfigIdV2({ composeHash: fill(0x22, 32), appId: fill(0x11, 20), keyProvider: "kms", keyProviderId: b(PHALA_KMS_ID) });
    const v3 = dstackMrConfigIdV3(dstackMrConfigV3Document({ composeHash: fill(0x22, 32), appId: fill(0x11, 20), keyProvider: "kms", keyProviderId: b(PHALA_KMS_ID), instanceId: fill(0x44, 20) }));
    const pins = [v1, v2, v3].map((mrConfigId) => dstackConfigMeasurement({ ...regs, mrConfigId }));
    expect(new Set(pins).size).toBe(3);
    const relabelled = v3.slice(); relabelled[0] = 2;
    expect(dstackConfigMeasurement({ ...regs, mrConfigId: relabelled })).not.toBe(pins[2]);
    for (const version of [0, 4, 0xff]) {
      const unknown = v3.slice(); unknown[0] = version;
      expect(() => dstackConfigMeasurement({ ...regs, mrConfigId: unknown })).toThrow("unsupported dstack MRCONFIGID version");
    }
    const zeroCommitment = new Uint8Array(48); zeroCommitment[0] = 3;
    expect(() => dstackMrConfigVersion(zeroCommitment)).toThrow("nonzero");
    const dirty = v3.slice(); dirty[47] = 1;
    expect(() => dstackMrConfigVersion(dirty)).toThrow("padding");
    expect(() => dstackMrConfigVersion(new Uint8Array(48))).toThrow();
  });
});

describe("dstack RTMR3 runtime events", () => {
  // Public boot event log of a Phala dstack 0.5.9 CVM (KMS key provider) and the RTMR3 its DCAP quotes carried.
  const events = [
    ["system-preparing", ""],
    ["app-id", "21dfb9d71c8d72522bb4372657b96308a190daaa"],
    ["compose-hash", "e7d11bff53f19b79df321af3f64e8108e19b22c1fc72d979ca1508457a1579d0"],
    ["instance-id", "a860de12f1343b31164d9b34f17218f583cb7ad2"],
    ["boot-mr-done", ""],
    ["mr-kms", "f632d9c363cc4861f7b0e870f22aefbe6bfd2cb01cba1def896e7d55a6fd5dba"],
    ["os-image-hash", "bd369a8c2f9edb2b52dad48ac8e0b32dde5f1337c423a506b48d07403a7d8033"],
    ["key-provider", bytesToHex(new TextEncoder().encode(`{"name":"kms","id":"${PHALA_KMS_ID}"}`)).slice(2)],
    ["storage-fs", "65787434"],
    ["system-ready", ""],
  ].map(([event, payload]) => ({ event: event!, payload: b(payload!) }));

  it("event digests and the replayed register match dstack", () => {
    expect(bytesToHex(dstackRuntimeEventDigest(events[1]!)))
      .toBe("0x9ed62428c189f50e81d1ec97382a363f20692a00a78cf547ce2f98b5418039527bf3a546cd3660753424cdd167ead6d9");
    expect(bytesToHex(dstackRuntimeEventDigest(events[7]!)))
      .toBe("0x83368b43a0fc6f824f5a9220592df85fd30e2d405ecbd253a5c6354af63e6c9b41aec557c38a38e348ab87f9ac8fc68c");
    expect(bytesToHex(replayDstackRtmr3(events)))
      .toBe("0xa95a9c6c5063ec21ef02bd7687f10511e417565e3cb048a5710d3556157143a71d97b0f507a0fa8280e1cdc628107a84");
    const swapped = events.slice(); [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(bytesToHex(replayDstackRtmr3(swapped))).not.toBe(bytesToHex(replayDstackRtmr3(events)));
    expect(bytesToHex(replayDstackRtmr3([]))).toBe(`0x${"00".repeat(48)}`);
  });
});
