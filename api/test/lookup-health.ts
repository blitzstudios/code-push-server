import * as assert from "assert";
import { LookupHealth, LookupHealthOptions } from "../script/utils/lookup-health";

describe("LookupHealth", () => {
  const options: LookupHealthOptions = { windowMs: 60000, minFailures: 20, failureRatio: 0.5, holdMs: 600000 };
  let clock: number;
  let health: LookupHealth;

  const record = (succeeded: boolean, count: number): void => {
    for (let i = 0; i < count; i++) {
      health.record(succeeded);
    }
  };

  beforeEach(() => {
    clock = 1_000_000_000;
    health = new LookupHealth(options, () => clock);
  });

  it("is healthy with no traffic", () => {
    assert.equal(health.isFailing(), false);
    assert.deepEqual(health.totals(), { successes: 0, failures: 0 });
  });

  it("fails once enough lookups fail and they are the majority", () => {
    record(true, 5);
    record(false, 19);
    assert.equal(health.isFailing(), false);

    record(false, 1);
    assert.equal(health.isFailing(), true);
  });

  it("does not fail below the minimum count even when every lookup fails", () => {
    record(false, 19);
    assert.equal(health.isFailing(), false);
  });

  it("does not fail when failures are a minority of many lookups", () => {
    record(true, 100);
    record(false, 40);
    assert.equal(health.isFailing(), false);
  });

  it("counts only outcomes inside the window", () => {
    record(false, 15);
    clock += 61000;
    record(false, 15);
    assert.deepEqual(health.totals(), { successes: 0, failures: 15 });
    assert.equal(health.isFailing(), false);
  });

  it("holds the failing verdict after traffic stops, then recovers", () => {
    record(false, 20);
    assert.equal(health.isFailing(), true);

    clock += 5 * 60000;
    assert.deepEqual(health.totals(), { successes: 0, failures: 0 });
    assert.equal(health.isFailing(), true);

    clock += 5 * 60000;
    assert.equal(health.isFailing(), false);
  });

  it("trips on a burst that clears before the verdict is read", () => {
    record(false, 20);
    clock += 61000;
    assert.deepEqual(health.totals(), { successes: 0, failures: 0 });
    assert.equal(health.isFailing(), true);
  });

  it("extends the hold while failures continue", () => {
    record(false, 20);
    clock += 9 * 60000;
    record(false, 20);
    clock += 9 * 60000;
    assert.equal(health.isFailing(), true);
  });
});
