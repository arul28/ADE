/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The focus timer runs in every ADE window that loaded it, from one stored
 * timer. When a phase ends, main lets one window complete it (log the session,
 * toast); the rest follow the stored state — and a window that lost the claim
 * must still settle if the winner's write never comes.
 */
const STORAGE_KEY = "ade.home.focus.v1";
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
  phase: string;
  endsAt: number | null;
  log: Record<string, { sessions: number; minutes: number }>;
};

async function loadTimerEndingIn(ms: number, claim: (endsAt: number) => Promise<boolean>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "focus", focusMinutes: 25, endsAt: Date.now() + ms, pausedMs: null, log: {} }));
  Object.defineProperty(window, "ade", { configurable: true, writable: true, value: { home: { focus: { claimCompletion: vi.fn(claim) } } } });
  // The timer schedules itself when the widget's module loads.
  await import("./PomodoroWidget");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 14, 0));
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("focus timer completion across windows", () => {
  it("logs the session in the window that wins the claim", async () => {
    await loadTimerEndingIn(1_000, async () => true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(stored()).toMatchObject({ phase: "break", endsAt: null, log: { "2026-10-08": { sessions: 1, minutes: 25 } } });
  });

  it("follows the winner's write when it arrives", async () => {
    await loadTimerEndingIn(1_000, async () => false);
    await vi.advanceTimersByTimeAsync(1_000);
    const winner = { phase: "break", focusMinutes: 25, endsAt: null, pausedMs: null, log: { "2026-10-08": { sessions: 1, minutes: 25 } } };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(winner));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(stored()).toEqual(winner);
  });

  it("settles on its own, without logging, when the winner's write never comes", async () => {
    await loadTimerEndingIn(1_000, async () => false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().phase).toBe("focus");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stored()).toMatchObject({ phase: "break", endsAt: null, log: {} });
  });
});
