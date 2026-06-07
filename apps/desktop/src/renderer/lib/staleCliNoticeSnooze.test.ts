import { beforeEach, describe, expect, it } from "vitest";
import {
  STALE_CLI_NOTICE_SNOOZE_MS,
  getStaleCliNoticeSnoozeUntil,
  isStaleCliNoticeSnoozed,
  snoozeStaleCliNotice,
} from "./staleCliNoticeSnooze";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
}

describe("staleCliNoticeSnooze", () => {
  const NOW = Date.parse("2026-06-06T00:00:00.000Z");
  const ROOT = "/project/a";

  beforeEach(() => {
    installLocalStorage();
  });

  it("reports no snooze for an unknown project", () => {
    expect(getStaleCliNoticeSnoozeUntil(ROOT)).toBe(0);
    expect(isStaleCliNoticeSnoozed(ROOT, NOW)).toBe(false);
  });

  it("snoozes a project for exactly one hour from now", () => {
    snoozeStaleCliNotice(ROOT, NOW);
    expect(getStaleCliNoticeSnoozeUntil(ROOT)).toBe(NOW + STALE_CLI_NOTICE_SNOOZE_MS);
    expect(isStaleCliNoticeSnoozed(ROOT, NOW)).toBe(true);
    // Still snoozed 59 minutes later, expired just after the hour.
    expect(isStaleCliNoticeSnoozed(ROOT, NOW + 59 * 60_000)).toBe(true);
    expect(isStaleCliNoticeSnoozed(ROOT, NOW + STALE_CLI_NOTICE_SNOOZE_MS + 1)).toBe(false);
  });

  it("keeps snooze windows independent per project", () => {
    snoozeStaleCliNotice(ROOT, NOW);
    expect(isStaleCliNoticeSnoozed("/project/b", NOW)).toBe(false);
    expect(isStaleCliNoticeSnoozed(ROOT, NOW)).toBe(true);
  });

  it("ignores blank/null project roots", () => {
    snoozeStaleCliNotice(null, NOW);
    snoozeStaleCliNotice("   ", NOW);
    expect(getStaleCliNoticeSnoozeUntil(null)).toBe(0);
    expect(getStaleCliNoticeSnoozeUntil("")).toBe(0);
  });

  it("prunes expired entries for other projects when snoozing", () => {
    // Snooze B in the distant past so it is expired by the time A is snoozed.
    snoozeStaleCliNotice("/project/b", NOW - 2 * STALE_CLI_NOTICE_SNOOZE_MS);
    snoozeStaleCliNotice(ROOT, NOW);
    expect(getStaleCliNoticeSnoozeUntil("/project/b")).toBe(0);
    expect(getStaleCliNoticeSnoozeUntil(ROOT)).toBe(NOW + STALE_CLI_NOTICE_SNOOZE_MS);
  });
});
