/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveSummary } from "../../../shared/types/archive";
import { useArchiveReminderBanner } from "./useArchiveReminderBanner";
import { useAppBanner } from "../ui/notice/appBannerStore";

/**
 * The weekly archive reminder. Its one non-obvious rule is a race: a summary
 * read may still be in flight when the person answers the banner, and the late
 * result must not put the banner back. Pinned here because a re-nag is exactly
 * the failure the snooze exists to prevent.
 */

vi.mock("../ui/notice/appBannerStore", () => ({
  useAppBanner: vi.fn(),
  APP_BANNER_PRIORITY: { default: 100 },
}));

const STALE: ArchiveSummary = {
  total: 3,
  byKind: { lane: 1, chat: 1, shell: 1 },
  olderThanDays: 14,
  staleTotal: 3,
  staleByKind: { lane: 1, chat: 1, shell: 1 },
  staleBytes: null,
  oldestArchivedAt: "2020-01-01T00:00:00.000Z",
};

function Harness() {
  useArchiveReminderBanner({ projectRoot: "/repo", enabled: true, onReview: vi.fn() });
  return null;
}

function lastBannerModel(): unknown {
  return vi.mocked(useAppBanner).mock.calls.at(-1)?.[0];
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(useAppBanner).mockClear();
});

describe("useArchiveReminderBanner", () => {
  it("does not re-show the reminder when a read finishes after the person snoozed", async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => store.clear(),
      },
    });

    const pending: Array<(value: ArchiveSummary) => void> = [];
    const summary = vi.fn(() => new Promise<ArchiveSummary>((resolve) => { pending.push(resolve); }));
    (window as any).ade = { archive: { summary } };

    render(<Harness />);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(summary).toHaveBeenCalledTimes(1);
    await act(async () => { pending[0]!(STALE); });
    const shown = lastBannerModel() as { id: string; actions: Array<{ label: string; onClick: () => void }> };
    expect(shown).toMatchObject({ id: "archive-cleanup-reminder" });

    // A later check is out when the person answers the banner.
    await act(async () => { vi.advanceTimersByTime(6 * 3_600_000); });
    expect(summary).toHaveBeenCalledTimes(2);
    await act(async () => {
      shown.actions.find((action) => action.label === "Remind me next week")!.onClick();
    });
    expect(lastBannerModel()).toBeNull();

    // The in-flight read lands after the snooze: it must be dropped, not shown.
    await act(async () => { pending[1]!(STALE); });
    expect(lastBannerModel()).toBeNull();
  });
});
