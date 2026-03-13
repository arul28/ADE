import type {
  CtoGetLinearWorkflowRunDetailArgs,
  CtoResolveLinearSyncQueueItemArgs,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowConfig,
  LinearWorkflowRunDetail,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { FlowPolicyService } from "./flowPolicyService";
import type { LinearRoutingService } from "./linearRoutingService";
import type { LinearIntakeService } from "./linearIntakeService";
import type { LinearDispatcherService } from "./linearDispatcherService";
import type { IssueTracker } from "./issueTracker";
import { getErrorMessage, nowIso } from "../shared/utils";

function isIssueOpen(issue: NormalizedLinearIssue): boolean {
  return issue.stateType !== "completed" && issue.stateType !== "canceled";
}

function snapshotChanged(issue: NormalizedLinearIssue): boolean {
  const raw = issue.raw ?? {};
  const currentHash = typeof raw._snapshotHash === "string" ? raw._snapshotHash : "";
  const previousHash = typeof raw._previousSnapshotHash === "string" ? raw._previousSnapshotHash : "";
  return currentHash.length > 0 && currentHash !== previousHash;
}

function workflowEnabled(policy: LinearWorkflowConfig): boolean {
  return policy.workflows.some((workflow) => workflow.enabled);
}

export function createLinearSyncService(args: {
  db: AdeDb;
  logger?: Logger | null;
  projectId: string;
  flowPolicyService: FlowPolicyService;
  routingService: LinearRoutingService;
  intakeService: LinearIntakeService;
  issueTracker: IssueTracker;
  dispatcherService: LinearDispatcherService;
  reconciliationIntervalSec?: number;
  autoStart?: boolean;
  hasCredentials?: () => boolean;
}) {
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let lastSkipReason: string | null = null;
  const reconciliationIntervalSec = Math.max(15, Math.floor(args.reconciliationIntervalSec ?? 30));

  const logSkip = (reason: "no_enabled_workflows" | "no_credentials", meta: Record<string, unknown>) => {
    if (lastSkipReason === reason) return;
    lastSkipReason = reason;
    args.logger?.info("linear_workflow.sync_cycle_skipped", {
      reason,
      ...meta,
    });
  };

  const clearSkipReason = () => {
    lastSkipReason = null;
  };

  const setSyncState = (patch: {
    enabled?: boolean;
    running?: boolean;
    lastPollAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
  }) => {
    const existing = args.db.get<{
      enabled: number;
      running: number;
      last_poll_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>(
      `
        select enabled, running, last_poll_at, last_success_at, last_error
        from linear_sync_state
        where project_id = ?
        limit 1
      `,
      [args.projectId]
    );
    args.db.run(
      `
        insert into linear_sync_state(project_id, enabled, running, last_poll_at, last_success_at, last_error, health_json, updated_at)
        values(?, ?, ?, ?, ?, ?, '{}', ?)
        on conflict(project_id) do update set
          enabled = excluded.enabled,
          running = excluded.running,
          last_poll_at = excluded.last_poll_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
      [
        args.projectId,
        patch.enabled != null ? (patch.enabled ? 1 : 0) : existing?.enabled ?? 0,
        patch.running != null ? (patch.running ? 1 : 0) : existing?.running ?? 0,
        patch.lastPollAt !== undefined ? patch.lastPollAt : existing?.last_poll_at ?? null,
        patch.lastSuccessAt !== undefined ? patch.lastSuccessAt : existing?.last_success_at ?? null,
        patch.lastError !== undefined ? patch.lastError : existing?.last_error ?? null,
        nowIso(),
      ]
    );
  };

  const releaseDueRetries = () => {
    args.db.run(
      `
        update linear_workflow_runs
        set status = 'queued',
            retry_after = null,
            updated_at = ?
        where project_id = ?
          and status = 'retry_wait'
          and retry_after is not null
          and retry_after <= ?
      `,
      [nowIso(), args.projectId, nowIso()]
    );
  };

  const dispatchNewRuns = async (policy: LinearWorkflowConfig) => {
    const candidates = await args.intakeService.fetchCandidates(policy);
    for (const issue of candidates) {
      await processIssueSnapshot(issue, policy);
    }
  };

  const processIssueSnapshot = async (issue: NormalizedLinearIssue, policy: LinearWorkflowConfig): Promise<void> => {
    args.intakeService.persistSnapshot(issue);
    if (!isIssueOpen(issue)) return;
    const activeRun = args.dispatcherService.findActiveRunForIssue(issue.id);
    if (!activeRun && !snapshotChanged(issue)) return;
    if (!activeRun) {
      const match = await args.routingService.routeIssue({ issue, policy });
      if (!match.workflow) return;
      const run = args.dispatcherService.createRun(issue, match);
      await args.dispatcherService.advanceRun(run.id, policy);
      return;
    }
    await args.dispatcherService.advanceRun(activeRun.id, policy);
  };

  const advanceRuns = async (policy: LinearWorkflowConfig) => {
    for (const run of args.dispatcherService.listActiveRuns()) {
      if (run.status === "retry_wait" && run.retryAfter && run.retryAfter > nowIso()) {
        continue;
      }
      if (run.status === "awaiting_human_review" && run.reviewState !== "approved") {
        continue;
      }
      await args.dispatcherService.advanceRun(run.id, policy);
    }
  };

  const runCycle = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    const policy = args.flowPolicyService.getPolicy();
    const workflowsEnabled = workflowEnabled(policy);
    const hasActiveRuns = args.dispatcherService.hasActiveRuns();
    const hasCredentials = args.hasCredentials?.() ?? true;
    setSyncState({
      enabled: workflowsEnabled,
      running: true,
      lastPollAt: nowIso(),
      lastError: null,
    });
    try {
      if (!workflowsEnabled && !hasActiveRuns) {
        logSkip("no_enabled_workflows", {
          activeRuns: 0,
        });
        setSyncState({
          running: false,
          lastSuccessAt: nowIso(),
        });
        return;
      }
      if (!hasCredentials && !hasActiveRuns) {
        logSkip("no_credentials", {
          activeRuns: 0,
          workflowsEnabled,
        });
        setSyncState({
          running: false,
          lastSuccessAt: nowIso(),
        });
        return;
      }
      clearSkipReason();
      releaseDueRetries();
      if (workflowsEnabled && hasCredentials) {
        await dispatchNewRuns(policy);
      }
      await advanceRuns(policy);
      setSyncState({
        running: false,
        lastSuccessAt: nowIso(),
      });
    } catch (error) {
      clearSkipReason();
      const message = getErrorMessage(error);
      args.logger?.warn("linear_workflow.sync_cycle_failed", {
        error: message,
      });
      setSyncState({
        running: false,
        lastError: message,
      });
    } finally {
      inFlight = false;
    }
  };

  const processIssueUpdate = async (issueId: string): Promise<void> => {
    if (disposed) return;
    if (!(args.hasCredentials?.() ?? true) && !args.dispatcherService.hasActiveRuns()) {
      args.logger?.info("linear_workflow.issue_update_skipped", {
        reason: "no_credentials",
        issueId,
      });
      return;
    }
    const issue = await args.issueTracker.fetchIssueById(issueId);
    if (!issue) return;
    const policy = args.flowPolicyService.getPolicy();
    const workflowsEnabled = workflowEnabled(policy);
    setSyncState({
      enabled: workflowsEnabled,
      running: true,
      lastPollAt: nowIso(),
      lastError: null,
    });
    try {
      releaseDueRetries();
      if (workflowsEnabled) {
        await processIssueSnapshot(issue, policy);
      }
      await advanceRuns(policy);
      setSyncState({
        running: false,
        lastSuccessAt: nowIso(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      setSyncState({
        running: false,
        lastError: message,
      });
      throw error;
    }
  };

  const processActiveRunsNow = async (): Promise<void> => {
    if (disposed) return;
    const policy = args.flowPolicyService.getPolicy();
    await advanceRuns(policy);
  };

  const getDashboard = (): LinearSyncDashboard => {
    const state = args.db.get<{
      enabled: number;
      running: number;
      last_poll_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>(
      `
        select enabled, running, last_poll_at, last_success_at, last_error
        from linear_sync_state
        where project_id = ?
        limit 1
      `,
      [args.projectId]
    );
    const queue = args.dispatcherService.listQueue();
    const counts = queue.reduce(
      (acc, item) => {
        if (item.status === "queued") acc.queued += 1;
        else if (item.status === "retry_wait") acc.retryWaiting += 1;
        else if (item.status === "escalated") acc.escalated += 1;
        else if (item.status === "dispatched") acc.dispatched += 1;
        else if (item.status === "failed") acc.failed += 1;
        return acc;
      },
      { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 }
    );

    return {
      enabled: Boolean(state?.enabled ?? 0),
      running: Boolean(state?.running ?? 0),
      ingressMode: "webhook-first",
      reconciliationIntervalSec,
      lastPollAt: state?.last_poll_at ?? null,
      lastSuccessAt: state?.last_success_at ?? null,
      lastError: state?.last_error ?? null,
      queue: counts,
      claimsActive: counts.queued + counts.retryWaiting + counts.escalated + counts.dispatched,
    };
  };

  const runSyncNow = async (): Promise<LinearSyncDashboard> => {
    await runCycle();
    return getDashboard();
  };

  const listQueue = (_input: { limit?: number } = {}): LinearSyncQueueItem[] => {
    return args.dispatcherService.listQueue();
  };

  const resolveQueueItem = async (input: CtoResolveLinearSyncQueueItemArgs): Promise<LinearSyncQueueItem | null> => {
    const policy = args.flowPolicyService.getPolicy();
    const run = await args.dispatcherService.resolveRunAction(input.queueItemId, input.action, input.note, policy);
    if (!run) return null;
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
      await args.dispatcherService.advanceRun(run.id, policy);
    }
    return args.dispatcherService.listQueue().find((entry) => entry.id === run.id) ?? null;
  };

  const getRunDetail = async (input: CtoGetLinearWorkflowRunDetailArgs): Promise<LinearWorkflowRunDetail | null> => {
    const policy = args.flowPolicyService.getPolicy();
    return args.dispatcherService.getRunDetail(input.runId, policy);
  };

  const dispose = () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = async (): Promise<void> => {
    if (disposed) return;
    if (!timer) {
      timer = setInterval(() => {
        void runCycle();
      }, reconciliationIntervalSec * 1000);
    }
    await runCycle();
  };

  if (args.autoStart !== false) {
    void start();
  }

  return {
    start,
    runSyncNow,
    processIssueUpdate,
    processActiveRunsNow,
    getDashboard,
    listQueue,
    resolveQueueItem,
    getRunDetail,
    dispose,
  };
}

export type LinearSyncService = ReturnType<typeof createLinearSyncService>;
