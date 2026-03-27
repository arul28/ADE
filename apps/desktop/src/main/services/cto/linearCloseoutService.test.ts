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

const sessionWorkflowFixture: LinearWorkflowDefinition = {
  ...workflowFixture,
  id: "flow-session",
  name: "Session closeout",
  target: { type: "employee_session" },
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
  executionLaneId: null,
  linkedMissionId: "mission-1",
  linkedSessionId: null,
  linkedWorkerRunId: null,
  linkedPrId: null,
  reviewState: null,
  supervisorIdentityKey: null,
  reviewReadyReason: null,
  prState: null,
  prChecksStatus: null,
  prReviewStatus: null,
  latestReviewNote: null,
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
      prService: {
        listAll: vi.fn(() => []),
        getForLane: vi.fn(() => null),
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: vi.fn(() => []),
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
    expect(publishMissionCloseout).toHaveBeenCalledWith(expect.objectContaining({
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
      commentTemplate: null,
    }));
  });

  it("publishes non-mission PR links and broker artifacts to the generic Linear closeout", async () => {
    const publishWorkflowCloseout = vi.fn(async () => {});
    const service = createLinearCloseoutService({
      issueTracker: {
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      outboundService: {
        publishMissionCloseout: vi.fn(async () => {}),
        publishWorkflowCloseout,
      } as any,
      missionService: {
        get: vi.fn(() => null),
      } as any,
      orchestratorService: {
        getArtifactsForMission: vi.fn(() => []),
      } as any,
      prService: {
        listAll: vi.fn(() => [{ id: "pr-99", githubUrl: "https://github.com/acme/repo/pull/99" }]),
        getForLane: vi.fn(() => null),
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: vi.fn(({ owner }: { owner: { kind: string; id: string } }) => {
          if (owner.kind === "chat_session") {
            return [{ id: "artifact-1", kind: "browser_trace", uri: ".ade/artifacts/chat-trace.zip" }];
          }
          if (owner.kind === "lane") {
            return [{ id: "artifact-2", kind: "screenshot", uri: "https://example.com/lane-proof.png" }];
          }
          if (owner.kind === "github_pr") {
            return [{ id: "artifact-3", kind: "browser_verification", uri: "https://example.com/pr-proof.json" }];
          }
          return [];
        }),
      } as any,
    });

    await service.applyOutcome({
      run: {
        ...runFixture,
        targetType: "employee_session",
        linkedMissionId: null,
        linkedSessionId: "session-1",
        linkedPrId: "pr-99",
        executionLaneId: "lane-1",
      },
      workflow: sessionWorkflowFixture,
      issue: issueFixture,
      outcome: "completed",
      summary: "Worker handoff wrapped with linked proof.",
    });

    expect(publishWorkflowCloseout).toHaveBeenCalledWith(expect.objectContaining({
      issue: issueFixture,
      status: "completed",
      summary: "Worker handoff wrapped with linked proof.",
      targetLabel: "employee session",
      targetId: "session-1",
      contextLines: [
        "Workflow target: employee_session",
        "Lane: lane-1",
        "Session: session-1",
        "Linked PR record: pr-99",
      ],
      prLinks: ["https://github.com/acme/repo/pull/99"],
      artifactPaths: [
        ".ade/artifacts/chat-trace.zip",
        "https://example.com/lane-proof.png",
        "https://example.com/pr-proof.json",
      ],
      artifactMode: "links",
      commentTemplate: null,
    }));
  });
});
