import type { IntakeClient } from "../ports.ts";

/** Intake refusals a public uploader can act on; anything else stays a generic gateway error. Messages are fixed here. */
export const PUBLIC_INTAKE_ERRORS: Record<string, { status: number; message: string; retryAfter?: number }> = {
  BAD_ENVELOPE: { status: 400, message: "The encrypted request could not be opened by the intake" },
  BAD_PARAMS: { status: 400, message: "The claim parameters are invalid" },
  BAD_BINDING: { status: 400, message: "The sealed open binding is invalid" },
  BAD_UPLOAD: { status: 400, message: "The uploaded document is invalid" },
  DOCUMENT_TOO_LARGE: { status: 413, message: "The document is too large" },
  UNSUPPORTED_CONTENT_TYPE: { status: 415, message: "This document type is not supported" },
  EMPTY_DOCUMENT: { status: 422, message: "The document has no readable text" },
  GRANT_EXISTS: { status: 409, message: "This open binding already has a different grant; use a new nonce" },
  GRANT_UNAVAILABLE: { status: 409, message: "This open binding's grant has expired; use a new nonce" },
  PROVENANCE_EXISTS: { status: 409, message: "A different document is already recorded for this grant" },
  STORE_FULL: { status: 503, message: "Intake storage is temporarily full; retry later", retryAfter: 600 },
};

export class IntakeHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) { super(`Intake request failed (${status})`); this.name = "IntakeHttpError"; }
  /** The public form of this refusal, or undefined when it must stay a generic error. */
  get publicError() {
    const known = this.code ? PUBLIC_INTAKE_ERRORS[this.code] : undefined;
    return known && known.status === this.status ? { code: this.code!, ...known } : undefined;
  }
}

export function createIntakeClient(baseUrl: string, timeoutMs: number): IntakeClient {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Only the error code is read from the intake's reply; its text is never echoed to callers.
      const code = await response.json().then((b: any) => typeof b?.error?.code === "string" ? b.error.code as string : undefined, () => undefined);
      throw new IntakeHttpError(response.status, code);
    }
    return response.json();
  };
  return { request, attestation: () => request("/v1/attestation") };
}
