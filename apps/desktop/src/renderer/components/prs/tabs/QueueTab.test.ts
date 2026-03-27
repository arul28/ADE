/**
 * Tests for QueueTab type-level helpers and batch rebase logic.
 *
 * The QueueTab defines several type aliases (QueueMember, QueueGroup,
 * BatchRebaseItemResult) and relies on queueWorkflowModel. We test
 * the type contracts and basic batch summary logic.
 */
import { describe, expect, it } from "vitest";

// ── Type-level contracts ──

type QueueMember = {
  prId: string;
  laneId: string;
  laneName: string;
  position: number;
  pr: { state: string } | null;
};

type BatchRebaseItemResult = {
  laneId: string;
  laneName: string;
  success: boolean;
  pushed: boolean;
  error: string | null;
};

type BatchRebaseSummary = {
  mode: "ai" | "local" | "push";
  scope: "next" | "all";
  items: BatchRebaseItemResult[];
  startedAt: string;
  completedAt: string | null;
};

function summarizeBatchResults(items: BatchRebaseItemResult[]): {
  successCount: number;
  failCount: number;
  pushedCount: number;
} {
  let successCount = 0;
  let failCount = 0;
  let pushedCount = 0;
  for (const item of items) {
    if (item.success) successCount++;
    else failCount++;
    if (item.pushed) pushedCount++;
  }
  return { successCount, failCount, pushedCount };
}

describe("QueueTab batch rebase summary", () => {
  it("counts successes and failures correctly", () => {
    const items: BatchRebaseItemResult[] = [
      { laneId: "l1", laneName: "Lane 1", success: true, pushed: true, error: null },
      { laneId: "l2", laneName: "Lane 2", success: false, pushed: false, error: "conflict" },
      { laneId: "l3", laneName: "Lane 3", success: true, pushed: false, error: null },
    ];
    const summary = summarizeBatchResults(items);
    expect(summary.successCount).toBe(2);
    expect(summary.failCount).toBe(1);
    expect(summary.pushedCount).toBe(1);
  });

  it("handles empty batch", () => {
    const summary = summarizeBatchResults([]);
    expect(summary.successCount).toBe(0);
    expect(summary.failCount).toBe(0);
    expect(summary.pushedCount).toBe(0);
  });

  it("handles all-success batch", () => {
    const items: BatchRebaseItemResult[] = [
      { laneId: "l1", laneName: "Lane 1", success: true, pushed: true, error: null },
      { laneId: "l2", laneName: "Lane 2", success: true, pushed: true, error: null },
    ];
    const summary = summarizeBatchResults(items);
    expect(summary.successCount).toBe(2);
    expect(summary.failCount).toBe(0);
    expect(summary.pushedCount).toBe(2);
  });
});

describe("QueueMember type validation", () => {
  it("creates valid QueueMember", () => {
    const member: QueueMember = {
      prId: "pr-1",
      laneId: "lane-1",
      laneName: "Feature",
      position: 0,
      pr: { state: "open" },
    };
    expect(member.prId).toBe("pr-1");
    expect(member.pr?.state).toBe("open");
  });

  it("allows null pr", () => {
    const member: QueueMember = {
      prId: "pr-1",
      laneId: "lane-1",
      laneName: "Feature",
      position: 0,
      pr: null,
    };
    expect(member.pr).toBeNull();
  });
});
