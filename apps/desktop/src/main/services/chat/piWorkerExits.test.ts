import { describe, expect, it, vi } from "vitest";
import { createPiWorkerExitTracker } from "./piWorkerExits";

describe("Pi worker exit tracker", () => {
  it("holds the chat's next launch until the released worker exits", async () => {
    const tracker = createPiWorkerExitTracker({ maxWaitMs: 5_000 });
    let exitWorker!: () => void;
    tracker.release("chat-1", (onExit) => { exitWorker = onExit; });
    expect(tracker.pending("chat-1")).toBe(true);

    let launched = false;
    const launch = tracker.waitForExit("chat-1").then(() => { launched = true; });
    await Promise.resolve();
    expect(launched).toBe(false);

    exitWorker();
    await launch;
    expect(launched).toBe(true);
    expect(tracker.pending("chat-1")).toBe(false);
  });

  it("does not wait for another chat or when nothing was released", async () => {
    const tracker = createPiWorkerExitTracker({ maxWaitMs: 5_000 });
    tracker.release("chat-1", () => { /* never exits */ });
    await expect(tracker.waitForExit("chat-2")).resolves.toBeUndefined();
  });

  it("stops waiting after the ceiling, so a wedged exit cannot hold a chat", async () => {
    vi.useFakeTimers();
    try {
      const tracker = createPiWorkerExitTracker({ maxWaitMs: 5_000 });
      tracker.release("chat-1", () => { /* never exits */ });
      let launched = false;
      const launch = tracker.waitForExit("chat-1").then(() => { launched = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(launched).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await launch;
      expect(launched).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the newest release when a chat restarts twice", async () => {
    const tracker = createPiWorkerExitTracker({ maxWaitMs: 5_000 });
    let exitFirst!: () => void;
    tracker.release("chat-1", (onExit) => { exitFirst = onExit; });
    tracker.release("chat-1", () => { /* second worker still exiting */ });
    exitFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.pending("chat-1")).toBe(true);
  });
});
