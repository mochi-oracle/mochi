import { brotliDecompressSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { buildCompose, parseRenderArgs, renderCompose } from "../../../scripts/phala-rehearsal.ts";
import { parseVerifyArgs, validatePinnedMeasurement } from "./verify.ts";

describe("Phala hardware rehearsal artifacts", () => {
  test("render CLI accepts only a single output path", () => {
    expect(parseRenderArgs([]).out.endsWith("deploy/phala/rehearsal/compose.yml")).toBe(true);
    expect(parseRenderArgs(["--out", "tmp/rehearsal.yml"]).out.endsWith("tmp/rehearsal.yml")).toBe(true);
    expect(() => parseRenderArgs(["--unknown"])).toThrow("Usage");
    expect(() => parseRenderArgs(["--out"])).toThrow("requires a path");
    expect(() => parseRenderArgs(["--out", "a", "--out", "b"])).toThrow("Usage");
  });

  test("compose pins Bun and dstack, embeds bounded chunks, and has no build or restart loop", () => {
    const bundle = Buffer.alloc(90_001, 7).toString("base64");
    const rendered = Bun.YAML.parse(renderCompose(bundle)) as { services: Record<string, Record<string, unknown>> };
    const svc = rendered.services["hardware-rehearsal"]!;
    const env = svc.environment as Record<string, string>;
    const parts = Object.entries(env).filter(([key]) => /^MOCHI_BUNDLE_PART_\d{3}$/u.test(key)).map(([, value]) => value);
    expect(svc.image).toBe("oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4");
    expect(svc.volumes).toEqual(["/var/run/dstack.sock:/var/run/dstack.sock"]);
    expect(env.TEE_MODE).toBe("dstack");
    expect(env.TEE_KEYS).toBe("ephemeral");
    expect(env.MOCHI_BUNDLE_PART_COUNT).toBe(String(parts.length));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 40_000)).toBe(true);
    expect(svc.command).toBeArray();
    const bootstrap = String((svc.command as string[])[2]);
    expect(bootstrap).toContain('$${String(i).padStart(3, "0")}');
    expect(bootstrap.replaceAll('$${', '')).not.toContain('${');
    expect(svc).not.toHaveProperty("build");
    expect(svc.restart).toBe("no");
    expect(svc.mem_limit).toBe("1g");
  });

  test("verifier requires operator pin and rejects wrong measurement before upload", () => {
    const pin = `0x${"ab".repeat(32)}`;
    expect(parseVerifyArgs(["--measurement", pin])).toEqual({ baseUrl: "http://127.0.0.1:8080", measurement: pin });
    expect(() => parseVerifyArgs([])).toThrow("explicitly pinned");
    expect(() => parseVerifyArgs(["--measurement", pin, "--measurement", pin])).toThrow("Unknown or duplicate");
    expect(() => validatePinnedMeasurement(`0x${"cd".repeat(32)}`, pin)).toThrow("upload was not attempted");
    expect(() => validatePinnedMeasurement(pin, pin)).not.toThrow();
  });
});

 test("real bundle round-trips with Brotli below the provider compose limit", async () => {
   const built = await buildCompose();
   expect(Buffer.byteLength(built.compose)).toBeLessThan(190 * 1024);
   const service = (Bun.YAML.parse(built.compose) as any).services["hardware-rehearsal"];
   const env = service.environment;
   const encoded = Array.from({ length: Number(env.MOCHI_BUNDLE_PART_COUNT) }, (_, i) => env[`MOCHI_BUNDLE_PART_${String(i).padStart(3, "0")}`]).join("");
   expect(brotliDecompressSync(Buffer.from(encoded, "base64")).byteLength).toBe(built.expandedBytes);
   expect(service.command[2]).toContain("brotliDecompressSync");
 });
