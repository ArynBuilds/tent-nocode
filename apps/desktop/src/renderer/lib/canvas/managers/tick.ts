// THE TICKER (tldraw's TickManager): one rAF loop while the editor is mounted; every frame walks into the
// machine as a tick with the elapsed ms, so a running gesture may edge-scroll or animate without its own clock.

export class Ticker {
  private raf = 0;
  private last = 0;
  private running = false;

  constructor(private readonly onTick: (elapsed: number) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const step = (now: number): void => {
      if (!this.running) return;
      const elapsed = now - this.last;
      this.last = now;
      try { this.onTick(elapsed); } finally { this.raf = window.requestAnimationFrame(step); }
    };
    this.raf = window.requestAnimationFrame(step);
  }

  stop(): void {
    this.running = false;
    window.cancelAnimationFrame(this.raf);
  }
}
