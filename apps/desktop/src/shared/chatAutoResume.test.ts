import { describe, expect, it } from "vitest";

import {
  AUTO_RESUME_BUFFER_MS,
  AUTO_RESUME_SCHEDULED_WORK_SOURCE,
  autoResumeFireAtMs,
  autoResumeScheduleId,
  formatAutoResumeTime,
  formatUsageLimitResetLabel,
  isAutoResumeScheduledWork,
  isPendingAutoResumeScheduledWork,
  isUsageLimitChatError,
  sessionAutoContinueAtUsageLimit,
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

  it("recognises the limit in the human message when no code is attached", () => {
    expect(isUsageLimitChatError({ message: "You've hit your usage limit." })).toBe(true);
    expect(isUsageLimitChatError({ message: "429 Rate limit reached for this model." })).toBe(true);
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

describe("formatAutoResumeTime", () => {
  it("renders a local-time label for a real instant", () => {
    expect(formatAutoResumeTime(Date.parse("2026-08-29T10:00:00.000Z")).trim().length)
      .toBeGreaterThan(0);
  });

  it("returns an empty label rather than 'Invalid Date' for a bad instant", () => {
    expect(formatAutoResumeTime(Number.NaN)).toBe("");
  });
});

describe("formatUsageLimitResetLabel", () => {
  it("names the reset clock and remaining window", () => {
    const resetAt = Date.parse("2026-08-29T15:40:00.000Z");
    const now = resetAt - 47 * 60_000;
    expect(formatUsageLimitResetLabel(resetAt, now)).toMatch(/^Reset at .+\(47 min\)$/);
  });

  it("omits the remaining window once the reset instant has passed", () => {
    const resetAt = Date.parse("2026-08-29T15:40:00.000Z");
    expect(formatUsageLimitResetLabel(resetAt, resetAt + 60_000)).toMatch(/^Reset at /);
    expect(formatUsageLimitResetLabel(resetAt, resetAt + 60_000)).not.toMatch(/min\)|hr\)$/);
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
