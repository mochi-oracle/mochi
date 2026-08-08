import { createHash, X509Certificate } from "node:crypto";
import https from "node:https";
import http from "node:http";
import { checkServerIdentity } from "node:tls";
import { encodeAbiParameters, keccak256, sha256, type Hex } from "viem";
import type { Clock, FetchPolicy, HttpGetter, HttpResponse } from "./ports.ts";

export class FetchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "FetchError"; }
}
const DEFAULT_MAX = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;
function allowed(url: URL, policy: FetchPolicy): { host: string; pins?: string[] } {
  const host = url.hostname.toLowerCase();
  const match = policy.origins.find((origin) => origin.host.toLowerCase() === host);
  if (!match) throw new FetchError("ORIGIN_NOT_ALLOWED", "Document origin is not allow-listed", 403);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (policy.allowHttpHosts ?? []).some((h) => h.toLowerCase() === host))) {
    throw new FetchError("HTTPS_REQUIRED", "HTTPS is required for document fetches");
  }
  return { host, pins: match.spkiSha256 };
}
function normalizedHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
export async function fetchDocument(urlInput: string, policy: FetchPolicy, deps: { httpGetter: HttpGetter; clock: Clock }) {
  let url: URL;
  try { url = new URL(urlInput); } catch { throw new FetchError("BAD_URL", "Invalid document URL"); }
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX, timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT;
  let hops = 0;
  const fingerprints: string[] = [];
  while (true) {
    const { host, pins } = allowed(url, policy);
    const response = await deps.httpGetter.get(url, { timeoutMs, maxBytes, ...(pins ? { spkiSha256: pins } : {}) });
    if (response.bytes.byteLength > maxBytes) throw new FetchError("DOCUMENT_TOO_LARGE", "Document exceeds the configured size limit", 413);
    if (url.protocol === "https:" && pins?.length && !pins.includes(response.certFingerprints[0] ?? "")) throw new FetchError("PIN_MISMATCH", "Document origin certificate pin did not match", 403);
    if (url.protocol === "https:") fingerprints.push(...response.certFingerprints);
    const headers = normalizedHeaders(response.headers);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hops >= 3) throw new FetchError("TOO_MANY_REDIRECTS", "Document URL exceeded the redirect limit");
      const location = headers.location;
      if (!location) throw new FetchError("BAD_REDIRECT", "Redirect response did not include a location");
      try { url = new URL(location, url); } catch { throw new FetchError("BAD_REDIRECT", "Redirect location is invalid"); }
      hops++;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new FetchError("UPSTREAM_ERROR", "Document origin returned an unsuccessful response", 502);
    const contentType = headers["content-type"]?.trim() || "application/octet-stream";
    const transcriptHash = keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint16" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32[]" }],
      [host, url.toString(), response.status, contentType, sha256(response.bytes), fingerprints.map((fp) => `0x${Buffer.from(fp, "base64").toString("hex")}` as Hex)],
    ));
    return { bytes: response.bytes, contentType, finalUrl: url.toString(), host, fetchedAt: deps.clock.nowSeconds(), transcriptHash };
  }
}

/** Direct TLS/HTTP getter. Redirects remain under fetchDocument's allow-list checks. */
export class NodeHttpGetter implements HttpGetter {
  get(url: URL, options: { timeoutMs: number; maxBytes: number; spkiSha256?: string[] }): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.get(url, {
        timeout: options.timeoutMs,
        ...(url.protocol === "https:" && options.spkiSha256?.length ? {
          checkServerIdentity: (hostname: string, cert: { raw: Buffer }) => {
            const identityError = checkServerIdentity(hostname, cert as never);
            if (identityError) return identityError;
            const fp = createHash("sha256").update(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" })).digest("base64");
            if (!options.spkiSha256!.includes(fp)) return new Error("SPKI pin mismatch");
            return undefined;
          },
        } : {}),
      }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (part: Buffer) => { size += part.length; if (size > options.maxBytes) { req.destroy(new FetchError("DOCUMENT_TOO_LARGE", "Document exceeds the configured size limit", 413)); return; } chunks.push(part); });
        res.on("end", () => {
          const cert = (res.socket as import("node:tls").TLSSocket).getPeerCertificate?.(true);
          const certFingerprints: string[] = [];
          let current = cert;
          while (current?.raw) {
            try { certFingerprints.push(createHash("sha256").update(new X509Certificate(current.raw).publicKey.export({ type: "spki", format: "der" })).digest("base64")); } catch { break; }
            current = current.issuerCertificate;
            if (current === cert) break;
          }
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(res.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          resolve({ status: res.statusCode ?? 0, headers, bytes: new Uint8Array(Buffer.concat(chunks)), certFingerprints });
        });
      });
      req.on("timeout", () => req.destroy(new FetchError("FETCH_TIMEOUT", "Document fetch timed out", 504)));
      req.on("error", reject);
    });
  }
}
