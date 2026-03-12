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
    });

    const run = dispatcher.createRun(issueFixture, buildMatch(policy));
    await dispatcher.advanceRun(run.id, policy);
    expect(dispatcher.listQueue()[0]?.status).toBe("escalated");
    db.close();
  });
});
