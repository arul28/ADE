import { describe, expect, it } from "vitest";
import {
  ATTENTION_CONTRACT_VERSION,
  attentionDestinationDeepLink,
  attentionItemNeedsInbox,
  sanitizeAttentionPreview,
  sortAttentionItems,
  type AttentionItem,
} from "./attention";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id: "agent:one",
    revision: 1,
    fingerprint: "one",
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    machine: { machineKey: "machine", name: "Studio Mac", online: true, lastSeenAt: null },
    project: { projectId: "project", name: "ADE" },
    title: "Fix auth",
    preview: "Approve the command",
    privacyPreview: "Agent needs attention",
    destination: { kind: "session", sessionId: "session" },
    actions: [],
    occurredAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("attention contract helpers", () => {
  it("prioritizes needs-you and failures before running and completed work", () => {
    expect(
      sortAttentionItems([
        item({ id: "done", phase: "completed", eventKind: "agent_completed" }),
        item({ id: "running", phase: "running" }),
        item({ id: "failed", phase: "failed", eventKind: "agent_failed" }),
        item({ id: "needs", phase: "needs_you" }),
      ]).map((entry) => entry.id),
    ).toEqual(["needs", "failed", "running", "done"]);
  });

  it("keeps unseen outcomes in Inbox and respects dismissal", () => {
    expect(attentionItemNeedsInbox(item({ phase: "completed", eventKind: "agent_completed" }))).toBe(true);
    expect(attentionItemNeedsInbox(item({
      phase: "completed",
      eventKind: "agent_completed",
      seenAt: "2026-07-28T10:05:00.000Z",
    }))).toBe(false);
    expect(attentionItemNeedsInbox(item({ dismissedAt: "2026-07-28T10:05:00.000Z" }))).toBe(false);
  });

  it("builds exact session and PR deep links", () => {
    expect(attentionDestinationDeepLink({
      kind: "session",
      sessionId: "session one",
      itemId: "approval-1",
    })).toBe("ade://session/session%20one?item=approval-1");
    expect(attentionDestinationDeepLink({
      kind: "pull_request",
      repoOwner: "open ai",
      repoName: "ade",
      number: 42,
      tab: "checks",
    })).toBe("ade://pr/open%20ai/ade/42?tab=checks");
  });

  it("sanitizes common secret shapes and bounds lock-screen copy", () => {
    const preview = sanitizeAttentionPreview(
      "Use Bearer abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz123456 for the request",
      64,
    );
    expect(preview).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(preview.length).toBeLessThanOrEqual(64);
  });
});
