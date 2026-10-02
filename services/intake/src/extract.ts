import type { PdfTextExtractor } from "./ports.ts";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Buffer } from "node:buffer";
import { replaceElements, replaceEndTags, replaceTags, tagNames } from "@mochi/core/html";

export class UnsupportedContentType extends Error {
  constructor(message: string) { super(message); this.name = "UnsupportedContentType"; }
}
export class DocumentTooLarge extends Error {
  constructor(message = "PDF exceeds the OCR runtime limits") { super(message); this.name = "DocumentTooLarge"; }
}
export class PdfExtractionError extends Error {
  constructor(message = "PDF text extraction failed") { super(message); this.name = "PdfExtractionError"; }
}
export class DefaultPdfTextExtractor implements PdfTextExtractor {
  async extract(_bytes: Uint8Array): Promise<string> { throw new UnsupportedContentType("application/pdf: in-enclave OCR runtime not bundled"); }
}

type OcrChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "once" | "on">;
export type OcrSpawn = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) => OcrChild;
export interface OcrPdfTextExtractorOptions {
  command: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: OcrSpawn;
}

/** Runs the isolated OCR runtime and strictly decodes its byte-counted page frames. */
export class OcrPdfTextExtractor implements PdfTextExtractor {
  readonly command: string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly spawnProcess: OcrSpawn;
  lastPageMethodCounts = { text: 0, ocr: 0 };

  constructor(options: OcrPdfTextExtractorOptions) {
    if (!options.command.length || options.command.some((part) => typeof part !== "string")) throw new Error("PDF OCR command must be a non-empty string array");
    this.command = [...options.command];
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024;
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) throw new Error("PDF OCR limits must be positive");
  }

  async extract(bytes: Uint8Array): Promise<string> {
    const [program, ...args] = this.command;
    let child: OcrChild;
    try { child = this.spawnProcess(program!, args, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch { throw new PdfExtractionError(); }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer!: ReturnType<typeof setTimeout>;
    const result = new Promise<Buffer>((resolve, reject) => {
      // Drain stderr to avoid a child blocking on a full pipe; its contents are intentionally discarded.
      child.stderr.resume();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.stdout.on("data", (part: Buffer | Uint8Array) => {
        if (settled) return;
        const chunk = Buffer.from(part);
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          child.kill("SIGKILL");
          fail(new PdfExtractionError("PDF OCR output exceeds the configured limit"));
          return;
        }
        chunks.push(chunk);
      });
      child.stdout.on("error", () => fail(new PdfExtractionError()));
      child.stdin.on("error", () => fail(new PdfExtractionError()));
      child.once("error", () => fail(new PdfExtractionError()));
      child.once("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks, outputBytes));
        else if (code === 2) reject(new UnsupportedContentType("Input is not a PDF"));
        else if (code === 3 || code === 4) reject(new DocumentTooLarge());
        else reject(new PdfExtractionError(`PDF text extraction failed (exit ${code ?? "unknown"})`));
      });
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new PdfExtractionError("PDF text extraction timed out"));
      }, this.timeoutMs);
      try { child.stdin.end(Buffer.from(bytes)); }
      catch { fail(new PdfExtractionError()); }
    });
    const framed = await result;
    const parsed = parseOcrFrames(framed);
    this.lastPageMethodCounts = parsed.methodCounts;
    return parsed.text;
  }
}

/** Strict parser for @@PAGE frames. The payload is sliced and decoded by byte length. */
export function parseOcrFrames(output: Uint8Array): { text: string; methodCounts: { text: number; ocr: number } } {
  const bytes = Buffer.from(output);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pages: string[] = [];
  const methodCounts = { text: 0, ocr: 0 };
  let offset = 0;
  while (offset < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) throw new PdfExtractionError("PDF OCR output has an invalid page header");
    let header: string;
    try { header = decoder.decode(bytes.subarray(offset, newline)); } catch { throw new PdfExtractionError("PDF OCR output has an invalid page header"); }
    const match = /^@@PAGE (\d+) (text|ocr) (\d+)$/.exec(header);
    if (!match) throw new PdfExtractionError("PDF OCR output has an invalid page header");
    const pageNumber = Number(match[1]);
    const payloadBytes = Number(match[3]);
    if (pageNumber !== pages.length + 1 || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new PdfExtractionError("PDF OCR output has invalid page ordering or length");
    offset = newline + 1;
    const end = offset + payloadBytes;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new PdfExtractionError("PDF OCR output ended inside a page");
    try { pages.push(decoder.decode(bytes.subarray(offset, end))); } catch { throw new PdfExtractionError("PDF OCR page is not valid UTF-8"); }
    methodCounts[match[2] as "text" | "ocr"]++;
    offset = end;
  }
  if (!pages.length) throw new PdfExtractionError("PDF OCR output contains no pages");
  return { text: pages.join("\n\f\n"), methodCounts };
}

/**
 * Intake extraction bounds. Text formats are decoded and scanned on the event loop, so their cost has to be bounded
 * and linear: every pass below is an index scan (@mochi/core/html) or a regex that cannot backtrack (a single
 * character class, or an alternation anchored on `&` whose digit runs belong to that one `&`).
 */
/** Largest document intake reads (the fetch default; public uploads are already capped at 1 MiB by the proxy). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Largest extracted text (UTF-16 code units, ~1M tokens): beyond any juror context, and stored with the record. */
export const MAX_TEXT_CHARS = 4 * 1024 * 1024;

/** The document yields no text, so there is nothing for jurors to read (and nothing a quote could honestly price). */
export class EmptyDocument extends Error {
  readonly code = "EMPTY_DOCUMENT";
  readonly status = 422;
  constructor(message = "Document has no extractable text") { super(message); this.name = "EmptyDocument"; }
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
    const lower = entity.toLowerCase();
    if (lower in named) return named[lower]!;
    const numeric = lower.startsWith("&#x") ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
    try { return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : "\ufffd"; } catch { return "\ufffd"; }
  });
}
const RAW_TEXT_TAGS = tagNames(["script", "style", "noscript"]);
const BLOCK_START_TAGS = tagNames(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article"]);
const BLOCK_END_TAGS = tagNames(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article"]);
/** Equivalent of text.split(/\r?\n/).map((line) => line.replace(/[\t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n"). */
function normalizeLines(text: string): string {
  const lines: string[] = [];
  for (let start = 0; start <= text.length;) {
    // A plain scan, not indexOf(…, start): see the note on find() in @mochi/core/html.
    let newline = start;
    while (newline < text.length && text.charCodeAt(newline) !== 10) newline++;
    const end = newline > start && text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
    const line = text.slice(start, end).replace(/[\t\f\v ]+/g, " ").trim();
    if (line) lines.push(line);
    start = newline + 1;
  }
  return lines.join("\n");
}
/**
 * The same text as the previous regex pipeline (script/style/noscript elements removed, block tags to line breaks,
 * other tags removed, entities decoded, lines trimmed), computed in linear time.
 */
export function htmlText(input: string): string {
  const stripped = replaceElements(input, RAW_TEXT_TAGS, "");
  const blocks = replaceEndTags(replaceTags(stripped, BLOCK_START_TAGS, "\n"), BLOCK_END_TAGS, "\n");
  return normalizeLines(decodeEntities(replaceTags(blocks, null, "")));
}
export async function extractText(bytes: Uint8Array, contentType: string, pdf: PdfTextExtractor = new DefaultPdfTextExtractor()): Promise<string> {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type !== "application/pdf" && !["text/plain", "text/html", "application/xhtml+xml", "application/json"].includes(type)) throw new UnsupportedContentType(`Unsupported content type: ${type}`);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLarge("Document exceeds the intake size limit");
  let text: string;
  if (type === "application/pdf") text = await pdf.extract(bytes);
  else {
    const decoded = new TextDecoder("utf-8").decode(bytes).replace(/\r\n/g, "\n");
    text = type === "text/html" || type === "application/xhtml+xml" ? htmlText(decoded) : decoded;
  }
  if (text.length > MAX_TEXT_CHARS) throw new DocumentTooLarge("Extracted text exceeds the intake size limit");
  if (!text.trim()) throw new EmptyDocument();
  return text;
}
/**
 * Billed size: the extracted text, which is what jurors read and what classPerK pays them for. Stored bytes are
 * deliberately not folded in, nor bounded by a raw-to-text ratio. Disk is an intake cost that tokensK (paid to jurors)
 * cannot fund, and at the launch tariff the per-K price is ~5% of a query, so billing or ratio-limiting raw bytes
 * would raise the cost of filling the store by well under 2x while refusing honest sparse documents (scanned PDFs,
 * script-heavy saved pages). Disk is bounded where it is spent instead: the upload size limit, empty documents
 * refused (EmptyDocument), compact records, and per-pool caps and lifetimes in the intake sealed store.
 */
export function estimateTokensK(text: string): number { return Math.max(1, Math.ceil(Math.ceil(text.length / 4) / 1000)); }
