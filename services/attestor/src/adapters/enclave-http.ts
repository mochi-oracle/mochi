import { AttestationDocSchema, JurorAttestationDocSchema } from "@mochi/protocol";
import type { EnclaveHttp } from "../ports.ts";

export class EndpointUnavailableError extends Error {
  constructor() { super("endpoint unavailable"); this.name = "EndpointUnavailableError"; }
}

export function createEnclaveHttp(timeoutMs: number): EnclaveHttp {
  return {
    async fetchAttestation(baseUrl) {
      let response: Response;
      try {
        const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
        const url = new URL("v1/attestation", base);
        response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      } catch {
        throw new EndpointUnavailableError();
      }
      if (!response.ok) throw new EndpointUnavailableError();
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new Error("invalid attestation JSON"); }
      const doc = AttestationDocSchema.parse(body);
      return doc.role === "JUROR" ? JurorAttestationDocSchema.parse(body) : doc;
    },
  };
}
