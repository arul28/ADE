// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { restartAde, restartedAdeRecently } from "./restartAde";

describe("restartAde", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else globalThis.window.ade = originalAde;
  });

  // "Restart ADE already tried" decides whether the next failed fix leads with
  // Reset ADE. Only a restart the person accepted may count; a cancelled one
  // must leave whatever another window recorded.
  it.each([
    { name: "accepted", accepted: true, priorRestartMinutesAgo: null, recentAfter: true },
    { name: "cancelled with no earlier restart", accepted: false, priorRestartMinutesAgo: null, recentAfter: false },
    { name: "cancelled after another window's restart", accepted: false, priorRestartMinutesAgo: 5, recentAfter: true },
    { name: "cancelled after an old restart", accepted: false, priorRestartMinutesAgo: 45, recentAfter: false },
  ])("a restart that was $name", async ({ accepted, priorRestartMinutesAgo, recentAfter }) => {
    vi.useFakeTimers({ now: new Date("2026-10-07T08:00:00Z"), toFake: ["Date"] });
    if (priorRestartMinutesAgo != null) {
      window.localStorage.setItem(
        "ade.recovery.restartRequestedAt",
        String(Date.now() - priorRestartMinutesAgo * 60_000),
      );
    }
    const updateRelaunchApp = vi.fn(async () => accepted);
    (globalThis.window as any).ade = { ...(originalAde ?? {}), updateRelaunchApp };

    await expect(restartAde()).resolves.toBe(accepted);

    expect(updateRelaunchApp).toHaveBeenCalledTimes(1);
    expect(restartedAdeRecently()).toBe(recentAfter);
  });
});
