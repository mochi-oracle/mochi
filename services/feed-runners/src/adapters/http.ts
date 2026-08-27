import { AttestationDocSchema, IntakeResultSchema, type EnvelopeJson } from "@mochi/protocol";
import type { Hex } from "viem";
import type { EdgarHttp, HttpPort } from "../ports.ts";
import { IntakeHttpError } from "../execute.ts";

async function jsonRequest(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
export class IntakeHttpClient implements HttpPort {
  async getAttestation(url: string, timeoutMs: number) {
    const response = await jsonRequest(url, { headers: { accept: "application/json" } }, timeoutMs);
    if (!response.ok) throw new Error(`attestation endpoint returned HTTP ${response.status}`);
    return AttestationDocSchema.parse(await response.json());
  }
  async postIntake(url: string, envelope: EnvelopeJson, timeoutMs: number) {
    const response = await jsonRequest(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ envelope }) }, timeoutMs);
    if (!response.ok) throw new IntakeHttpError(response.status);
    return IntakeResultSchema.parse(await response.json());
  }
}

export class EdgarHttpClient implements EdgarHttp {
  private nextRequestAt = 0;
  private throttle: Promise<void> = Promise.resolve();
  constructor(private readonly userAgent: string, private readonly timeoutMs = 10_000, private readonly now = () => Date.now(), private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {}
  private async get(url: string): Promise<Response> {
    let release!: () => void;
    const previous = this.throttle;
    this.throttle = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const now = this.now();
    const delay = this.nextRequestAt - now;
    if (delay > 0) await this.sleep(delay);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + 200;
    release();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: { "User-Agent": this.userAgent, accept: "application/atom+xml, application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`EDGAR returned HTTP ${response.status}`);
      return response;
    } finally { clearTimeout(timer); }
  }
  async getAtom(cik: string): Promise<string> {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=8-K&dateb=&owner=include&count=10&output=atom`;
    return this.get(url).then((response) => response.text());
  }
  /** Returns the filing's `-index.htm` page (index.json lacks document types). */
  async getFilingIndex(cik: string, accessionNoDashes: string): Promise<string> {
    const dashed = `${accessionNoDashes.slice(0, 10)}-${accessionNoDashes.slice(10, 12)}-${accessionNoDashes.slice(12)}`;
    const url = `https://www.sec.gov/Archives/edgar/data/${encodeURIComponent(cik)}/${encodeURIComponent(accessionNoDashes)}/${dashed}-index.htm`;
    return this.get(url).then((response) => response.text());
  }
}
