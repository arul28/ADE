import { describe, expect, it } from "vitest";
import {
  applyPairedDeviceRejectionThrottle,
  createPairedDeviceRejectionLimiter,
  PAIRED_DEVICE_REJECTION_BASE_DELAY_MS,
  PAIRED_DEVICE_REJECTION_DELAY_AFTER,
  PAIRED_DEVICE_REJECTION_LOG_EVERY,
  PAIRED_DEVICE_REJECTION_MAX_DELAY_MS,
  PAIRED_DEVICE_REJECTION_WINDOW_MS,
} from "./pairedDeviceRejectionLimiter";

function createClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("paired device rejection limiter", () => {
  it("logs the first rejection and then every Nth, independent of rejection reason", () => {
    const clock = createClock();
    const limiter = createPairedDeviceRejectionLimiter({ now: clock.now });
    const logged: number[] = [];

    for (let i = 1; i <= PAIRED_DEVICE_REJECTION_LOG_EVERY * 2; i += 1) {
      const action = limiter.record("phone-a");
      if (action.shouldLog) logged.push(i);
      expect(action.countInWindow).toBe(i);
    }

    expect(logged).toEqual([
      1,
      PAIRED_DEVICE_REJECTION_LOG_EVERY,
      PAIRED_DEVICE_REJECTION_LOG_EVERY * 2,
    ]);
  });

  it("does not start delaying until after the burst threshold, then caps", () => {
    const clock = createClock();
    const limiter = createPairedDeviceRejectionLimiter({ now: clock.now });

    for (let i = 1; i <= PAIRED_DEVICE_REJECTION_DELAY_AFTER; i += 1) {
      expect(limiter.record("phone-a").delayMs).toBe(0);
    }

    const firstDelayed = limiter.record("phone-a");
    expect(firstDelayed.delayMs).toBe(PAIRED_DEVICE_REJECTION_BASE_DELAY_MS);

    const secondDelayed = limiter.record("phone-a");
    expect(secondDelayed.delayMs).toBe(PAIRED_DEVICE_REJECTION_BASE_DELAY_MS * 2);

    for (let i = 0; i < 20; i += 1) {
      limiter.record("phone-a");
    }
    expect(limiter.record("phone-a").delayMs).toBe(PAIRED_DEVICE_REJECTION_MAX_DELAY_MS);
  });

  it("isolates devices so one looping phone cannot delay another", () => {
    const clock = createClock();
    const limiter = createPairedDeviceRejectionLimiter({ now: clock.now });

    for (let i = 0; i < 10; i += 1) {
      limiter.record("phone-looping");
    }

    const other = limiter.record("phone-ok");
    expect(other.countInWindow).toBe(1);
    expect(other.shouldLog).toBe(true);
    expect(other.delayMs).toBe(0);
  });

  it("forgets hits that fall outside the window", () => {
    const clock = createClock();
    const limiter = createPairedDeviceRejectionLimiter({ now: clock.now });

    for (let i = 0; i < 10; i += 1) {
      limiter.record("phone-a");
    }
    expect(limiter.record("phone-a").countInWindow).toBe(11);

    clock.advance(PAIRED_DEVICE_REJECTION_WINDOW_MS + 1);
    const other = limiter.record("phone-b");
    expect(other.countInWindow).toBe(1);
    const afterWindow = limiter.record("phone-a");
    expect(afterWindow.countInWindow).toBe(1);
    expect(afterWindow.shouldLog).toBe(true);
    expect(afterWindow.delayMs).toBe(0);
  });

  it("does not key empty device ids into a shared bucket", () => {
    const limiter = createPairedDeviceRejectionLimiter();
    const first = limiter.record("   ");
    const second = limiter.record("");
    expect(first.delayMs).toBe(0);
    expect(second.delayMs).toBe(0);
    expect(first.shouldLog).toBe(true);
    expect(second.shouldLog).toBe(true);
  });

  it("skips sleeping when delay is zero", async () => {
    const started = Date.now();
    await applyPairedDeviceRejectionThrottle({
      countInWindow: 1,
      shouldLog: true,
      delayMs: 0,
    });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("keeps a large same-device burst as a bounded count, not a growing timestamp list", () => {
    const clock = createClock();
    const limiter = createPairedDeviceRejectionLimiter({ now: clock.now });
    const burst = 10_000;

    let last = limiter.record("phone-burst");
    for (let i = 1; i < burst; i += 1) {
      last = limiter.record("phone-burst");
    }

    expect(last.countInWindow).toBe(burst);
    expect(last.delayMs).toBe(PAIRED_DEVICE_REJECTION_MAX_DELAY_MS);
    const other = limiter.record("phone-ok");
    expect(other.countInWindow).toBe(1);
    expect(other.delayMs).toBe(0);
  });
});
