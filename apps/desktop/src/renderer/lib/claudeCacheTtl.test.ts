import { describe, expect, it } from "vitest";
import type { ClaudePromptCache } from "../../shared/claudePromptCache";
import { claudeCacheCountdown, formatClaudeCacheTtl, shouldShowClaudeCacheTtl } from "./claudeCacheTtl";

const TURN_ENDED = "2026-04-08T12:00:00.000Z";
const minutesAfterTurn = (minutes: number) => Date.parse(TURN_ENDED) + minutes * 60_000;
const MIN = 60_000;

describe("claudeCacheTtl", () => {
  it("formats remaining time as m:ss", () => {
    expect(formatClaudeCacheTtl(299_000)).toBe("4:59");
    expect(formatClaudeCacheTtl(9_000)).toBe("0:09");
    expect(formatClaudeCacheTtl(0)).toBe("0:00");
  });

  it.each<[string, ClaudePromptCache | null, number, { remainingMs: number; showInMs: number }]>([
    ["a 5-minute cache counts from the turn end", { ttl: "5m" }, 2, { remainingMs: 3 * MIN, showInMs: 0 }],
    ["a 5-minute cache is over at five minutes", { ttl: "5m" }, 5, { remainingMs: 0, showInMs: 0 }],
    ["a 1-hour cache is hidden for most of the hour", { ttl: "1h" }, 10, { remainingMs: 45 * MIN, showInMs: 35 * MIN }],
    ["a 1-hour cache shows its last ten minutes", { ttl: "1h" }, 45, { remainingMs: 10 * MIN, showInMs: 0 }],
    ["a 1-hour cache is over before the hour", { ttl: "1h" }, 55, { remainingMs: 0, showInMs: 0 }],
    // The last request started 3 minutes before the turn ended: Claude's clock started there.
    ["time counts from the last request, not the turn end", { ttl: "5m", since: "2026-04-08T11:57:00.000Z" }, 1, { remainingMs: 1 * MIN, showInMs: 0 }],
    ["an unknown cache has no countdown", null, 1, { remainingMs: 0, showInMs: 0 }],
  ])("%s", (_name, cache, minutes, expected) => {
    expect(claudeCacheCountdown(TURN_ENDED, cache, minutesAfterTurn(minutes))).toEqual(expected);
  });

  it("has no countdown while a turn runs, whatever the cache says", () => {
    expect(claudeCacheCountdown(null, { ttl: "1h", since: TURN_ENDED }, minutesAfterTurn(50)))
      .toEqual({ remainingMs: 0, showInMs: 0 });
  });

  it.each([
    ["an idle Claude chat with a live countdown", {}, true],
    ["a chat that waits for input", { awaitingInput: true }, false],
    ["another provider", { provider: "codex" }, false],
    ["a running chat", { status: "active" }, false],
    ["a chat whose cache is unknown", { cache: null }, false],
  ])("mounts the badge only for %s", (_name, overrides, shown) => {
    expect(shouldShowClaudeCacheTtl({
      provider: "claude",
      status: "idle",
      idleSinceAt: TURN_ENDED,
      cache: { ttl: "1h" },
      nowMs: minutesAfterTurn(2),
      ...overrides,
    })).toBe(shown);
  });
});
