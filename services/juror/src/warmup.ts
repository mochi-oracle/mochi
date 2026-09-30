import { abortableProviderCall } from "@mochi/aci";
import type { TimingEvent } from "@mochi/protocol";
/** Attestation only: no prompt or inference, failures never prevent serving. Retries are bounded and cancellable. */
export async function warmupModel(client: { attest(signal?: AbortSignal): Promise<{ tcbStatus: string }> }, modelId: string, signal: AbortSignal, emit: (event: TimingEvent) => void, options: { sleep?: (ms: number) => Promise<void>; attempts?: number; timeoutMs?: number } = {}): Promise<void> {
  for (let attempt = 1; attempt <= (options.attempts ?? 3) && !signal.aborted; attempt++) {
    const start = Date.now();
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
    try {
      const attestation = await abortableProviderCall(client.attest(attemptSignal), attemptSignal);
      if (attestation.tcbStatus !== "UpToDate") throw new Error("warmup verification failed");
      emit({ modelId, attempt, elapsedMs: Date.now() - start, remainingBudgetMs: 0, causeCode: "warmup_ok" });
      return;
    } catch {
      emit({ modelId, attempt, elapsedMs: Date.now() - start, remainingBudgetMs: 0, causeCode: "warmup_failed" });
      if (!signal.aborted && attempt < (options.attempts ?? 3)) {
        if (options.sleep) await options.sleep(15_000);
        else await new Promise<void>(resolve => { const timer = setTimeout(done, 15_000); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
      }
    }
  }
}
