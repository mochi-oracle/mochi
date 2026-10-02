import { Buffer } from "node:buffer";

/**
 * Compact on-disk form of a sealed intake record (StoredIntake). Intake hands the store the record as JSON, which
 * carries the document as base64 (4/3 of its bytes) and the extracted text as a JSON string (up to 6 bytes per
 * character for control characters, 3 for every U+FFFD that replaces an invalid byte). Stored, the record is the JSON
 * of its other fields, then the document bytes and the text, each once:
 *
 *   "MIR" 1 | u32 header length | header JSON (docB64 and text emptied) | u32 document length | document bytes
 *         | u8 text encoding (0 UTF-8, 1 UTF-16LE) | u32 text length | text
 *
 * Reading rebuilds the same JSON. Values that are not such a record are stored behind "MIR" 0 unchanged, and values
 * written before this format (plain JSON) are read as they are.
 */
const RECORD = [0x4d, 0x49, 0x52, 0x01] as const;
const OPAQUE = [0x4d, 0x49, 0x52, 0x00] as const;
const UTF8 = 0, UTF16LE = 1;

const startsWith = (value: Uint8Array, magic: readonly number[]) => value.byteLength >= magic.length && magic.every((byte, i) => value[i] === byte);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** No unpaired surrogate, so UTF-8 round-trips the string exactly. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(i + 1); if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; } return false; }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 * i] = c & 0xff; out[2 * i + 1] = c >> 8; }
  return out;
}
function fromUtf16le(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 2 * 8192) {
    const end = Math.min(bytes.byteLength, i + 2 * 8192);
    const units = new Array<number>((end - i) / 2);
    for (let j = i; j < end; j += 2) units[(j - i) / 2] = bytes[j]! | (bytes[j + 1]! << 8);
    parts.push(String.fromCharCode(...units));
  }
  return parts.join("");
}
const u32 = (n: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, n); return out; };

/** Encodes a JSON intake record compactly; anything else is stored unchanged behind its own marker. */
export function encodeIntakeRecord(value: Uint8Array): Uint8Array {
  const opaque = () => Buffer.concat([Uint8Array.from(OPAQUE), value]);
  let record: unknown;
  try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); } catch { return opaque(); }
  if (!isRecord(record) || typeof record.docB64 !== "string" || typeof record.text !== "string") return opaque();
  const doc = Buffer.from(record.docB64, "base64");
  if (doc.toString("base64") !== record.docB64) return opaque(); // only canonical base64 rebuilds to the same string
  const header = new TextEncoder().encode(JSON.stringify({ ...record, docB64: "", text: "" }));
  // UTF-8 unless the text has a lone surrogate (UTF-8 cannot hold one) or UTF-16 is smaller (mostly U+0800 and up,
  // such as the U+FFFD that replaces each invalid byte: 3 bytes in UTF-8, 2 in UTF-16).
  const utf8 = wellFormed(record.text) && Buffer.byteLength(record.text, "utf8") <= 2 * record.text.length;
  const text = utf8 ? new TextEncoder().encode(record.text) : utf16le(record.text);
  return Buffer.concat([Uint8Array.from(RECORD), u32(header.byteLength), header, u32(doc.byteLength), doc, Uint8Array.of(utf8 ? UTF8 : UTF16LE), u32(text.byteLength), text]);
}

/** The JSON value `encodeIntakeRecord` was given (values stored before this format come back unchanged). */
export function decodeIntakeRecord(stored: Uint8Array): Uint8Array {
  if (startsWith(stored, OPAQUE)) return stored.slice(OPAQUE.length);
  if (!startsWith(stored, RECORD)) return stored;
  const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  let at = RECORD.length;
  const take = (length: number) => {
    if (at + length > stored.byteLength) throw new Error("intake record is truncated");
    const out = stored.subarray(at, at + length); at += length; return out;
  };
  const length = () => { if (at + 4 > stored.byteLength) throw new Error("intake record is truncated"); const n = view.getUint32(at); at += 4; return n; };
  const headerBytes = take(length());
  const doc = take(length());
  const encoding = take(1)[0];
  const text = take(length());
  if (at !== stored.byteLength || !(encoding === UTF8 || (encoding === UTF16LE && text.byteLength % 2 === 0))) throw new Error("intake record is malformed");
  let header: Record<string, unknown>;
  try { header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>; } catch { throw new Error("intake record is malformed"); }
  header.docB64 = Buffer.from(doc).toString("base64");
  header.text = encoding === UTF8 ? new TextDecoder().decode(text) : fromUtf16le(text);
  return new TextEncoder().encode(JSON.stringify(header));
}
