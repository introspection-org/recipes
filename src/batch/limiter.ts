/**
 * A concurrency limit that halves when the provider rate-limits a call and
 * grows back by one after a run of successes, so a batch backs off without a
 * hand-tuned number and recovers once the provider does.
 */
export class AdaptiveLimiter {
  private limit: number;
  private active = 0;
  private successesSinceChange = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly growAfter = 10,
  ) {
    this.limit = max;
  }

  get currentLimit(): number {
    return this.limit;
  }

  async acquire(): Promise<() => void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.wake();
    };
  }

  onRateLimited(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successesSinceChange = 0;
  }

  onSuccess(): void {
    this.successesSinceChange += 1;
    if (this.limit < this.max && this.successesSinceChange >= this.growAfter) {
      this.limit += 1;
      this.successesSinceChange = 0;
      this.wake();
    }
  }

  private wake(): void {
    const available = this.limit - this.active;
    for (const resolve of this.waiters.splice(0, Math.max(0, available))) {
      resolve();
    }
  }
}
