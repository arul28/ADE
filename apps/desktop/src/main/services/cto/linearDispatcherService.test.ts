import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LinearWorkflowConfig, LinearWorkflowMatchResult, NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearDispatcherService } from "./linearDispatcherService";

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

function buildPolicy(targetType: "mission" | "review_gate" | "worker_run"): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
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
            : [{ id: "wait", type: "wait_for_target_status", name: "Wait" } as const]),
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

function buildPrPolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
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
        fetchWorkflowStates: vi.fn(async () => [{ id: "done", name: "Done", type: "completed", teamId: "team-1", teamKey: "ACME" }]),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => [{ id: "agent-1", slug: "backend-dev", capabilities: [] }]) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: missionCreate, get: vi.fn(() => ({ id: "mission-1", status: "completed", artifacts: [] })) } as any,
      aiOrchestratorService: { startMissionRun: vi.fn(async () => ({ runId: "run-1" })) } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), listSessions: vi.fn(async () => []) } as any,
      laneService: { listLanes: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Fix it." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
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
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
      } as any,
      workerAgentService: { listAgents: vi.fn(() => []) } as any,
      workerHeartbeatService: { triggerWakeup: vi.fn(), listRuns: vi.fn(() => []) } as any,
      missionService: { create: vi.fn(), get: vi.fn() } as any,
      aiOrchestratorService: { startMissionRun: vi.fn() } as any,
      agentChatService: { ensureIdentitySession: vi.fn(), listSessions: vi.fn(async () => []) } as any,
      laneService: { listLanes: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "noop" })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
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

    const dispatcher = createLinearDispatcherService({
      db,
      projectId: "project-1",
      issueTracker: {
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
      laneService: { list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Please implement the issue." })) } as any,
      closeoutService: { applyOutcome: vi.fn(async () => {}) } as any,
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
      agentChatService: { ensureIdentitySession: vi.fn(), listSessions: vi.fn(async () => []) } as any,
      laneService: { list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]) } as any,
      templateService: { renderTemplate: vi.fn(() => ({ prompt: "Open a PR." })) } as any,
      closeoutService: { applyOutcome: closeout } as any,
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
});
