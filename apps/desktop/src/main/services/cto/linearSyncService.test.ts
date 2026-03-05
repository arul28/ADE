import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LinearRouteDecision, LinearSyncConfig, NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { nowIso } from "../shared/utils";
import { createLinearSyncService } from "./linearSyncService";

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
  assigneeName: null,
  ownerId: "owner-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

describe("linearSyncService", () => {
  it("dispatches once, claim-locks issue, and avoids duplicate dispatch on unchanged snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());

    const policy: LinearSyncConfig = {
      enabled: true,
      pollingIntervalSec: 300,
      projects: [{ slug: "acme-platform" }],
      assignment: { setAssigneeOnDispatch: false },
      autoDispatch: { default: "auto", rules: [] },
      concurrency: { global: 5, byState: { todo: 3, in_progress: 5 } },
      reconciliation: { enabled: true, stalledTimeoutSec: 300 },
      classification: { mode: "hybrid", confidenceThreshold: 0.7 },
      artifacts: { mode: "links" },
    };

    const routeDecision: LinearRouteDecision = {
      action: "auto",
      workerSlug: "backend-dev",
      workerId: "agent-1",
      workerName: "Backend Dev",
      templateId: "bug-fix",
      reason: "Matched bug rule.",
      confidence: 0.9,
      matchedRuleId: "rule-1",
      matchedSignals: ["label:bug"],
    };

    const missions = new Map<string, any>();
    let missionSeq = 0;
    const missionCreate = vi.fn((args: { title: string }) => {
      missionSeq += 1;
      const mission = {
        id: `mission-${missionSeq}`,
        title: args.title,
        status: "in_progress",
        updatedAt: nowIso(),
        totalSteps: 0,
        completedSteps: 0,
        lastError: null,
        outcomeSummary: null,
        artifacts: [],
      };
      missions.set(mission.id, mission);
      return { id: mission.id, title: mission.title };
    });

    const service = createLinearSyncService({
      db,
      logger: createLogger(),
      projectId: "project-1",
      projectRoot: root,
      issueTracker: {
        fetchCandidateIssues: vi.fn(async () => [issueFixture]),
        fetchIssueById: vi.fn(async () => issueFixture),
        fetchWorkflowStates: vi.fn(async () => []),
        updateIssueState: vi.fn(async () => {}),
        updateIssueAssignee: vi.fn(async () => {}),
        createComment: vi.fn(async () => ({ commentId: "comment-1" })),
        updateComment: vi.fn(async () => {}),
        addLabel: vi.fn(async () => {}),
        uploadAttachment: vi.fn(async () => ({ url: "https://example.com/file" })),
      } as any,
      flowPolicyService: {
        getPolicy: () => policy,
      } as any,
      routingService: {
        routeIssue: vi.fn(async () => routeDecision),
      } as any,
      templateService: {
        renderTemplate: vi.fn(() => ({
          templateId: "bug-fix",
          templateName: "Bug Fix",
          prompt: "Fix the issue.",
          metadata: {},
        })),
      } as any,
      outboundService: {
        publishMissionStart: vi.fn(async () => {}),
        publishMissionProgress: vi.fn(async () => {}),
        publishMissionCloseout: vi.fn(async () => {}),
      } as any,
      workerAgentService: {
        getAgent: vi.fn(() => ({ id: "agent-1", adapterConfig: {} })),
      } as any,
      missionService: {
        create: missionCreate,
        get: vi.fn((id: string) => missions.get(id) ?? null),
        update: vi.fn((patch: { missionId: string } & Record<string, unknown>) => {
          const existing = missions.get(patch.missionId);
          if (!existing) return null;
          const next = { ...existing, ...patch, updatedAt: nowIso() };
          missions.set(patch.missionId, next);
          return next;
        }),
      } as any,
      aiOrchestratorService: {
        startMissionRun: vi.fn(async () => ({ runId: "run-1" })),
        cancelRunGracefully: vi.fn(async () => {}),
      } as any,
      orchestratorService: {
        listRuns: vi.fn(() => []),
        cancelRun: vi.fn(() => {}),
      } as any,
      autoStart: false,
    });

    await service.runSyncNow();
    expect(missionCreate).toHaveBeenCalledTimes(1);

    const firstQueueRows = db.all<{ id: string; status: string }>(
      `select id, status from linear_dispatch_queue where project_id = ?`,
      ["project-1"]
    );
    expect(firstQueueRows.length).toBe(1);
    expect(firstQueueRows[0]?.status).toBe("dispatched");

    const activeClaimsAfterFirstRun = db.get<{ count: number }>(
      `select count(*) as count from linear_issue_claims where project_id = ? and status = 'active'`,
      ["project-1"]
    )?.count;
    expect(activeClaimsAfterFirstRun).toBe(1);

    await service.runSyncNow();
    expect(missionCreate).toHaveBeenCalledTimes(1);

    const secondQueueRows = db.all<{ id: string; status: string }>(
      `select id, status from linear_dispatch_queue where project_id = ?`,
      ["project-1"]
    );
    expect(secondQueueRows.length).toBe(1);
    expect(secondQueueRows[0]?.status).toBe("dispatched");

    db.close();
    service.dispose();
  });
});
