// Bundle the existing TEE provider and IntakeEnclave upload path into an inline, no-build Phala compose service.
// It embeds code only: no credentials, private keys, deployment configuration, or source fixtures are bundled.
import { brotliCompressSync, constants } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "deploy/phala/rehearsal/server.ts");
const PINNED_BUN = "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const PART_SIZE = 40_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const DEFAULT_OUT = resolve(ROOT, "deploy/phala/rehearsal/compose.yml");

export function parseRenderArgs(args: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--out" || out) throw new Error("Usage: bun scripts/phala-rehearsal.ts [--out compose.yml]");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("--out requires a path.");
    out = resolve(value);
  }
  return { out: out ?? DEFAULT_OUT };
}

export function renderCompose(bundleBase64: string): string {
  if (!bundleBase64 || !/^[A-Za-z0-9+/]+=*$/u.test(bundleBase64)) throw new TypeError("Expected a base64 bundle.");
  if (Buffer.from(bundleBase64, "base64").toString("base64") !== bundleBase64) throw new TypeError("Expected canonical base64 bundle data.");
  const parts = bundleBase64.match(new RegExp(`.{1,${PART_SIZE}}`, "gu")) ?? [];
  const environment: Record<string, string> = {
    HOST: "0.0.0.0", PORT: "8080", TEE_MODE: "dstack", TEE_KEYS: "ephemeral",
    DSTACK_SOCKET: "/var/run/dstack.sock", SEALED_STORE_DIR: "/tmp/intake",
    MOCHI_BUNDLE_PART_COUNT: String(parts.length),
  };
  parts.forEach((part, index) => { environment[`MOCHI_BUNDLE_PART_${String(index).padStart(3, "0")}`] = part; });
  const bootstrap = [
    'import { brotliDecompressSync } from "node:zlib";',
    'const n = Number(process.env.MOCHI_BUNDLE_PART_COUNT);',
    'if (!Number.isSafeInteger(n) || n < 1 || n > 64) throw new Error("invalid embedded bundle");',
    'const b64 = Array.from({ length: n }, (_, i) => process.env[`MOCHI_BUNDLE_PART_$${String(i).padStart(3, "0")}`] ?? "").join("");',
    'if (!b64 || b64.length > 3_000_000) throw new Error("invalid embedded bundle");',
    'const code = brotliDecompressSync(Buffer.from(b64, "base64"));',
    'await Bun.write("/tmp/mochi-rehearsal.mjs", code);',
    'await import("/tmp/mochi-rehearsal.mjs");',
  ].join(" ");
  const compose = {
    services: {
      "hardware-rehearsal": {
        image: PINNED_BUN,
        restart: "no",
        ports: ["8080:8080"],
        volumes: ["/var/run/dstack.sock:/var/run/dstack.sock"],
        tmpfs: ["/tmp:rw,noexec,nosuid,size=64m,mode=1777"],
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        mem_limit: "1g",
        cpus: "1.0",
        pids_limit: 128,
        environment,
        command: ["bun", "-e", bootstrap],
      },
    },
  };
  return Bun.YAML.stringify(compose, null, 2) + "\n";
}

export async function buildCompose(): Promise<{ compose: string; compressedBytes: number; expandedBytes: number }> {
  const build = await Bun.build({ entrypoints: [ENTRY], target: "bun", minify: true, sourcemap: "none" });
  if (!build.success || build.outputs.length !== 1) throw new Error("Could not bundle the rehearsal service.");
  const expanded = new Uint8Array(await build.outputs[0]!.arrayBuffer());
  if (expanded.byteLength > MAX_BUNDLE_BYTES) throw new Error("Bundled rehearsal service exceeds the 2 MiB build limit.");
  const compressed = brotliCompressSync(expanded, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const b64 = Buffer.from(compressed).toString("base64");
  if (b64.length > PART_SIZE * 64) throw new Error("Compressed bundle exceeds the embedded command limits.");
  const compose = renderCompose(b64);
  if (Buffer.byteLength(compose) > 190 * 1024) throw new Error("Compose exceeds the rehearsal 190 KiB budget below Phala’s 200 KiB limit.");
  return { compose, compressedBytes: compressed.byteLength, expandedBytes: expanded.byteLength };
}

if (import.meta.main) {
  try {
    const { out } = parseRenderArgs(Bun.argv.slice(2));
    const result = await buildCompose();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, result.compose, { mode: 0o600 });
    process.stdout.write(`Rendered ${out}\nBundled code: ${result.expandedBytes} bytes; brotli: ${result.compressedBytes} bytes\nPinned image: ${PINNED_BUN}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Rehearsal compose render failed."}\n`);
    process.exitCode = 1;
  }
}
