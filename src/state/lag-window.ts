/** Sliding-window sum of host event-loop lag samples (ms). No VS Code dependency. */
export class LagWindow {
  private readonly samples: Array<{ at: number; lag: number }> = [];

  constructor(private readonly windowMs: number) {}

  push(now: number, lagMs: number): void {
    if (lagMs > 0) this.samples.push({ at: now, lag: lagMs });
    this.prune(now);
  }

  /** Lag accumulated within the last `windowMs` ending at `now`. */
  total(now: number): number {
    this.prune(now);
    let sum = 0;
    for (const s of this.samples) sum += s.lag;
    return sum;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length && (this.samples[0] as { at: number }).at < cutoff) this.samples.shift();
  }
}
