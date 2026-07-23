import { describe, expect, it } from "vitest";
import {
  formatRecoveryCommand,
  formatRecoveryTime,
  shouldShowRecoveryNotice,
} from "./BrainRecoveryNotice";

const wedge = (ts: string, lastCommand = "npm run build") => ({
  ts,
  lastCommand,
  blockedMs: 4200,
});

describe("shouldShowRecoveryNotice", () => {
  it("is hidden when there is no wedge", () => {
    expect(shouldShowRecoveryNotice(null, null)).toBe(false);
    expect(shouldShowRecoveryNotice(undefined, null)).toBe(false);
  });

  it("shows an unacknowledged wedge", () => {
    expect(shouldShowRecoveryNotice(wedge("2026-07-23T10:00:00Z"), null)).toBe(true);
  });

  it("hides a wedge that was already acknowledged", () => {
    const ts = "2026-07-23T10:00:00Z";
    expect(shouldShowRecoveryNotice(wedge(ts), ts)).toBe(false);
  });

  it("re-shows when a newer wedge supersedes an old acknowledgment", () => {
    expect(
      shouldShowRecoveryNotice(wedge("2026-07-23T11:00:00Z"), "2026-07-23T10:00:00Z"),
    ).toBe(true);
  });
});

describe("formatRecoveryCommand", () => {
  it("falls back when the command is blank", () => {
    expect(formatRecoveryCommand("   ")).toBe("background task");
  });

  it("passes short commands through trimmed", () => {
    expect(formatRecoveryCommand("  git status  ")).toBe("git status");
  });

  it("truncates long commands with an ellipsis", () => {
    const long = "run-a-really-long-background-command-that-keeps-going-forever";
    const out = formatRecoveryCommand(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(48);
  });
});

describe("formatRecoveryTime", () => {
  it("returns the raw value for an unparseable timestamp", () => {
    expect(formatRecoveryTime("not-a-date")).toBe("not-a-date");
  });

  it("formats a parseable timestamp to a short local time", () => {
    const out = formatRecoveryTime("2026-07-23T10:05:00Z");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});
