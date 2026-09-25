import { describe, expect, it } from "vitest";
import { sessionElapsedAnchor, sessionElapsedLabel, sessionStatusPresentation } from "./sessionStatusPresentation";
import type { AgentChatUsageLimitResume } from "./types/chat";
import type { SessionActivityReport } from "./types/sessions";

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

describe("sessionStatusPresentation usage-limit resume", () => {
  const resume = (
    state: AgentChatUsageLimitResume["state"],
    fireAt: string | null,
  ): AgentChatUsageLimitResume => ({
    state,
    provider: "claude",
    fireAt,
    resetAt: fireAt,
    scheduleId: state === "armed" ? "auto-resume:chat-1" : null,
    attempts: state === "paused" ? 2 : 1,
    providerDetail: null,
    turnId: "turn-1",
    updatedAt: "2026-08-17T11:59:00.000Z",
  });

  it("names the resume instant instead of Waiting or Done while a resume is armed", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
    const armed = sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("armed", "2026-08-17T12:47:00.000Z"),
      nextWakeAt: "2026-08-17T12:10:00.000Z",
      nowMs,
    });
    expect(armed).toMatchObject({ tone: "neutral", glyph: "waiting" });
    expect(armed?.label.startsWith("Resumes ")).toBe(true);
  });

  it("reads Resuming — not a past clock — once the row is due", () => {
    const nowMs = Date.parse("2026-08-17T13:00:00.000Z");
    const resuming = sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("armed", "2026-08-17T12:47:00.000Z"),
      nowMs,
    });
    // The row still speaks for the chat, but "Resumes 12:47 PM" would be
    // promising an instant that is already thirteen minutes gone.
    expect(resuming).toMatchObject({ label: "Resuming", tone: "neutral", glyph: "waiting" });
  });

  it("labels a capped streak as attention, and leaves the rest to the phase", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
    expect(sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("paused", "2026-08-17T21:30:00.000Z"),
      nowMs,
    })).toMatchObject({ label: "Paused · limit", tone: "amber", glyph: "waiting" });
    // Neither of these is waiting for anything, so the row keeps its ordinary
    // presentation instead of being quieted into a limit label.
    expect(sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("opted_out", null),
      nowMs,
    })?.label).toBe("Done");
    expect(sessionStatusPresentation("failed", {}, {
      usageLimitResume: resume("no_reset", null),
      nowMs,
    })).toMatchObject({ label: "Failed", tone: "red" });
  });

  it("outranks the red Failed label for the turn that died at the limit", () => {
    const armed = sessionStatusPresentation("failed", {}, {
      usageLimitResume: resume("armed", "2026-08-17T12:47:00.000Z"),
      nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
    });
    expect(armed).toMatchObject({ tone: "neutral", glyph: "waiting" });
    expect(armed?.label.startsWith("Resumes ")).toBe(true);
    // A capped streak still outranks failed — the chat stopped on a limit.
    expect(sessionStatusPresentation("failed", {}, {
      usageLimitResume: resume("paused", "2026-08-17T21:30:00.000Z"),
      nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
    })).toMatchObject({ label: "Paused · limit", tone: "amber" });
    // A failure with no live limit is still a failure.
    expect(sessionStatusPresentation("failed", {}, { usageLimitResume: null }))
      .toMatchObject({ label: "Failed", tone: "red" });
  });

  it("keeps the paused row prominent and lets the countdown recede", () => {
    const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
    // Amber means "your move", and SessionCard fades every non-prominent row to
    // 70%. A streak that stopped retrying is exactly the row that must not fade
    // — same claim `needs_you` and `woke` make, same prominence.
    expect(sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("paused", "2026-08-17T21:30:00.000Z"),
      nowMs,
    })).toMatchObject({ tone: "amber", prominent: true });
    // An armed countdown is not asking for anything, so it stays quiet.
    expect(sessionStatusPresentation("idle", {}, {
      usageLimitResume: resume("armed", "2026-08-17T12:47:00.000Z"),
      nowMs,
    })).toMatchObject({ tone: "neutral", prominent: false });
  });

  it("falls back to the ordinary phase label when no limit is live", () => {
    expect(sessionStatusPresentation("idle", {}, {
      usageLimitResume: null,
      nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
    })?.label).toBe("Done");
  });
});

describe("sessionStatusPresentation agent-reported activity", () => {
  const report: SessionActivityReport = {
    value: "testing",
    source: "agent",
    updatedAt: "2026-09-22T12:00:10.000Z",
  };

  it("shows one typed activity detail inside a running parent phase", () => {
    expect(sessionStatusPresentation("running", {}, {
      activityStatus: report,
      currentTurnStartedAt: "2026-09-22T12:00:00.000Z",
    })).toMatchObject({
      label: "Testing",
      glyph: "testing",
      tone: "blue",
      activityDetail: true,
      activitySource: "agent",
      activityUpdatedAt: report.updatedAt,
    });
  });

  it("keeps Needs you ahead of an agent-reported activity", () => {
    expect(sessionStatusPresentation("needs_you", {}, {
      activityStatus: report,
    })).toMatchObject({ label: "Needs you", glyph: "needs-you" });
  });

  it("lets host-detected background monitoring outrank a stale turn report", () => {
    expect(sessionStatusPresentation("running", {}, {
      activityStatus: report,
      liveness: "monitoring",
      backgroundWork: { workingCount: 0, monitoringCount: 1 },
      currentTurnStartedAt: null,
    })).toMatchObject({ label: "Monitoring", glyph: "monitoring" });
  });

  it("ignores a report from an earlier turn and keeps a Done parent unchanged", () => {
    expect(sessionStatusPresentation("running", {}, {
      activityStatus: report,
      currentTurnStartedAt: "2026-09-22T12:01:00.000Z",
    })?.label).toBe("Working");
    expect(sessionStatusPresentation("idle", {}, {
      activityStatus: report,
    })?.label).toBe("Done");
  });
});

describe("sessionStatusPresentation detected activity", () => {
  const detected: SessionActivityReport = {
    value: "exploring",
    source: "detected",
    updatedAt: "2026-09-24T12:30:00.000Z",
  };

  it.each([
    ["exploring", "Exploring", "exploring"],
    ["shipping", "Shipping", "shipping"],
  ] as const)("presents %s as live activity", (value, label, glyph) => {
    const activityStatus = { ...detected, value };
    expect(sessionStatusPresentation("running", {}, {
      activityStatus,
      currentTurnStartedAt: "2026-09-24T12:45:00.000Z",
    })).toMatchObject({
      label,
      glyph,
      tone: "blue",
      activityDetail: true,
      activitySource: "detected",
      activityUpdatedAt: detected.updatedAt,
    });
    expect(sessionElapsedAnchor({ activityStatus, currentTurnStartedAt: "2026-09-24T12:45:00.000Z" }, "running", "turn"))
      .toBe(detected.updatedAt);
    expect(sessionStatusPresentation("needs_you", {}, { activityStatus })?.label).toBe("Needs you");
  });

  it("carries detection across continuation turns, hides an older agent report, and anchors elapsed at entry", () => {
    const continuation = "2026-09-24T13:00:00.000Z";
    const oldAgentReport: SessionActivityReport = {
      value: "debugging",
      source: "agent",
      updatedAt: "2026-09-24T12:00:00.000Z",
    };
    const carried = sessionStatusPresentation("running", {}, {
      activityStatus: detected,
      currentTurnStartedAt: continuation,
    });
    const hidden = sessionStatusPresentation("running", {}, {
      activityStatus: oldAgentReport,
      currentTurnStartedAt: continuation,
    });

    expect(carried).toMatchObject({ label: "Exploring", activitySource: "detected" });
    expect(hidden?.label).toBe("Working");
    expect(sessionElapsedAnchor({ activityStatus: detected, currentTurnStartedAt: continuation }, "running", "turn"))
      .toBe(detected.updatedAt);
    const reconfirmed = {
      ...detected,
      source: "agent" as const,
      reportedAt: continuation,
    };
    expect(sessionStatusPresentation("running", {}, {
      activityStatus: reconfirmed,
      currentTurnStartedAt: continuation,
    })).toMatchObject({ label: "Exploring", activitySource: "agent" });
    expect(sessionElapsedAnchor({ activityStatus: reconfirmed, currentTurnStartedAt: continuation }, "running", "turn"))
      .toBe(detected.updatedAt);
  });

  it("keeps native Planning over detected Exploring but honors an agent refinement", () => {
    const currentTurnStartedAt = "2026-09-24T12:45:00.000Z";
    const exploring = sessionStatusPresentation("running", {}, {
      chatActivityMode: "planning",
      activityStatus: detected,
      currentTurnStartedAt,
    });
    const explicitTesting: SessionActivityReport = {
      ...detected,
      value: "testing",
      source: "agent",
      reportedAt: currentTurnStartedAt,
    };
    const testing = sessionStatusPresentation("running", {}, {
      chatActivityMode: "planning",
      activityStatus: explicitTesting,
      currentTurnStartedAt,
    });

    expect(exploring).toMatchObject({ label: "Planning", glyph: "planning", tone: "violet" });
    expect(testing).toMatchObject({ label: "Testing", glyph: "testing", activitySource: "agent" });
  });
});
