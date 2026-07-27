import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../../../shared/types";
import { isSessionSnoozed } from "../../../../shared/sessionCanonicalState";
import {
  OPTIMISTIC_TTL_MS,
  RECONCILE_GRACE_MS,
  SessionLifecycleOverlay,
} from "../sessionLifecycleOverlay";
import { sessionLifecycleSupported } from "../sessionLifecycleSupport";

function row(overrides: Partial<TerminalSessionSummary> & { id: string }): TerminalSessionSummary {
  return overrides as TerminalSessionSummary;
}

describe("SessionLifecycleOverlay", () => {
  it("paints a snooze onto the host row so the shared derivation files it as snoozed", () => {
    const overlay = new SessionLifecycleOverlay();
    const untilIso = new Date(Date.now() + 3_600_000).toISOString();
    const host = row({ id: "s1" });

    expect(isSessionSnoozed(overlay.decorate(host))).toBe(false);
    overlay.begin("s1", { snoozedUntil: untilIso, snoozedAt: new Date().toISOString() });

    expect(isSessionSnoozed(overlay.decorate(host))).toBe(true);
    // The authoritative row is never mutated — only the copy handed to the UI.
    expect(host.snoozedUntil).toBeUndefined();
  });

  it("retires a patch on agreement even though the host stamps its own instant", () => {
    const overlay = new SessionLifecycleOverlay();
    overlay.begin("s1", { snoozedUntil: "2026-07-26T10:00:00.000Z", snoozedAt: "2026-07-26T09:00:00.000Z" });

    const report = overlay.reconcile([
      row({ id: "s1", snoozedUntil: "2026-07-26T10:00:03.000Z", snoozedAt: "2026-07-26T09:00:01.000Z" }),
    ]);

    expect(report).toEqual({ reconciled: ["s1"], rolledBack: [] });
    expect(overlay.size).toBe(0);
  });

  it("keeps a patch pending while the host row still disagrees", () => {
    const overlay = new SessionLifecycleOverlay();
    overlay.begin("s1", { snoozedUntil: "2026-07-26T10:00:00.000Z" });

    const report = overlay.reconcile([row({ id: "s1" })]);

    expect(report).toEqual({ reconciled: [], rolledBack: [] });
    expect(overlay.has("s1")).toBe(true);
  });

  it("compares enum columns exactly, so a different override is not agreement", () => {
    const overlay = new SessionLifecycleOverlay();
    overlay.begin("s1", { settleOverride: "active" });

    expect(overlay.reconcile([row({ id: "s1", settleOverride: "settled" })]).reconciled).toEqual([]);
    expect(overlay.reconcile([row({ id: "s1", settleOverride: "active" })]).reconciled).toEqual(["s1"]);
  });

  it("drops an unconfirmed patch at its TTL so a lost ack cannot wedge the row", () => {
    let nowMs = 1_000;
    const overlay = new SessionLifecycleOverlay({ now: () => nowMs });
    overlay.begin("s1", { settledAt: "2026-07-26T10:00:00.000Z" });

    nowMs += OPTIMISTIC_TTL_MS - 1;
    expect(overlay.reconcile([row({ id: "s1" })]).rolledBack).toEqual([]);

    nowMs += 2;
    expect(overlay.reconcile([row({ id: "s1" })]).rolledBack).toEqual(["s1"]);
    expect(overlay.size).toBe(0);
  });

  it("shortens the window to the reconcile grace once the host acks", () => {
    let nowMs = 1_000;
    const overlay = new SessionLifecycleOverlay({ now: () => nowMs });
    const token = overlay.begin("s1", { settledAt: "2026-07-26T10:00:00.000Z" });
    overlay.confirm("s1", token);

    nowMs += RECONCILE_GRACE_MS + 1;
    expect(overlay.reconcile([row({ id: "s1" })]).rolledBack).toEqual(["s1"]);
  });

  it("rolls back on reject and ignores a stale token from a superseded write", () => {
    const overlay = new SessionLifecycleOverlay();
    const first = overlay.begin("s1", { snoozedUntil: "2026-07-26T10:00:00.000Z" });
    const second = overlay.begin("s1", { snoozedUntil: "2026-07-26T18:00:00.000Z" });

    // The first write losing a race must not tear down the second write's patch.
    overlay.reject("s1", first);
    expect(overlay.decorate(row({ id: "s1" })).snoozedUntil).toBe("2026-07-26T18:00:00.000Z");

    overlay.reject("s1", second);
    expect(overlay.size).toBe(0);
  });

  it("returns the original list untouched when nothing is pending", () => {
    const overlay = new SessionLifecycleOverlay();
    const rows = [row({ id: "s1" })];
    expect(overlay.decorateAll(rows)).toBe(rows);
  });
});

describe("sessionLifecycleSupported", () => {
  it("requires the per-row settle/snooze/wake actions the controls issue", () => {
    expect(sessionLifecycleSupported([])).toBe(false);
    expect(sessionLifecycleSupported(
      ["work.listSessions", "session.snoozeSession"].map((action) => ({
        action,
        scope: "project" as const,
        policy: { viewerAllowed: true },
      })),
    )).toBe(false);
    expect(sessionLifecycleSupported(
      ["session.settleSession", "session.snoozeSession", "session.wakeSession"].map((action) => ({
        action,
        scope: "project" as const,
        policy: { viewerAllowed: true },
      })),
    )).toBe(true);
  });
});
