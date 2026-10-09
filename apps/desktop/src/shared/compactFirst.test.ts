import { describe, expect, it } from "vitest";
import { compactFirstOffer } from "./compactFirst";
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
    ["claude idle past an hour with large context", { events: [done(61)], contextTokens: 150_000 }, true],
    ["exactly an hour idle", { events: [done(60)], contextTokens: 150_000 }, true],
    ["idle just under an hour", { events: [done(59)], contextTokens: 150_000 }, false],
    ["context just under 100k", { events: [done(90)], contextTokens: 99_999 }, false],
    ["context exactly 100k", { events: [done(90)], contextTokens: 100_000 }, true],
    ["mode never", { events: [done(90)], contextTokens: 150_000, mode: "never" as const }, false],
    ["non-claude provider", { events: [done(90)], contextTokens: 150_000, provider: "codex" }, false],
    ["a new turn started after the last done", { events: [done(90), started(80)], contextTokens: 150_000 }, false],
    ["no finished turn yet", { events: [], contextTokens: 150_000 }, false],
    ["context unknown", { events: [done(90)] }, false],
  ])("%s", (_name, args, offered) => {
    const offer = compactFirstOffer({ provider: "claude", now: NOW, ...args });
    expect(offer !== null).toBe(offered);
  });

  it("reports when the offer became eligible", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90)], contextTokens: 150_000 })?.eligibleAt)
      .toBe(NOW - 30 * 60_000);
  });

  it("estimates the post-compact size from the last completed compaction, else 2% of context", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90)], contextTokens: 150_000 })?.estimatedPostTokens)
      .toBe(3_000);
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [compacted(200, 12_345), done(90)], contextTokens: 150_000 })?.estimatedPostTokens)
      .toBe(12_345);
  });

  it("reads measured context from the done event when the caller has no reading", () => {
    expect(compactFirstOffer({ provider: "claude", now: NOW, events: [done(90, 130_000)] })?.contextTokens).toBe(130_000);
  });
});
