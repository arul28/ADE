import { describe, expect, it } from "vitest";
import { buildPrsRouteSearch, parsePrsRouteState, resolvePrsActiveTab } from "./prsRouteState";

describe("prsRouteState", () => {
  it("parses route state from search params and falls back to hash params when needed", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-123&laneId=lane-search",
        hash: "#/prs?tab=workflows&workflow=queue&queueGroupId=group-hash",
      }),
    ).toEqual({
      tab: "normal",
      workflowTab: "queue",
      laneId: "lane-search",
      prId: "pr-123",
      queueGroupId: "group-hash",
      eventId: null,
      threadId: null,
      commitSha: null,
    });
  });

  it("reads route state from hash query strings when search params are absent", () => {
    expect(
      parsePrsRouteState({
        search: "",
        hash: "#/prs?tab=workflows&workflow=rebase&laneId=lane-456&prId=pr-789&queueGroupId=group-1",
      }),
    ).toEqual({
      tab: "workflows",
      workflowTab: "rebase",
      laneId: "lane-456",
      prId: "pr-789",
      queueGroupId: "group-1",
      eventId: null,
      threadId: null,
      commitSha: null,
    });
  });

  it("parses deep-link event, thread, and commit params", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-1&eventId=evt-99&threadId=thr-12&commitSha=abc123",
      }),
    ).toEqual({
      tab: "normal",
      workflowTab: null,
      laneId: null,
      prId: "pr-1",
      queueGroupId: null,
      eventId: "evt-99",
      threadId: "thr-12",
      commitSha: "abc123",
    });
  });

  it("builds search with deep-link params", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-1",
        selectedQueueGroupId: null,
        selectedRebaseItemId: null,
        eventId: "evt-5",
        threadId: "thr-3",
        commitSha: "abc",
      }),
    ).toBe("?tab=normal&prId=pr-1&eventId=evt-5&threadId=thr-3&commitSha=abc");
  });

  it("builds normal and workflow route searches with the expected ids", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-ignored",
        selectedRebaseItemId: "lane-ignored",
      }),
    ).toBe("?tab=normal&prId=pr-123");

    expect(
      buildPrsRouteSearch({
        activeTab: "queue",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-456",
        selectedRebaseItemId: "lane-ignored",
      }),
    ).toBe("?tab=workflows&workflow=queue&queueGroupId=group-456");

    expect(
      buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-ignored",
        selectedRebaseItemId: "lane-456",
      }),
    ).toBe("?tab=workflows&workflow=rebase&laneId=lane-456");
  });
});

describe("resolvePrsActiveTab", () => {
  it("routes a stale tab=normal + hash workflow=rebase to the rebase workflow", () => {
    const parsed = parsePrsRouteState({
      search: "?tab=normal",
      hash: "#/prs?tab=workflows&workflow=rebase&laneId=lane-1",
    });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBe("rebase");
    expect(resolved.activeTab).toBe("rebase");
  });

  it("falls back to integration when tab=workflows has no workflow param", () => {
    const parsed = parsePrsRouteState({ search: "?tab=workflows" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBeNull();
    expect(resolved.activeTab).toBe("integration");
  });

  it("treats a workflow-alias tab (tab=queue) as a workflow route", () => {
    const parsed = parsePrsRouteState({ search: "?tab=queue&queueGroupId=g-1" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(true);
    expect(resolved.effectiveWorkflow).toBe("queue");
    expect(resolved.activeTab).toBe("queue");
  });

  it("keeps tab=normal on the normal tab when no workflow signal is present", () => {
    const parsed = parsePrsRouteState({ search: "?tab=normal&prId=pr-1" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });

  it("returns normal when the route has no tab or workflow signal", () => {
    const parsed = parsePrsRouteState({ search: "" });
    const resolved = resolvePrsActiveTab(parsed);
    expect(resolved.isWorkflowRoute).toBe(false);
    expect(resolved.activeTab).toBe("normal");
  });
});
