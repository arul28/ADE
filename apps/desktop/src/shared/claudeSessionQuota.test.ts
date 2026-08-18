import { describe, expect, it } from "vitest";
import {
  buildClaudeSessionQuotaCard,
  CLAUDE_SESSION_QUOTA_CARD_ACTION,
  CLAUDE_SESSION_QUOTA_CARD_VARIANT,
  classifyClaudeRateLimitInfo,
  claudeSessionQuotaCardId,
  isClaudeSessionQuotaText,
  parseClaudeSessionQuotaResetAt,
  snapshotFromClaudeSessionQuotaText,
  utilizationToPercent,
} from "./claudeSessionQuota";

describe("claudeSessionQuota", () => {
  it("classifies only hard session-limit copy, not ordinary 429 text", () => {
    expect(isClaudeSessionQuotaText("You've hit your session limit · resets 7pm (America/New_York)")).toBe(true);
    expect(isClaudeSessionQuotaText("Session limit reached. Check Settings or start a new session.")).toBe(false);
    expect(isClaudeSessionQuotaText("cost limit exceeded")).toBe(true);
    expect(isClaudeSessionQuotaText("Rate limited by Anthropic. Retrying...")).toBe(false);
    expect(isClaudeSessionQuotaText("too many requests")).toBe(false);
  });

  it("treats allowed_warning as approaching and other statuses as rejected", () => {
    expect(classifyClaudeRateLimitInfo({ status: "allowed" })).toEqual({ kind: "ignore" });
    expect(classifyClaudeRateLimitInfo({
      status: "allowed_warning",
      utilization: 0.82,
      resetsAt: 1_770_000_000,
    })).toMatchObject({
      kind: "approaching",
      snapshot: { utilizationPct: 82, resetsAtMs: 1_770_000_000_000 },
    });
    expect(classifyClaudeRateLimitInfo({
      status: "rejected",
      utilization: 1,
    })).toMatchObject({
      kind: "rejected",
      snapshot: { utilizationPct: 100 },
    });
  });

  it("parses the Claude 7pm reset clock in the advertised timezone", () => {
    const now = Date.parse("2026-08-17T21:10:00.000Z"); // 5:10pm ET
    const resetAt = parseClaudeSessionQuotaResetAt(
      "You've hit your session limit · resets 7pm (America/New_York)",
      now,
    );
    expect(resetAt).toBeGreaterThan(now);
    const zoned = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(resetAt!));
    expect(zoned).toBe("19");
  });

  it("builds a sticky live card with a local-fork action", () => {
    const card = buildClaudeSessionQuotaCard({
      sessionId: "chat-1",
      turnId: "turn-1",
      snapshot: { utilizationPct: 82, resetsAtMs: Date.parse("2026-08-17T23:00:00.000Z") },
    });
    expect(card.cardId).toBe(claudeSessionQuotaCardId("chat-1"));
    expect(card.variant).toBe(CLAUDE_SESSION_QUOTA_CARD_VARIANT);
    expect(card.state).toBe("live");
    expect(card.actions).toEqual([{
      id: CLAUDE_SESSION_QUOTA_CARD_ACTION,
      label: "Fork in this lane",
      kind: "primary",
    }]);
    expect(card.progress).toEqual({ passed: 0, failed: 82, running: 0, queued: 18 });
    expect(card.fallbackText).toContain("Send again after reset");
    expect(card.fallbackText).toContain("fork");
  });

  it("builds a terminal dismissed card without actions", () => {
    const card = buildClaudeSessionQuotaCard({
      sessionId: "chat-1",
      snapshot: { utilizationPct: 82, resetsAtMs: null },
      dismissed: true,
    });
    expect(card.state).toBe("terminal");
    expect(card.actions).toBeUndefined();
    expect(card.title).toBe("Claude session resumed");
  });

  it("reads utilization of 0.82 or 82 as a percent", () => {
    expect(utilizationToPercent(0.82)).toBe(82);
    expect(utilizationToPercent(82)).toBe(82);
    expect(utilizationToPercent(-1)).toBeNull();
  });

  it("extracts a reset time from quota text when the SDK omitted rate_limit_info", () => {
    const snapshot = snapshotFromClaudeSessionQuotaText(
      "You've hit your session limit · resets 7pm (America/New_York)",
      Date.parse("2026-08-17T21:10:00.000Z"),
    );
    expect(snapshot.resetsAtMs).not.toBeNull();
  });
});
