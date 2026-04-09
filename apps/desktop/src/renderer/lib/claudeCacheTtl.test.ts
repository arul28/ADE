import { describe, expect, it } from "vitest";
import {
  CLAUDE_CHAT_CACHE_TTL_MS,
  formatClaudeCacheTtl,
  getClaudeCacheTtlRemainingMs,
  shouldShowClaudeCacheTtl,
} from "./claudeCacheTtl";

describe("claudeCacheTtl", () => {
  it("formats remaining time as m:ss", () => {
    expect(formatClaudeCacheTtl(299_000)).toBe("4:59");
    expect(formatClaudeCacheTtl(9_000)).toBe("0:09");
  });

  it("returns zero once the ttl expires", () => {
    expect(getClaudeCacheTtlRemainingMs("2026-04-08T12:00:00.000Z", Date.parse("2026-04-08T12:05:01.000Z"))).toBe(0);
  });

  it("shows only for idle claude sessions with unexpired cache", () => {
    const idleSinceAt = "2026-04-08T12:00:00.000Z";
    const nowMs = Date.parse("2026-04-08T12:02:00.000Z");
    expect(getClaudeCacheTtlRemainingMs(idleSinceAt, nowMs)).toBe(CLAUDE_CHAT_CACHE_TTL_MS - 120_000);
    expect(shouldShowClaudeCacheTtl({
      provider: "claude",
      status: "idle",
      idleSinceAt,
      nowMs,
    })).toBe(true);
    expect(shouldShowClaudeCacheTtl({
      provider: "claude",
      status: "idle",
      idleSinceAt,
      awaitingInput: true,
      nowMs,
    })).toBe(false);
    expect(shouldShowClaudeCacheTtl({
      provider: "codex",
      status: "idle",
      idleSinceAt,
      nowMs,
    })).toBe(false);
    expect(shouldShowClaudeCacheTtl({
      provider: "claude",
      status: "active",
      idleSinceAt,
      nowMs,
    })).toBe(false);
  });
});
