import { randomUUID } from "node:crypto";
import type {
  CtoGetLinearWorkflowRunDetailArgs,
  CtoResolveLinearSyncQueueItemArgs,
  LinearSyncDashboard,
  LinearSyncEventRecord,
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
import { getErrorMessage, nowIso, safeJsonParse } from "../shared/utils";

const DEFAULT_TERMINAL_STATE_TYPES = ["completed", "canceled"] as const;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim().toLowerCase() ?? "").filter(Boolean)));
}

function getTerminalStateTypes(policy: LinearWorkflowConfig): string[] {
  const values = uniqueStrings(policy.intake.terminalStateTypes ?? [...DEFAULT_TERMINAL_STATE_TYPES]);
  return values.length ? values : [...DEFAULT_TERMINAL_STATE_TYPES];
}

function isIssueOpen(issue: NormalizedLinearIssue, policy: LinearWorkflowConfig): boolean {
  return !new Set(getTerminalStateTypes(policy)).has((issue.stateType ?? "").trim().toLowerCase());
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
  onIssueUpdated?: (args: { issue: NormalizedLinearIssue; previousIssue: Partial<NormalizedLinearIssue> | null }) => void | Promise<void>;
}) {
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let lastSkipReason: string | null = null;
  const reconciliationIntervalSec = Math.max(15, Math.floor(args.reconciliationIntervalSec ?? 30));

  const appendSyncEvent = (input: {
    issueId?: string | null;
    queueItemId?: string | null;
    eventType: string;
    status?: string | null;
    message?: string | null;
    payload?: Record<string, unknown> | null;
  }): void => {
    args.db.run(
      `
        insert into linear_sync_events(id, project_id, issue_id, queue_item_id, event_type, status, message, payload_json, created_at)
        values(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        args.projectId,
        input.issueId ?? null,
        input.queueItemId ?? null,
        input.eventType,
        input.status ?? null,
        input.message ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        nowIso(),
      ],
    );
  };

  const listRecentSyncEvents = (limit = 12): LinearSyncEventRecord[] =>
    args.db.all<{
      id: string;
      issue_id: string | null;
      queue_item_id: string | null;
      event_type: string;
      status: string | null;
      message: string | null;
      payload_json: string | null;
      created_at: string;
    }>(
      `
        select id, issue_id, queue_item_id, event_type, status, message, payload_json, created_at
        from linear_sync_events
        where project_id = ?
        order by datetime(created_at) desc
        limit ?
      `,
      [args.projectId, Math.max(1, Math.floor(limit))],
    ).map((row) => ({
      id: row.id,
      issueId: row.issue_id,
      queueItemId: row.queue_item_id,
      eventType: row.event_type,
      status: row.status,
      message: row.message,
      payload: safeJsonParse<Record<string, unknown> | null>(row.payload_json, null),
      createdAt: row.created_at,
    }));

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
    if (!isIssueOpen(issue, policy)) {
      const activeRuns = args.dispatcherService.listActiveRuns().filter((run) => run.issueId === issue.id);
      for (const activeRun of activeRuns) {
        appendSyncEvent({
          issueId: issue.id,
          queueItemId: activeRun.id,
          eventType: "issue_closed",
          status: "cancelled",
          message: `Issue is now ${issue.stateType}; cancelling the active workflow run.`,
        });
        await args.dispatcherService.cancelRun(activeRun.id, `Issue externally ${issue.stateType}`, policy);
      }
      return;
    }
    const activeRun = args.dispatcherService.findActiveRunForIssue(issue.id);
    if (!activeRun) {
      const match = await args.routingService.routeIssue({ issue, policy });
      if (!match.workflow) return;
      if (match.workflow.routing?.watchOnly) {
        if (!snapshotChanged(issue)) return;
        appendSyncEvent({
          issueId: issue.id,
          eventType: "watch_only_match",
          status: "observed",
          message: `Observed '${issue.identifier}' with watch-only workflow '${match.workflow.name}'.`,
          payload: {
            workflowId: match.workflow.id,
            workflowName: match.workflow.name,
            reason: match.reason,
            matchedSignals: match.candidates.find((candidate) => candidate.workflowId === match.workflow?.id)?.matchedSignals ?? [],
          },
        });
        return;
      }
      if (!snapshotChanged(issue)) return;
      const activeRuns = args.dispatcherService.listActiveRuns();
      const workflowActiveRuns = activeRuns.filter((run) => run.workflowId === match.workflow!.id);
      const issueWorkflowRuns = workflowActiveRuns.filter((run) => run.issueId === issue.id);
      const maxActiveRuns = match.workflow.concurrency?.maxActiveRuns;
      if (maxActiveRuns != null && workflowActiveRuns.length >= maxActiveRuns) {
        appendSyncEvent({
          issueId: issue.id,
          eventType: "workflow_capacity_wait",
          status: "deferred",
          message: `Workflow '${match.workflow.name}' is at capacity.`,
          payload: {
            workflowId: match.workflow.id,
            activeRuns: workflowActiveRuns.length,
            maxActiveRuns,
          },
        });
        return;
      }
      const dedupeByIssue = match.workflow.concurrency?.dedupeByIssue !== false;
      if (dedupeByIssue && issueWorkflowRuns.length > 0) {
        appendSyncEvent({
          issueId: issue.id,
          eventType: "issue_deduped",
          status: "deferred",
          message: `Skipped duplicate run for '${issue.identifier}' in workflow '${match.workflow.name}'.`,
          payload: {
            workflowId: match.workflow.id,
            activeRunIds: issueWorkflowRuns.map((run) => run.id),
          },
        });
        return;
      }
      const perIssue = match.workflow.concurrency?.perIssue;
      if (perIssue != null && issueWorkflowRuns.length >= perIssue) {
        appendSyncEvent({
          issueId: issue.id,
          eventType: "issue_per_workflow_limit",
          status: "deferred",
          message: `Issue '${issue.identifier}' already has ${issueWorkflowRuns.length} active run(s) for '${match.workflow.name}'.`,
          payload: {
            workflowId: match.workflow.id,
            activeRuns: issueWorkflowRuns.length,
            perIssue,
          },
        });
        return;
      }
      const run = args.dispatcherService.createRun(issue, match);
      appendSyncEvent({
        issueId: issue.id,
        queueItemId: run.id,
        eventType: "run_created",
        status: "queued",
        message: `Queued workflow '${match.workflow.name}' for '${issue.identifier}'.`,
        payload: {
          workflowId: match.workflow.id,
          workflowName: match.workflow.name,
          reason: match.reason,
        },
      });
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
    const previousSnapshotRow = args.db.get<{ payload_json: string | null; hash: string | null }>(
      `
        select payload_json, hash
        from linear_issue_snapshots
        where project_id = ?
          and issue_id = ?
        limit 1
      `,
      [args.projectId, issueId]
    );
    const previousIssue = previousSnapshotRow?.payload_json
      ? safeJsonParse<Partial<NormalizedLinearIssue> | null>(previousSnapshotRow.payload_json, null)
      : null;
    const issueWithHistory: NormalizedLinearIssue = {
      ...issue,
      previousStateId: previousIssue?.stateId ?? null,
      previousStateName: previousIssue?.stateName ?? null,
      previousStateType: previousIssue?.stateType ?? null,
      raw: {
        ...(issue.raw ?? {}),
        _snapshotHash: args.intakeService.issueHash(issue),
        _previousSnapshotHash: previousSnapshotRow?.hash ?? null,
      },
    };
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
        await processIssueSnapshot(issueWithHistory, policy);
      }
      await advanceRuns(policy);
      await args.onIssueUpdated?.({ issue: issueWithHistory, previousIssue });
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
    const watchOnlyHits = Number(
      args.db.get<{ total: number }>(
        `
          select count(*) as total
          from linear_sync_events
          where project_id = ?
            and event_type = 'watch_only_match'
        `,
        [args.projectId],
      )?.total ?? 0,
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
      watchOnlyHits,
      recentEvents: listRecentSyncEvents(),
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
    const run = await args.dispatcherService.resolveRunAction(
      input.queueItemId,
      input.action,
      input.note,
      policy,
      input.employeeOverride,
    );
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
