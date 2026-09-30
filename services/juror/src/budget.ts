/** One absolute wall-clock deadline; cancelling a stage never resets the round. */
export class AnswerBudget {
  readonly signal: AbortSignal;
  readonly modelSignal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly modelController = new AbortController();
  private readonly timers: ReturnType<typeof setTimeout>[];
  constructor(readonly deadlineMs: number, readonly reserveMs: number, private readonly now = Date.now, parent?: AbortSignal) {
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    this.modelSignal = AbortSignal.any([this.signal, this.modelController.signal]);
    const left = this.remaining();
    this.timers = [setTimeout(() => this.controller.abort(), Math.max(1, left)), setTimeout(() => this.modelController.abort(), Math.max(1, left - reserveMs))];
    if (left <= 0) this.controller.abort();
    if (left <= reserveMs) this.modelController.abort();
  }
  remaining(model = false): number { return Math.max(0, this.deadlineMs - this.now() - (model ? this.reserveMs : 0)); }
  async wait<T>(work: Promise<T>, model = false): Promise<T> {
    const signal = model ? this.modelSignal : this.signal;
    if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
    let onAbort!: () => void;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { onAbort = () => reject(new Error("answer deadline exhausted")); signal.addEventListener("abort", onAbort, { once: true }); })]);
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  dispose(): void { this.timers.forEach(clearTimeout); this.controller.abort(); }
}
