import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOwnerRenewal } from "./providerLoginRenew";

const DAY = 24 * 60 * 60 * 1000;
const AHEAD = 270_000;

describe("owner renewal timers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews a login due past setTimeout's limit once, at its renewal time", async () => {
    const renews: number[] = [];
    const outcomes: string[] = [];
    const planner = createOwnerRenewal({
      renewer: { aheadMs: { opencode: AHEAD }, renew: async () => (renews.push(Date.now()), true) },
      now: () => Date.now(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      onRenewed: (_target, outcome) => outcomes.push(outcome),
    });
    const expiresAt = Date.now() + 30 * DAY;
    planner.plan([{ key: "opencode/a.base", provider: "opencode", expiresAt }]);

    // Past 2^31-1 ms (24.8 days) a timer wakes early; that wake is not a renewal.
    await vi.advanceTimersByTimeAsync(29 * DAY);
    expect(renews).toEqual([]);
    expect(planner.timerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(DAY);
    expect(renews).toEqual([expiresAt - AHEAD]);
    expect(outcomes).toEqual(["renewed"]);
    planner.stop();
  });
});
