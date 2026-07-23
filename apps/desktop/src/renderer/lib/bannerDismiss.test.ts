import { beforeEach, describe, expect, it } from "vitest";
import {
  BANNER_DISMISS_GRACE_MS,
  clearBannerDismissal,
  dismissBanner,
  hasRecentBannerDismissal,
  isBannerDismissed,
} from "./bannerDismiss";

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

describe("bannerDismiss", () => {
  const NOW = Date.parse("2026-07-01T00:00:00.000Z");
  const KEY = "github-cli:/project/a";

  beforeEach(() => {
    installLocalStorage();
  });

  it("is not dismissed before any dismissal", () => {
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    expect(hasRecentBannerDismissal(KEY, BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
  });

  it("persists a dismissal for the same fingerprint within the grace window", () => {
    dismissBanner(KEY, "no-token", NOW);
    // Same fingerprint, still within grace → dismissed.
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW + 60_000)).toBe(true);
  });

  it("resurfaces when the fingerprint changes (state regressed)", () => {
    dismissBanner(KEY, "no-token", NOW);
    // The underlying gh state moved to a different sub-state → not dismissed.
    expect(isBannerDismissed(KEY, "repo-access", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    // ...but the fingerprint-agnostic heuristic still counts it as recently dismissed.
    expect(hasRecentBannerDismissal(KEY, BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
  });

  it("resurfaces after the grace window elapses", () => {
    dismissBanner(KEY, "no-token", NOW);
    const justInside = NOW + BANNER_DISMISS_GRACE_MS - 1;
    const justOutside = NOW + BANNER_DISMISS_GRACE_MS + 1;
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, justInside)).toBe(true);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, justOutside)).toBe(false);
    expect(hasRecentBannerDismissal(KEY, BANNER_DISMISS_GRACE_MS, justOutside)).toBe(false);
  });

  it("survives a re-read (durable across simulated restart)", () => {
    dismissBanner(KEY, "no-token", NOW);
    // A fresh module read (same backing store) still sees the dismissal — this is
    // what localStorage buys us over the old session-only Zustand map.
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW + 1_000)).toBe(true);
  });

  it("keeps dismissals independent per key", () => {
    dismissBanner(KEY, "no-token", NOW);
    expect(isBannerDismissed("ai-provider:/project/a", "missing", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
  });

  it("prunes other expired entries when a new dismissal is written", () => {
    // Dismiss B far in the past so it is beyond grace when A is dismissed.
    dismissBanner("mock-provider:/project/b", "mock", NOW - 2 * BANNER_DISMISS_GRACE_MS);
    dismissBanner(KEY, "no-token", NOW);
    // The expired B entry is gone; A remains.
    expect(hasRecentBannerDismissal("mock-provider:/project/b", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
  });

  it("ignores blank keys", () => {
    dismissBanner("   ", "x", NOW);
    expect(isBannerDismissed("", "x", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
  });

  it("clearBannerDismissal removes an entry so the banner resurfaces", () => {
    dismissBanner(KEY, "no-token", NOW);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
    // Condition went healthy → clear the recorded dismissal.
    clearBannerDismissal(KEY);
    // A later regression to the SAME state is no longer suppressed.
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    expect(hasRecentBannerDismissal(KEY, BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
  });

  it("clearBannerDismissal only removes the target key", () => {
    dismissBanner(KEY, "no-token", NOW);
    dismissBanner("ai-provider:/project/a", "missing", NOW);
    clearBannerDismissal(KEY);
    expect(isBannerDismissed(KEY, "no-token", BANNER_DISMISS_GRACE_MS, NOW)).toBe(false);
    expect(isBannerDismissed("ai-provider:/project/a", "missing", BANNER_DISMISS_GRACE_MS, NOW)).toBe(true);
  });

  it("clearBannerDismissal is a no-op for absent or blank keys", () => {
    expect(() => clearBannerDismissal("never-dismissed")).not.toThrow();
    expect(() => clearBannerDismissal("   ")).not.toThrow();
  });
});
