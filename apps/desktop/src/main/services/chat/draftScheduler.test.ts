import { describe, expect, it, vi } from "vitest";
import type { DraftEntry } from "../../../shared/types/chat";
import type { DraftDeliveryOutcome } from "./draftDelivery";
import { createDraftScheduler, type DraftSchedulerTimerApi } from "./draftScheduler";

const logger = { warn: () => {}, info: () => {} };

function draft(id: string): DraftEntry {
  return {
    id,
    text: id,
    provider: null,
    modelId: null,
    createdAt: "2026-10-09T11:00:00.000Z",
    kind: "scheduled",
    status: "scheduled",
    scheduledAt: "2026-10-09T12:00:00.000Z",
    targetKind: "existing",
    targetSessionId: "chat-1",
  };
}

/** A timer stub whose pending callback can be run on demand. */
function fakeTimers() {
  let pending: { callback: () => void; delayMs: number } | null = null;
  const api: DraftSchedulerTimerApi = {
    setTimeout: (callback, delayMs) => {
      pending = { callback, delayMs };
      return pending;
    },
    clearTimeout: () => { pending = null; },
  };
  return {
    api,
    get delayMs() { return pending?.delayMs ?? null; },
    async run() {
      const current = pending;
      pending = null;
      current?.callback();
      // Let the async tick settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("draftScheduler", () => {
  it("delivers what is already due when it starts", async () => {
    const delivered: string[] = [];
    const outcomes: Array<[string, DraftDeliveryOutcome]> = [];
    const timers = fakeTimers();
    const scheduler = createDraftScheduler({
      dueNow: () => [draft("a"), draft("b")],
      nextFireAt: () => null,
      deliver: async (entry) => ({ status: "sent", firedAt: "2026-10-09T12:00:00.000Z" }),
      onOutcome: (entry, outcome) => { outcomes.push([entry.id, outcome]); },
      timers: timers.api,
      logger,
    });

    scheduler.start();
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes.map(([id]) => id)).toEqual(["a", "b"]);
    expect(delivered).toEqual([]);
    scheduler.stop();
  });

  it("arms for the next fire time instead of polling", () => {
    const timers = fakeTimers();
    const now = 1_000_000;
    const scheduler = createDraftScheduler({
      dueNow: () => [],
      nextFireAt: () => now + 30_000,
      deliver: async () => ({ status: "sent", firedAt: "x" }),
      onOutcome: () => {},
      timers: timers.api,
      now: () => now,
      logger,
    });

    scheduler.start();
    expect(timers.delayMs).toBe(30_000);
    scheduler.stop();
  });

  it("sweeps periodically when nothing is armed", () => {
    const timers = fakeTimers();
    const scheduler = createDraftScheduler({
      dueNow: () => [],
      nextFireAt: () => null,
      deliver: async () => ({ status: "sent", firedAt: "x" }),
      onOutcome: () => {},
      timers: timers.api,
      sweepMs: 120_000,
      logger,
    });

    scheduler.start();
    expect(timers.delayMs).toBe(120_000);
    scheduler.stop();
  });

  // Without a floor, a row that stays due would re-arm at zero and spin.
  it("waits before retrying a row that is still due", async () => {
    const timers = fakeTimers();
    const now = 1_000_000;
    const scheduler = createDraftScheduler({
      dueNow: () => [draft("a")],
      nextFireAt: () => now - 5_000,
      deliver: async () => ({ status: "retry", error: "chat is busy" }),
      onOutcome: () => {},
      timers: timers.api,
      now: () => now,
      retryDelayMs: 45_000,
      logger,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.delayMs).toBe(45_000);
    scheduler.stop();
  });

  // stop() cannot un-send a delivery already in flight, but it must stop the
  // scheduler from arming again or firing another row.
  it("does not re-arm or fire again once stopped", async () => {
    const outcomes: string[] = [];
    const timers = fakeTimers();
    const scheduler = createDraftScheduler({
      dueNow: () => [draft("a")],
      nextFireAt: () => null,
      deliver: async () => ({ status: "sent", firedAt: "x" }),
      onOutcome: (entry) => { outcomes.push(entry.id); },
      timers: timers.api,
      logger,
    });

    scheduler.start();
    await vi.waitFor(() => expect(outcomes).toEqual(["a"]));
    scheduler.stop();

    expect(timers.delayMs).toBeNull();
    scheduler.refresh();
    expect(timers.delayMs).toBeNull();
    await timers.run();
    expect(outcomes).toEqual(["a"]);
  });

  it("re-arms when the drafts table changes through this machine", async () => {
    const timers = fakeTimers();
    let next: number | null = null;
    const scheduler = createDraftScheduler({
      dueNow: () => [],
      nextFireAt: () => next,
      deliver: async () => ({ status: "sent", firedAt: "x" }),
      onOutcome: () => {},
      timers: timers.api,
      now: () => 1_000_000,
      sweepMs: 120_000,
      logger,
    });

    scheduler.start();
    expect(timers.delayMs).toBe(120_000);

    next = 1_030_000;
    scheduler.refresh();
    expect(timers.delayMs).toBe(30_000);
    scheduler.stop();
  });

  it("keeps going when one row blows up", async () => {
    const outcomes: string[] = [];
    const timers = fakeTimers();
    const scheduler = createDraftScheduler({
      dueNow: () => [draft("bad"), draft("good")],
      nextFireAt: () => null,
      deliver: async (entry) => {
        if (entry.id === "bad") throw new Error("boom");
        return { status: "sent", firedAt: "x" };
      },
      onOutcome: (entry) => { outcomes.push(entry.id); },
      timers: timers.api,
      logger,
    });

    scheduler.start();
    await vi.waitFor(() => expect(outcomes).toEqual(["bad", "good"]));
    scheduler.stop();
  });
});
