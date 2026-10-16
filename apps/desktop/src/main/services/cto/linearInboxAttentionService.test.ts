import { describe, expect, it, vi } from "vitest";
import { createLinearInboxAttentionService } from "./linearInboxAttentionService";
import type { LaneSummary, LinearInboxNotification } from "../../../shared/types";

function notification(args: Partial<LinearInboxNotification> & Pick<LinearInboxNotification, "id" | "createdAt">): LinearInboxNotification {
  return {
    type: "issueMention",
    readAt: null,
    snoozedUntilAt: null,
    actorName: "Ada",
    actorAvatarUrl: null,
    issueId: "issue-1",
    issueIdentifier: "ADE-123",
    issueTitle: "Agent inbox",
    issueUrl: null,
    issueStateName: "Todo",
    issueStateType: "unstarted",
    commentId: null,
    commentBody: null,
    ...args,
  };
}

describe("Linear inbox attention", () => {
  it("uses the first poll as a watermark, then raises only fresh attention for a linked lane", async () => {
    let watermark: string | null = null;
    let notifications = [
      notification({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
      notification({ id: "new", createdAt: "2026-09-02T00:00:00.000Z", commentBody: "Please review this" }),
    ];
    const requestAttention = vi.fn();
    const service = createLinearInboxAttentionService({
      logger: { warn: vi.fn() } as never,
      kv: {
        getJson: <T>() => watermark as T | null,
        setJson: (_key, value) => { watermark = value as string; },
      },
      isLinearConnected: () => true,
      listNotifications: async () => notifications,
      listLanes: async () => [{
        id: "lane-1",
        linearIssue: { id: "issue-1" } as NonNullable<LaneSummary["linearIssue"]>,
        linearIssueLinks: [],
      }],
      latestSessionInLane: (laneId) => laneId === "lane-1" ? "session-1" : null,
      requestAttention,
    });

    await service.pollNow();
    expect(requestAttention).not.toHaveBeenCalled();
    expect(watermark).toBe("2026-09-02T00:00:00.000Z");

    notifications = [
      ...notifications,
      notification({ id: "unlinked", issueId: "issue-other", createdAt: "2026-09-03T00:00:00.000Z" }),
      notification({ id: "linked", createdAt: "2026-09-04T00:00:00.000Z", commentBody: "  Please\nreview this  " }),
    ];
    await service.pollNow();

    expect(requestAttention).toHaveBeenCalledTimes(1);
    expect(requestAttention).toHaveBeenCalledWith(
      "session-1",
      "Ada mentioned you on ADE-123 in Linear: “ Please review this ”",
    );
    expect(watermark).toBe("2026-09-04T00:00:00.000Z");
    service.stop();
  });
});
