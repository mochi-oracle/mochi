const MAX_RESPONSE = 2 * 1024 * 1024;

export async function boundedHttpsFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("HTTPS request rejected");
  const host = url.hostname.toLowerCase();
  const pcsHost = host === "api.trustedservices.intel.com" && /^\/(?:tdx|sgx)\/certification\/v4\//u.test(url.pathname);
  const rootHost = host === "certificates.trustedservices.intel.com" && url.pathname === "/IntelSGXRootCA.der";
  if (!pcsHost && !rootHost) throw new Error("Collateral host rejected");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok || response.redirected || !response.body) throw new Error("Collateral fetch failed");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE) throw new Error("Collateral response too large");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) { await reader.cancel(); throw new Error("Collateral response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); }
}

