export interface LookupHealthOptions {
  windowMs: number;
  minFailures: number;
  failureRatio: number;
  holdMs: number;
}

export interface LookupTotals {
  successes: number;
  failures: number;
}

// Judges one instance by the outcomes of its own lookups over a trailing window.
//
// Outcomes are tallied in one-second buckets, so memory is fixed however much traffic
// passes through and reading the totals never walks a log.
//
// A verdict of failing is held for holdMs after the threshold was last met. Once the load
// balancer acts on it the instance stops receiving traffic, which also stops producing the
// evidence that would clear it; without the hold the failures age out of the window, the
// instance reports healthy while still sick, and it is handed traffic again.
export class LookupHealth {
  private readonly options: LookupHealthOptions;
  private readonly now: () => number;
  private readonly bucketCount: number;
  private readonly bucketSeconds: number[];
  private readonly successes: number[];
  private readonly failures: number[];
  private trippedAt: number = null;

  constructor(options: LookupHealthOptions, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
    this.bucketCount = Math.max(1, Math.ceil(options.windowMs / 1000));
    this.bucketSeconds = new Array(this.bucketCount).fill(-1);
    this.successes = new Array(this.bucketCount).fill(0);
    this.failures = new Array(this.bucketCount).fill(0);
  }

  public record(succeeded: boolean): void {
    const second: number = Math.floor(this.now() / 1000);
    const index: number = second % this.bucketCount;
    if (this.bucketSeconds[index] !== second) {
      this.bucketSeconds[index] = second;
      this.successes[index] = 0;
      this.failures[index] = 0;
    }

    if (succeeded) {
      this.successes[index]++;
      return;
    }

    this.failures[index]++;
    // Checked on every failure rather than only when /health is read, so a burst that
    // clears between two probes still trips the hold.
    if (this.thresholdMet(this.totals())) {
      this.trippedAt = this.now();
    }
  }

  public totals(): LookupTotals {
    const oldest: number = Math.floor(this.now() / 1000) - this.bucketCount + 1;
    const totals: LookupTotals = { successes: 0, failures: 0 };
    for (let i = 0; i < this.bucketCount; i++) {
      if (this.bucketSeconds[i] >= oldest) {
        totals.successes += this.successes[i];
        totals.failures += this.failures[i];
      }
    }

    return totals;
  }

  public isFailing(): boolean {
    if (this.thresholdMet(this.totals())) {
      this.trippedAt = this.now();
    }

    return this.trippedAt !== null && this.now() - this.trippedAt < this.options.holdMs;
  }

  private thresholdMet(totals: LookupTotals): boolean {
    const attempts: number = totals.successes + totals.failures;
    return totals.failures >= this.options.minFailures && totals.failures >= attempts * this.options.failureRatio;
  }
}
