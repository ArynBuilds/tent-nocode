import type { ActivityStep } from '@nodeloom/core';

// Batches ActivitySteps into periodic flushes; caps per run and marks drops honestly.
export class ActivitySink {
  private buf: ActivityStep[] = [];
  private kept = 0;
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly cap: number;

  constructor(
    private readonly flushFn: (steps: ActivityStep[], dropped: number) => Promise<void>,
    opts: { flushMs?: number; cap?: number } = {},
  ) {
    this.flushMs = opts.flushMs ?? 300;
    this.cap = opts.cap ?? 500;
  }

  push(step: ActivityStep): void {
    if (this.kept >= this.cap) { this.dropped += 1; return; }
    this.kept += 1;
    this.buf.push(step);
    if (this.timer === null) {
      this.timer = setTimeout(() => { void this.flush(); }, this.flushMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.buf.length === 0) return;
    const steps = this.buf;
    this.buf = [];
    try { await this.flushFn(steps, this.dropped); } catch { /* a flush failure never fails the run */ }
  }

  /** Final flush; appends the honest cap marker when steps were dropped. */
  async stop(): Promise<void> {
    if (this.dropped > 0) {
      this.buf.push({ kind: 'text', text: `… ${this.dropped} more steps (cap reached, not recorded)` });
    }
    await this.flush();
  }
}
