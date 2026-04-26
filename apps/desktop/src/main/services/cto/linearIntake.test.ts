import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowRun,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearCloseoutService } from "./linearCloseoutService";
import { createLinearIngressService } from "./linearIngressService";
import { createLinearIntakeService } from "./linearIntakeService";
import { createLinearRoutingService } from "./linearRoutingService";
import { openKvDb } from "../state/kvDb";

describe("linearIntakeService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  const issueFixture: NormalizedLinearIssue = {
    id: "issue-1",
    identifier: "ABC-42",
    title: "Fix flaky sync run",
    description: "Occasional sync failure under load.",
    url: "https://linear.app/acme/issue/ABC-42",
    projectId: "proj-1",
    projectSlug: "acme-platform",
    teamId: "team-1",
    teamKey: "ACME",
    stateId: "state-todo",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug"],
    assigneeId: null,
    assigneeName: "CTO",
    ownerId: "owner-1",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    raw: {},
  };

  const secondIssue: NormalizedLinearIssue = {
    ...issueFixture,
    id: "issue-2",
    identifier: "ABC-43",
    title: "Add rate limiter",
    priority: 1,
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
  };

  const policy: LinearWorkflowConfig = {
    version: 1,
    source: "repo",
    intake: {
      projectSlugs: ["acme-platform"],
      activeStateTypes: ["backlog", "unstarted", "started"],
      terminalStateTypes: ["completed", "canceled"],
    },
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "flow-1",
        name: "Flow 1",
        enabled: true,
        priority: 100,
        triggers: { assignees: ["CTO"], projectSlugs: ["acme-platform"] },
        target: { type: "mission" },
        steps: [{ id: "launch", type: "launch_target" }],
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };

  async function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-intake-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger());
    return { root, adeDir, db };
  }

  describe("linearIntakeService", () => {
    it("fetches candidates, filters out blockers, and sorts by priority then createdAt", async () => {
      const fixture = await createFixture();
      const blockedIssue: NormalizedLinearIssue = {
        ...issueFixture,
        id: "issue-blocked",
        identifier: "ABC-99",
        hasOpenBlockers: true,
        priority: 0,
      };
      const fetchCandidateIssues = vi.fn(async () => [blockedIssue, secondIssue, issueFixture]);

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId: "project-intake-test",
        issueTracker: {
          fetchCandidateIssues,
        } as any,
      });

      const candidates = await service.fetchCandidates(policy);

      expect(fetchCandidateIssues).toHaveBeenCalledWith({
        projectSlugs: ["acme-platform"],
        stateTypes: ["backlog", "unstarted", "started"],
      });

      // Blocked issue should be filtered out
      expect(candidates.find((issue) => issue.id === "issue-blocked")).toBeUndefined();
      // Remaining should be sorted by priority (ascending), then createdAt
      expect(candidates).toHaveLength(2);
      expect(candidates[0]!.id).toBe("issue-2"); // priority 1 < priority 2
      expect(candidates[1]!.id).toBe("issue-1");

      fixture.db.close();
    });

    it("merges project slugs from intake, workflows, and legacy config", async () => {
      const fixture = await createFixture();
      const fetchCandidateIssues = vi.fn(async () => []);

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId: "project-slug-merge",
        issueTracker: { fetchCandidateIssues } as any,
      });

      const policyWithLegacy: LinearWorkflowConfig = {
        ...policy,
        intake: {
          ...policy.intake,
          projectSlugs: ["primary-project"],
        },
        workflows: [
          {
            id: "flow-extra",
            name: "Extra flow",
            enabled: true,
            priority: 100,
            triggers: { projectSlugs: ["extra-project"] },
            target: { type: "mission" },
            steps: [{ id: "launch", type: "launch_target" }],
          },
        ],
        legacyConfig: {
          enabled: true,
          projects: [{ slug: "legacy-project" }],
        },
      };

      await service.fetchCandidates(policyWithLegacy);

      const calledWith = (fetchCandidateIssues.mock.calls as any)[0][0] as { projectSlugs: string[] };
      expect(calledWith.projectSlugs).toContain("primary-project");
      expect(calledWith.projectSlugs).toContain("extra-project");
      expect(calledWith.projectSlugs).toContain("legacy-project");

      fixture.db.close();
    });

    it("attaches previous state info from persisted snapshots", async () => {
      const fixture = await createFixture();
      const projectId = "project-previous-state";

      // Pre-persist a snapshot so the service finds previous state
      const now = new Date().toISOString();
      fixture.db.run(
        `
          insert into linear_issue_snapshots(
            id, project_id, issue_id, identifier, state_type, assignee_id, updated_at_linear, payload_json, hash, created_at, updated_at
          )
          values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          `${projectId}:${issueFixture.id}`,
          projectId,
          issueFixture.id,
          issueFixture.identifier,
          "backlog",
          null,
          issueFixture.updatedAt,
          JSON.stringify({ ...issueFixture, stateId: "state-backlog", stateName: "Backlog", stateType: "backlog" }),
          "old-hash",
          now,
          now,
        ]
      );

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId,
        issueTracker: {
          fetchCandidateIssues: vi.fn(async () => [issueFixture]),
        } as any,
      });

      const candidates = await service.fetchCandidates(policy);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.previousStateType).toBe("backlog");
      expect(candidates[0]!.previousStateName).toBe("Backlog");

      fixture.db.close();
    });

    it("persistSnapshot inserts a new row and updates an existing one", async () => {
      const fixture = await createFixture();
      const projectId = "project-persist-test";

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId,
        issueTracker: {
          fetchCandidateIssues: vi.fn(async () => []),
        } as any,
      });

      // First persist: insert
      service.persistSnapshot(issueFixture);
      const row1 = fixture.db.get<{ issue_id: string; state_type: string }>(
        `select issue_id, state_type from linear_issue_snapshots where project_id = ? and issue_id = ?`,
        [projectId, issueFixture.id]
      );
      expect(row1, "First persist should create a row").toBeTruthy();
      expect(row1!.issue_id).toBe(issueFixture.id);
      expect(row1!.state_type).toBe("unstarted");

      // Second persist: update
      const updatedIssue = { ...issueFixture, stateType: "started" as const, stateName: "In Progress" };
      service.persistSnapshot(updatedIssue);
      const row2 = fixture.db.get<{ state_type: string }>(
        `select state_type from linear_issue_snapshots where project_id = ? and issue_id = ?`,
        [projectId, issueFixture.id]
      );
      expect(row2!.state_type).toBe("started");

      fixture.db.close();
    });

    it("issueHash produces consistent deterministic output", async () => {
      const fixture = await createFixture();

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId: "project-hash-test",
        issueTracker: {
          fetchCandidateIssues: vi.fn(async () => []),
        } as any,
      });

      const hash1 = service.issueHash(issueFixture);
      const hash2 = service.issueHash(issueFixture);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // sha256 hex

      const hash3 = service.issueHash({ ...issueFixture, title: "Different title" });
      expect(hash3).not.toBe(hash1);

      fixture.db.close();
    });

    it("returns empty array when no issues match the query", async () => {
      const fixture = await createFixture();

      const service = createLinearIntakeService({
        db: fixture.db,
        projectId: "project-empty",
        issueTracker: {
          fetchCandidateIssues: vi.fn(async () => []),
        } as any,
      });

      const candidates = await service.fetchCandidates(policy);
      expect(candidates).toEqual([]);

      fixture.db.close();
    });
  });

});

describe("linearIngressService (file group)", () => {

  describe("linearIngressService", () => {
    const fetchMock = vi.fn();

    afterEach(() => {
      vi.restoreAllMocks();
      fetchMock.mockReset();
    });

    it("ensures the relay webhook and stores ingress status", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-ingress-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          endpointId: "endpoint-1",
          webhookUrl: "https://relay.example.com/linear/webhooks/endpoint-1",
          signingSecret: "relay-secret",
          lastDeliveredAt: null,
        }),
      } as Response);
      fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted");
      });

      vi.stubGlobal("fetch", fetchMock);

      const service = createLinearIngressService({
        db,
        projectId: "project-1",
        linearClient: {
          listWebhooks: vi.fn(async () => []),
          createWebhook: vi.fn(async () => ({ id: "webhook-1" })),
        } as any,
        secretService: {
          getSecret: (key: string) =>
            key === "linearRelay.apiBaseUrl"
              ? "https://relay.example.com"
              : key === "linearRelay.remoteProjectId"
                ? "remote-project-1"
                : key === "linearRelay.accessToken"
                  ? "token-1"
                  : null,
        } as any,
      });

      await service.ensureRelayWebhook(true);
      const status = service.getStatus();

      expect(status.localWebhook.status).toBe("listening");
      expect(status.localWebhook.url).toContain("/linear-webhooks");
      expect(status.relay.status).toBe("ready");
      expect(status.relay.webhookUrl).toContain("/linear/webhooks/endpoint-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      service.dispose();
      db.close();
    });

    it("does not auto-start ingress when relay credentials are missing", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-ingress-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);

      vi.stubGlobal("fetch", fetchMock);

      const service = createLinearIngressService({
        db,
        projectId: "project-1",
        linearClient: {
          listWebhooks: vi.fn(async () => []),
          createWebhook: vi.fn(async () => ({ id: "webhook-1" })),
        } as any,
        secretService: {
          getSecret: () => null,
        } as any,
      });

      await service.start();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.getStatus().localWebhook.status).toBe("disabled");
      expect(service.canAutoStart()).toBe(false);

      service.dispose();
      db.close();
    });
  });

});

describe("linearRoutingService (file group)", () => {

  const baseIssue: NormalizedLinearIssue = {
    id: "issue-1",
    identifier: "ABC-10",
    title: "Fix login bug",
    description: "Users cannot login when refresh token is stale.",
    url: null,
    projectId: "proj-1",
    projectSlug: "acme-platform",
    teamId: "team-1",
    teamKey: "ACME",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    previousStateId: "state-backlog",
    previousStateName: "Backlog",
    previousStateType: "backlog",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug", "fast-lane"],
    metadataTags: ["ui"],
    assigneeId: null,
    assigneeName: "CTO",
    ownerId: "owner-1",
    creatorId: "creator-1",
    creatorName: "Taylor",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    raw: {},
  };

  function buildPolicy(): LinearWorkflowConfig {
    return {
      version: 1,
      source: "repo",
      intake: {
        projectSlugs: ["acme-platform"],
        activeStateTypes: ["backlog", "unstarted", "started"],
        terminalStateTypes: ["completed", "canceled"],
      },
      settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
      workflows: [
        {
          id: "review",
          name: "Review gate",
          enabled: true,
          priority: 50,
          triggers: { assignees: ["CTO"], labels: ["needs-triage"] },
          target: { type: "review_gate" },
          steps: [{ id: "launch", type: "launch_target" }],
        },
        {
          id: "fast-lane",
          name: "PR fast lane",
          enabled: true,
          priority: 120,
          triggers: { assignees: ["CTO"], labels: ["fast-lane"], priority: ["high"], projectSlugs: ["acme-platform"] },
          target: { type: "pr_resolution", runMode: "autopilot" },
          steps: [{ id: "launch", type: "launch_target", name: "Launch PR flow" }],
        },
      ],
      files: [],
      migration: { hasLegacyConfig: false, needsSave: false },
      legacyConfig: null,
    };
  }

  describe("linearRoutingService", () => {
    it("returns all candidate explanations and picks the highest-priority match", async () => {
      const policy = buildPolicy();
      const service = createLinearRoutingService({
        flowPolicyService: {
          getPolicy: () => policy,
          normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
        } as any,
      });

      const decision = await service.routeIssue({ issue: baseIssue });
      expect(decision.workflowId).toBe("fast-lane");
      expect(decision.target?.type).toBe("pr_resolution");
      expect(decision.candidates).toHaveLength(2);
      expect(decision.candidates.find((candidate) => candidate.workflowId === "review")?.matched).toBe(false);
    });

    it("explains when nothing matched", async () => {
      const policy = buildPolicy();
      const service = createLinearRoutingService({
        flowPolicyService: {
          getPolicy: () => policy,
          normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
        } as any,
      });

      const decision = await service.routeIssue({
        issue: { ...baseIssue, labels: ["bug"], assigneeName: "Someone Else" },
      });
      expect(decision.workflowId).toBeNull();
      expect(decision.reason).toContain("No workflow matched");
    });

    it("requires both assignee and workflow label, while allowing employee identity mappings", async () => {
      const policy = buildPolicy();
      policy.workflows[1] = {
        ...policy.workflows[1]!,
        triggers: {
          ...policy.workflows[1]!.triggers,
          assignees: ["agent-1"],
        },
      };
      const service = createLinearRoutingService({
        flowPolicyService: {
          getPolicy: () => policy,
          normalizePolicy: (input?: LinearWorkflowConfig) => input ?? policy,
        } as any,
        workerAgentService: {
          listAgents: () => [
            {
              id: "agent-1",
              slug: "backend-dev",
              name: "Backend Dev",
              linearIdentity: { userIds: ["user-1"], displayNames: ["Alex Johnson"], aliases: ["alex"] },
            },
          ],
        } as any,
      });

      const missingLabel = await service.routeIssue({
        issue: { ...baseIssue, assigneeId: "user-1", assigneeName: "Alex Johnson", labels: ["bug"] },
      });
      expect(missingLabel.workflowId).toBeNull();
      expect(missingLabel.candidates[1]?.missingSignals).toContain("Missing label");

      const matched = await service.routeIssue({
        issue: { ...baseIssue, assigneeId: "user-1", assigneeName: "Alex Johnson", labels: ["fast-lane"] },
      });
      expect(matched.workflowId).toBe("fast-lane");
      expect(matched.simulation?.explainsAndAcrossFields).toBe(true);
    });
  });

});

describe("linearCloseoutService (file group)", () => {

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

});
