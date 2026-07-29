import { describe, expect, it } from "vitest";
import {
  createPairFailureTracker,
  PAIR_COOLDOWN_MS,
  PAIR_FAILURE_THRESHOLD,
  PAIR_FAILURE_WINDOW_MS,
  PAIR_GLOBAL_FAILURE_THRESHOLD,
} from "./syncPairFailureTracker";

function createClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("pair failure tracker", () => {
  it("cools down the device that failed without touching anyone else", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });

    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD; attempt += 1) {
      tracker.registerFailure({ ip: "192.168.1.20", deviceId: "phone-a" });
    }

    expect(tracker.cooldownMsRemaining({ ip: "192.168.1.20", deviceId: "phone-a" }))
      .toBe(PAIR_COOLDOWN_MS);
    // The regression this exists for: five fumbled PINs on ONE phone used to
    // trip the global bucket and block pairing (and account adoption, which
    // consults the same cooldown) for every other device in the house.
    expect(tracker.cooldownMsRemaining({ ip: "10.0.0.9", deviceId: "phone-b" })).toBe(0);
    expect(tracker.cooldownMsRemaining({})).toBe(0);
  });

  it("follows a device that moves to a new address", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });

    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD; attempt += 1) {
      tracker.registerFailure({ ip: "192.168.1.20", deviceId: "phone-a" });
    }

    expect(tracker.cooldownMsRemaining({ ip: "172.16.0.4", deviceId: "phone-a" }))
      .toBe(PAIR_COOLDOWN_MS);
  });

  it("still stops one address cycling through fresh device ids", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });

    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD; attempt += 1) {
      tracker.registerFailure({ ip: "192.168.1.20", deviceId: `spoofed-${attempt}` });
    }

    expect(tracker.cooldownMsRemaining({ ip: "192.168.1.20", deviceId: "spoofed-99" }))
      .toBe(PAIR_COOLDOWN_MS);
  });

  it("keeps a global breaker for guessing spread across many origins", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });

    for (let attempt = 0; attempt < PAIR_GLOBAL_FAILURE_THRESHOLD - 1; attempt += 1) {
      tracker.registerFailure({ ip: `10.0.0.${attempt}`, deviceId: `device-${attempt}` });
    }
    expect(tracker.cooldownMsRemaining({ ip: "10.0.1.1", deviceId: "innocent" })).toBe(0);

    tracker.registerFailure({ ip: "10.0.1.250", deviceId: "device-last" });

    expect(tracker.cooldownMsRemaining({ ip: "10.0.1.1", deviceId: "innocent" }))
      .toBe(PAIR_COOLDOWN_MS);
  });

  it("expires a cooldown and forgets the bucket once its window lapses", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });
    const subject = { ip: "192.168.1.20", deviceId: "phone-a" };

    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD; attempt += 1) {
      tracker.registerFailure(subject);
    }
    clock.advance(PAIR_COOLDOWN_MS + 1);

    expect(tracker.cooldownMsRemaining(subject)).toBe(0);

    clock.advance(PAIR_FAILURE_WINDOW_MS + 1);
    tracker.pruneExpired();
    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD - 1; attempt += 1) {
      tracker.registerFailure(subject);
    }
    expect(tracker.cooldownMsRemaining(subject)).toBe(0);
  });

  it("clears the buckets a correct PIN was charged against", () => {
    const clock = createClock();
    const tracker = createPairFailureTracker({ now: clock.now });
    const subject = { ip: "192.168.1.20", deviceId: "phone-a" };

    for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD - 1; attempt += 1) {
      tracker.registerFailure(subject);
    }
    tracker.clearAfterSuccess(subject);
    tracker.registerFailure(subject);

    expect(tracker.cooldownMsRemaining(subject)).toBe(0);
  });
});
