import { describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue } from "../../../shared/types";
import type { IssueTracker } from "./issueTracker";
import { createLinearLiveStatusService, isLinearLiveStatusRoundTripEnabled } from "./linearLiveStatusService";

function makeIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Fix OAuth",
    url: null,
    projectId: "proj-1",
    projectSlug: "eng",
    teamId: "team-1",
    teamKey: "ENG",
    stateId: "state-backlog",
    stateName: "Backlog",
    stateType: "backlog",
    priority: 0,
    priorityLabel: "No priority",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    branchName: "eng-1-fix-oauth",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  } as LaneLinearIssue;
}

function makeTracker(overrides: Partial<IssueTracker> = {}): IssueTracker {
  return {
    listWorkflowStates: vi.fn(async () => [
      { id: "state-progress", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ENG" },
      { id: "state-done", name: "Done", type: "completed", teamId: "team-1", teamKey: "ENG" },
    ]),
    updateIssueState: vi.fn(async () => {}),
    updateIssueAssignee: vi.fn(async () => {}),
    createComment: vi.fn(async () => ({ commentId: "c1" })),
    getConnectionStatus: vi.fn(async () => ({
      connected: true,
      viewerId: "viewer-1",
      viewerName: "Me",
      message: null,
    })),
    ...overrides,
  } as unknown as IssueTracker;
}

describe("isLinearLiveStatusRoundTripEnabled", () => {
  it("is off unless the flag is exactly '1'", () => {
    expect(isLinearLiveStatusRoundTripEnabled({})).toBe(false);
    expect(isLinearLiveStatusRoundTripEnabled({ ADE_LINEAR_LIVE_STATUS_ROUNDTRIP: "0" })).toBe(false);
    expect(isLinearLiveStatusRoundTripEnabled({ ADE_LINEAR_LIVE_STATUS_ROUNDTRIP: "1" })).toBe(true);
  });
});

describe("createLinearLiveStatusService", () => {
  it("is a no-op when disabled", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: false });
    await service.onAgentLaunched({ issue: makeIssue() });
    await service.onPrOpened({ issueIds: ["issue-1"], prNumber: 7, githubUrl: "https://x/pr/7" });
    await service.onIssueMerged({ issues: [{ id: "issue-1", teamKey: "ENG" }] });
    expect(tracker.updateIssueState).not.toHaveBeenCalled();
    expect(tracker.createComment).not.toHaveBeenCalled();
    expect(tracker.updateIssueAssignee).not.toHaveBeenCalled();
  });

  it("moves to In Progress, self-assigns, and comments the branch on launch", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeIssue(), laneName: "ade/eng-1" });
    expect(tracker.updateIssueState).toHaveBeenCalledWith("issue-1", "state-progress");
    expect(tracker.updateIssueAssignee).toHaveBeenCalledWith("issue-1", "viewer-1");
    expect(tracker.createComment).toHaveBeenCalledTimes(1);
    expect((tracker.createComment as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("eng-1-fix-oauth");
  });

  it("does not re-move an issue already in the In Progress state", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeIssue({ stateId: "state-progress" }) });
    expect(tracker.updateIssueState).not.toHaveBeenCalled();
  });

  it("only transitions an issue to In Progress once across launches", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeIssue() });
    await service.onAgentLaunched({ issue: makeIssue() });
    expect(tracker.updateIssueState).toHaveBeenCalledTimes(1);
  });

  it("comments the PR link on PR open", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onPrOpened({ issueIds: ["issue-1", "issue-1", ""], prNumber: 42, githubUrl: "https://gh/pr/42" });
    // Deduped + empties dropped → single comment.
    expect(tracker.createComment).toHaveBeenCalledTimes(1);
    expect((tracker.createComment as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("https://gh/pr/42");
  });

  it("moves to Done on merge", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onIssueMerged({ issues: [{ id: "issue-1", teamKey: "ENG", stateId: "state-progress" }] });
    expect(tracker.updateIssueState).toHaveBeenCalledWith("issue-1", "state-done");
  });
});
