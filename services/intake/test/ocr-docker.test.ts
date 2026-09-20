import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { OcrPdfTextExtractor } from "../src/extract.ts";
import { loadConfig } from "../src/config.ts";

const imageAvailable = spawnSync("docker", ["image", "inspect", "mochi-ocr:1"], { stdio: "ignore" }).status === 0;
describe("real OCR container", () => {
  (imageAvailable ? test : test.skip)(imageAvailable ? "extracts text layer and OCR from real fixtures" : "skipped: docker image mochi-ocr:1 is not available", async () => {
    const config = loadConfig({ PDF_OCR: "docker" });
    const extractor = new OcrPdfTextExtractor({ command: config.pdfOcrCommand! });
    const textPdf = new Uint8Array(await readFile(new URL("./fixtures/text.pdf", import.meta.url)));
    const scanPdf = new Uint8Array(await readFile(new URL("./fixtures/scan.pdf", import.meta.url)));
    const text = await extractor.extract(textPdf);
    expect(text).toContain("ACME Corp announces a 3-for-1 stock split");
    expect(text).toContain("effective November 20, 2026");
    expect(extractor.lastPageMethodCounts).toEqual({ text: 1, ocr: 0 });
    const scan = await extractor.extract(scanPdf);
    expect(scan).toContain("ACME Corp announces a 3-for-1 stock split");
    expect(scan).toContain("effective November 20, 2026");
    expect(extractor.lastPageMethodCounts).toEqual({ text: 0, ocr: 1 });
  });
});
