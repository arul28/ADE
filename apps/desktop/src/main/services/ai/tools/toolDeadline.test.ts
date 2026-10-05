import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdeToolDeadlineError, pauseAdeToolDeadline, runAdeToolWithDeadline } from "./toolDeadline";

/** A promise settled from outside, standing in for a person deciding on an approval card. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("ADE tool deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a tool that outlives its budget, but never counts time spent on an approval card", async () => {
    const slow = runAdeToolWithDeadline(1_000, () => new Promise<string>(() => {}));
    const slowResult = slow.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await slowResult).toBeInstanceOf(AdeToolDeadlineError);

    const card = deferred<string>();
    const approved = runAdeToolWithDeadline(1_000, async () => {
      const answer = await pauseAdeToolDeadline(() => card.promise);
      return `approved: ${answer}`;
    });
    // Four minutes on the card is far past the one-second budget.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    card.resolve("yes");
    await expect(approved).resolves.toBe("approved: yes");
  });

  it("keeps the clock stopped until the last of two open cards closes", async () => {
    const first = deferred();
    const second = deferred();
    let settled: "ok" | "expired" | null = null;
    const call = runAdeToolWithDeadline(1_000, async () => {
      await Promise.all([
        pauseAdeToolDeadline(() => first.promise),
        pauseAdeToolDeadline(() => second.promise),
      ]);
      // Work after both cards, inside the remaining budget.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return "ok" as const;
    }).then(
      (value) => { settled = value; },
      (error: unknown) => { settled = error instanceof AdeToolDeadlineError ? "expired" : null; },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    first.resolve();
    // One card still open: the budget must not be running.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBeNull();
    second.resolve();
    await vi.advanceTimersByTimeAsync(600);
    await call;
    expect(settled).toBe("ok");
  });
});
