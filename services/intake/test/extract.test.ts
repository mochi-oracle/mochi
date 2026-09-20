import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DocumentTooLarge, OcrPdfTextExtractor, PdfExtractionError, parseOcrFrames, UnsupportedContentType, type OcrSpawn } from "../src/extract.ts";
import { loadConfig } from "../src/config.ts";

const encoder = new TextEncoder();
const frame = (page: number, method: "text" | "ocr", content: string, byteLength = encoder.encode(content).byteLength) =>
  encoder.encode(`@@PAGE ${page} ${method} ${byteLength}\n${content}`);
function fakeSpawn(output: Uint8Array, exitCode = 0, killed?: { value: boolean }): OcrSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (killed) killed.value = true; return true; };
    child.stdin.on("finish", () => child.stdout.end(output, () => child.emit("close", exitCode)));
    return child as unknown as ReturnType<OcrSpawn>;
  }) as OcrSpawn;
}

describe("OCR framed output", () => {
  test("extracts ordered pages and counts methods, using byte lengths for UTF-8", async () => {
    const output = Buffer.concat([Buffer.from(frame(1, "text", "Café text")), Buffer.from(frame(2, "ocr", "scanned page"))]);
    const extractor = new OcrPdfTextExtractor({ command: ["fake-ocr"], spawn: fakeSpawn(output) });
    expect(await extractor.extract(encoder.encode("pdf bytes"))).toBe("Café text\n\f\nscanned page");
    expect(extractor.lastPageMethodCounts).toEqual({ text: 1, ocr: 1 });
    expect(encoder.encode("Café text").byteLength).toBeGreaterThan("Café text".length);
  });

  test("rejects wrong order, malformed headers, short and long declared byte counts, and trailing bytes", () => {
    const cases = [
      Buffer.concat([Buffer.from(frame(2, "text", "a"))]),
      Buffer.from("@@PAGE x text 1\na"),
      frame(1, "text", "abc", 4),
      frame(1, "text", "abc", 2),
      Buffer.concat([Buffer.from(frame(1, "text", "a")), Buffer.from("garbage")]),
    ];
    for (const output of cases) expect(() => parseOcrFrames(output)).toThrow(PdfExtractionError);
  });

  test("enforces output cap and kills a process that exceeds it", async () => {
    const killed = { value: false };
    const extractor = new OcrPdfTextExtractor({ command: ["fake"], maxOutputBytes: 4, spawn: fakeSpawn(encoder.encode("12345"), 0, killed) });
    await expect(extractor.extract(encoder.encode("pdf"))).rejects.toThrow("output exceeds");
    expect(killed.value).toBe(true);
  });

  test("kills process on timeout", async () => {
    const killed = { value: false };
    const spawn: OcrSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed.value = true; return true; };
      return child as unknown as ReturnType<OcrSpawn>;
    }) as OcrSpawn;
    const extractor = new OcrPdfTextExtractor({ command: ["fake"], timeoutMs: 10, spawn });
    await expect(extractor.extract(encoder.encode("pdf"))).rejects.toThrow("timed out");
    expect(killed.value).toBe(true);
  });

  test("maps process exit codes without exposing stderr or document text", async () => {
    for (const [code, ErrorType] of [[2, UnsupportedContentType], [3, DocumentTooLarge], [4, DocumentTooLarge], [9, PdfExtractionError]] as const) {
      const extractor = new OcrPdfTextExtractor({ command: ["fake"], spawn: fakeSpawn(new Uint8Array(), code) });
      try { await extractor.extract(encoder.encode("SECRET ACME document text")); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(ErrorType);
        expect((error as Error).message).not.toContain("SECRET");
        expect((error as Error).message).not.toContain("ACME");
      }
    }
  });
});

describe("PDF OCR config", () => {
  test("defaults off and builds hardened docker/native command arrays", () => {
    expect(loadConfig({}).pdfOcrCommand).toBeUndefined();
    expect(loadConfig({ PDF_OCR: "off", PDF_OCR_COMMAND: '["custom-ocr"]' }).pdfOcrCommand).toBeUndefined();
    expect(loadConfig({ PDF_OCR: "native" }).pdfOcrCommand).toEqual(["/usr/local/bin/mochi-ocr"]);
    expect(loadConfig({ PDF_OCR: "docker" }).pdfOcrCommand).toEqual([
      "docker", "run", "--rm", "-i", "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=512m,mode=1777",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g", "mochi-ocr:1",
    ]);
    expect(loadConfig({ PDF_OCR: "native", PDF_OCR_COMMAND: '["custom-ocr","--safe"]' }).pdfOcrCommand).toEqual(["custom-ocr", "--safe"]);
  });
});
