import { describe, expect, it } from "vitest";
import { claudePromptCacheTtlOfWrites, normalizeClaudePromptCache } from "./claudePromptCache";
import { compactFirstMinTokensFromEnv, compactFirstOffer, warmIdleCompactAtMs } from "./compactFirst";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const env = (event: AgentChatEvent, timestamp: string): AgentChatEventEnvelope =>
  ({ sessionId: "s", timestamp, event }) as AgentChatEventEnvelope;
const done = (m: number, contextTokens?: number) =>
  env({ type: "done", turnId: "t", status: "completed", ...(contextTokens != null ? { usage: { contextTokens } } : {}) } as AgentChatEvent, minutesAgo(m));
const started = (m: number) => env({ type: "status", turnStatus: "started", turnId: "t2" } as AgentChatEvent, minutesAgo(m));
const compacted = (m: number, postTokens: number) =>
  env({ type: "context_compact", trigger: "manual", state: "completed", postTokens } as AgentChatEvent, minutesAgo(m));

describe("compactFirstOffer", () => {
  it.each([
    ["claude idle past an hour with large context", { events: [done(61)], contextTokens: 250_000 }, true],
    ["exactly an hour idle", { events: [done(60)], contextTokens: 250_000 }, true],
    ["idle just under an hour", { events: [done(59)], contextTokens: 250_000 }, false],
    ["context just under 100k", { events: [done(90)], contextTokens: 99_999 }, false],
    ["context exactly 200k", { events: [done(90)], contextTokens: 200_000 }, true],
    ["context just under 200k", { events: [done(90)], contextTokens: 199_999 }, false],
    ["mode never", { events: [done(90)], contextTokens: 250_000, mode: "never" as const }, false],
    ["non-claude provider", { events: [done(90)], contextTokens: 250_000, provider: "codex" }, false],
    ["a new turn started after the last done", { events: [done(90), started(80)], contextTokens: 250_000 }, false],
    ["no finished turn yet", { events: [], contextTokens: 250_000 }, false],
    ["context unknown", { events: [done(90)] }, false],
    // The chat's real cache lifetime decides the wait, counted from the last request's start.
    ["a 5-minute cache, idle five minutes", { events: [done(5)], contextTokens: 250_000, cache: { ttl: "5m" as const } }, true],
    ["a 5-minute cache, idle four minutes", { events: [done(4)], contextTokens: 250_000, cache: { ttl: "5m" as const } }, false],
    ["a 5-minute cache whose last request started two minutes before the turn ended", { events: [done(3)], contextTokens: 250_000, cache: { ttl: "5m" as const, since: minutesAgo(5) } }, true],
    ["a 1-hour cache, idle 59 minutes", { events: [done(59)], contextTokens: 250_000, cache: { ttl: "1h" as const } }, false],
    // Right after a turn (a compaction), the summary can still carry an earlier turn's `since`.
    ["a just-finished turn while the cache still reads from an earlier turn", { events: [started(1), done(0)], contextTokens: 250_000, cache: { ttl: "1h" as const, since: minutesAgo(65) } }, false],
    // A brain started with a lowered limit offers it on a small chat; the normal limit does not.
    ["a small chat under a lowered limit", { events: [done(90)], contextTokens: 12_000, minTokens: 10_000 }, true],
    ["a small chat under the normal limit", { events: [done(90)], contextTokens: 12_000 }, false],
  ])("%s", (_name, args, offered) => {
    const offer = compactFirstOffer({ provider: "claude", now: NOW, ...args });
    expect(offer !== null).toBe(offered);
  });

  it("reports when the offer became eligible", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90)], contextTokens: 250_000 })?.eligibleAt)
      .toBe(NOW - 30 * 60_000);
  });

  it("estimates the post-compact size from the last completed compaction, else 2% of context and never under the fixed part of a chat", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90)], contextTokens: 600_000 })?.estimatedPostTokens)
      .toBe(12_000);
    // 2% of 200k is 4k, but a compacted chat still carries its system prompt and tools.
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90)], contextTokens: 200_000 })?.estimatedPostTokens)
      .toBe(5_000);
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [compacted(200, 12_345), done(90)], contextTokens: 250_000 })?.estimatedPostTokens)
      .toBe(12_345);
  });

  it("reads measured context from the done event when the caller has no reading", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90, 230_000)] })?.contextTokens).toBe(230_000);
  });
});

describe("warmIdleCompactAtMs", () => {
  const hourCache = { ttl: "1h" as const, since: minutesAgo(10) };
  it.each([
    ["Always, a one-hour cache and a big chat: 54 minutes into the cache", { mode: "always" as const, cache: hourCache, contextTokens: 250_000 }, NOW + 44 * 60_000],
    ["Ask waits for the person", { mode: "ask" as const, cache: hourCache, contextTokens: 250_000 }, null],
    ["Never", { mode: "never" as const, cache: hourCache, contextTokens: 250_000 }, null],
    ["a 5-minute cache is gone before it matters", { mode: "always" as const, cache: { ttl: "5m" as const, since: minutesAgo(1) }, contextTokens: 250_000 }, null],
    ["an unknown cache lifetime", { mode: "always" as const, cache: null, contextTokens: 250_000 }, null],
    ["a chat under the floor", { mode: "always" as const, cache: hourCache, contextTokens: 150_000 }, null],
  ])("%s", (_name, args, expected) => {
    expect(warmIdleCompactAtMs({ provider: "claude", events: [done(10)], ...args })).toBe(expected);
  });

  it("never schedules while a turn is running", () => {
    expect(warmIdleCompactAtMs({ provider: "claude", events: [done(10), started(5)], mode: "always", cache: hourCache, contextTokens: 250_000 })).toBeNull();
  });
});

describe("the prompt cache lifetime a Claude turn wrote", () => {
  it.each([
    ["every write is 1-hour (a subscription)", 69_016, 69_016, "1h"],
    ["every write is 5-minute (an API key)", 500, 0, "5m"],
    // A server tool adds a small 5-minute write behind a 1-hour prefix.
    ["mostly 1-hour with a small 5-minute tail", 10_000, 9_800, "1h"],
    // The account crossed into extra usage early in the turn.
    ["mostly 5-minute", 10_000, 1_000, "5m"],
    ["nothing was written", 0, 0, null],
    ["the provider did not report the split", 500, null, null],
    ["no usage at all", null, null, null],
  ])("%s", (_name, written, written1h, expected) => {
    expect(claudePromptCacheTtlOfWrites(written, written1h)).toBe(expected);
  });

  it("reads a stored cache back and drops anything it cannot trust", () => {
    expect(normalizeClaudePromptCache({ ttl: "1h", since: "2026-10-09T11:00:00.000Z" }))
      .toEqual({ ttl: "1h", since: "2026-10-09T11:00:00.000Z" });
    expect(normalizeClaudePromptCache({ ttl: "5m", since: "not a date" })).toEqual({ ttl: "5m" });
    expect(normalizeClaudePromptCache({ ttl: "2h" })).toBeNull();
    expect(normalizeClaudePromptCache("1h")).toBeNull();
  });
});

describe("compactFirstMinTokensFromEnv", () => {
  it.each([
    ["10000", 10_000],
    [undefined, null],
    ["", null],
    ["0", null],
    ["-5", null],
    ["12.5", null],
    ["lots", null],
  ])("reads %j as %j", (value, expected) => {
    expect(compactFirstMinTokensFromEnv({ ADE_COMPACT_FIRST_MIN_TOKENS: value })).toBe(expected);
  });
});
