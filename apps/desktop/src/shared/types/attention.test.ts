import { describe, expect, it, vi } from "vitest";
import {
  ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT,
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  activityItemIsAmbient,
  activityItemTier,
  attentionDestinationDeepLink,
  attentionItemNeedsInbox,
  runAcknowledgmentChunks,
  sanitizeAttentionPreview,
  sortAttentionItems,
  unreachedOutcomeFields,
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

  it("keeps idle roster rows out of Inbox and derives legacy tiers by phase", () => {
    const idleOutcome = item({
      phase: "completed",
      eventKind: "agent_completed",
      activityTier: "idle",
    });
    expect(attentionItemNeedsInbox(idleOutcome)).toBe(false);
    expect(activityItemTier(idleOutcome)).toBe("idle");
    expect(activityItemIsAmbient(idleOutcome)).toBe(true);
    expect(activityItemTier(item({ phase: "needs_you" }))).toBe("signal");
    expect(activityItemTier(item({ phase: "running", eventKind: "agent_running" }))).toBe("ambient");
  });

  it("defaults machine overrides empty and the dock badge to this Mac", () => {
    expect(DEFAULT_ATTENTION_PREFERENCES.machines).toEqual({});
    expect(DEFAULT_ATTENTION_PREFERENCES.account.dockBadgeScope).toBe("local");
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
    expect(attentionDestinationDeepLink(
      {
        kind: "session",
        sessionId: "remote-session",
      },
      item({
        machine: {
          machineKey: "runtime-target",
          accountMachineKey: "account-machine-key",
          name: "Studio Mac",
          online: true,
          lastSeenAt: null,
        },
        project: { projectId: "remote-project", name: "ADE" },
      }),
    )).toBe(
      "ade://session/remote-session?accountMachineKey=account-machine-key&projectId=remote-project",
    );
  });

  it("never stamps the project's absolute root into a shareable link", () => {
    // ADE links get pasted into PR descriptions, Linear issues and Slack; a
    // `projectRoot=` parameter would hand every reader the local username and
    // directory layout. The canonical id IS the hash of that path, so the
    // receiver still resolves it.
    const ownership = item({
      machine: {
        machineKey: "runtime-target",
        accountMachineKey: "account-machine-key",
        name: "Studio Mac",
        online: true,
        lastSeenAt: null,
      },
      project: {
        projectId: "0b3d2f61-9a44-4a1c-9c65-6a4e0a3f9a11",
        canonicalId: "project_9f2c1b7a4e",
        name: "ADE",
        rootPath: "/Users/arul/Projects/ClientWork/acme-secret",
      },
    });
    for (const link of [
      attentionDestinationDeepLink({ kind: "session", sessionId: "s1" }, ownership),
      attentionDestinationDeepLink(
        { kind: "pull_request", number: 42, tab: "overview" },
        ownership,
      ),
    ]) {
      expect(link).not.toContain("projectRoot");
      expect(link).not.toContain("acme-secret");
      expect(link).not.toContain("arul");
      // The machine-independent id is what replaces it.
      expect(link).toContain("projectId=project_9f2c1b7a4e");
    }
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

describe("runAcknowledgmentChunks", () => {
  const ids = (count: number, prefix = "item") =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

  it("keeps the three lists disjoint and totalling every id the caller sent", async () => {
    // Three chunks: the first partly refused, the second wholly accepted, the
    // third never reached because the second-to-last throw aborts the loop.
    const itemIds = ids(ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT * 3);
    let call = 0;
    const outcome = await runAcknowledgmentChunks(itemIds, async (chunk) => {
      call += 1;
      if (call === 1) return [chunk[0], chunk[1]];
      if (call === 2) return [];
      throw new Error("relay 503");
    });

    expect(outcome.failure).toBeInstanceOf(Error);
    expect(outcome.stale).toEqual([itemIds[0], itemIds[1]]);
    expect(outcome.unreached).toEqual(itemIds.slice(ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT * 2));
    // Disjoint, and together exactly the input — in the caller's order.
    const all = [...outcome.acknowledged, ...outcome.stale, ...outcome.unreached];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...itemIds].sort());
  });

  it("aborts on the first failing chunk instead of pushing the rest at a failing host", async () => {
    const itemIds = ids(ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT * 3);
    const send = vi.fn(async () => {
      throw new Error("auth expired");
    });
    const outcome = await runAcknowledgmentChunks(itemIds, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.acknowledged).toEqual([]);
    expect(outcome.stale).toEqual([]);
    expect(outcome.unreached).toEqual(itemIds);
  });

  it("ignores stale ids the host names outside the chunk it was sent", async () => {
    const itemIds = ids(3);
    const outcome = await runAcknowledgmentChunks(itemIds, async () => ["item-9"]);

    expect(outcome.stale).toEqual([]);
    expect(outcome.acknowledged).toEqual(itemIds);
    expect(outcome.unreached).toEqual([]);
    expect(unreachedOutcomeFields(outcome.unreached, outcome.failure)).toEqual({});
  });
});
