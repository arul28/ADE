import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LinearWorkflowConfig, LinearWorkflowMatchResult, NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearDispatcherService } from "./linearDispatcherService";
import { createLinearOutboundService } from "./linearOutboundService";
import { createLinearCloseoutService } from "./linearCloseoutService";

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
  creatorId: "creator-1",
  creatorName: "Taylor",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

const intake = {
  projectSlugs: ["acme-platform"],
  activeStateTypes: ["backlog", "unstarted", "started"],
  terminalStateTypes: ["completed", "canceled"],
};

function buildPolicy(targetType: "mission" | "review_gate" | "worker_run"): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "flow-1",
        name: "Flow 1",
        enabled: true,
        priority: 100,
        triggers: { assignees: ["CTO"], projectSlugs: ["acme-platform"] },
        target: { type: targetType, runMode: targetType === "review_gate" ? "manual" : "autopilot", workerSelector: { mode: "slug", value: "backend-dev" } },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch target" },
          ...(targetType === "review_gate"
            ? [{ id: "review", type: "request_human_review", name: "Review gate" } as const]
            : [{ id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: targetType === "mission" ? "completed" : "runtime_completed" } as const]),
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "done", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildEmployeeSessionPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "employee-flow",
        name: "Employee flow",
        enabled: true,
        priority: 100,
        triggers: { assignees: ["agent-1"], labels: ["workflow:backend"] },
        target: { type: "employee_session", runMode: "assisted" },
        steps: [
          { id: "set", type: "set_linear_state", name: "Move to progress", state: "in_progress" },
          { id: "launch", type: "launch_target", name: "Launch chat" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "completed" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildDirectCtoSessionPolicy(overrides?: Partial<LinearWorkflowConfig["workflows"][number]["target"]>): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "cto-session-flow",
        name: "CTO direct session",
        enabled: true,
        priority: 100,
        triggers: { assignees: ["CTO"], labels: ["workflow:backend"] },
        target: {
          type: "employee_session",
          runMode: "assisted",
          employeeIdentityKey: "cto",
          sessionTemplate: "default",
          laneSelection: "primary",
          sessionReuse: "reuse_existing",
          ...overrides,
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch chat" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "completed" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildSupervisedWorkerPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "supervised-worker",
        name: "Supervised worker",
        enabled: true,
        priority: 140,
        triggers: { assignees: ["CTO"], labels: ["workflow:backend-supervised"] },
        target: {
          type: "worker_run",
          runMode: "autopilot",
          workerSelector: { mode: "slug", value: "backend-dev" },
          laneSelection: "fresh_issue_lane",
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch worker run" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "runtime_completed" },
          {
            id: "review",
            type: "request_human_review",
            name: "Supervisor review",
            reviewerIdentityKey: "cto",
            rejectAction: "loop_back",
            loopToStepId: "launch",
          },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildWorkerExplicitCompletionPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "worker-explicit",
        name: "Worker explicit completion",
        enabled: true,
        priority: 120,
        triggers: { assignees: ["CTO"], labels: ["workflow:explicit-complete"] },
        target: {
          type: "worker_run",
          runMode: "autopilot",
          workerSelector: { mode: "slug", value: "backend-dev" },
          laneSelection: "primary",
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch worker run" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "explicit_completion" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildPrReadyPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "pr-ready-flow",
        name: "PR ready flow",
        enabled: true,
        priority: 120,
        triggers: { assignees: ["CTO"], labels: ["workflow:backend"] },
        target: {
          type: "pr_resolution",
          runMode: "autopilot",
          workerSelector: { mode: "slug", value: "backend-dev" },
          prStrategy: { kind: "per-lane", draft: true },
          prTiming: "after_target_complete",
          laneSelection: "primary",
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch PR flow" },
          { id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links", reviewReadyWhen: "pr_ready" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildPrPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "pr-flow",
        name: "PR flow",
        enabled: true,
        priority: 120,
        triggers: { assignees: ["CTO"], labels: ["workflow:backend"] },
        target: { type: "pr_resolution", runMode: "autopilot", workerSelector: { mode: "slug", value: "backend-dev" }, prStrategy: { kind: "per-lane", draft: true } },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch PR flow" },
          { id: "wait-pr", type: "wait_for_pr", name: "Wait for PR" },
          { id: "notify", type: "emit_app_notification", name: "Notify", notifyOn: "review_ready" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links", reviewReadyWhen: "pr_created" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildDownstreamEmployeeSessionPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "downstream-session-flow",
        name: "Downstream session flow",
        enabled: true,
        priority: 125,
        triggers: { assignees: ["CTO"], labels: ["workflow:downstream-session"] },
        target: {
          type: "worker_run",
          runMode: "autopilot",
          workerSelector: { mode: "slug", value: "backend-dev" },
          laneSelection: "primary",
          downstreamTarget: {
            type: "employee_session",
            employeeIdentityKey: "cto",
            runMode: "assisted",
            laneSelection: "primary",
            sessionReuse: "reuse_existing",
          },
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch worker run" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "runtime_completed" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildDownstreamManualCompletionPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "downstream-manual-flow",
        name: "Downstream manual flow",
        enabled: true,
        priority: 126,
        triggers: { assignees: ["CTO"], labels: ["workflow:downstream-manual"] },
        target: {
          type: "employee_session",
          runMode: "assisted",
          employeeIdentityKey: "cto",
          laneSelection: "primary",
          sessionReuse: "fresh_session",
          downstreamTarget: {
            type: "employee_session",
            runMode: "assisted",
            employeeIdentityKey: "cto",
            laneSelection: "primary",
            sessionReuse: "fresh_session",
          },
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch chat" },
          { id: "wait", type: "wait_for_target_status", name: "Wait" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildEmployeeToWorkerHandoffPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "employee-to-worker-flow",
        name: "Employee to worker flow",
        enabled: true,
        priority: 127,
        triggers: { assignees: ["CTO"], labels: ["workflow:employee-to-worker"] },
        target: {
          type: "employee_session",
          runMode: "assisted",
          employeeIdentityKey: "cto",
          laneSelection: "primary",
          sessionReuse: "reuse_existing",
          downstreamTarget: {
            type: "worker_run",
            runMode: "autopilot",
            workerSelector: { mode: "slug", value: "backend-dev" },
            laneSelection: "primary",
          },
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch chat" },
          { id: "wait", type: "wait_for_target_status", name: "Wait" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}
function buildInvalidDownstreamPrPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    intake,
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "invalid-downstream-pr",
        name: "Invalid downstream PR",
        enabled: true,
        priority: 130,
        triggers: { assignees: ["CTO"], labels: ["workflow:downstream-pr"] },
        target: {
          type: "worker_run",
          runMode: "autopilot",
          workerSelector: { mode: "slug", value: "backend-dev" },
          laneSelection: "primary",
          downstreamTarget: {
            type: "pr_resolution",
            runMode: "autopilot",
            workerSelector: { mode: "slug", value: "backend-dev" },
            laneSelection: "primary",
          },
        },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch worker run" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "runtime_completed" },
          { id: "complete", type: "complete_issue", name: "Complete issue" },
        ],
        closeout: { successState: "in_review", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildMatch(policy: LinearWorkflowConfig): LinearWorkflowMatchResult {
  return {
    workflowId: policy.workflows[0]!.id,
    workflowName: policy.workflows[0]!.name,
    workflow: policy.workflows[0]!,
    target: policy.workflows[0]!.target,
    reason: "Matched the configured workflow.",
    candidates: [{ workflowId: "flow-1", workflowName: "Flow 1", priority: 100, matched: true, reasons: ["Assignee matched CTO"], matchedSignals: ["Assignee matched CTO"] }],
    nextStepsPreview: ["Launch target", "Wait", "Complete issue"],
  };
}

function createOutboundServiceMocks() {
  return {
    ensureWorkpad: vi.fn(async () => ({ commentId: "comment-1" })),
    updateWorkpad: vi.fn(async () => ({ commentId: "comment-1" })),
    publishMissionStart: vi.fn(async () => {}),
    publishMissionProgress: vi.fn(async () => {}),
    publishWorkflowStatus: vi.fn(async () => {}),
    publishWorkflowCloseout: vi.fn(async () => {}),
    publishMissionCloseout: vi.fn(async () => {}),
  } as any;
}

describe("linearDispatcherService", () => {
  it("launches a mission target and records the mission id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildPolicy("mission");
    const missionCreate = vi.fn(() => ({ id: "mission-1", title: "Mission" }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => [{ id: "done", name: "Done", type: "completed", teamId: "team-1", teamKey: "ACME" }]),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", capabilities: [] }]) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: missionCreate, get: vi.fn(() => ({ id: "mission-1", status: "completed", artifacts: [] })) } as any,
      aiOrchestratorService: { startMissionRun: vi.fn(async () => ({ runId: "run-1" })) } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-1" })),
        sendMessage: vi.fn(async () => {}),
        listSessions: vi.fn(async () => []),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Fix it." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun(issueFixture, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    expect(missionCreate).toHaveBeenCalledTimes(1);
    expect(dispatcher.listQueue()[0]?.missionId).toBe("mission-1");
    db.close();
  });

  it("holds review_gate targets in escalated status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-review-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildPolicy("review_gate");

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-1" })),
        sendMessage: vi.fn(async () => {}),
        listSessions: vi.fn(async () => []),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "noop" })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun(issueFixture, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    expect(dispatcher.listQueue()[0]?.status).toBe("escalated");
    db.close();
  });

  it("delegates employee_session runs into the assigned employee chat", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-session-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildEmployeeSessionPolicy();
    const sendMessage = vi.fn(async () => ({ id: "message-1" }));
    const ensureTaskSession = vi.fn(() => ({ id: "task-session-1" }));
    const employeeIssue = { ...issueFixture, assigneeId: "user-1", assigneeName: "Alex", labels: ["workflow:backend"] };

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => employeeIssue),
        fetchWorkflowStates: vi.fn(async () => [{ id: "state-progress", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ACME" }]),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", name: "Backend Dev", adapterType: "claude-local", capabilities: [], linearIdentity: { userIds: ["user-1"], displayNames: ["Alex"] } }]),
        getAgent: vi.fn(() => null),
      } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-1" })),
        sendMessage,
        listSessions: vi.fn(async () => [{ sessionId: "session-1", laneId: "lane-1", status: "idle" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please implement the issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession,
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, assigneeId: "user-1", assigneeName: "Alex", labels: ["workflow:backend"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    expect(ensureTaskSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: expect.stringContaining("Start work immediately for Linear issue ABC-42."),
    });
    expect(dispatcher.listQueue()[0]?.sessionId).toBe("session-1");
    db.close();
  });

  it("keeps employee_session runs visible as queued when manual delegation is required", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-awaiting-delegation-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildEmployeeSessionPolicy();
    const employeeIssue = { ...issueFixture, assigneeId: "user-missing", assigneeName: "Missing Person", labels: ["workflow:backend"] };

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => employeeIssue),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-1" })),
        sendMessage: vi.fn(async () => {}),
        listSessions: vi.fn(async () => []),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Fix it." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun(employeeIssue, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    expect(dispatcher.listQueue()[0]?.status).toBe("queued");
    const detail = await dispatcher.getRunDetail(run.id, policy);
    expect(detail?.run.status).toBe("awaiting_delegation");
    db.close();
  });

  it("rewinds launch_target when retrying a run that is awaiting delegation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-retry-awaiting-delegation-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildEmployeeSessionPolicy();
    const employeeIssue = {
      ...issueFixture,
      assigneeId: "unknown-agent",
      assigneeName: "Unknown Agent",
      labels: ["workflow:backend"],
    };

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => employeeIssue),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun(employeeIssue, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    const detailBeforeRetry = await dispatcher.getRunDetail(run.id, policy);
    expect(detailBeforeRetry?.steps.find((step) => step.workflowStepId === "launch")?.status).toBe("completed");

    await dispatcher.resolveRunAction(run.id, "retry", "Try again.", policy);

    const detailAfterRetry = await dispatcher.getRunDetail(run.id, policy);
    expect(detailAfterRetry?.steps.find((step) => step.workflowStepId === "launch")?.status).toBe("pending");
    db.close();
  });

  it("launches a direct CTO employee session when the workflow targets CTO", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-cto-session-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDirectCtoSessionPolicy();
    const ensureIdentitySession = vi.fn(async () => ({ id: "session-cto-1" }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession,
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [{ sessionId: "session-cto-1", laneId: "lane-1", status: "idle" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"], assigneeName: "CTO" }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({
      identityKey: "cto",
      laneId: "lane-1",
    }));
    expect(dispatcher.listQueue()[0]?.sessionId).toBe("session-cto-1");
    db.close();
  });

  it("keeps employee-session workflows waiting when a chat runtime ends and relinks to the active identity session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-session-relink-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDirectCtoSessionPolicy();
    let sessions = [
      {
        sessionId: "session-cto-1",
        laneId: "lane-1",
        identityKey: "cto",
        status: "idle",
        lastActivityAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto-1" })),
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => sessions),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"], assigneeName: "CTO" }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    sessions = [
      {
        sessionId: "session-cto-1",
        laneId: "lane-1",
        identityKey: "cto",
        status: "ended",
        lastActivityAt: "2026-03-05T00:05:00.000Z",
      },
    ];
    const waiting = await dispatcher.advanceRun(run.id, policy);
    expect(waiting?.status).toBe("waiting_for_target");

    sessions = [
      {
        sessionId: "session-cto-2",
        laneId: "lane-1",
        identityKey: "cto",
        status: "idle",
        lastActivityAt: "2026-03-05T00:06:00.000Z",
      },
    ];
    const relinked = await dispatcher.advanceRun(run.id, policy);
    expect(relinked?.status).toBe("waiting_for_target");
    expect(dispatcher.listQueue()[0]?.sessionId).toBe("session-cto-2");
    const detail = await dispatcher.getRunDetail(run.id, policy);
    expect(detail?.steps.find((step) => step.workflowStepId === "wait")?.targetStatus).toBe("explicit_completion");
    db.close();
  });

  it("creates a fresh issue lane and fresh session when configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-fresh-lane-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDirectCtoSessionPolicy({
      laneSelection: "fresh_issue_lane",
      sessionReuse: "fresh_session",
      freshLaneName: "Backend supervised lane",
    });
    const ensureIdentitySession = vi.fn(async () => ({ id: "session-fresh-1" }));
    const createLane = vi.fn(async () => ({ id: "lane-2", name: "Backend supervised lane" }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession,
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [{ sessionId: "session-fresh-1", laneId: "lane-2", status: "idle" }]),
      } as any,
      laneService: {
        ensurePrimaryLane: vi.fn(async () => {}),
        list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        create: createLane,
      } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"], assigneeName: "CTO" }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    expect(createLane).toHaveBeenCalledTimes(1);
    expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({
      identityKey: "cto",
      laneId: "lane-2",
      reuseExisting: false,
    }));
    expect(dispatcher.listQueue()[0]?.laneId).toBe("lane-2");
    db.close();
  });

  it("requires an explicit ADE completion signal for worker runs when configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-worker-explicit-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildWorkerExplicitCompletionPolicy();
    const closeout = vi.fn(async () => {});

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => [{ id: "worker-run-1", status: "completed" }]),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Implement the issue." })) } as any,
      closeoutService: { applyOutcome: closeout } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:explicit-complete"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    const waiting = await dispatcher.advanceRun(run.id, policy);
    expect(waiting?.status).toBe("waiting_for_target");

    const detailBefore = await dispatcher.getRunDetail(run.id, policy);
    expect(detailBefore?.steps.find((step) => step.workflowStepId === "wait")?.targetStatus).toBe("explicit_completion");

    await dispatcher.resolveRunAction(run.id, "complete", "Validated via ADE closeout.", policy);
    const completed = await dispatcher.advanceRun(run.id, policy);
    expect(completed?.status).toBe("completed");
    expect(closeout).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("scopes manual completion markers to the active downstream stage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-downstream-manual-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDownstreamManualCompletionPolicy();
    const ensureIdentitySession = vi
      .fn()
      .mockResolvedValueOnce({ id: "session-1" })
      .mockResolvedValueOnce({ id: "session-2" });

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession,
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [
          { sessionId: "session-1", laneId: "lane-1", identityKey: "cto", status: "idle", lastActivityAt: "2026-03-05T00:00:00.000Z" },
          { sessionId: "session-2", laneId: "lane-1", identityKey: "cto", status: "idle", lastActivityAt: "2026-03-05T00:01:00.000Z" },
        ]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:downstream-manual"], assigneeName: "CTO" }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.resolveRunAction(run.id, "complete", "Stage 1 finished.", policy);

    const afterHandoff = await dispatcher.advanceRun(run.id, policy);
    expect(afterHandoff?.status).toBe("waiting_for_target");
    expect(dispatcher.listQueue()[0]?.sessionId).toBe("session-2");

    const stillWaiting = await dispatcher.advanceRun(run.id, policy);
    expect(stillWaiting?.status).toBe("waiting_for_target");
    expect(dispatcher.listQueue()[0]?.sessionId).toBe("session-2");
    expect(ensureIdentitySession).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("clears incompatible CTO overrides before handing off to a worker-backed downstream target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-override-handoff-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildEmployeeToWorkerHandoffPolicy();
    const triggerWakeup = vi.fn(async () => ({ runId: "worker-run-1" }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup,
        listRuns: vi.fn(() => []),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-1" })),
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [{ sessionId: "session-1", laneId: "lane-1", identityKey: "cto", status: "idle", lastActivityAt: "2026-03-05T00:00:00.000Z" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:employee-to-worker"], assigneeName: "CTO" }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.resolveRunAction(run.id, "complete", "Hand off to a worker.", policy, "cto");

    const handedOff = await dispatcher.advanceRun(run.id, policy);
    expect(handedOff?.status).toBe("waiting_for_target");
    expect(handedOff?.linkedWorkerRunId).toBe("worker-run-1");
    expect(dispatcher.listQueue()[0]?.employeeOverride).toBeNull();
    expect(triggerWakeup).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("preserves a launched session instead of scheduling a retry after a partial launch failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-partial-launch-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDirectCtoSessionPolicy();
    const ensureIdentitySession = vi.fn(async () => ({ id: "session-cto-1" }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession,
        sendMessage: vi.fn(async () => {
          throw new Error("Chat delivery failed after session creation.");
        }),
        listSessions: vi.fn(async () => [{ sessionId: "session-cto-1", laneId: "lane-1", identityKey: "cto", status: "idle", lastActivityAt: "2026-03-05T00:00:00.000Z" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"], assigneeName: "CTO" }, buildMatch(policy));
    const preserved = await dispatcher.advanceRun(run.id, policy);

    expect(preserved?.status).toBe("waiting_for_target");
    expect(preserved?.linkedSessionId).toBe("session-cto-1");
    expect(dispatcher.listQueue()[0]?.status).not.toBe("retry_wait");

    const detail = await dispatcher.getRunDetail(run.id, policy);
    expect(detail?.steps.find((step) => step.workflowStepId === "launch")?.status).toBe("completed");

    const resumed = await dispatcher.advanceRun(run.id, policy);
    expect(resumed?.status).toBe("waiting_for_target");
    expect(ensureIdentitySession).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("still completes delegated workflows that are configured to complete on launch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-complete-on-launch-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDirectCtoSessionPolicy();
    policy.workflows[0]!.steps = [
      { id: "launch", type: "launch_target", name: "Launch chat" },
      { id: "complete", type: "complete_issue", name: "Complete issue" },
    ];
    const closeout = vi.fn(async () => {});

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto-1" })),
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [{ sessionId: "session-cto-1", laneId: "lane-1", status: "idle" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: closeout } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"], assigneeName: "CTO" }, buildMatch(policy));
    const completed = await dispatcher.advanceRun(run.id, policy);

    expect(completed?.status).toBe("completed");
    expect(closeout).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("keeps a single Linear workpad comment live through delegated worker execution, PR linking, and closeout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-workpad-integration-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const artifactPath = path.join(root, "proof.txt");
    fs.writeFileSync(artifactPath, "proof", "utf8");

    const policy = buildWorkerExplicitCompletionPolicy();
    const workflow = policy.workflows[0]!;
    workflow.target.laneSelection = "fresh_issue_lane";
    workflow.target.prStrategy = { kind: "per-lane", draft: true };
    workflow.target.prTiming = "after_start";

    const createComment = vi.fn(async () => ({ commentId: "comment-1" }));
    const updateBodies: string[] = [];
    const updateComment = vi.fn(async (_commentId: string, body: string) => {
      updateBodies.push(body);
    });
    const issueTracker = {
      fetchIssueById: vi.fn(async () => issueFixture),
      fetchWorkflowStates: vi.fn(async () => [{ id: "state-review", name: "In Review", type: "started", teamId: "team-1", teamKey: "ACME" }]),
      updateIssueState: vi.fn(async () => {}),
      addLabel: vi.fn(async () => {}),
      createComment,
      updateComment,
      uploadAttachment: vi.fn(),
    } as any;
    const prService = {
      getForLane: vi.fn(() => null),
      getStatus: vi.fn(async () => ({
        prId: "pr-55",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "requested",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      })),
      createFromLane: vi.fn(async () => ({ id: "pr-55", githubPrNumber: 55 })),
      listAll: vi.fn(() => [{ id: "pr-55", githubUrl: "https://github.com/acme/repo/pull/55" }]),
    } as any;
    const outboundService = createLinearOutboundService({
      db,
      projectId: "project-1",
      projectRoot: root,
      issueTracker,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
    });
    const closeoutService = createLinearCloseoutService({
      issueTracker,
      outboundService,
      missionService: { get: vi.fn(() => null) } as any,
      orchestratorService: { getArtifactsForMission: vi.fn(() => []) } as any,
      prService,
      computerUseArtifactBrokerService: {
        listArtifacts: vi.fn(() => [{ uri: artifactPath }]),
      } as any,
    });

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "codex-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => [{ id: "worker-run-1", status: "completed" }]),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: {
        ensurePrimaryLane: vi.fn(async () => {}),
        list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        create: vi.fn(async () => ({ id: "lane-2", name: "ABC-42 fresh lane" })),
      } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Implement the issue." })) } as any,
      closeoutService,
      outboundService,
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:explicit-complete"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.resolveRunAction(run.id, "complete", "Validated with proof and PR.", policy);
    const completed = await dispatcher.advanceRun(run.id, policy);

    expect(completed?.status).toBe("completed");
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateBodies.length).toBeGreaterThanOrEqual(2);
    expect(updateBodies[0]).toContain("- Lane: lane-2");
    expect(updateBodies[0]).toContain("- Worker run: worker-run-1");
    expect(updateBodies[0]).toContain("- PR: pr-55");
    expect(updateBodies[updateBodies.length - 1]).toContain("### Closeout Summary");
    expect(updateBodies[updateBodies.length - 1]).toContain("https://github.com/acme/repo/pull/55");
    expect(updateBodies[updateBodies.length - 1]).toContain(`file://${artifactPath}`);
    db.close();
  });

  it("persists downstream session ownership after handing work from a worker to an employee session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-downstream-session-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildDownstreamEmployeeSessionPolicy();
    const outboundService = createOutboundServiceMocks();

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => [{ id: "worker-run-1", status: "completed" }]),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: {
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto-2" })),
        sendMessage: vi.fn(async () => ({ id: "message-1" })),
        listSessions: vi.fn(async () => [{ sessionId: "session-cto-2", laneId: "lane-1", status: "idle", identityKey: "cto" }]),
      } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please own this issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService,
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:downstream-session"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.advanceRun(run.id, policy);

    const queueItem = dispatcher.listQueue()[0]!;
    expect(queueItem.sessionId).toBe("session-cto-2");
    expect(queueItem.sessionLabel).toBe("CTO");
    expect(queueItem.workerId).toBeNull();
    expect(queueItem.workerSlug).toBeNull();
    expect(outboundService.publishWorkflowStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      delegatedOwner: "CTO",
      sessionId: "session-cto-2",
    }));
    db.close();
  });

  it("pauses for supervisor approval and can resume after approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-supervisor-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildSupervisedWorkerPolicy();
    const createLane = vi.fn(async () => ({ id: "lane-2", name: "Fresh lane" }));
    const listRuns = vi.fn(() => [{ id: "worker-run-1", status: "completed" }]);

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns,
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: {
        ensurePrimaryLane: vi.fn(async () => {}),
        list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        create: createLane,
      } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Implement the issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend-supervised"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    const awaitingReview = await dispatcher.advanceRun(run.id, policy);

    expect(awaitingReview?.status).toBe("awaiting_human_review");
    expect(dispatcher.listQueue()[0]?.status).toBe("escalated");

    await dispatcher.resolveRunAction(run.id, "approve", "Looks good.", policy);
    const completed = await dispatcher.advanceRun(run.id, policy);
    expect(completed?.status).toBe("completed");
    db.close();
  });

  it("loops back to delegated work when supervisor requests changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-loopback-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildSupervisedWorkerPolicy();

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]),
      } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => [{ id: "worker-run-1", status: "completed" }]),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: {
        ensurePrimaryLane: vi.fn(async () => {}),
        list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        create: vi.fn(async () => ({ id: "lane-2", name: "Fresh lane" })),
      } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Implement the issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-1", githubPrNumber: 101 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend-supervised"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.advanceRun(run.id, policy);
    await dispatcher.resolveRunAction(run.id, "reject", "Please tighten the implementation.", policy);
    const looped = await dispatcher.advanceRun(run.id, policy);

    expect(looped?.status).toBe("queued");
    expect(looped?.currentStepId).toBe("launch");
    expect(dispatcher.listQueue()[0]?.reviewState).toBe("changes_requested");
    db.close();
  });

  it("links or creates a PR before closing out review-ready runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-pr-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildPrPolicy();
    const events: Array<{ type: string; milestone?: string; level?: string }> = [];
    const closeout = vi.fn(async () => {});
    const createFromLane = vi.fn(async () => ({ id: "pr-42", githubPrNumber: 42 }));

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => [{ id: "state-review", name: "In Review", type: "started", teamId: "team-1", teamKey: "ACME" }]),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]) } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => []),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Open a PR." })) } as any,
      closeoutService: { applyOutcome: closeout } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane,
      } as any,
      onEvent: (event) => events.push({ type: event.type, milestone: (event as any).milestone, level: (event as any).level }),
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    const finalRun = await dispatcher.advanceRun(run.id, policy);

    expect(createFromLane).toHaveBeenCalledTimes(1);
    expect(finalRun?.linkedPrId).toBe("pr-42");
    expect(finalRun?.status).toBe("completed");
    expect(closeout).toHaveBeenCalledTimes(1);
    expect(events.some((entry) => entry.milestone === "pr_linked")).toBe(true);
    expect(events.some((entry) => entry.milestone === "review_ready")).toBe(true);
    db.close();
  });

  it("waits for a PR to become review-ready before closing out", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-pr-ready-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildPrReadyPolicy();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        prId: "pr-42",
        state: "open",
        checksStatus: "failing",
        reviewStatus: "requested",
        isMergeable: false,
        mergeConflicts: false,
        behindBaseBy: 0,
      })
      .mockResolvedValueOnce({
        prId: "pr-42",
        state: "open",
        checksStatus: "failing",
        reviewStatus: "requested",
        isMergeable: false,
        mergeConflicts: false,
        behindBaseBy: 0,
      })
      .mockResolvedValueOnce({
        prId: "pr-42",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      })
      .mockResolvedValueOnce({
        prId: "pr-42",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      });

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]) } as any,
      workerHeartbeatService: {
        triggerWakeup: vi.fn(async () => ({ runId: "worker-run-1" })),
        listRuns: vi.fn(() => []),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Open a review-ready PR." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        getStatus,
        createFromLane: vi.fn(async () => ({ id: "pr-42", githubPrNumber: 42 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:backend"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    const waiting = await dispatcher.advanceRun(run.id, policy);
    expect(waiting?.status).toBe("waiting_for_pr");

    const resolved = await dispatcher.advanceRun(run.id, policy);
    expect(resolved?.status).toBe("completed");
    expect(getStatus).toHaveBeenCalledTimes(4);
    expect(dispatcher.listQueue()[0]?.prChecksStatus).toBe("passing");
    expect(dispatcher.listQueue()[0]?.prReviewStatus).toBe("approved");
    db.close();
  });

  it("fails before launching a downstream PR stage when the workflow is missing wait_for_pr", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-invalid-downstream-pr-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const policy = buildInvalidDownstreamPrPolicy();
    const triggerWakeup = vi
      .fn()
      .mockResolvedValueOnce({ runId: "worker-run-1" })
      .mockResolvedValueOnce({ runId: "worker-run-2" });

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", adapterType: "claude-local", capabilities: [] }]) } as any,
      workerHeartbeatService: {
        triggerWakeup,
        listRuns: vi.fn(() => [{ id: "worker-run-1", status: "completed" }]),
      } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), sendMessage: vi.fn(async () => {}), listSessions: vi.fn(async () => []) } as any,
      laneService: { ensurePrimaryLane: vi.fn(async () => {}), list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Open a PR." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
      outboundService: createOutboundServiceMocks(),
      workerTaskSessionService: {
        deriveTaskKey: vi.fn(() => "task-key-1"),
        ensureTaskSession: vi.fn(() => ({ id: "task-session-1" })),
      } as any,
      prService: {
        getForLane: vi.fn(() => null),
        createFromLane: vi.fn(async () => ({ id: "pr-42", githubPrNumber: 42 })),
      } as any,
    });

    const run = dispatcher.createRun({ ...issueFixture, labels: ["workflow:downstream-pr"] }, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);

    const retried = await dispatcher.advanceRun(run.id, policy);
    expect(retried?.status).toBe("failed");
    expect(triggerWakeup).toHaveBeenCalledTimes(1);
    db.close();
  });
});
