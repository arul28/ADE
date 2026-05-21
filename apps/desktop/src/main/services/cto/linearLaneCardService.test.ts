import { describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import {
  buildLinearLaneCardAttachment,
  buildLinearLaneInitialComment,
  publishLinearLaneCard,
} from "./linearLaneCardService";

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

  it("uses the cross-machine ADE deeplink when repo is known", () => {
    const attachment = buildLinearLaneCardAttachment({
      lane: makeLane(),
      issue: makeIssue(),
      projectRoot: "/Users/admin/Projects/ADE",
      linkedAt: "2026-05-12T20:05:00.000Z",
      repoOwner: "anthropics",
      repoName: "claude-code",
    });
    expect(attachment.url).toContain("https://ade.app/open?type=branch");
    expect(attachment.url).toContain("repo=anthropics%2Fclaude-code");
    expect(attachment.url).toContain("branch=abc-42-fix-flaky-sync-run");
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
    expect(body).toContain("https://ade.app/open?type=branch");
  });

  it("returns null comment when repo is unknown", () => {
    const body = buildLinearLaneInitialComment({
      lane: makeLane(),
      issue: makeIssue(),
    });
    expect(body).toBeNull();
  });

  it("posts the initial comment when requested and repo is known", async () => {
    const createIssueAttachment = vi.fn(async () => ({ id: "attachment-1", url: "https://ade.app/open?type=branch" }));
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
});
