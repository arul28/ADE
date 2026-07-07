import { describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import {
  buildLinearLaneCardAttachment,
  buildLinearLaneInitialComment,
  buildLinearChatSessionAttachment,
  buildLinearIssueQuickViewAttachment,
  buildLinearPrCardAttachment,
  createLinearChatLinkPublisher,
  publishLinearChatSessionCard,
  publishLinearIssueQuickViewAttachment,
  publishLinearLaneCard,
  publishLinearPrCard,
} from "./linearLaneCardService";
import type { IssueTracker } from "./issueTracker";
import { createLinearLiveStatusService, isLinearLiveStatusRoundTripEnabled } from "./linearLiveStatusService";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "ABC-42 Fix flaky sync run",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "abc-42-fix-flaky-sync-run",
    worktreePath: "/tmp/worktrees/abc-42-fix-flaky-sync-run",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-12T20:00:00.000Z",
    archivedAt: null,
    linearIssue: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ABC-42",
    title: "Fix flaky sync run",
    description: "Occasional sync failure under load.",
    url: "https://linear.app/acme/issue/ABC-42/fix-flaky-sync-run",
    projectId: "project-1",
    projectSlug: "acme-platform",
    projectName: "Acme Platform",
    teamId: "team-1",
    teamKey: "ABC",
    teamName: "Platform",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug", "sync"],
    assigneeId: "user-1",
    assigneeName: "Taylor",
    creatorId: "creator-1",
    creatorName: "Alex",
    dueDate: null,
    estimate: null,
    branchName: "abc-42-fix-flaky-sync-run",
    createdAt: "2026-05-11T20:00:00.000Z",
    updatedAt: "2026-05-12T19:00:00.000Z",
    ...overrides,
  };
}

describe("linearLaneCardService", () => {
  it("builds a stable Linear issue attachment for an ADE lane", () => {
    const attachment = buildLinearLaneCardAttachment({
      lane: makeLane(),
      issue: makeIssue(),
      projectRoot: "/Users/admin/Projects/ADE",
      linkedAt: "2026-05-12T20:05:00.000Z",
    });

    expect(attachment).toMatchObject({
      issueId: "issue-1",
      title: "ADE lane: ABC-42 Fix flaky sync run",
      subtitle: "abc-42-fix-flaky-sync-run - linked {linkedAt__since}",
      url: "https://linear.app/acme/issue/ABC-42/fix-flaky-sync-run#ade-lane-lane-1",
    });
    expect(attachment.metadata).toMatchObject({
      title: "ADE lane linked to ABC-42",
      laneId: "lane-1",
      laneName: "ABC-42 Fix flaky sync run",
      branch: "abc-42-fix-flaky-sync-run",
      baseRef: "main",
      projectName: "ADE",
      linkedAt: "2026-05-12T20:05:00.000Z",
    });
    expect(attachment.metadata?.attributes).toContainEqual({ name: "Linear team", value: "Platform" });
    expect(attachment.metadata?.messages?.[0]?.body).toContain("ADE uses this lane link");
  });

  it("keeps truncated title and subtitle within Linear attachment limits", () => {
    const attachment = buildLinearLaneCardAttachment({
      lane: makeLane({ name: "A".repeat(120) }),
      issue: makeIssue({ branchName: "b".repeat(120) }),
      projectRoot: "/Users/admin/Projects/ADE",
    });

    expect(attachment.title.length).toBeLessThanOrEqual("ADE lane: ".length + 64);
    expect((attachment.subtitle ?? "").split(" - linked ")[0]?.length).toBeLessThanOrEqual(56);
  });

  it("publishes the card through the issue tracker", async () => {
    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-1", url: "https://linear.app/acme/issue/ABC-42#ade-lane-lane-1" }));
    const result = await publishLinearLaneCard({
      issueTracker: { createIssueAttachment } as any,
      lane: makeLane(),
      issue: makeIssue(),
      projectRoot: "/Users/admin/Projects/ADE",
    });

    expect(result.id).toBe("attachment-1");
    expect(createIssueAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      title: "ADE lane: ABC-42 Fix flaky sync run",
    }));
  });

  it("uses a lane deeplink with a portable envelope when repo is known", () => {
    const attachment = buildLinearLaneCardAttachment({
      lane: makeLane(),
      issue: makeIssue(),
      projectRoot: "/Users/admin/Projects/ADE",
      linkedAt: "2026-05-12T20:05:00.000Z",
      repoOwner: "anthropics",
      repoName: "claude-code",
      prNumber: 42,
    });
    expect(attachment.url).toContain("https://ade-app.dev/open?type=lane");
    expect(attachment.url).toContain("id=lane-1");
    expect(attachment.url).toContain("repo=anthropics%2Fclaude-code");
    expect(attachment.url).toContain("branch=abc-42-fix-flaky-sync-run");
    expect(attachment.url).toContain("pr=42");
    expect(attachment.title).toBe("Open in ADE: ABC-42 Fix flaky sync run");
  });

  it("builds an initial comment with the deeplink", () => {
    const body = buildLinearLaneInitialComment({
      lane: makeLane(),
      issue: makeIssue(),
      repoOwner: "anthropics",
      repoName: "claude-code",
    });
    expect(body).toContain("Open in ADE");
    expect(body).toContain("https://ade-app.dev/open?type=lane");
    expect(body).toContain("repo=anthropics%2Fclaude-code");
  });

  it("builds and publishes an ADE Linear-pane attachment", async () => {
    const attachment = buildLinearIssueQuickViewAttachment({
      issue: makeIssue(),
      branch: "abc-42-fix-flaky-sync-run",
      linkedAt: "2026-05-12T20:10:00.000Z",
    });

    expect(attachment).toMatchObject({
      issueId: "issue-1",
      title: "Open in ADE: ABC-42",
      url: "https://ade-app.dev/open?type=linear-issue&issue=ABC-42&branch=abc-42-fix-flaky-sync-run",
    });
    expect(attachment.metadata?.attributes).toContainEqual({ name: "ADE view", value: "Linear pane" });

    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-issue", url: attachment.url }));
    await publishLinearIssueQuickViewAttachment({
      issueTracker: { createIssueAttachment } as any,
      issue: makeIssue(),
      branch: "abc-42-fix-flaky-sync-run",
      linkedAt: "2026-05-12T20:10:00.000Z",
    });
    expect(createIssueAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      title: "Open in ADE: ABC-42",
      url: "https://ade-app.dev/open?type=linear-issue&issue=ABC-42&branch=abc-42-fix-flaky-sync-run",
    }));
  });

  it("builds and publishes an ADE chat session attachment", async () => {
    const attachment = buildLinearChatSessionAttachment({
      issue: makeIssue(),
      laneId: "lane-1",
      sessionId: "session-1",
      sessionTitle: "Investigate sync flakes",
      linkedAt: "2026-05-12T20:15:00.000Z",
    });

    expect(attachment).toMatchObject({
      issueId: "issue-1",
      title: "Open ADE chat: ABC-42",
      url: "ade://session/session-1?lane=lane-1",
    });
    expect(attachment.metadata?.attributes).toContainEqual({ name: "ADE view", value: "Work chat" });

    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-chat", url: attachment.url }));
    await publishLinearChatSessionCard({
      issueTracker: { createIssueAttachment } as any,
      issue: makeIssue(),
      laneId: "lane-1",
      sessionId: "session-1",
      sessionTitle: "Investigate sync flakes",
      linkedAt: "2026-05-12T20:15:00.000Z",
    });
    expect(createIssueAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      title: "Open ADE chat: ABC-42",
      url: "ade://session/session-1?lane=lane-1",
    }));
  });

  it("attaches repo, branch, and PR envelope to chat session links when provided", () => {
    const attachment = buildLinearChatSessionAttachment({
      issue: makeIssue(),
      laneId: "lane-1",
      sessionId: "session-1",
      sessionTitle: "Investigate sync flakes",
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "abc-42-fix-flaky-sync-run",
      prNumber: 42,
    });

    expect(attachment.url).toContain("ade://session/session-1?");
    expect(attachment.url).toContain("repo=anthropics%2Fclaude-code");
    expect(attachment.url).toContain("branch=abc-42-fix-flaky-sync-run");
    expect(attachment.url).toContain("pr=42");
    expect(attachment.url).not.toContain("linear=");
  });

  it("dedupes chat session card publishing per issue and session", async () => {
    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-chat", url: "ade://session/session-1?lane=lane-1" }));
    const publisher = createLinearChatLinkPublisher({
      getIssueTracker: () => ({ createIssueAttachment } as any),
    });

    const args = {
      issue: makeIssue(),
      laneId: "lane-1",
      sessionId: "session-1",
      sessionTitle: "Investigate sync flakes",
      linkedAt: "2026-05-12T20:15:00.000Z",
    };
    publisher(args);
    publisher(args);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createIssueAttachment).toHaveBeenCalledTimes(1);
  });

  it("returns null comment when repo is unknown", () => {
    const body = buildLinearLaneInitialComment({
      lane: makeLane(),
      issue: makeIssue(),
    });
    expect(body).toBeNull();
  });

  it("posts the initial comment when requested and repo is known", async () => {
    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-1", url: "https://ade-app.dev/open?type=branch" }));
    const createComment = vi.fn(async () => ({}));
    await publishLinearLaneCard({
      issueTracker: { createIssueAttachment, createComment } as any,
      lane: makeLane(),
      issue: makeIssue(),
      projectRoot: "/Users/admin/Projects/ADE",
      repoOwner: "a",
      repoName: "b",
      postInitialComment: true,
    });
    expect(createComment).toHaveBeenCalledWith("issue-1", expect.stringContaining("Open in ADE"));
  });

  it("builds and publishes a Linear attachment for an ADE PR", async () => {
    const attachment = buildLinearPrCardAttachment({
      lane: makeLane(),
      issue: makeIssue(),
      repoOwner: "acme",
      repoName: "ade",
      prNumber: 42,
      githubUrl: "https://github.com/acme/ade/pull/42",
      linkedAt: "2026-05-12T21:00:00.000Z",
    });

    expect(attachment).toMatchObject({
      issueId: "issue-1",
      title: "Open in ADE PR #42: ABC-42",
      url: "https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42",
    });
    expect(attachment.metadata?.attributes).toContainEqual({ name: "GitHub PR", value: "acme/ade#42" });
    expect(attachment.metadata?.attributes).toContainEqual(expect.objectContaining({ name: "ADE lane" }));
    expect(attachment.metadata?.messages?.[0]?.body).toContain("GitHub PR acme/ade#42");

    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-2", url: attachment.url }));
    await publishLinearPrCard({
      issueTracker: { createIssueAttachment } as any,
      lane: makeLane(),
      issue: makeIssue(),
      repoOwner: "acme",
      repoName: "ade",
      prNumber: 42,
      githubUrl: "https://github.com/acme/ade/pull/42",
    });
    expect(createIssueAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      title: "Open in ADE PR #42: ABC-42",
    }));
  });
});


function makeLiveStatusIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
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
    await service.onAgentLaunched({ issue: makeLiveStatusIssue() });
    await service.onPrOpened({ issueIds: ["issue-1"], prNumber: 7, githubUrl: "https://x/pr/7" });
    await service.onIssueMerged({ issues: [{ id: "issue-1", teamKey: "ENG" }] });
    expect(tracker.updateIssueState).not.toHaveBeenCalled();
    expect(tracker.createComment).not.toHaveBeenCalled();
    expect(tracker.updateIssueAssignee).not.toHaveBeenCalled();
  });

  it("moves to In Progress, self-assigns, and comments the branch on launch", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeLiveStatusIssue(), laneName: "ade/eng-1" });
    expect(tracker.updateIssueState).toHaveBeenCalledWith("issue-1", "state-progress");
    expect(tracker.updateIssueAssignee).toHaveBeenCalledWith("issue-1", "viewer-1");
    expect(tracker.createComment).toHaveBeenCalledTimes(1);
    expect((tracker.createComment as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("eng-1-fix-oauth");
  });

  it("does not re-move an issue already in the In Progress state", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeLiveStatusIssue({ stateId: "state-progress" }) });
    expect(tracker.updateIssueState).not.toHaveBeenCalled();
  });

  it("only transitions an issue to In Progress once across launches", async () => {
    const tracker = makeTracker();
    const service = createLinearLiveStatusService({ getIssueTracker: () => tracker, enabled: true });
    await service.onAgentLaunched({ issue: makeLiveStatusIssue() });
    await service.onAgentLaunched({ issue: makeLiveStatusIssue() });
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
