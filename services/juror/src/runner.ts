import { createHash } from "node:crypto";

export interface ModelInput {
  system: string;
  user: string;
  document: string;
  jsonSchema: unknown;
  maxTokens: number;
}

export interface ModelRunner {
  run(input: ModelInput): Promise<unknown>;
}

export class RunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
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

  async run(input: ModelInput): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          signal: controller.signal,
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
      );
      if (!response.ok) throw new RunnerError(`model server returned HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") throw new RunnerError("invalid model response");
      const choices = (payload as { choices?: unknown }).choices;
      const message = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } | undefined : undefined;
      const content = message?.message?.content;
      if (typeof content !== "string") throw new RunnerError("model response has no JSON content");
      try { return JSON.parse(content) as unknown; }
      catch (error) { throw new RunnerError("model response content is invalid JSON", { cause: error }); }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (controller.signal.aborted) throw new RunnerError("model request timed out", { cause: error });
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
  lastProviderReceipt: { receiptId: string; sessionId: string; workloadId: string; modelId: string } | undefined;
  constructor(private readonly options: { client: import("@mochi/aci").AciClient; model: string; timeoutMs: number; maxTokens?: number; maxInputBytes?: number; compactReceiptMetadata?: boolean }) {}
  async run(input: ModelInput): Promise<unknown> {
    const maxTokens = Math.min(input.maxTokens, this.options.maxTokens ?? input.maxTokens);
    const requestBody = {
      model: this.options.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: `${input.user}\n\n<document>\n${input.document}\n</document>` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "mochi_extraction", schema: input.jsonSchema, strict: true } },
      temperature: 0,
      seed: 0,
      max_tokens: maxTokens,
    };
    if (this.options.maxInputBytes !== undefined && new TextEncoder().encode(JSON.stringify(requestBody)).byteLength > this.options.maxInputBytes) throw new RunnerError("model request exceeds the configured public bound");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const result = await this.options.client.chat(requestBody, { signal: controller.signal, requireUpToDate: true, maxResponseBytes: 256 * 1024 });
      // ACI checks UpToDate on the freshly attested workload before submitting
      // chat when requireUpToDate is set. Keep this defense-in-depth check too.
      if (result.established.tcbStatus !== "UpToDate") throw new RunnerError("TDX TCB status is not allowed");
      const choices = result.json?.choices;
      const message = Array.isArray(choices) ? choices[0]?.message : undefined;
      if (typeof message?.content !== "string") throw new RunnerError("model response has no JSON content");
      this.lastProviderReceipt = { ...result.receipt, workloadId: result.established.workloadId };
      const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
      this.lastReceipt = this.options.compactReceiptMetadata ? {
        modelId: result.receipt.modelId,
        receiptId: digest(result.receipt.receiptId),
        sessionId: digest(result.receipt.sessionId),
        workloadId: digest(result.established.workloadId),
      } : this.lastProviderReceipt;
      try { return JSON.parse(message.content) as unknown; }
      catch (error) { throw new RunnerError("model response content is invalid JSON", { cause: error }); }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (controller.signal.aborted) throw new RunnerError("model request timed out", { cause: error });
      throw new RunnerError("model verification or inference failed", { cause: error });
    } finally { clearTimeout(timer); }
  }
}

export class StubRunner implements ModelRunner {
  constructor(private readonly fixture: (input: ModelInput) => unknown | Promise<unknown>) {}
  async run(input: ModelInput): Promise<unknown> { return this.fixture(input); }
}
