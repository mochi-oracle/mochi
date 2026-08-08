import { z } from "zod";
import type { FetchPolicy } from "./ports.ts";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  HOST: z.string().default("127.0.0.1"),
  MOCHI_DEPLOYMENT: z.string().default("deployments/local.json"),
  TEE_MODE: z.enum(["mock", "tdx", "dstack"]).default("mock"),
  TEE_KEYS: z.enum(["kms", "ephemeral"]).optional(),
  TEE_KEY_LABEL: z.string().min(1).max(64).default("default"),
  QUOTE_VERIFIER: z.enum(["mock", "dcap"]).default("mock"),
  MOCK_TEE_SEED: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).default(`0x${"11".repeat(32)}`),
  MOCK_TEE_MEASUREMENT: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(`0x${"22".repeat(32)}`),
  MOCK_ROOT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x0000000000000000000000000000000000000001"),
  MOCK_ROOT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).default(`0x${"33".repeat(32)}`),
  SEALED_STORE_DIR: z.string().default("./data/intake"),
  FETCH_ORIGINS: z.string().default("[]"),
  ALLOW_HTTP_HOSTS: z.string().default(""),
  PDF_OCR: z.enum(["off", "docker", "native"]).default("off"),
  PDF_OCR_IMAGE: z.string().min(1).default("mochi-ocr:1"),
  PDF_OCR_COMMAND: z.string().optional(),
});
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const raw = ConfigSchema.parse(env);
  let origins: FetchPolicy["origins"];
  try { origins = z.array(z.object({ host: z.string().min(1), spkiSha256: z.array(z.string()).optional() })).parse(JSON.parse(raw.FETCH_ORIGINS)); }
  catch { throw new Error("FETCH_ORIGINS must be a JSON array of origin policies"); }
  let pdfOcrCommand: string[] | undefined;
  if (raw.PDF_OCR !== "off" && raw.PDF_OCR_COMMAND !== undefined) {
    try { pdfOcrCommand = z.array(z.string()).min(1).parse(JSON.parse(raw.PDF_OCR_COMMAND)); }
    catch { throw new Error("PDF_OCR_COMMAND must be a JSON array of strings"); }
  } else if (raw.PDF_OCR === "docker") {
    pdfOcrCommand = ["docker", "run", "--rm", "-i", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g", raw.PDF_OCR_IMAGE];
  } else if (raw.PDF_OCR === "native") {
    pdfOcrCommand = ["/usr/local/bin/mochi-ocr"];
  }
  return { port: raw.PORT, deploymentPath: raw.MOCHI_DEPLOYMENT, teeMode: raw.TEE_MODE, mockTeeSeed: raw.MOCK_TEE_SEED as `0x${string}`, mockTeeMeasurement: raw.MOCK_TEE_MEASUREMENT as `0x${string}`, mockRootAddress: raw.MOCK_ROOT_ADDRESS as `0x${string}`, mockRootKey: raw.MOCK_ROOT_KEY as `0x${string}`, sealedStoreDir: raw.SEALED_STORE_DIR, pdfOcr: raw.PDF_OCR, pdfOcrCommand, fetchPolicy: { origins, allowHttpHosts: raw.ALLOW_HTTP_HOSTS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) } satisfies FetchPolicy };
}
