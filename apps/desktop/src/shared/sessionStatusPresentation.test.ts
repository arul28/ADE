import { describe, expect, it } from "vitest";
import { sessionElapsedAnchor, sessionElapsedLabel } from "./sessionStatusPresentation";

/**
 * `sessionElapsedAnchor` is the shared answer to "how long", read by the
 * desktop status slot, `ade code`'s work list, and `ade session show`. The
 * cases below are the three anchors it has to keep apart — mixing any two of
 * them produced a duration the row could not be judged by.
 */
describe("sessionElapsedAnchor", () => {
  const base = {
    currentTurnStartedAt: "2026-08-17T10:00:00.000Z",
    lastActivityAt: "2026-08-17T12:00:00.000Z",
    startedAt: "2026-08-17T09:00:00.000Z",
    backgroundWorkSince: "2026-08-17T10:30:00.000Z",
  };

  it("counts a live turn from the turn start, not from the last output write", () => {
    // A CLI repainting its TUI writes output constantly; anchoring there
    // reports a five-minute turn as "2s".
    expect(sessionElapsedAnchor(base, "running", "turn")).toBe(base.currentTurnStartedAt);
  });

  it("counts background work from when the work started", () => {
    // The turn is over. `lastActivityAt` is refreshed by every provider frame,
    // so anchoring there made a job that had been running for hours read the
    // same as one that started three seconds ago.
    expect(sessionElapsedAnchor(base, "running", "background")).toBe(base.backgroundWorkSince);
    expect(sessionElapsedAnchor(base, "running", "monitoring")).toBe(base.backgroundWorkSince);
  });

  it("falls back to last activity when the runtime cannot say when the work began", () => {
    // Providers with no background-task level, and summaries from older peers,
    // must keep reading exactly as they did before.
    const withoutAnchor = { ...base, backgroundWorkSince: null };
    expect(sessionElapsedAnchor(withoutAnchor, "running", "background")).toBe(base.lastActivityAt);
  });

  it("counts every resting state from last activity", () => {
    expect(sessionElapsedAnchor(base, "stale", null)).toBe(base.lastActivityAt);
    expect(sessionElapsedAnchor(base, "ready", null)).toBe(base.lastActivityAt);
  });

  it("formats the elapsed only when the presentation asks for one", () => {
    // The label is what `ade code` and `ade session show` render, so its two
    // "say nothing" branches decide whether a row shows a bare word or a lie.
    const working = { label: "Background work", tone: "blue", glyph: "working", showsElapsed: true, prominent: false } as const;
    const quiet = { label: "Done", tone: "emerald", glyph: "done", showsElapsed: false, prominent: true } as const;
    const nowMs = Date.parse("2026-08-17T12:30:00.000Z");

    expect(sessionElapsedLabel(base, working, "running", "background", nowMs)).toBe("2h");
    expect(sessionElapsedLabel(base, quiet, "ready", null, nowMs)).toBeNull();
    expect(sessionElapsedLabel(base, null, "running", "turn", nowMs)).toBeNull();
    expect(sessionElapsedLabel(
      { lastActivityAt: "not a date" },
      working,
      "running",
      "background",
      nowMs,
    )).toBeNull();
  });

  it("falls back to the session start when there is no activity yet", () => {
    const fresh = { currentTurnStartedAt: null, lastActivityAt: null, startedAt: base.startedAt };
    expect(sessionElapsedAnchor(fresh, "running", "turn")).toBe(base.startedAt);
    expect(sessionElapsedAnchor(fresh, "ready", null)).toBe(base.startedAt);
  });
});
