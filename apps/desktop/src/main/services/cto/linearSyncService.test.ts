import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

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
        hasActiveRuns: vi.fn(() => false),
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

  it("starts immediately and continues on the reconciliation interval", async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const fetchCandidates = vi.fn(async () => []);

    const service = createLinearSyncService({
      db,
      projectId: "project-1",
      flowPolicyService: {
        getPolicy: () => ({
          ...policy,
          workflows: [
            {
              id: "workflow-1",
              enabled: true,
            },
          ],
        }),
      } as any,
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
        fetchCandidates,
        persistSnapshot: vi.fn(() => {}),
      } as any,
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
      } as any,
      dispatcherService: {
        hasActiveRuns: vi.fn(() => false),
        findActiveRunForIssue: vi.fn(() => null),
        createRun: vi.fn(),
        advanceRun: vi.fn(async () => null),
        listActiveRuns: vi.fn(() => []),
        listQueue: vi.fn(() => []),
        resolveRunAction: vi.fn(),
      } as any,
      hasCredentials: () => true,
      reconciliationIntervalSec: 30,
      autoStart: false,
    });

    await service.start();
    expect(fetchCandidates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCandidates).toHaveBeenCalledTimes(2);

    service.dispose();
    db.close();
  });

  it("immediately advances queue actions after a supervisor decision", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-review-action-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const advanceRun = vi.fn(async () => ({ id: "run-1", status: "queued" }));

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
        fetchCandidates: vi.fn(async () => []),
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
        listQueue: vi.fn(() => [{ id: "run-1" }]),
        resolveRunAction: vi.fn(async () => ({ id: "run-1", status: "queued" })),
        getRunDetail: vi.fn(async () => null),
      } as any,
      autoStart: false,
    });

    await service.resolveQueueItem({ queueItemId: "run-1", action: "approve" });
    expect(advanceRun).toHaveBeenCalledWith("run-1", policy);
    db.close();
  });
});
