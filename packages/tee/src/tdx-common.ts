// Mochi conventions shared by the enclave side (TdxTeeProvider) and the verifier (DcapQuoteVerifier) for Intel TDX.
import { bytesToHex, concat, hexToBytes, keccak256, toBytes, type Hex } from "viem";

export const TDX_REPORT_DATA_BYTES = 64;
const REGISTER_BYTES = 48;

/**
 * TD REPORTDATA (64 bytes) = keyBinding (32) ‖ issuedAt as uint64 big-endian (8) ‖ 24 zero bytes.
 * keyBinding = keyBinding(enclave signer address, x25519 public key) from provider.ts; issuedAt = unix seconds.
 */
export function tdxReportData(keyBinding: Hex, issuedAt: number): Uint8Array {
  const binding = hexToBytes(keyBinding);
  if (binding.length !== 32) throw new RangeError("keyBinding must be 32 bytes");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new RangeError("issuedAt must be a non-negative safe integer");
  const out = new Uint8Array(TDX_REPORT_DATA_BYTES);
  out.set(binding, 0);
  new DataView(out.buffer).setBigUint64(32, BigInt(issuedAt), false);
  return out;
}

/** Inverse of tdxReportData. Returns undefined unless the length is 64 and the 24 padding bytes are zero. */
export function parseTdxReportData(reportData: Uint8Array): { keyBinding: Hex; issuedAt: number } | undefined {
  if (reportData.length !== TDX_REPORT_DATA_BYTES) return undefined;
  if (reportData.subarray(40).some((b) => b !== 0)) return undefined;
  const issued = new DataView(reportData.buffer, reportData.byteOffset, reportData.byteLength).getBigUint64(32, false);
  if (issued > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { keyBinding: bytesToHex(reportData.subarray(0, 32)), issuedAt: Number(issued) };
}

/**
 * The bytes32 measurement registered on-chain (JurorRegistry.setMeasurement) for a TD:
 * keccak256(MRTD ‖ RTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3), each register 48 bytes.
 * MRTD pins the virtual firmware, RTMR0 its configuration (VM size/ACPI), RTMR1–2 the kernel, initrd and command line
 * (and so a dm-verity root hash), RTMR3 runtime extensions. A change to any of them is a different enclave.
 */
export function tdxMeasurement(regs: { mrtd: Uint8Array; rtmr: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array] }): Hex {
  for (const r of [regs.mrtd, ...regs.rtmr]) if (r.length !== REGISTER_BYTES) throw new RangeError("TDX registers are 48 bytes");
  return keccak256(concat([regs.mrtd, ...regs.rtmr]));
}


export type MeasurementScheme = "dstack-config-v1";
export const DSTACK_CONFIG_MEASUREMENT_DOMAIN = "MOCHI_DSTACK_CONFIG_V1";

/**
 * Stable dstack app identity measurement. MRCONFIGID is version || compose commitment || 15 zero bytes.
 * Runtime extensions in RTMR3 are deliberately excluded; full DCAP verification remains mandatory.
 */
export function dstackConfigMeasurement(regs: {
  mrtd: Uint8Array;
  mrConfigId: Uint8Array;
  rtmr: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
}): Hex {
  if (regs.mrtd.length !== REGISTER_BYTES || regs.rtmr.some((register) => register.length !== REGISTER_BYTES)) {
    throw new RangeError("TDX registers are 48 bytes");
  }
  const config = regs.mrConfigId;
  if (config.length !== REGISTER_BYTES) throw new RangeError("MRCONFIGID is 48 bytes");
  if (config[0] !== 1 && config[0] !== 2) throw new Error("unsupported dstack MRCONFIGID version");
  if (config.subarray(1, 33).every((byte) => byte === 0)) throw new Error("dstack MRCONFIGID commitment must be nonzero");
  if (config.subarray(33).some((byte) => byte !== 0)) throw new Error("dstack MRCONFIGID padding must be zero");
  return keccak256(concat([
    toBytes(DSTACK_CONFIG_MEASUREMENT_DOMAIN), regs.mrtd, regs.rtmr[0], regs.rtmr[1], regs.rtmr[2], config,
  ]));
}
