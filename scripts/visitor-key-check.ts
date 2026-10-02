/**
 * Confirms that the website and the CVM hold the same visitor secret, without either server publishing anything
 * derived from it:
 *
 *   bun scripts/visitor-key-check.ts https://<website>/health https://<cvm>/production/status < <file holding the secret>
 *
 * Reads the secret from standard input (never from the command line), sends each URL a fresh X-Mochi-Key-Check proof
 * (keyCheckHeader in services/claims/src/visitor-key.ts) and prints each server's answer from `client.visitorKeyCheck`.
 * Exits 0 only when every server answers "match". Each check is one online guess at the secret for the server, so the
 * servers allow only a few per hour ("rate_limited").
 */
import { KEY_CHECK_HEADER, keyCheckHeader } from "../services/claims/src/visitor-key.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** HTTPS, or plain HTTP to a loopback address for a local rehearsal; no credentials in the URL. */
function checkedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Not a URL: ${value}`); }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) throw new Error(`Use an HTTPS URL without credentials: ${value}`);
  return url;
}

export async function checkVisitorKeys(secret: string, urls: string[], fetcher: typeof fetch = fetch): Promise<Array<{ url: string; result: string }>> {
  const targets = urls.map(checkedUrl);
  const results: Array<{ url: string; result: string }> = [];
  for (const url of targets) {
    // A fresh proof per server; it throws for a missing or short secret before anything is sent.
    const proof = keyCheckHeader(secret);
    let result = "unreachable";
    try {
      const response = await fetcher(url, { headers: { [KEY_CHECK_HEADER]: proof }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = response.ok ? await response.json() as { client?: { visitorKeyCheck?: unknown } } : undefined;
      const reported = body?.client?.visitorKeyCheck;
      result = typeof reported === "string" ? reported : `HTTP ${response.status}`;
    } catch { /* reported as unreachable */ }
    results.push({ url: url.toString(), result });
  }
  return results;
}

if (import.meta.main) {
  const urls = Bun.argv.slice(2);
  if (!urls.length) throw new Error("usage: bun scripts/visitor-key-check.ts <website>/health <cvm>/production/status < secret-file");
  const secret = (await new Response(Bun.stdin.stream()).text()).trim();
  const results = await checkVisitorKeys(secret, urls);
  for (const { url, result } of results) console.log(`${result}\t${url}`);
  if (!results.every(({ result }) => result === "match")) process.exit(1);
}
