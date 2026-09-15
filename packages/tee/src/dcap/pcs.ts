import type { CollateralSource, TdxCollateral } from "./collateral.ts";
import { parseCrl } from "./crl.ts";

type PcsOptions = {
  baseUrl?: string;
  rootCaCrlUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/** Fetch Intel PCS v4 collateral and cache each FMSPC/CA pair until its earliest expiry. */
export class PcsCollateralSource implements CollateralSource {
  private readonly cache = new Map<string, { value: TdxCollateral; until: number }>();

  constructor(private readonly options: PcsOptions = {}) {}

  async get(fmspc: string, ca: "platform" | "processor"): Promise<TdxCollateral> {
    const normalizedFmspc = fmspc.toUpperCase();
    const key = `${normalizedFmspc}:${ca}`;
    const now = this.options.now?.() ?? Date.now() / 1000;
    const cached = this.cache.get(key);
    if (cached && now <= cached.until) return cached.value;

    const fetcher = this.options.fetch ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? "https://api.trustedservices.intel.com").replace(/\/$/, "");
    const request = async (url: string): Promise<Response> => {
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`PCS HTTP ${response.status}`);
      return response;
    };

    const tcbResponse = await request(
      `${baseUrl}/tdx/certification/v4/tcb?fmspc=${normalizedFmspc}`,
    );
    const tcbBody = await tcbResponse.text();
    const tcbEnvelope = JSON.parse(tcbBody) as { signature: string };
    const tcbInfo = extractSignedBody(tcbBody, "tcbInfo");
    const tcbIssuerChain = requiredHeader(tcbResponse, "TCB-Info-Issuer-Chain");

    const qeResponse = await request(`${baseUrl}/tdx/certification/v4/qe/identity`);
    const qeBody = await qeResponse.text();
    const qeEnvelope = JSON.parse(qeBody) as { signature: string };
    const qeIdentity = extractSignedBody(qeBody, "enclaveIdentity");
    const qeIssuerChain = requiredHeader(qeResponse, "SGX-Enclave-Identity-Issuer-Chain");

    const pckResponse = await request(
      `${baseUrl}/sgx/certification/v4/pckcrl?ca=${ca}&encoding=der`,
    );
    const pckCrl = new Uint8Array(await pckResponse.arrayBuffer());
    const pckIssuerChain = requiredHeader(pckResponse, "SGX-PCK-CRL-Issuer-Chain");

    const rootUrl = this.options.rootCaCrlUrl
      ?? "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";
    const rootCrl = new Uint8Array(await (await request(rootUrl)).arrayBuffer());
    const collateral: TdxCollateral = {
      pck_crl_issuer_chain: pckIssuerChain,
      root_ca_crl: toHex(rootCrl),
      pck_crl: toHex(pckCrl),
      tcb_info_issuer_chain: tcbIssuerChain,
      tcb_info: tcbInfo,
      tcb_info_signature: tcbEnvelope.signature,
      qe_identity_issuer_chain: qeIssuerChain,
      qe_identity: qeIdentity,
      qe_identity_signature: qeEnvelope.signature,
    };

    const expiresAt = Math.min(
      Date.parse(JSON.parse(tcbInfo).nextUpdate) / 1000,
      Date.parse(JSON.parse(qeIdentity).nextUpdate) / 1000,
      parseCrl(rootCrl).nextUpdate,
      parseCrl(pckCrl).nextUpdate,
    );
    this.cache.set(key, { value: collateral, until: expiresAt });
    return collateral;
  }
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`PCS missing ${name}`);
  return decodeURIComponent(value);
}

function extractSignedBody(text: string, key: string): string {
  let offset = 0;
  while (/\s/.test(text[offset] ?? "")) offset++;
  if (text[offset++] !== "{") throw new Error("PCS malformed JSON");

  while (offset < text.length) {
    while (/[\s,]/.test(text[offset] ?? "")) offset++;
    if (text[offset] === "}") break;
    if (text[offset] !== '"') throw new Error("PCS malformed JSON");
    const keyStart = offset;
    offset = quotedEnd(text, offset);
    const name = JSON.parse(text.slice(keyStart, offset)) as string;
    while (/\s/.test(text[offset] ?? "")) offset++;
    if (text[offset++] !== ":") throw new Error("PCS malformed JSON");
    while (/\s/.test(text[offset] ?? "")) offset++;

    const valueStart = offset;
    const valueEnd = scanValueEnd(text, offset);
    if (name === key) {
      if (text[offset] !== "{") throw new Error("PCS malformed JSON");
      return text.slice(valueStart, valueEnd);
    }
    offset = valueEnd;
  }
  throw new Error(`PCS missing ${key}`);
}

function quotedEnd(text: string, start: number): number {
  let escaped = false;
  for (let offset = start + 1; offset < text.length; offset++) {
    const character = text[offset]!;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return offset + 1;
  }
  throw new Error("PCS malformed JSON");
}

function scanValueEnd(text: string, start: number): number {
  if (text[start] === '"') return quotedEnd(text, start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = start; offset < text.length; offset++) {
    const character = text[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth++;
    } else if (character === "}" || character === "]") {
      if (depth === 0) return offset;
      depth--;
      if (depth === 0) return offset + 1;
    } else if (character === "," && depth === 0) {
      return offset;
    }
  }
  return text.length;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
