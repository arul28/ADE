import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LinearWorkflowConfig, NormalizedLinearIssue } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createLinearSyncService } from "./linearSyncService";

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

const policy: LinearWorkflowConfig = {
  version: 1,
  source: "repo",
  settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
  workflows: [],
  files: [],
  migration: { hasLegacyConfig: false, needsSave: false },
  legacyConfig: null,
};

describe("linearSyncService", () => {
  it("runs an intake cycle and updates the dashboard heartbeat", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const advanceRun = vi.fn(async () => null);

    const service = createLinearSyncService({
      db,
      projectId: "project-1",
      flowPolicyService: { getPolicy: () => policy } as any,
      routingService: {
        routeIssue: vi.fn(async () => ({
          workflowId: null,
          workflowName: null,
          workflow: null,
          target: null,
          reason: "No match",
          candidates: [],
          nextStepsPreview: [],
        })),
      } as any,
      intakeService: {
        fetchCandidates: vi.fn(async () => [issueFixture]),
        persistSnapshot: vi.fn(() => {}),
      } as any,
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
      } as any,
      dispatcherService: {
        findActiveRunForIssue: vi.fn(() => null),
        createRun: vi.fn(),
        advanceRun,
        listActiveRuns: vi.fn(() => []),
        listQueue: vi.fn(() => []),
        resolveRunAction: vi.fn(),
      } as any,
      autoStart: false,
    });

    await service.runSyncNow();
    expect(service.getDashboard().lastSuccessAt).toBeTruthy();
    expect(advanceRun).not.toHaveBeenCalled();
    db.close();
  });
});
