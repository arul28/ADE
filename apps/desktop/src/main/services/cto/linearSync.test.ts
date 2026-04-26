import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LinearSyncConfig } from "../../../shared/types";
import type { LinearWorkflowConfig, LinearWorkflowMatchResult, NormalizedLinearIssue } from "../../../shared/types";
import type { LinearWorkflowConfig, NormalizedLinearIssue } from "../../../shared/types";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearCloseoutService } from "./linearCloseoutService";
import { createLinearDispatcherService } from "./linearDispatcherService";
import { createLinearOutboundService } from "./linearOutboundService";
import { createLinearSyncService } from "./linearSyncService";
import { createLinearTemplateService } from "./linearTemplateService";
import { createLinearWorkflowFileService } from "./linearWorkflowFileService";
import { describe, expect, it } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { pathToFileURL } from "node:url";

describe("linearSyncService (file group)", () => {

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

    it("buffers webhook issue updates while a sync cycle is in flight and replays them once", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-buffer-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
      let resolveAdvance: (() => void) | null = null;
      let allowActiveRun = true;
      const advanceRun = vi.fn(async () => {
        if (!allowActiveRun) return null;
        return await new Promise<null>((resolve) => {
          resolveAdvance = () => {
            allowActiveRun = false;
            resolve(null);
          };
        });
      });
      const fetchIssueById = vi.fn(async (issueId: string) =>
        issueId === "issue-2"
          ? { ...issueFixture, id: "issue-2", identifier: "ABC-43" }
          : issueFixture
      );

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
          issueHash: vi.fn(() => "hash-current"),
        } as any,
        issueTracker: {
          fetchIssueById,
        } as any,
        dispatcherService: {
          hasActiveRuns: vi.fn(() => allowActiveRun),
          findActiveRunForIssue: vi.fn(() => null),
          createRun: vi.fn(),
          advanceRun,
          listActiveRuns: vi.fn(() => (
            allowActiveRun
              ? [{
                  id: "run-1",
                  issueId: "issue-1",
                  workflowId: "workflow-1",
                  status: "in_progress",
                  retryAfter: null,
                  reviewState: "approved",
                }]
              : []
          )),
          listQueue: vi.fn(() => []),
          resolveRunAction: vi.fn(),
        } as any,
        autoStart: false,
      });

      const cycle = service.runSyncNow();
      await service.processIssueUpdate("issue-1");
      await service.processIssueUpdate("issue-1");
      await service.processIssueUpdate("issue-2");
      if (!resolveAdvance) {
        throw new Error("Expected the reconciliation cycle to be blocked.");
      }
      (resolveAdvance as () => void)();

      await cycle;

      expect(fetchIssueById).toHaveBeenCalledTimes(2);
      expect(fetchIssueById).toHaveBeenNthCalledWith(1, "issue-1");
      expect(fetchIssueById).toHaveBeenNthCalledWith(2, "issue-2");
      db.close();
    });

    it("retains buffered issue updates that fail during replay for a later retry", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-buffer-retry-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
      let resolveAdvance: (() => void) | null = null;
      let allowActiveRun = true;
      let shouldFailReplay = true;
      const advanceRun = vi.fn(async () => {
        if (!allowActiveRun) return null;
        return await new Promise<null>((resolve) => {
          resolveAdvance = () => {
            allowActiveRun = false;
            resolve(null);
          };
        });
      });
      const fetchIssueById = vi.fn(async (issueId: string) => {
        if (issueId === "issue-2" && shouldFailReplay) {
          shouldFailReplay = false;
          throw new Error("Temporary Linear failure");
        }
        return { ...issueFixture, id: issueId, identifier: issueId === "issue-2" ? "ABC-43" : issueFixture.identifier };
      });

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
          issueHash: vi.fn(() => "hash-current"),
        } as any,
        issueTracker: { fetchIssueById } as any,
        dispatcherService: {
          hasActiveRuns: vi.fn(() => allowActiveRun),
          findActiveRunForIssue: vi.fn(() => null),
          createRun: vi.fn(),
          advanceRun,
          listActiveRuns: vi.fn(() => (
            allowActiveRun
              ? [{
                  id: "run-1",
                  issueId: "issue-1",
                  workflowId: "workflow-1",
                  status: "in_progress",
                  retryAfter: null,
                  reviewState: "approved",
                }]
              : []
          )),
          listQueue: vi.fn(() => []),
          resolveRunAction: vi.fn(),
        } as any,
        autoStart: false,
      });

      const cycle = service.runSyncNow();
      await service.processIssueUpdate("issue-2");
      if (!resolveAdvance) {
        throw new Error("Expected the reconciliation cycle to be blocked.");
      }
      (resolveAdvance as () => void)();
      await cycle;

      expect(fetchIssueById).toHaveBeenCalledTimes(1);
      await service.runSyncNow();
      expect(fetchIssueById).toHaveBeenCalledTimes(2);
      expect(fetchIssueById).toHaveBeenNthCalledWith(2, "issue-2");
      db.close();
    });

    it("serializes concurrent webhook issue updates and coalesces duplicates", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-webhook-buffer-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
      let releaseFirstFetch!: () => void;
      const firstFetchGate = new Promise<void>((resolve) => {
        releaseFirstFetch = resolve;
      });
      const fetchIssueById = vi.fn(async (issueId: string) => {
        if (issueId === "issue-1") {
          await firstFetchGate;
          return {
            ...issueFixture,
            id: "issue-1",
            raw: { _snapshotHash: "hash-issue-1", _previousSnapshotHash: "hash-0" },
          };
        }
        return {
          ...issueFixture,
          id: "issue-2",
          identifier: "ABC-43",
          raw: { _snapshotHash: "hash-issue-2", _previousSnapshotHash: "hash-0" },
        };
      });

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
          issueHash: vi.fn((issue: NormalizedLinearIssue) => String(issue.raw?._snapshotHash ?? "hash-current")),
        } as any,
        issueTracker: { fetchIssueById } as any,
        dispatcherService: {
          hasActiveRuns: vi.fn(() => false),
          findActiveRunForIssue: vi.fn(() => null),
          createRun: vi.fn(),
          advanceRun: vi.fn(async () => null),
          listActiveRuns: vi.fn(() => []),
          listQueue: vi.fn(() => []),
          resolveRunAction: vi.fn(),
        } as any,
        autoStart: false,
      });

      const first = service.processIssueUpdate("issue-1");
      await Promise.resolve();
      await service.processIssueUpdate("issue-2");
      await service.processIssueUpdate("issue-2");
      releaseFirstFetch();
      await first;

      expect(fetchIssueById).toHaveBeenCalledTimes(2);
      expect(fetchIssueById).toHaveBeenNthCalledWith(1, "issue-1");
      expect(fetchIssueById).toHaveBeenNthCalledWith(2, "issue-2");
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

      const watchOnlyIssue: NormalizedLinearIssue = {
        ...issueFixture,
        raw: { _snapshotHash: "hash-new", _previousSnapshotHash: "hash-old" },
      };

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
          fetchCandidates: vi.fn(async () => [watchOnlyIssue]),
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
      expect(resolveRunAction).toHaveBeenCalledWith("run-1", "retry", undefined, policy, "agent:worker-1", undefined);
      db.close();
    });

    it("forwards laneId through queue resolution resumes", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-sync-lane-"));
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
          listQueue: vi.fn(() => [{ id: "run-1", laneId: "lane-2" }]),
          resolveRunAction,
          getRunDetail: vi.fn(async () => null),
        } as any,
        autoStart: false,
      });

      await service.resolveQueueItem({ queueItemId: "run-1", action: "resume", laneId: "lane-2" });
      expect(resolveRunAction).toHaveBeenCalledWith("run-1", "resume", undefined, policy, undefined, "lane-2");
      db.close();
    });
  });

});

describe("linearDispatcherService (file group)", () => {

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

    it("resumes awaiting-delegation runs after an operator picks an override", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-resume-awaiting-delegation-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
      const policy = buildEmployeeSessionPolicy();
      const employeeIssue = {
        ...issueFixture,
        assigneeId: "unknown-agent",
        assigneeName: "Unknown Agent",
        labels: ["workflow:backend"],
      };
      const ensureIdentitySession = vi.fn(async () => ({ id: "session-override-1" }));

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
          ensureIdentitySession,
          sendMessage: vi.fn(async () => ({ id: "message-1" })),
          listSessions: vi.fn(async () => []),
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

      const run = dispatcher.createRun(employeeIssue, buildMatch(policy));
      const awaitingDelegation = await dispatcher.advanceRun(run.id, policy);
      expect(awaitingDelegation?.status).toBe("awaiting_delegation");

      const queued = await dispatcher.resolveRunAction(run.id, "resume", "Use CTO.", policy, "cto");
      expect(queued?.status).toBe("queued");

      const resumed = await dispatcher.advanceRun(run.id, policy);
      expect(resumed?.status).toBe("waiting_for_target");
      expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({
        identityKey: "cto",
        laneId: "lane-1",
      }));
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

    it("resumes awaiting-lane-choice runs after an operator picks a lane", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-dispatcher-lane-choice-"));
      const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);
      const policy = buildDirectCtoSessionPolicy({
        laneSelection: "operator_prompt",
        sessionReuse: "reuse_existing",
      });
      const ensureIdentitySession = vi.fn(async () => ({ id: "session-cto-2" }));

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
          listSessions: vi.fn(async () => []),
        } as any,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [
            { id: "lane-1", laneType: "primary", name: "Primary" },
            { id: "lane-2", laneType: "worktree", name: "Existing lane" },
          ]),
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
      const awaitingLaneChoice = await dispatcher.advanceRun(run.id, policy);

      expect(awaitingLaneChoice?.status).toBe("awaiting_lane_choice");

      const queued = await dispatcher.resolveRunAction(run.id, "resume", "Use the existing lane.", policy, undefined, "lane-2");
      expect(queued?.executionLaneId).toBe("lane-2");

      await dispatcher.advanceRun(run.id, policy);

      expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({
        identityKey: "cto",
        laneId: "lane-2",
      }));
      expect(dispatcher.listQueue()[0]).toEqual(expect.objectContaining({
        laneId: "lane-2",
        sessionId: "session-cto-2",
      }));
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
      expect(updateBodies[updateBodies.length - 1]).toContain(pathToFileURL(fs.realpathSync(artifactPath)).href);
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

});

describe("linearOutboundService (file group)", () => {

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
    identifier: "ABC-12",
    title: "Stabilize auth refresh",
    description: "Auth refresh sometimes fails after idle timeout.",
    url: "https://linear.app/acme/issue/ABC-12",
    projectId: "proj-1",
    projectSlug: "acme-platform",
    teamId: "team-1",
    teamKey: "ACME",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug"],
    assigneeId: null,
    assigneeName: null,
    ownerId: "user-1",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    raw: {},
  };

  describe("linearOutboundService", () => {
    it("keeps one persistent workpad comment and avoids duplicate updates for identical body", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-outbound-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());

      const createComment = vi.fn(async () => ({ commentId: "comment-1" }));
      const updateComment = vi.fn(async () => {});
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment,
          updateComment,
          uploadAttachment: vi.fn(),
        } as any,
        logger: createLogger(),
      });

      await service.publishMissionStart({
        issue: issueFixture,
        missionId: "mission-1",
        missionTitle: "Fix auth refresh",
        templateId: "bug-fix",
        routeReason: "Matched bug rule",
        workerName: "Backend Dev",
      });
      expect(createComment).toHaveBeenCalledTimes(1);

      await service.publishMissionProgress({
        issue: issueFixture,
        missionId: "mission-1",
        status: "in_progress",
        stepSummary: "1/3 steps completed.",
      });
      await service.publishMissionProgress({
        issue: issueFixture,
        missionId: "mission-1",
        status: "in_progress",
        stepSummary: "1/3 steps completed.",
      });

      expect(updateComment).toHaveBeenCalledTimes(1);
      db.close();
    });

    it("reuses the same workpad comment across workflow launch, progress, and final closeout", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-workpad-lifecycle-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());
      const createComment = vi.fn(async () => ({ commentId: "comment-workpad-1" }));
      const updateBodies: string[] = [];
      const updateComment = vi.fn(async (_commentId: string, body: string) => {
        updateBodies.push(body);
      });
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment,
          updateComment,
          uploadAttachment: vi.fn(),
        } as any,
        logger: createLogger(),
      });

      await service.publishWorkflowStatus({
        issue: issueFixture,
        workflowName: "Assigned worker run",
        runId: "run-1",
        targetType: "worker_run",
        state: "waiting_for_target",
        currentStep: "Launch worker run",
        delegatedOwner: "backend-dev",
        laneId: "lane-22",
        workerRunId: "worker-run-22",
        note: "Delegated the issue into a dedicated worker lane.",
      });
      await service.publishWorkflowStatus({
        issue: issueFixture,
        workflowName: "Assigned worker run",
        runId: "run-1",
        targetType: "worker_run",
        state: "waiting_for_pr",
        currentStep: "Wait for PR",
        delegatedOwner: "backend-dev",
        laneId: "lane-22",
        workerRunId: "worker-run-22",
        prId: "pr-22",
        waitingFor: "review-ready PR",
        note: "PR linked and awaiting review-ready state.",
      });
      await service.publishWorkflowCloseout({
        issue: issueFixture,
        status: "completed",
        summary: "Validated proof and closed out the delegated workflow.",
        targetLabel: "worker run",
        targetId: "worker-run-22",
        contextLines: ["Lane: lane-22", "Linked PR record: pr-22"],
        prLinks: ["https://github.com/acme/repo/pull/22"],
        artifactMode: "links",
      });

      expect(createComment).toHaveBeenCalledTimes(1);
      expect(updateComment).toHaveBeenCalledTimes(2);
      expect(updateBodies[0]).toContain("- Lane: lane-22");
      expect(updateBodies[0]).toContain("- Worker run: worker-run-22");
      expect(updateBodies[1]).toContain("### Closeout Summary");
      expect(updateBodies[1]).toContain("https://github.com/acme/repo/pull/22");

      const stored = db.get<{ comment_id: string }>(
        `select comment_id from linear_workpads where project_id = ? and issue_id = ? limit 1`,
        ["project-1", issueFixture.id]
      );
      expect(stored?.comment_id).toBe("comment-workpad-1");
      db.close();
    });

    it("preserves inside-project artifact links and rejects files outside the project root", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-artifacts-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());
      const insideArtifact = path.join(root, "build.log");
      fs.writeFileSync(insideArtifact, "log", "utf8");
      const outsideArtifact = path.join(os.tmpdir(), "outside.log");
      fs.writeFileSync(outsideArtifact, "outside", "utf8");
      const insideCanonicalUri = pathToFileURL(fs.realpathSync(insideArtifact)).href;
      const outsideCanonicalUri = pathToFileURL(fs.realpathSync(outsideArtifact)).href;
      const insideUri = pathToFileURL(insideArtifact).href;
      const outsideUri = pathToFileURL(outsideArtifact).href;

      const updateBodies: string[] = [];
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment: vi.fn(async () => ({ commentId: "comment-1" })),
          updateComment: vi.fn(async (_commentId: string, body: string) => {
            updateBodies.push(body);
          }),
          uploadAttachment: vi.fn(),
        } as any,
        logger: createLogger(),
      });

      await service.publishMissionStart({
        issue: issueFixture,
        missionId: "mission-1",
        missionTitle: "Auth mission",
        templateId: "bug-fix",
        routeReason: "Matched bug",
      });

      await service.publishWorkflowCloseout({
        issue: issueFixture,
        status: "completed",
        summary: "Shipped",
        targetLabel: "employee session",
        targetId: "session-1",
        contextLines: ["Workflow target: employee_session"],
        artifactMode: "links",
        artifactPaths: [insideArtifact, insideUri, outsideArtifact, outsideUri, "https://example.com/artifact.txt"],
      });

      const latest = updateBodies[updateBodies.length - 1] ?? "";
      expect(latest).toContain(insideCanonicalUri);
      expect(latest).toContain("https://example.com/artifact.txt");
      expect(latest).not.toContain(outsideCanonicalUri);
      db.close();
    });

    it("uploads attachment-mode artifacts from inside the project root and skips files outside it", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-attachment-upload-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());
      const insideArtifact = path.join(root, "inside.png");
      const outsideArtifact = path.join(os.tmpdir(), `ade-outside-${Date.now()}.png`);
      fs.writeFileSync(insideArtifact, "inside", "utf8");
      fs.writeFileSync(outsideArtifact, "outside", "utf8");

      const uploadAttachment = vi.fn(async ({ filePath }: { filePath: string }) => ({
        url: `https://linear.example/${path.basename(filePath)}`,
      }));
      const updateBodies: string[] = [];
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment: vi.fn(async () => ({ commentId: "comment-1" })),
          updateComment: vi.fn(async (_commentId: string, body: string) => {
            updateBodies.push(body);
          }),
          uploadAttachment,
        } as any,
        logger: createLogger(),
      });

      await service.publishMissionStart({
        issue: issueFixture,
        missionId: "mission-1",
        missionTitle: "Auth mission",
        templateId: "bug-fix",
        routeReason: "Matched bug",
      });

      await service.publishWorkflowCloseout({
        issue: issueFixture,
        status: "completed",
        summary: "Uploaded proof artifacts.",
        targetLabel: "employee session",
        targetId: "session-1",
        artifactMode: "attachments",
        artifactPaths: [insideArtifact, outsideArtifact],
      });

      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(uploadAttachment).toHaveBeenCalledWith({
        issueId: issueFixture.id,
        filePath: insideArtifact,
        title: path.basename(insideArtifact),
      });

      const latest = updateBodies[updateBodies.length - 1] ?? "";
      expect(latest).toContain(`https://linear.example/${path.basename(insideArtifact)}`);
      expect(latest).not.toContain(`https://linear.example/${path.basename(outsideArtifact)}`);
      db.close();
    });

    it("keeps the mission closeout wrapper body shape stable", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-mission-closeout-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());
      const updateBodies: string[] = [];
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment: vi.fn(async () => ({ commentId: "comment-1" })),
          updateComment: vi.fn(async (_commentId: string, body: string) => {
            updateBodies.push(body);
          }),
          uploadAttachment: vi.fn(),
        } as any,
        logger: createLogger(),
      });

      await service.publishMissionStart({
        issue: issueFixture,
        missionId: "mission-1",
        missionTitle: "Auth mission",
        templateId: "bug-fix",
        routeReason: "Matched bug",
      });

      await service.publishMissionCloseout({
        issue: issueFixture,
        missionId: "mission-1",
        status: "completed",
        summary: "Shipped",
        artifactMode: "links",
      });

      const latest = updateBodies[updateBodies.length - 1] ?? "";
      expect(latest).toContain("- Mission: mission-1");
      expect(latest).not.toContain("- Target:");
      db.close();
    });

    it("renders comment templates for workflow status and closeout bodies", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-comment-"));
      const db = await openKvDb(path.join(root, "ade.db"), createLogger());
      const createBodies: string[] = [];
      const bodies: string[] = [];
      const service = createLinearOutboundService({
        db,
        projectId: "project-1",
        projectRoot: root,
        issueTracker: {
          createComment: vi.fn(async (_issueId: string, body: string) => {
            createBodies.push(body);
            return { commentId: "comment-1" };
          }),
          updateComment: vi.fn(async (_commentId: string, body: string) => {
            bodies.push(body);
          }),
          uploadAttachment: vi.fn(),
        } as any,
        logger: createLogger(),
      });

      await service.publishWorkflowStatus({
        issue: issueFixture,
        workflowName: "Assigned worker run",
        runId: "run-7",
        targetType: "worker_run",
        state: "waiting_for_target",
        note: "Delegated the issue.",
        waitingFor: "delegated work",
        commentTemplate: [
          "Issue {{ issue.identifier }}",
          "Workflow {{ workflow.name }}",
          "Target {{ target.type }}",
          "Note {{ note }}",
        ].join("\n"),
      });

      await service.publishWorkflowCloseout({
        issue: issueFixture,
        status: "completed",
        summary: "Closed.",
        targetLabel: "worker run",
        targetId: "worker-22",
        artifactMode: "links",
        commentTemplate: "Closeout {{ issue.identifier }} {{ target.id }} {{ note }}",
      });

      expect(createBodies[0]).toContain("Issue ABC-12");
      expect(createBodies[0]).toContain("Workflow Assigned worker run");
      expect(createBodies[0]).toContain("Target worker_run");
      expect(bodies[0]).toContain("Closeout ABC-12 worker-22 Closed.");
      db.close();
    });
  });

});

describe("linearTemplateService (file group)", () => {

  const issueFixture: NormalizedLinearIssue = {
    id: "issue-1",
    identifier: "ABC-12",
    title: "Fix auth token refresh",
    description: "Refresh token flow fails when access token is expired.",
    url: "https://linear.app/acme/issue/ABC-12",
    projectId: "proj-1",
    projectSlug: "acme-platform",
    teamId: "team-1",
    teamKey: "ACME",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug", "auth"],
    assigneeId: null,
    assigneeName: null,
    ownerId: "user-1",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    raw: {},
  };

  describe("linearTemplateService", () => {
    it("renders placeholders from template yaml", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-"));
      const templatesDir = path.join(root, ".ade", "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      fs.writeFileSync(
        path.join(templatesDir, "bug.yaml"),
        [
          "id: bug-fix",
          "name: Bug Fix",
          "promptTemplate: |-",
          "  Issue {{ issue.identifier }}",
          "  Worker {{ worker.name }}",
          "  Reason {{ route.reason }}",
        ].join("\n"),
        "utf8"
      );

      const service = createLinearTemplateService({ adeDir: path.join(root, ".ade") });
      const rendered = service.renderTemplate({
        templateId: "bug-fix",
        issue: issueFixture,
        route: { reason: "Matched bug rule" },
        worker: { name: "Backend Dev" },
      });

      expect(rendered.templateId).toBe("bug-fix");
      expect(rendered.prompt).toContain("Issue ABC-12");
      expect(rendered.prompt).toContain("Worker Backend Dev");
      expect(rendered.prompt).toContain("Reason Matched bug rule");
    });

    it("falls back to default template when no template files exist", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-empty-"));
      const service = createLinearTemplateService({ adeDir: path.join(root, ".ade") });

      const rendered = service.renderTemplate({
        templateId: "missing-template",
        issue: issueFixture,
      });

      expect(rendered.templateId).toBe("default");
      expect(rendered.prompt).toContain("Handle the following Linear issue end to end.");
      expect(rendered.prompt).toContain("ABC-12");
    });
  });

});

describe("linearWorkflowFileService (file group)", () => {

  function createFixtureRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-workflows-"));
  }

  describe("linearWorkflowFileService", () => {
    it("generates editable starter workflows when the repo has no workflow files", () => {
      const root = createFixtureRoot();
      const service = createLinearWorkflowFileService({ projectRoot: root });

      const loaded = service.load(null);

      expect(loaded.source).toBe("generated");
      expect(loaded.migration?.needsSave).toBe(true);
      expect(loaded.intake.activeStateTypes).toEqual(["backlog", "unstarted", "started"]);
      expect(loaded.intake.terminalStateTypes).toEqual(["completed", "canceled"]);
      expect(loaded.settings.ctoLinearAssigneeName).toBe("CTO");
      expect(loaded.workflows.map((workflow) => workflow.id)).toEqual([
        "cto-mission-autopilot",
        "cto-direct-employee-session",
        "cto-worker-run-autopilot",
        "cto-pr-fast-lane",
        "cto-human-review-gate",
      ]);
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-direct-employee-session")?.steps.map((step) => step.type)).toEqual([
        "set_linear_state",
        "launch_target",
        "wait_for_target_status",
        "emit_app_notification",
        "complete_issue",
      ]);
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-worker-run-autopilot")?.steps.map((step) => step.type)).toEqual([
        "set_linear_state",
        "launch_target",
        "wait_for_target_status",
        "emit_app_notification",
        "complete_issue",
      ]);
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-pr-fast-lane")?.steps.map((step) => step.type)).toEqual([
        "set_linear_state",
        "launch_target",
        "wait_for_pr",
        "emit_app_notification",
        "complete_issue",
      ]);
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-direct-employee-session")?.target.laneSelection).toBe("fresh_issue_lane");
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-direct-employee-session")?.target.sessionReuse).toBe("fresh_session");
      expect(loaded.workflows.find((workflow) => workflow.id === "cto-worker-run-autopilot")?.target.laneSelection).toBe("fresh_issue_lane");

      const saved = service.save(loaded);

      expect(saved.source).toBe("repo");
      expect(saved.files.some((file) => file.kind === "settings")).toBe(true);
      expect(saved.files.filter((file) => file.kind === "workflow")).toHaveLength(5);
      expect(fs.existsSync(path.join(root, ".ade", "workflows", "linear", "_settings.yaml"))).toBe(true);
    });

    it("migrates legacy LinearSyncConfig into repo workflows and writes a compatibility snapshot", () => {
      const root = createFixtureRoot();
      const service = createLinearWorkflowFileService({ projectRoot: root });
      const legacy: LinearSyncConfig = {
        enabled: true,
        projects: [{ slug: "acme-platform", defaultWorker: "backend-dev" }],
        routing: {
          byLabel: {
            bug: "backend-hotfix",
          },
        },
        autoDispatch: {
          default: "auto",
          rules: [
            {
              id: "legacy-bug-rule",
              action: "auto",
              template: "fast-track",
              match: {
                labels: ["bug"],
                projectSlugs: ["acme-platform"],
                priority: ["high"],
              },
            },
          ],
        },
        concurrency: {
          global: 7,
        },
        artifacts: {
          mode: "attachments",
        },
      };

      const loaded = service.load(legacy);
      const migrated = loaded.workflows.find((workflow) => workflow.id === "legacy-bug-rule");

      expect(loaded.source).toBe("generated");
      expect(loaded.migration?.hasLegacyConfig).toBe(true);
      expect(loaded.migration?.needsSave).toBe(true);
      expect(loaded.intake.projectSlugs).toEqual(["acme-platform"]);
      expect(loaded.intake.activeStateTypes).toEqual(["backlog", "unstarted", "started"]);
      expect(loaded.intake.terminalStateTypes).toEqual(["completed", "canceled"]);
      expect(migrated?.target.type).toBe("mission");
      expect(migrated?.target.missionTemplate).toBe("fast-track");
      expect(migrated?.target.workerSelector).toEqual({ mode: "slug", value: "backend-hotfix" });
      expect(migrated?.triggers.labels).toEqual(["bug"]);
      expect(migrated?.triggers.projectSlugs).toEqual(["acme-platform"]);
      expect(migrated?.closeout?.artifactMode).toBe("attachments");
      expect(migrated?.concurrency?.maxActiveRuns).toBe(7);

      const saved = service.save(loaded);

      expect(saved.source).toBe("repo");
      expect(saved.migration?.needsSave).toBe(false);
      expect(saved.migration?.compatibilitySnapshotPath).toBe(service.legacySnapshotPath);
      expect(fs.existsSync(service.legacySnapshotPath)).toBe(true);
    });
  });

});
