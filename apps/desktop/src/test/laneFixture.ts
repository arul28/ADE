/**
 * A typed `LaneSummary` (and its Linear issue) for suites that need a lane to
 * hand a component.
 *
 * The point of the builder is what it refuses. A lane literal written inline
 * has to spell out every required field to typecheck, so suites reached for
 * `as unknown as LaneSummary` instead — and a cast is a promise the compiler
 * stops checking: a field renamed on `LaneSummary`, or a shape that tightened
 * from `string | null` to `string`, keeps compiling in every casted literal and
 * only shows up as a test asserting against a lane the product can never
 * produce. Here the defaults are checked once, and `overrides` is a
 * `Partial<LaneSummary>`, so the same rename is a compile error in every suite
 * that names the field and silent in every suite that does not care about it.
 *
 * Defaults describe the ordinary case — a clean worktree lane, no issue linked.
 * A suite that needs a linked lane asks for one, because the link is the thing
 * such a suite is about and it should be visible in the test rather than
 * inherited from here.
 */

import type { LaneLinearIssue, LaneSummary } from "../shared/types";

export function laneLinearIssueFixture(
  overrides: Partial<LaneLinearIssue> = {},
): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Copy the issue link",
    description: null,
    url: "https://linear.app/ade/issue/ADE-123/copy-the-issue-link",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: null,
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: null,
    creatorName: null,
    dueDate: null,
    estimate: null,
    branchName: "ade-123",
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

export function laneFixture(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Lane One",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/ade-123",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}
