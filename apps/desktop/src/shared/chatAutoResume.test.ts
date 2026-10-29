import { describe, expect, it } from "vitest";

import {
  AUTO_RESUME_BUFFER_MS,
  AUTO_RESUME_SCHEDULED_WORK_SOURCE,
  autoResumeFireAtMs,
  autoResumeScheduleId,
  isAutoResumeScheduledWork,
  isPendingAutoResumeScheduledWork,
  isPendingUpdateResumeScheduledWork,
  isUpdateResumeScheduledWork,
  isUsageLimitChatError,
  sessionAutoContinueAtUsageLimit,
  UPDATE_RESUME_SCHEDULED_WORK_SOURCE,
  updateResumeScheduleId,
  nextRestartResumeStreak,
  restartResumeHold,
} from "./chatAutoResume";

describe("isUsageLimitChatError", () => {
  it("recognises the structured classifier category", () => {
    expect(isUsageLimitChatError({ message: "anything", errorInfo: { category: "rate_limit" } }))
      .toBe(true);
  });

  it("recognises the opaque provider strings Codex forwards", () => {
    expect(isUsageLimitChatError({ errorInfo: "usageLimitReached" })).toBe(true);
    expect(isUsageLimitChatError({ errorInfo: "usage_limit_reached" })).toBe(true);
    expect(isUsageLimitChatError({ errorInfo: "rate-limit-exceeded" })).toBe(true);
  });

  it.each([
    "You've hit your usage limit.",
    "429 Rate limit reached for this model.",
    "You're out of usage. Switch to Auto, or ask your admin to increase your limit.",
  ])("recognises the provider limit message %s without a code", (message) => {
    expect(isUsageLimitChatError({ message })).toBe(true);
  });

  it("does not treat other failures as usage limits", () => {
    expect(isUsageLimitChatError({ message: "The connection was reset." })).toBe(false);
    expect(isUsageLimitChatError({ errorInfo: { category: "auth" }, message: "Not signed in." }))
      .toBe(false);
    // "limit" alone is not a usage limit — a context-window overflow is a
    // different failure with a different recovery.
    expect(isUsageLimitChatError({ message: "Prompt exceeds the context limit." })).toBe(false);
    expect(isUsageLimitChatError({})).toBe(false);
  });
});

describe("autoResumeFireAtMs", () => {
  const now = Date.parse("2026-08-29T10:00:00.000Z");

  it("waits out the buffer past the reset instant", () => {
    const resetsAt = now + 30 * 60_000;
    expect(autoResumeFireAtMs(resetsAt, now)).toBe(resetsAt + AUTO_RESUME_BUFFER_MS);
  });

  it("arms nothing when the provider reported no reset instant", () => {
    expect(autoResumeFireAtMs(null, now)).toBeNull();
    expect(autoResumeFireAtMs(undefined, now)).toBeNull();
    expect(autoResumeFireAtMs(Number.NaN, now)).toBeNull();
    expect(autoResumeFireAtMs(0, now)).toBeNull();
    expect(autoResumeFireAtMs(-1, now)).toBeNull();
  });

  it("arms nothing once the buffered fire time has already passed", () => {
    // The limit is already back: a schedule would fire immediately for no
    // reason, and the manual retry affordance is the right answer.
    expect(autoResumeFireAtMs(now - 10 * 60_000, now)).toBeNull();
    expect(autoResumeFireAtMs(now - AUTO_RESUME_BUFFER_MS, now)).toBeNull();
    // A reset that just passed is still worth arming: the buffer has not
    // elapsed yet, so the fire time is genuinely in the future.
    expect(autoResumeFireAtMs(now - AUTO_RESUME_BUFFER_MS + 1_000, now))
      .toBe(now + 1_000);
  });
});

describe("autoResumeScheduleId", () => {
  it("is deterministic per chat so a repeat failure replaces rather than stacks", () => {
    expect(autoResumeScheduleId("session-a")).toBe(autoResumeScheduleId("session-a"));
    expect(autoResumeScheduleId("session-a")).not.toBe(autoResumeScheduleId("session-b"));
    expect(isAutoResumeScheduledWork({ id: autoResumeScheduleId("session-a") })).toBe(true);
  });
});

describe("isAutoResumeScheduledWork", () => {
  it("accepts the tag as authoritative regardless of the id", () => {
    expect(isAutoResumeScheduledWork({
      id: "wakeup:session-a",
      source: AUTO_RESUME_SCHEDULED_WORK_SOURCE,
    })).toBe(true);
  });

  it("falls back to the id prefix for rows persisted before the tag existed", () => {
    expect(isAutoResumeScheduledWork({ id: "auto-resume:session-a" })).toBe(true);
    expect(isAutoResumeScheduledWork({ id: "auto-resume:session-a", source: null })).toBe(true);
  });

  it("never claims a user- or agent-created row", () => {
    expect(isAutoResumeScheduledWork({ id: "wakeup:session-a" })).toBe(false);
    expect(isAutoResumeScheduledWork({ id: "cron-tool:abc", source: "something-else" }))
      .toBe(false);
    expect(isAutoResumeScheduledWork(null)).toBe(false);
    expect(isAutoResumeScheduledWork(undefined)).toBe(false);
    expect(isAutoResumeScheduledWork({})).toBe(false);
  });
});

describe("isPendingAutoResumeScheduledWork", () => {
  const row = { id: "auto-resume:session-a", source: AUTO_RESUME_SCHEDULED_WORK_SOURCE } as const;

  it("treats live statuses as pending", () => {
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "scheduled" })).toBe(true);
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "paused" })).toBe(true);
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "fired" })).toBe(true);
    expect(isPendingAutoResumeScheduledWork({ ...row })).toBe(true);
  });

  it("accepts both vocabularies for the finished state", () => {
    // The host record says `done`; the client item says `completed`. Neither is
    // pending, and the shared predicate must not disagree with itself.
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "done" })).toBe(false);
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "completed" })).toBe(false);
    expect(isPendingAutoResumeScheduledWork({ ...row, status: "cancelled" })).toBe(false);
  });

  it("never claims a row ADE did not create, whatever its status", () => {
    expect(isPendingAutoResumeScheduledWork({ id: "wakeup:session-a", status: "scheduled" }))
      .toBe(false);
    expect(isPendingAutoResumeScheduledWork(null)).toBe(false);
  });
});

describe("isUpdateResumeScheduledWork", () => {
  const row = { id: updateResumeScheduleId("session-a"), source: UPDATE_RESUME_SCHEDULED_WORK_SOURCE } as const;

  it("claims only rows tagged update_restart", () => {
    expect(isUpdateResumeScheduledWork(row)).toBe(true);
    // The update tag has no pre-tag history to fall back on, so the
    // deterministic id alone is not a recogniser.
    expect(isUpdateResumeScheduledWork({ id: updateResumeScheduleId("session-a") })).toBe(false);
    expect(isUpdateResumeScheduledWork({ source: AUTO_RESUME_SCHEDULED_WORK_SOURCE })).toBe(false);
    expect(isUpdateResumeScheduledWork(null)).toBe(false);
  });

  it("treats live statuses as pending and terminal ones as not", () => {
    for (const status of ["scheduled", "paused", "fired"] as const) {
      expect(isPendingUpdateResumeScheduledWork({ ...row, status })).toBe(true);
    }
    for (const status of ["done", "completed", "cancelled"] as const) {
      expect(isPendingUpdateResumeScheduledWork({ ...row, status })).toBe(false);
    }
  });
});

describe("sessionAutoContinueAtUsageLimit", () => {
  it("defaults auto-continue on, with explicit false as the per-chat opt-out", () => {
    expect(sessionAutoContinueAtUsageLimit(undefined)).toBe(true);
    expect(sessionAutoContinueAtUsageLimit({})).toBe(true);
    expect(sessionAutoContinueAtUsageLimit({ autoContinueAtUsageLimit: true })).toBe(true);
    expect(sessionAutoContinueAtUsageLimit({ autoContinueAtUsageLimit: false })).toBe(false);
  });
});

// A chat whose resumed turn is cut off by another restart, again and again,
// must stop resuming itself (T3 #18461), and nothing may resume past an open
// question. One table for the streak, one for the decision.
describe("restart resume streak and hold", () => {
  const fired = { source: UPDATE_RESUME_SCHEDULED_WORK_SOURCE, status: "done", lastFiredAt: 1_000, restartResumeStreak: 2 };
  it.each([
    ["the first resume", undefined, null, 1],
    ["a resumed turn cut off again", fired, null, 3],
    ["a resumed turn cut off again, idle from before it fired", fired, new Date(500).toISOString(), 3],
    ["after the resumed turn finished", fired, new Date(2_000).toISOString(), 1],
    ["after the user stepped in", { ...fired, status: "cancelled" }, null, 1],
    ["after an update the user accepted", { ...fired, restartResumeStreak: 0 }, null, 1],
    ["after another kind of wake", { ...fired, source: "auto_resume_limit" }, null, 1],
  ] as const)("streak: %s", (_label, previous, idleSinceAt, expected) => {
    expect(nextRestartResumeStreak(previous, idleSinceAt)).toBe(expected);
  });

  const base = { continueEnabled: true, recent: true, awaitingUser: false, capped: false, settledOrArchived: false };
  it.each([
    ["resumes", base, null],
    ["waits for an open question", { ...base, awaitingUser: true }, "awaiting_user"],
    ["waits at the cap", { ...base, capped: true }, "capped"],
    ["leaves old work alone", { ...base, recent: false }, "stale"],
    ["leaves a settled chat alone", { ...base, settledOrArchived: true, awaitingUser: true }, "settled"],
    ["respects the setting first", { ...base, continueEnabled: false, capped: true }, "disabled"],
  ] as const)("hold: %s", (_label, args, hold) => {
    expect(restartResumeHold(args)).toBe(hold);
  });
});
