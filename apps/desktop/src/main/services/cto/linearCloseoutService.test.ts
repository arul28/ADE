import { describe, expect, it, vi } from "vitest";
import type {
  LinearWorkflowDefinition,
  LinearWorkflowRun,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { createLinearCloseoutService } from "./linearCloseoutService";

const issueFixture: NormalizedLinearIssue = {
  id: "issue-1",
  identifier: "ADE-12",
  title: "Harden automation closeout",
  description: "Proof artifacts should publish cleanly into Linear closeout.",
  url: "https://linear.app/acme/issue/ADE-12",
  projectId: "proj-1",
  projectSlug: "acme-platform",
  teamId: "team-1",
  teamKey: "ACME",
  stateId: "state-todo",
  stateName: "Todo",
  stateType: "unstarted",
  priority: 2,
  priorityLabel: "high",
  labels: ["automation"],
  assigneeId: null,
  assigneeName: null,
  ownerId: "owner-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

const workflowFixture: LinearWorkflowDefinition = {
  id: "flow-1",
  name: "Automation hardening",
  enabled: true,
  priority: 100,
  triggers: { projectSlugs: ["acme-platform"] },
  target: { type: "mission" },
  steps: [],
  closeout: {
    successState: "done",
    failureState: "blocked",
    successComment: "Closeout applied.",
    applyLabels: ["ade"],
    artifactMode: "links",
  },
};

const runFixture: LinearWorkflowRun = {
  id: "run-1",
  issueId: issueFixture.id,
  identifier: issueFixture.identifier,
  title: issueFixture.title,
  workflowId: workflowFixture.id,
  workflowName: workflowFixture.name,
  workflowVersion: "2026-03-12T00:00:00.000Z",
  source: "repo",
  targetType: "mission",
  status: "in_progress",
  currentStepIndex: 0,
  currentStepId: null,
  linkedMissionId: "mission-1",
  linkedSessionId: null,
  linkedWorkerRunId: null,
  linkedPrId: null,
  reviewState: null,
  retryCount: 0,
  retryAfter: null,
  closeoutState: "pending",
  terminalOutcome: null,
  sourceIssueSnapshot: issueFixture,
  lastError: null,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
};

describe("linearCloseoutService", () => {
  it("merges mission and orchestrator proof artifacts into Linear closeout payload", async () => {
    const publishMissionCloseout = vi.fn(async () => {});
    const issueTracker = {
      fetchWorkflowStates: vi.fn(async () => [
        { id: "state-done", name: "Done", type: "completed" },
        { id: "state-blocked", name: "Blocked", type: "started" },
      ]),
      updateIssueState: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      createComment: vi.fn(async () => ({ commentId: "comment-1" })),
    };

    const service = createLinearCloseoutService({
      issueTracker: issueTracker as any,
      outboundService: {
        publishMissionCloseout,
      } as any,
      missionService: {
        get: vi.fn(() => ({
          id: "mission-1",
          artifacts: [
            { id: "art-1", artifactType: "pr", uri: "https://github.com/acme/repo/pull/42" },
            { id: "art-2", artifactType: "note", uri: "https://example.com/mission-note" },
          ],
        })),
      } as any,
      orchestratorService: {
        getArtifactsForMission: vi.fn(() => [
          {
            id: "orch-1",
            kind: "screenshot",
            value: ".ade/artifacts/computer-use/shot.png",
            metadata: {},
          },
          {
            id: "orch-2",
            kind: "pr",
            value: "https://github.com/acme/repo/pull/43",
            metadata: {},
          },
          {
            id: "orch-3",
            kind: "file",
            value: "",
            metadata: { uri: "https://example.com/browser-trace.zip" },
          },
        ]),
      } as any,
    });

    await service.applyOutcome({
      run: runFixture,
      workflow: workflowFixture,
      issue: issueFixture,
      outcome: "completed",
      summary: "Validation evidence captured and closeout completed.",
    });

    expect(issueTracker.updateIssueState).toHaveBeenCalledWith(issueFixture.id, "state-done");
    expect(issueTracker.addLabel).toHaveBeenCalledWith(issueFixture.id, "ade");
    expect(issueTracker.createComment).toHaveBeenCalledWith(issueFixture.id, "Closeout applied.");
    expect(publishMissionCloseout).toHaveBeenCalledWith({
      issue: issueFixture,
      missionId: "mission-1",
      status: "completed",
      summary: "Validation evidence captured and closeout completed.",
      prLinks: [
        "https://github.com/acme/repo/pull/42",
        "https://github.com/acme/repo/pull/43",
      ],
      artifactPaths: [
        "https://github.com/acme/repo/pull/42",
        "https://example.com/mission-note",
        ".ade/artifacts/computer-use/shot.png",
        "https://github.com/acme/repo/pull/43",
        "https://example.com/browser-trace.zip",
      ],
      artifactMode: "links",
    });
  });
});
