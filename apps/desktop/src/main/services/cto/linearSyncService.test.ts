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
  intake: {
    projectSlugs: ["acme-platform"],
    activeStateTypes: ["backlog", "unstarted", "started"],
    terminalStateTypes: ["completed", "canceled"],
  },
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
        fetchCandidates: vi.fn(async () => [
          {
            ...issueFixture,
            raw: {
              _snapshotHash: "hash-1",
              _previousSnapshotHash: "hash-0",
            },
          },
        ]),
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

  it("records watch-only matches in the dashboard without creating runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-watch-only-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const createRun = vi.fn();

    const service = createLinearSyncService({
      db,
      projectId: "project-1",
      flowPolicyService: {
        getPolicy: () => ({
          ...policy,
          workflows: [
            {
              id: "watch-only",
              name: "Watch only",
              enabled: true,
              priority: 100,
              triggers: { projectSlugs: ["acme-platform"] },
              routing: { watchOnly: true },
              target: { type: "review_gate" },
              steps: [{ id: "review", type: "request_human_review" }],
            },
          ],
        }),
      } as any,
      routingService: {
        routeIssue: vi.fn(async () => ({
          workflowId: "watch-only",
          workflowName: "Watch only",
          workflow: {
            id: "watch-only",
            name: "Watch only",
            enabled: true,
            priority: 100,
            routing: { watchOnly: true },
            concurrency: {},
          },
          target: { type: "review_gate" },
          reason: "Matched watch-only workflow",
          candidates: [{ workflowId: "watch-only", workflowName: "Watch only", priority: 100, matched: true, reasons: ["Project matched"], matchedSignals: ["Project matched"] }],
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
        createRun,
        advanceRun: vi.fn(async () => null),
        listActiveRuns: vi.fn(() => []),
        listQueue: vi.fn(() => []),
        resolveRunAction: vi.fn(),
      } as any,
      autoStart: false,
    });

    await service.runSyncNow();
    expect(createRun).not.toHaveBeenCalled();
    const dashboard = service.getDashboard();
    expect(dashboard.watchOnlyHits).toBe(1);
    expect(dashboard.recentEvents[0]?.eventType).toBe("watch_only_match");
    db.close();
  });

  it("hydrates webhook issue updates with snapshot hashes before routing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-webhook-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const createRun = vi.fn(() => ({ id: "run-1" }));

    db.run(
      `
        insert into linear_issue_snapshots(
          id, project_id, issue_id, identifier, state_type, assignee_id, updated_at_linear, payload_json, hash, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "project-1:issue-1",
        "project-1",
        "issue-1",
        issueFixture.identifier,
        "backlog",
        null,
        "2026-03-04T00:00:00.000Z",
        JSON.stringify({
          ...issueFixture,
          stateId: "state-backlog",
          stateName: "Backlog",
          stateType: "backlog",
        }),
        "hash-previous",
        "2026-03-04T00:00:00.000Z",
        "2026-03-04T00:00:00.000Z",
      ],
    );

    const service = createLinearSyncService({
      db,
      projectId: "project-1",
      flowPolicyService: {
        getPolicy: () => ({
          ...policy,
          workflows: [
            {
              id: "workflow-1",
              name: "Dispatch issue",
              enabled: true,
              priority: 100,
              triggers: { projectSlugs: ["acme-platform"] },
              routing: {},
              target: { type: "review_gate" },
              steps: [{ id: "review", type: "request_human_review" }],
            },
          ],
        }),
      } as any,
      routingService: {
        routeIssue: vi.fn(async () => ({
          workflowId: "workflow-1",
          workflowName: "Dispatch issue",
          workflow: {
            id: "workflow-1",
            name: "Dispatch issue",
            enabled: true,
            routing: {},
            concurrency: {},
          },
          target: { type: "review_gate" },
          reason: "Matched project",
          candidates: [],
          nextStepsPreview: [],
        })),
      } as any,
      intakeService: {
        fetchCandidates: vi.fn(async () => []),
        persistSnapshot: vi.fn(() => {}),
        issueHash: vi.fn(() => "hash-current"),
      } as any,
      issueTracker: {
        fetchIssueById: vi.fn(async () => issueFixture),
      } as any,
      dispatcherService: {
        hasActiveRuns: vi.fn(() => false),
        findActiveRunForIssue: vi.fn(() => null),
        createRun,
        advanceRun: vi.fn(async () => null),
        listActiveRuns: vi.fn(() => []),
        listQueue: vi.fn(() => []),
        resolveRunAction: vi.fn(),
      } as any,
      autoStart: false,
    });

    await service.processIssueUpdate("issue-1");

    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({
          _snapshotHash: "hash-current",
          _previousSnapshotHash: "hash-previous",
        }),
        previousStateId: "state-backlog",
        previousStateType: "backlog",
      }),
      expect.anything(),
    );
    db.close();
  });

  it("cancels every active run for an issue when the issue closes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-close-all-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const cancelRun = vi.fn(async () => {});

    const service = createLinearSyncService({
      db,
      projectId: "project-1",
      flowPolicyService: {
        getPolicy: () => ({
          ...policy,
          workflows: [
            {
              id: "workflow-1",
              name: "Dispatch issue",
              enabled: true,
              priority: 100,
              triggers: { projectSlugs: ["acme-platform"] },
              routing: {},
              target: { type: "review_gate" },
              steps: [{ id: "review", type: "request_human_review" }],
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
        fetchCandidates: vi.fn(async () => []),
        persistSnapshot: vi.fn(() => {}),
        issueHash: vi.fn(() => "hash-current"),
      } as any,
      issueTracker: {
        fetchIssueById: vi.fn(async () => ({
          ...issueFixture,
          stateId: "state-done",
          stateName: "Done",
          stateType: "completed",
        })),
      } as any,
      dispatcherService: {
        hasActiveRuns: vi.fn(() => true),
        findActiveRunForIssue: vi.fn(() => ({ id: "run-2", issueId: "issue-1" })),
        createRun: vi.fn(),
        cancelRun,
        advanceRun: vi.fn(async () => null),
        listActiveRuns: vi.fn(() => [
          { id: "run-1", issueId: "issue-1" },
          { id: "run-2", issueId: "issue-1" },
          { id: "run-3", issueId: "issue-2" },
        ]),
        listQueue: vi.fn(() => []),
        resolveRunAction: vi.fn(),
      } as any,
      autoStart: false,
    });

    await service.processIssueUpdate("issue-1");

    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(cancelRun).toHaveBeenNthCalledWith(
      1,
      "run-1",
      "Issue externally completed",
      expect.objectContaining({ workflows: expect.any(Array) }),
    );
    expect(cancelRun).toHaveBeenNthCalledWith(
      2,
      "run-2",
      "Issue externally completed",
      expect.objectContaining({ workflows: expect.any(Array) }),
    );
    db.close();
  });

  it("forwards employee overrides through queue resolution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-override-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
    const resolveRunAction = vi.fn(async () => ({ id: "run-1", status: "queued" }));

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
        hasActiveRuns: vi.fn(() => false),
        findActiveRunForIssue: vi.fn(() => null),
        createRun: vi.fn(),
        advanceRun: vi.fn(async () => null),
        listActiveRuns: vi.fn(() => []),
        listQueue: vi.fn(() => [{ id: "run-1", employeeOverride: "agent:worker-1" }]),
        resolveRunAction,
        getRunDetail: vi.fn(async () => null),
      } as any,
      autoStart: false,
    });

    await service.resolveQueueItem({ queueItemId: "run-1", action: "retry", employeeOverride: "agent:worker-1" });
    expect(resolveRunAction).toHaveBeenCalledWith("run-1", "retry", undefined, policy, "agent:worker-1");
    db.close();
  });
});
