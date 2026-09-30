import { createHash } from "node:crypto";
import { abortableProviderCall, ProviderCallAborted, ProviderRetryError, withProviderRetries, type ProviderAttemptFailure, type ProviderRetryOptions } from "@mochi/aci";

export interface ModelInput {
  system: string;
  user: string;
  document: string;
  jsonSchema: unknown;
  maxTokens: number;
}

export interface RunBudget { signal: AbortSignal; remainingMs(): number; onAttempt?: import("@mochi/aci").ProviderRetryOptions["onAttempt"] }

export interface ModelRunner {
  run(input: ModelInput, budget?: RunBudget): Promise<unknown>;
}

export class RunnerError extends Error {
  constructor(message: string, options?: ErrorOptions, readonly diagnosticCode = "runner_failed") {
    super(message, options);
    this.name = "RunnerError";
  }
}

export class OpenAICompatibleRunner implements ModelRunner {
  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs: number;
    temperature?: number;
    seed?: number;
    fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  }) {}

  async run(input: ModelInput, budget?: RunBudget): Promise<unknown> {
    const controller = new AbortController();
    const totalMs = Math.min(this.options.timeoutMs, budget?.remainingMs() ?? this.options.timeoutMs);
    if (totalMs <= 0) throw new RunnerError("model budget exhausted", undefined, "timeout");
    const signal = budget ? AbortSignal.any([controller.signal, budget.signal]) : controller.signal;
    signal.throwIfAborted();
    const timer = setTimeout(() => controller.abort(), totalMs);
    try {
      const response = await abortableProviderCall((this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          signal,
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: `${input.user}\n\n<document>\n${input.document}\n</document>` },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "mochi_extraction", schema: input.jsonSchema, strict: true },
            },
            temperature: this.options.temperature ?? 0,
            seed: this.options.seed ?? 0,
            max_tokens: input.maxTokens,
          }),
        },
      ), signal);
      if (!response.ok) throw new RunnerError(`model server returned HTTP ${response.status}`);
      const payload: unknown = await abortableProviderCall(response.json(), signal);
      if (!payload || typeof payload !== "object") throw new RunnerError("invalid model response");
      const choices = (payload as { choices?: unknown }).choices;
      const message = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } | undefined : undefined;
      const content = message?.message?.content;
      if (typeof content !== "string") throw new RunnerError("model response has no JSON content");
      try { return JSON.parse(content) as unknown; }
      catch (error) { throw new RunnerError("model response content is invalid JSON", { cause: error }); }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (signal.aborted) throw new RunnerError("model request timed out", { cause: error });
      throw new RunnerError("model request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Phala ACI runner. AciClient does not expose response JSON until its signed
 * receipt and both exact wire body hashes have verified. */
export class PhalaAciRunner implements ModelRunner {
  lastReceipt: { receiptId: string; sessionId: string; workloadId: string; modelId: string } | undefined;
  lastProviderReceipt: { receiptId: string; sessionId: string; workloadId: string; modelId: string; upstreamModelId?: string } | undefined;
  lastFailure: { causeCode: string; httpStatus?: number; attempts?: number; attemptFailures?: ProviderAttemptFailure[] } | undefined;
  /** Provider attempts used by the last run, retries included (content-free, for cost and reliability telemetry). */
  lastAttempts = 0;
  constructor(private readonly options: { client: import("@mochi/aci").AciClient; model: string; timeoutMs: number; maxTokens?: number; maxInputBytes?: number; compactReceiptMetadata?: boolean; maxAttempts?: number; attemptCapMs?: number; retry?: Partial<Pick<ProviderRetryOptions, "now" | "sleep" | "random" | "minAttemptMs">> }) {}
  async run(input: ModelInput, budget?: RunBudget): Promise<unknown> {
    this.lastFailure = undefined;
    this.lastAttempts = 0;
    const maxTokens = Math.min(input.maxTokens, this.options.maxTokens ?? input.maxTokens);
    const requestBody = {
      model: this.options.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: `${input.user}\n\n<document>\n${input.document}\n</document>` },
      ],
      provider: { aci_verified: true },
      response_format: { type: "json_schema", json_schema: { name: "mochi_extraction", schema: input.jsonSchema, strict: true } },
      temperature: 0,
      seed: 0,
      max_tokens: maxTokens,
    };
    if (this.options.maxInputBytes !== undefined && new TextEncoder().encode(JSON.stringify(requestBody)).byteLength > this.options.maxInputBytes) {
      this.lastFailure = { causeCode: "request_too_large" };
      throw new RunnerError("model request exceeds the configured public bound", undefined, "request_too_large");
    }
    const controller = new AbortController();
    const totalMs = Math.min(this.options.timeoutMs, budget?.remainingMs() ?? this.options.timeoutMs);
    if (totalMs <= 0) throw new RunnerError("model budget exhausted", undefined, "timeout");
    const signal = budget ? AbortSignal.any([controller.signal, budget.signal]) : controller.signal;
    signal.throwIfAborted();
    const timer = setTimeout(() => controller.abort(), totalMs);
    let attemptFailures: ProviderAttemptFailure[] = [];
    try {
      // Transient provider failures (429/5xx, dropped connections, stalled attempts) are retried with the
      // identical request to the same attested route, inside the one overall model timeout.
      const maxAttempts = this.options.maxAttempts ?? 3;
      const outcome = await withProviderRetries({
        maxAttempts,
        totalMs,
        onAttempt: budget?.onAttempt,
        attemptCapMs: this.options.attemptCapMs ?? 75_000,
        minAttemptMs: 35_000,
        signal,
        ...this.options.retry,
      }, (signal) => this.options.client.chat(requestBody, { signal, requireUpToDate: true, maxResponseBytes: 256 * 1024 })).catch((error: unknown) => {
        if (error instanceof ProviderCallAborted) { attemptFailures = error.failures; this.lastAttempts = error.attemptsStarted; throw error; }
        if (!(error instanceof ProviderRetryError)) throw error;
        attemptFailures = error.failures;
        this.lastAttempts = error.failures.length;
        throw error.attemptTimedOut ? new RunnerError("model request timed out", { cause: error.lastError }, "timeout") : error.lastError;
      });
      this.lastAttempts = outcome.attempts;
      const result = outcome.value;
      // ACI checks UpToDate on the freshly attested workload before submitting
      // chat when requireUpToDate is set. Keep this defense-in-depth check too.
      if (result.established.tcbStatus !== "UpToDate") throw new RunnerError("TDX TCB status is not allowed", undefined, "tcb_status");
      const choices = result.json?.choices;
      const message = Array.isArray(choices) ? choices[0]?.message : undefined;
      if (typeof message?.content !== "string") throw new RunnerError("model response has no JSON content", undefined, "response_json");
      const requestedModelId = (result.receipt as typeof result.receipt & { requestedModelId?: string }).requestedModelId;
      if (this.options.compactReceiptMetadata && requestedModelId !== this.options.model) throw new RunnerError("verified receipt model does not match the request", undefined, "receipt_model");
      this.lastProviderReceipt = {
        receiptId: result.receipt.receiptId,
        sessionId: result.receipt.sessionId,
        workloadId: result.established.workloadId,
        modelId: this.options.compactReceiptMetadata ? requestedModelId! : result.receipt.modelId,
        ...(this.options.compactReceiptMetadata ? { upstreamModelId: result.receipt.modelId } : {}),
      };
      const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
      this.lastReceipt = this.options.compactReceiptMetadata ? {
        modelId: this.lastProviderReceipt.modelId,
        receiptId: digest(result.receipt.receiptId),
        sessionId: digest(result.receipt.sessionId),
        workloadId: digest(result.established.workloadId),
      } : this.lastProviderReceipt;
      try { return JSON.parse(message.content) as unknown; }
      catch (error) { throw new RunnerError("model response content is invalid JSON", { cause: error }, "response_json"); }
    } catch (error) {
      const code = error instanceof RunnerError ? error.diagnosticCode
        : signal.aborted ? "timeout"
        : error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z_]+$/u.test(error.code) ? error.code
        : "aci_error";
      const known = new Set(["aborted", "attestation_http", "attestation_redirect", "inference_http", "inference_redirect", "receipt_header", "receipt_redirect", "receipt_unavailable", "receipt_binding", "receipt_signature", "receipt_model", "body_hash", "upstream_unverified", "response_json", "response_body", "response_too_large", "invalid_report", "report_binding", "report_stale", "quote_missing", "quote_binding", "dcap_failed", "compose_measurement", "tcb_status", "workload_not_allowed", "request_shape", "request_provider", "request_confidentiality", "timeout", "request_too_large", "runner_failed"]);
      const causeCode = known.has(code) ? code : "aci_error";
      const nested = error instanceof RunnerError ? error.cause : error;
      const httpStatus = nested && typeof nested === "object" && "httpStatus" in nested && typeof nested.httpStatus === "number" && Number.isInteger(nested.httpStatus) && nested.httpStatus >= 100 && nested.httpStatus <= 599 ? nested.httpStatus : undefined;
      this.lastFailure = { causeCode, ...(httpStatus === undefined ? {} : { httpStatus }), ...(this.lastAttempts > 1 ? { attempts: this.lastAttempts, attemptFailures } : {}) };
      if (error instanceof RunnerError) throw error;
      if (signal.aborted) throw new RunnerError("model request timed out", { cause: error }, "timeout");
      throw new RunnerError("model verification or inference failed", { cause: error }, causeCode);
    } finally { clearTimeout(timer); }
  }
}

export class StubRunner implements ModelRunner {
  constructor(private readonly fixture: (input: ModelInput) => unknown | Promise<unknown>) {}
  async run(input: ModelInput, budget?: RunBudget): Promise<unknown> { return this.fixture(input); }
}
