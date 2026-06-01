import { randomUUID } from "node:crypto";
import type {
  AgentChatIdentityKey,
  LinearWorkflowDefinition,
  LinearWorkflowExecutionContext,
  LinearWorkflowRouteContext,
  LinearWorkflowRun,
  LinearWorkflowRunEvent,
  LinearWorkflowRunStatus,
  LinearWorkflowRunStep,
  LinearWorkflowStep,
  LinearWorkflowTargetStatus,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse } from "../shared/utils";

const ACTIVE_RUN_STATUSES =
  "'queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'awaiting_delegation', 'awaiting_lane_choice', 'retry_wait'";

export type RunRow = {
  id: string;
  issue_id: string;
  identifier: string;
  title: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: string;
  source: "repo" | "generated";
  target_type: LinearWorkflowRun["targetType"];
  status: LinearWorkflowRunStatus;
  current_step_index: number;
  current_step_id: string | null;
  execution_lane_id: string | null;
  linked_session_id: string | null;
  linked_worker_run_id: string | null;
  linked_pr_id: string | null;
  review_state: LinearWorkflowRun["reviewState"];
  supervisor_identity_key: string | null;
  review_ready_reason: LinearWorkflowRun["reviewReadyReason"];
  pr_state: LinearWorkflowRun["prState"];
  pr_checks_status: LinearWorkflowRun["prChecksStatus"];
  pr_review_status: LinearWorkflowRun["prReviewStatus"];
  latest_review_note: string | null;
  retry_count: number;
  retry_after: string | null;
  closeout_state: LinearWorkflowRun["closeoutState"];
  terminal_outcome: LinearWorkflowRun["terminalOutcome"];
  source_issue_snapshot_json: string;
  route_context_json: string | null;
  execution_context_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type StepRow = {
  id: string;
  run_id: string;
  workflow_step_id: string;
  type: LinearWorkflowStep["type"];
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";
  started_at: string | null;
  completed_at: string | null;
  payload_json: string | null;
};

type EventRow = {
  id: string;
  run_id: string;
  event_type: string;
  status: string | null;
  message: string | null;
  payload_json: string | null;
  created_at: string;
};

type RunPatch = Partial<{
  status: LinearWorkflowRunStatus;
  currentStepIndex: number;
  currentStepId: string | null;
  executionLaneId: string | null;
  linkedSessionId: string | null;
  linkedWorkerRunId: string | null;
  linkedPrId: string | null;
  reviewState: LinearWorkflowRun["reviewState"];
  supervisorIdentityKey: AgentChatIdentityKey | null;
  reviewReadyReason: LinearWorkflowRun["reviewReadyReason"];
  prState: LinearWorkflowRun["prState"];
  prChecksStatus: LinearWorkflowRun["prChecksStatus"];
  prReviewStatus: LinearWorkflowRun["prReviewStatus"];
  latestReviewNote: string | null;
  retryCount: number;
  retryAfter: string | null;
  closeoutState: LinearWorkflowRun["closeoutState"];
  terminalOutcome: LinearWorkflowRun["terminalOutcome"];
  routeContext: LinearWorkflowRouteContext | null;
  executionContext: LinearWorkflowExecutionContext | null;
  lastError: string | null;
}>;

type StepPatch = Partial<{
  status: StepRow["status"];
  startedAt: string | null;
  completedAt: string | null;
  payload: Record<string, unknown> | null;
}>;

export function toRun(row: RunRow): LinearWorkflowRun {
  return {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    title: row.title,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    source: row.source,
    targetType: row.target_type,
    status: row.status,
    currentStepIndex: row.current_step_index,
    currentStepId: row.current_step_id,
    executionLaneId: row.execution_lane_id,
    linkedSessionId: row.linked_session_id,
    linkedWorkerRunId: row.linked_worker_run_id,
    linkedPrId: row.linked_pr_id,
    reviewState: row.review_state,
    supervisorIdentityKey: (row.supervisor_identity_key ?? null) as AgentChatIdentityKey | null,
    reviewReadyReason: row.review_ready_reason,
    prState: row.pr_state,
    prChecksStatus: row.pr_checks_status,
    prReviewStatus: row.pr_review_status,
    latestReviewNote: row.latest_review_note,
    retryCount: row.retry_count,
    retryAfter: row.retry_after,
    closeoutState: row.closeout_state,
    terminalOutcome: row.terminal_outcome,
    sourceIssueSnapshot: safeJsonParse<NormalizedLinearIssue | null>(row.source_issue_snapshot_json, null),
    routeContext: safeJsonParse(row.route_context_json, null),
    executionContext: safeJsonParse(row.execution_context_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRunStep(row: StepRow, workflow?: LinearWorkflowDefinition | null): LinearWorkflowRunStep {
  const step = workflow?.steps.find((entry) => entry.id === row.workflow_step_id);
  return {
    id: row.id,
    runId: row.run_id,
    workflowStepId: row.workflow_step_id,
    type: row.type,
    name: step?.name ?? row.workflow_step_id,
    targetStatus:
      step?.type === "wait_for_target_status" && workflow
        ? resolveWorkflowTargetStatus(workflow.target.type, step.targetStatus)
        : step?.targetStatus,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    payload: safeJsonParse(row.payload_json, null),
  };
}

export function toRunEvent(row: EventRow): LinearWorkflowRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    status: row.status,
    message: row.message,
    payload: safeJsonParse(row.payload_json, null),
    createdAt: row.created_at,
  };
}

export function resolveWorkflowTargetStatus(
  _targetType: LinearWorkflowDefinition["target"]["type"],
  targetStatus?: LinearWorkflowTargetStatus | null,
): LinearWorkflowTargetStatus {
  if (!targetStatus || targetStatus === "completed") {
    return "explicit_completion";
  }
  return targetStatus;
}

export function createLinearDispatcherRunStore(args: { db: AdeDb; projectId: string }) {
  const appendEvent = (runId: string, eventType: string, status?: string | null, message?: string | null, payload?: Record<string, unknown> | null): void => {
    args.db.run(
      `
        insert into linear_workflow_run_events(id, project_id, run_id, event_type, status, message, payload_json, created_at)
        values(?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), args.projectId, runId, eventType, status ?? null, message ?? null, payload ? JSON.stringify(payload) : null, nowIso()]
    );
  };

  const getRunRow = (runId: string): RunRow | null =>
    args.db.get<RunRow>(
      `
        select *
        from linear_workflow_runs
        where id = ?
          and project_id = ?
        limit 1
      `,
      [runId, args.projectId]
    );

  const listActiveRuns = (): LinearWorkflowRun[] =>
    args.db
      .all<RunRow>(
        `
          select *
          from linear_workflow_runs
          where project_id = ?
            and status in (${ACTIVE_RUN_STATUSES})
          order by datetime(created_at) asc
        `,
        [args.projectId]
      )
      .map(toRun);

  const hasActiveRuns = (): boolean => {
    const row = args.db.get<{ total: number }>(
      `
        select count(*) as total
        from linear_workflow_runs
        where project_id = ?
          and status in (${ACTIVE_RUN_STATUSES})
        limit 1
      `,
      [args.projectId]
    );
    return Number(row?.total ?? 0) > 0;
  };

  const getStepRows = (runId: string): StepRow[] =>
    args.db.all<StepRow>(
      `
        select *
        from linear_workflow_run_steps
        where run_id = ?
        order by datetime(created_at) asc
      `,
      [runId]
    );

  const getEventRows = (runId: string): EventRow[] =>
    args.db.all<EventRow>(
      `
        select id, run_id, event_type, status, message, payload_json, created_at
        from linear_workflow_run_events
        where run_id = ?
        order by datetime(created_at) asc
      `,
      [runId]
    );

  const updateRun = (runId: string, patch: RunPatch): void => {
    const existing = getRunRow(runId);
    if (!existing) return;
    args.db.run(
      `
        update linear_workflow_runs
        set status = ?,
            current_step_index = ?,
            current_step_id = ?,
            execution_lane_id = ?,
            linked_session_id = ?,
            linked_worker_run_id = ?,
            linked_pr_id = ?,
            review_state = ?,
            supervisor_identity_key = ?,
            review_ready_reason = ?,
            pr_state = ?,
            pr_checks_status = ?,
            pr_review_status = ?,
            latest_review_note = ?,
            retry_count = ?,
            retry_after = ?,
            closeout_state = ?,
            terminal_outcome = ?,
            route_context_json = ?,
            execution_context_json = ?,
            last_error = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        patch.status ?? existing.status,
        patch.currentStepIndex ?? existing.current_step_index,
        patch.currentStepId === undefined ? existing.current_step_id : patch.currentStepId,
        patch.executionLaneId === undefined ? existing.execution_lane_id : patch.executionLaneId,
        patch.linkedSessionId === undefined ? existing.linked_session_id : patch.linkedSessionId,
        patch.linkedWorkerRunId === undefined ? existing.linked_worker_run_id : patch.linkedWorkerRunId,
        patch.linkedPrId === undefined ? existing.linked_pr_id : patch.linkedPrId,
        patch.reviewState === undefined ? existing.review_state : patch.reviewState,
        patch.supervisorIdentityKey === undefined ? existing.supervisor_identity_key : patch.supervisorIdentityKey,
        patch.reviewReadyReason === undefined ? existing.review_ready_reason : (patch.reviewReadyReason ?? null),
        patch.prState === undefined ? existing.pr_state : patch.prState,
        patch.prChecksStatus === undefined ? existing.pr_checks_status : patch.prChecksStatus,
        patch.prReviewStatus === undefined ? existing.pr_review_status : patch.prReviewStatus,
        patch.latestReviewNote === undefined ? existing.latest_review_note : patch.latestReviewNote,
        patch.retryCount ?? existing.retry_count,
        patch.retryAfter === undefined ? existing.retry_after : patch.retryAfter,
        patch.closeoutState ?? existing.closeout_state,
        patch.terminalOutcome === undefined ? existing.terminal_outcome : patch.terminalOutcome,
        patch.routeContext === undefined ? existing.route_context_json : patch.routeContext ? JSON.stringify(patch.routeContext) : null,
        patch.executionContext === undefined ? existing.execution_context_json : patch.executionContext ? JSON.stringify(patch.executionContext) : null,
        patch.lastError === undefined ? existing.last_error : patch.lastError,
        nowIso(),
        runId,
        args.projectId,
      ]
    );
  };

  const mergeExecutionContext = (
    runId: string,
    patch: Partial<Record<string, unknown>> | null,
  ): LinearWorkflowExecutionContext | null => {
    const current = getRunRow(runId);
    if (!current) return null;
    const existing = safeJsonParse<Record<string, unknown> | null>(current.execution_context_json, null) ?? {};
    if (!patch) {
      updateRun(runId, { executionContext: null });
      return null;
    }
    const next = { ...existing, ...patch } as LinearWorkflowExecutionContext;
    updateRun(runId, { executionContext: next });
    return next;
  };

  const updateStep = (stepId: string, patch: StepPatch): void => {
    const existing = args.db.get<StepRow>(
      `select * from linear_workflow_run_steps where id = ? limit 1`,
      [stepId]
    );
    if (!existing) return;
    args.db.run(
      `
        update linear_workflow_run_steps
        set status = ?,
            started_at = ?,
            completed_at = ?,
            payload_json = ?,
            updated_at = ?
        where id = ?
      `,
      [
        patch.status ?? existing.status,
        patch.startedAt === undefined ? existing.started_at : patch.startedAt,
        patch.completedAt === undefined ? existing.completed_at : patch.completedAt,
        patch.payload === undefined ? existing.payload_json : patch.payload ? JSON.stringify(patch.payload) : null,
        nowIso(),
        stepId,
      ]
    );
  };

  const findActiveRunForIssue = (issueId: string): LinearWorkflowRun | null => {
    const row = args.db.get<RunRow>(
      `
        select *
        from linear_workflow_runs
        where project_id = ?
          and issue_id = ?
          and status in (${ACTIVE_RUN_STATUSES})
        order by datetime(created_at) desc
        limit 1
      `,
      [args.projectId, issueId]
    );
    return row ? toRun(row) : null;
  };

  return {
    appendEvent,
    getRunRow,
    listActiveRuns,
    hasActiveRuns,
    getStepRows,
    getEventRows,
    updateRun,
    mergeExecutionContext,
    updateStep,
    findActiveRunForIssue,
  };
}
