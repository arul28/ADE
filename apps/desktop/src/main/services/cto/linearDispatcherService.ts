import { randomUUID } from "node:crypto";
import type {
  AgentChatIdentityKey,
  AdapterType,
  LinearIngressEventRecord,
  LinearSyncQueueItem,
  LinearWorkflowConfig,
  LinearWorkflowExecutionContext,
  LinearWorkflowDefinition,
  LinearWorkflowEventPayload,
  LinearWorkflowMatchResult,
  LinearWorkflowRouteContext,
  LinearWorkflowRunDetail,
  LinearWorkflowRun,
  LinearWorkflowRunEvent,
  LinearSyncResolutionAction,
  LinearWorkflowRunStatus,
  LinearWorkflowRunStep,
  LinearWorkflowStep,
  LinearWorkflowTargetStatus,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse } from "../shared/utils";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { createLaneService } from "../lanes/laneService";
import type { createPrService } from "../prs/prService";
import type { createWorkerHeartbeatService } from "./workerHeartbeatService";
import type { IssueTracker } from "./issueTracker";
import type { LinearCloseoutService } from "./linearCloseoutService";
import type { LinearOutboundService } from "./linearOutboundService";
import type { WorkerAgentService } from "./workerAgentService";
import type { LinearTemplateService } from "./linearTemplateService";
import type { WorkerTaskSessionService } from "./workerTaskSessionService";

type RunRow = {
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
  linked_mission_id: string | null;
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

type StepRow = {
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

function toRun(row: RunRow): LinearWorkflowRun {
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
    linkedMissionId: row.linked_mission_id,
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

function toRunStep(row: StepRow, workflow?: LinearWorkflowDefinition | null): LinearWorkflowRunStep {
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

function toRunEvent(row: EventRow): LinearWorkflowRunEvent {
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

function describePrBehavior(target: LinearWorkflowDefinition["target"]): string {
  const strategy = target.prStrategy;
  if (!strategy) return "No PR will be created unless a later workflow step requires one.";
  const timing = target.prTiming ?? "after_target_complete";
  if (strategy.kind === "manual") {
    return `Track a manually created PR (${timing === "after_start" ? "watch immediately" : "wait after delegated work"}).`;
  }
  return `${strategy.kind} PR (${timing === "after_start" ? "create or link right after launch" : "create or link after delegated work"}).`;
}

function resolveWorkflowTargetStatus(
  targetType: LinearWorkflowDefinition["target"]["type"],
  targetStatus?: LinearWorkflowTargetStatus | null,
): LinearWorkflowTargetStatus {
  if (targetType === "mission") {
    return targetStatus ?? "completed";
  }
  if (!targetStatus || targetStatus === "completed") {
    return "explicit_completion";
  }
  return targetStatus;
}

function targetStatusAllowsTerminalSuccess(targetStatus: LinearWorkflowTargetStatus): boolean {
  return targetStatus === "completed" || targetStatus === "runtime_completed" || targetStatus === "any_terminal";
}

function getTargetStages(target: LinearWorkflowDefinition["target"]): LinearWorkflowDefinition["target"][] {
  const { downstreamTarget, ...current } = target;
  return [
    current as LinearWorkflowDefinition["target"],
    ...(downstreamTarget ? getTargetStages(downstreamTarget) : []),
  ];
}

export function createLinearDispatcherService(args: {
  db: AdeDb;
  projectId: string;
  issueTracker: IssueTracker;
  workerAgentService: WorkerAgentService;
  workerHeartbeatService: ReturnType<typeof createWorkerHeartbeatService>;
  missionService: ReturnType<typeof createMissionService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  agentChatService: ReturnType<typeof createAgentChatService>;
  laneService: ReturnType<typeof createLaneService>;
  templateService: LinearTemplateService;
  closeoutService: LinearCloseoutService;
  outboundService: LinearOutboundService;
  workerTaskSessionService: WorkerTaskSessionService;
  prService: ReturnType<typeof createPrService>;
  onEvent?: (event: LinearWorkflowEventPayload) => void;
}) {
  const appendEvent = (runId: string, eventType: string, status?: string | null, message?: string | null, payload?: Record<string, unknown> | null): void => {
    args.db.run(
      `
        insert into linear_workflow_run_events(id, project_id, run_id, event_type, status, message, payload_json, created_at)
        values(?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), args.projectId, runId, eventType, status ?? null, message ?? null, payload ? JSON.stringify(payload) : null, nowIso()]
    );
  };

  const emitRunEvent = (
    run: LinearWorkflowRun,
    milestone: Extract<LinearWorkflowEventPayload, { type: "linear-workflow-run" }>["milestone"],
    message: string
  ): void => {
    args.onEvent?.({
      type: "linear-workflow-run",
      projectId: args.projectId,
      runId: run.id,
      issueId: run.issueId,
      issueIdentifier: run.identifier,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      milestone,
      message,
      linkedPrId: run.linkedPrId,
      linkedSessionId: run.linkedSessionId,
      createdAt: nowIso(),
    });
  };

  const emitNotification = (run: LinearWorkflowRun, title: string, message: string, level: "info" | "success" | "warning" | "error"): void => {
    args.onEvent?.({
      type: "linear-workflow-notification",
      projectId: args.projectId,
      runId: run.id,
      issueIdentifier: run.identifier,
      title,
      message,
      level,
      createdAt: nowIso(),
    });
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
            and status in ('queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'awaiting_delegation', 'awaiting_lane_choice', 'retry_wait')
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
          and status in ('queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'awaiting_delegation', 'awaiting_lane_choice', 'retry_wait')
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

  const updateRun = (runId: string, patch: Partial<{
    status: LinearWorkflowRunStatus;
    currentStepIndex: number;
    currentStepId: string | null;
    executionLaneId: string | null;
    linkedMissionId: string | null;
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
  }>): void => {
    const existing = getRunRow(runId);
    if (!existing) return;
    args.db.run(
      `
        update linear_workflow_runs
        set status = ?,
            current_step_index = ?,
            current_step_id = ?,
            execution_lane_id = ?,
            linked_mission_id = ?,
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
        patch.linkedMissionId === undefined ? existing.linked_mission_id : patch.linkedMissionId,
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

  const getActiveTargetStageIndex = (run: LinearWorkflowRun, workflow: LinearWorkflowDefinition): number => {
    const requested = Number(run.executionContext?.activeStageIndex ?? 0);
    const stages = getTargetStages(workflow.target);
    if (!Number.isFinite(requested)) return 0;
    return Math.max(0, Math.min(stages.length - 1, Math.floor(requested)));
  };

  const getActiveTarget = (run: LinearWorkflowRun, workflow: LinearWorkflowDefinition): LinearWorkflowDefinition["target"] => {
    const stages = getTargetStages(workflow.target);
    return stages[getActiveTargetStageIndex(run, workflow)] ?? stages[0] ?? workflow.target;
  };

  const buildTargetStageId = (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    step: LinearWorkflowStep,
  ): string => {
    const activeTarget = getActiveTarget(run, workflow);
    return `${step.id}:${getActiveTargetStageIndex(run, workflow)}:${activeTarget.type}`;
  };

  const stripManualCompletionState = (
    payload: Record<string, unknown>,
  ): Record<string, unknown> => {
    const {
      completionSource: _completionSource,
      stageId: _stageId,
      targetState: _targetState,
      ...rest
    } = payload;
    return rest;
  };

  const hasDurableLaunchMarker = (run: LinearWorkflowRun): boolean =>
    Boolean(run.linkedMissionId || run.linkedSessionId || run.linkedWorkerRunId || run.linkedPrId);

  const updateStep = (stepId: string, patch: Partial<{
    status: StepRow["status"];
    startedAt: string | null;
    completedAt: string | null;
    payload: Record<string, unknown> | null;
  }>): void => {
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

  type ResolvedWorkerTarget = { id: string; slug: string; adapterType: AdapterType };
  type ResolvedEmployeeSessionTarget = {
    identityKey: AgentChatIdentityKey | null;
    worker: ResolvedWorkerTarget | null;
    label: string;
  };

  const listWorkers = () => args.workerAgentService.listAgents({ includeDeleted: false });

  const toResolvedWorker = (worker: {
    id: string;
    slug: string;
    adapterType: AdapterType;
    name: string;
  }): ResolvedWorkerTarget & { name: string } => ({
    id: worker.id,
    slug: worker.slug,
    adapterType: worker.adapterType,
    name: worker.name,
  });

  const resolveWorkerByToken = (value: string | null | undefined): (ResolvedWorkerTarget & { name: string }) | null => {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return null;
    for (const worker of listWorkers()) {
      const aliases = new Set(
        [
          worker.id,
          worker.slug,
          worker.name,
          ...(worker.linearIdentity?.userIds ?? []),
          ...(worker.linearIdentity?.displayNames ?? []),
          ...(worker.linearIdentity?.aliases ?? []),
        ]
          .map((entry) => (entry ?? "").trim().toLowerCase())
          .filter(Boolean),
      );
      if (aliases.has(normalized)) {
        return toResolvedWorker({
          id: worker.id,
          slug: worker.slug,
          adapterType: worker.adapterType as AdapterType,
          name: worker.name,
        });
      }
    }
    return null;
  };

  const isCtoAlias = (policy: LinearWorkflowConfig, value: string | null | undefined): boolean => {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    const ctoAliases = new Set(
      [
        policy.settings.ctoLinearAssigneeId,
        policy.settings.ctoLinearAssigneeName,
        ...(policy.settings.ctoLinearAssigneeAliases ?? []),
        "cto",
      ]
        .map((entry) => (entry ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    return ctoAliases.has(normalized);
  };

  const resolveOverrideWorker = (
    policy: LinearWorkflowConfig,
    override: string | null | undefined,
  ): (ResolvedWorkerTarget & { name: string }) | "cto" | null => {
    const trimmed = (override ?? "").trim();
    if (!trimmed) return null;
    if (isCtoAlias(policy, trimmed)) return "cto";
    const normalized = trimmed.toLowerCase();
    if (normalized.startsWith("agent:")) {
      const agentId = trimmed.slice("agent:".length).trim();
      const direct = agentId ? args.workerAgentService.getAgent(agentId) : null;
      if (!direct) {
        throw new Error(`Unknown employee override '${trimmed}'.`);
      }
      return toResolvedWorker({
        id: direct.id,
        slug: direct.slug,
        adapterType: direct.adapterType as AdapterType,
        name: direct.name,
      });
    }
    const worker = resolveWorkerByToken(trimmed);
    if (!worker) {
      throw new Error(`Unknown employee override '${trimmed}'.`);
    }
    return worker;
  };

  const resolveWorker = (
    policy: LinearWorkflowConfig,
    target: LinearWorkflowDefinition["target"],
    override?: string | null,
  ): (ResolvedWorkerTarget & { name: string }) | null => {
    const overridden = resolveOverrideWorker(policy, override);
    if (overridden === "cto") {
      return null;
    }
    if (overridden) {
      return overridden;
    }
    const selector = target.workerSelector;
    const workers = listWorkers();
    if (!selector || selector.mode === "none") return null;
    let match: typeof workers[number] | undefined;
    switch (selector.mode) {
      case "id": match = workers.find((entry) => entry.id === selector.value); break;
      case "slug": match = workers.find((entry) => entry.slug === selector.value); break;
      case "capability": match = workers.find((entry) => entry.capabilities.includes(selector.value)); break;
      default: return null;
    }
    return match ? toResolvedWorker({ id: match.id, slug: match.slug, adapterType: match.adapterType as AdapterType, name: match.name }) : null;
  };

  const resolveWorkerFromAssignee = (issue: NormalizedLinearIssue): ResolvedWorkerTarget | null => {
    const assigneeValues = new Set(
      [issue.assigneeId, issue.assigneeName]
        .map((value) => (value ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    if (!assigneeValues.size) return null;
    for (const assigneeValue of assigneeValues) {
      const match = resolveWorkerByToken(assigneeValue);
      if (match) return match;
    }
    return null;
  };

  const issueMatchesCto = (policy: LinearWorkflowConfig, issue: NormalizedLinearIssue): boolean => {
    const assigneeValues = new Set(
      [issue.assigneeId, issue.assigneeName]
        .map((value) => (value ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    if (!assigneeValues.size) return false;
    return [...assigneeValues].some((value) => isCtoAlias(policy, value));
  };

  const resolveEmployeeTarget = (
    policy: LinearWorkflowConfig,
    target: LinearWorkflowDefinition["target"],
    issue: NormalizedLinearIssue,
    override?: string | null,
  ): ResolvedEmployeeSessionTarget | null => {
    const overridden = resolveOverrideWorker(policy, override);
    if (overridden === "cto") {
      return {
        identityKey: "cto",
        worker: null,
        label: "CTO",
      };
    }
    if (overridden) {
      return {
        identityKey: `agent:${overridden.id}`,
        worker: overridden,
        label: overridden.name,
      };
    }
    const explicitIdentity = target.employeeIdentityKey?.trim() ?? "";
    if (explicitIdentity === "cto") {
      return {
        identityKey: "cto",
        worker: null,
        label: "CTO",
      };
    }
    if (explicitIdentity.startsWith("agent:")) {
      const agentId = explicitIdentity.slice("agent:".length);
      const direct = args.workerAgentService.getAgent(agentId);
      if (direct) {
        return {
          identityKey: `agent:${direct.id}`,
          worker: { id: direct.id, slug: direct.slug, adapterType: direct.adapterType as AdapterType },
          label: direct.name,
        };
      }
    }
    if (issueMatchesCto(policy, issue)) {
      return {
        identityKey: "cto",
        worker: null,
        label: "CTO",
      };
    }
    const worker = resolveWorkerFromAssignee(issue) ?? resolveWorker(policy, target);
    if (!worker) {
      return {
        identityKey: null,
        worker: null,
        label: "Awaiting delegation",
      };
    }
    return {
      identityKey: `agent:${worker.id}`,
      worker,
      label: worker.slug,
    };
  };

  const isEmployeeOverrideCompatibleWithTarget = (
    policy: LinearWorkflowConfig,
    targetType: LinearWorkflowDefinition["target"]["type"],
    override: string | null | undefined,
  ): boolean => {
    const trimmed = (override ?? "").trim();
    if (!trimmed) return true;
    try {
      const resolved = resolveOverrideWorker(policy, trimmed);
      if (resolved === "cto") {
        return targetType !== "worker_run" && targetType !== "pr_resolution";
      }
      return true;
    } catch {
      return false;
    }
  };

  const buildLaunchPayloadFromRun = (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    policy: LinearWorkflowConfig,
  ): Record<string, unknown> => {
    const activeTarget = getActiveTarget(run, workflow);
    const issue = run.sourceIssueSnapshot as NormalizedLinearIssue;
    const payload: Record<string, unknown> = {
      activeTargetType: run.executionContext?.activeTargetType ?? activeTarget.type,
      laneId: run.executionLaneId,
      missionId: run.linkedMissionId,
      sessionId: run.linkedSessionId,
      workerRunId: run.linkedWorkerRunId,
      prId: run.linkedPrId,
    };
    if (run.executionContext?.workerId) payload.workerId = run.executionContext.workerId;
    if (run.executionContext?.workerSlug) payload.workerSlug = run.executionContext.workerSlug;
    if (run.executionContext?.sessionLabel) payload.sessionLabel = run.executionContext.sessionLabel;
    if (activeTarget.type === "employee_session") {
      const employeeTarget = resolveEmployeeTarget(policy, activeTarget, issue, run.executionContext?.employeeOverride ?? null);
      if (employeeTarget?.identityKey) payload.sessionIdentityKey = employeeTarget.identityKey;
      if (employeeTarget?.label) payload.sessionLabel = employeeTarget.label;
    }
    return payload;
  };

  const primaryLane = async () => {
    await args.laneService.ensurePrimaryLane().catch(() => {});
    const lanes = await args.laneService.list({ includeArchived: false, includeStatus: false });
    const preferred = lanes.find((entry) => entry.laneType === "primary") ?? lanes[0];
    if (!preferred) throw new Error("No lane available for employee session launch.");
    return preferred;
  };

  const resolveOperatorLane = async (laneId: string): Promise<string> => {
    const trimmed = laneId.trim();
    if (!trimmed) throw new Error("Choose an execution lane before resuming this workflow.");
    const lanes = await args.laneService.list({ includeArchived: false, includeStatus: false });
    const lane = lanes.find((entry) => entry.id === trimmed) ?? null;
    if (!lane) {
      throw new Error(`Execution lane not found: ${trimmed}`);
    }
    return lane.id;
  };

  const buildDelegationPrompt = (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    target: LinearWorkflowDefinition["target"],
    issue: NormalizedLinearIssue,
  ): string => {
    const rendered = args.templateService.renderTemplate({
      templateId: target.sessionTemplate ?? target.missionTemplate ?? "default",
      issue,
      route: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        runMode: target.runMode ?? "autopilot",
      },
      worker: {
        assigneeId: issue.assigneeId,
        assigneeName: issue.assigneeName,
      },
    });
    const prMode = `PR behavior: ${describePrBehavior(target)}`;
    const supervisorFeedback = run.latestReviewNote?.trim()
      ? [
          "",
          "Supervisor feedback to address before you hand this back:",
          run.latestReviewNote.trim(),
        ].join("\n")
      : "";
    return [
      rendered.prompt,
      "",
      "Execution contract:",
      `- Start work immediately for Linear issue ${issue.identifier}.`,
      "- Keep progress observable in ADE and Linear.",
      `- ${prMode}`,
      "- When implementation is ready, leave the session in a state where ADE can move the issue to review.",
      supervisorFeedback,
    ].join("\n");
  };

  const readDelegationContext = (run: LinearWorkflowRun, launchContext?: Record<string, unknown> | null) => {
    const source = launchContext ?? {};
    const executionContext = run.executionContext ?? null;
    const workerId =
      executionContext && "workerId" in executionContext
        ? (typeof executionContext.workerId === "string" ? executionContext.workerId : null)
        : typeof source.workerId === "string"
          ? source.workerId
          : null;
    const workerSlug =
      executionContext && "workerSlug" in executionContext
        ? (typeof executionContext.workerSlug === "string" ? executionContext.workerSlug : null)
        : typeof source.workerSlug === "string"
          ? source.workerSlug
          : null;
    const sessionLabel =
      executionContext && "sessionLabel" in executionContext
        ? (typeof executionContext.sessionLabel === "string" ? executionContext.sessionLabel : null)
        : typeof source.sessionLabel === "string"
          ? source.sessionLabel
          : null;
    return { workerId, workerSlug, sessionLabel };
  };

  const getLaunchContext = (runId: string): Record<string, unknown> => {
    const step = getStepRows(runId).find((entry) => entry.type === "launch_target");
    return safeJsonParse<Record<string, unknown> | null>(step?.payload_json ?? null, null) ?? {};
  };

  const syncWorkflowWorkpad = async (input: {
    runId: string;
    workflow: LinearWorkflowDefinition;
    note?: string | null;
    waitingFor?: string | null;
  }): Promise<void> => {
    const row = getRunRow(input.runId);
    if (!row) return;
    const run = toRun(row);
    const issue = run.sourceIssueSnapshot as NormalizedLinearIssue;
    const launchContext = getLaunchContext(run.id);
    const currentStep = input.workflow.steps.find((entry) => entry.id === run.currentStepId) ?? null;
    const delegatedContext = readDelegationContext(run, launchContext);
    const delegatedOwner =
      [delegatedContext.sessionLabel, delegatedContext.workerSlug, delegatedContext.workerId]
        .map((value) => value?.trim() ?? "")
        .find((value) => value.length > 0) ?? null;
    await args.outboundService.publishWorkflowStatus({
      issue,
      workflowName: run.workflowName,
      runId: run.id,
      targetType: run.executionContext?.activeTargetType ?? run.targetType,
      state: run.status,
      currentStep: currentStep?.name ?? currentStep?.id ?? null,
      delegatedOwner,
      laneId: run.executionLaneId,
      missionId: run.linkedMissionId,
      sessionId: run.linkedSessionId,
      workerRunId: run.linkedWorkerRunId,
      prId: run.linkedPrId,
      reviewState: run.reviewState,
      reviewReadyReason: run.reviewReadyReason,
      waitingFor: input.waitingFor ?? run.executionContext?.waitingFor ?? null,
      note: input.note,
      commentTemplate: input.workflow.closeout?.commentTemplate ?? null,
      templateValues: {
        workflow: {
          id: input.workflow.id,
          name: input.workflow.name,
        },
        run,
        target: {
          type: run.executionContext?.activeTargetType ?? run.targetType,
          id: run.linkedSessionId ?? run.linkedWorkerRunId ?? run.linkedMissionId ?? run.linkedPrId ?? run.executionLaneId ?? null,
          owner: delegatedOwner,
        },
        pr: {
          id: run.linkedPrId,
          state: run.prState,
          checksStatus: run.prChecksStatus,
          reviewStatus: run.prReviewStatus,
        },
        review: {
          state: run.reviewState,
          readyReason: run.reviewReadyReason,
          note: run.latestReviewNote,
        },
      },
    });
  };

  const resolveRunLaneId = async (run: LinearWorkflowRun): Promise<string | null> => {
    if (run.executionLaneId) return run.executionLaneId;
    const launchContext = getLaunchContext(run.id);
    const laneId = typeof launchContext.laneId === "string" ? launchContext.laneId.trim() : "";
    if (laneId) return laneId;
    if (run.linkedSessionId) {
      const sessions = await args.agentChatService.listSessions();
      const session = sessions.find((entry) => entry.sessionId === run.linkedSessionId);
      if (session?.laneId) return session.laneId;
    }
    return null;
  };

  const updateExecutionState = (
    runId: string,
    patch: Partial<LinearWorkflowExecutionContext>,
  ): LinearWorkflowExecutionContext | null => mergeExecutionContext(runId, patch);

  const clearExecutionWaitState = (runId: string): LinearWorkflowExecutionContext | null =>
    updateExecutionState(runId, {
      waitingFor: null,
      stalledReason: null,
    });

  const getRetryDelaySec = (workflow: LinearWorkflowDefinition, retryCount: number): number => {
    const baseDelay = workflow.retry?.backoffSeconds ?? workflow.retry?.baseDelaySec ?? 30;
    const safeBase = Math.max(5, Math.floor(baseDelay));
    return Math.min(safeBase * (2 ** Math.max(0, retryCount)), 3600);
  };

  const scheduleRetry = async (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    error: unknown,
    context: { eventType: string; messagePrefix: string; waitingFor?: string | null },
  ): Promise<void> => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const currentAttempts = run.retryCount ?? 0;
    const maxAttempts = Math.max(0, workflow.retry?.maxAttempts ?? 0);
    if (currentAttempts >= maxAttempts) {
      appendEvent(run.id, context.eventType, "failed", `${context.messagePrefix}: ${errorMessage}`, {
        retryCount: currentAttempts,
        maxAttempts,
      });
      await finalizeRun(run, workflow, "failed", `${context.messagePrefix}: ${errorMessage}`);
      return;
    }

    const retryCount = currentAttempts + 1;
    const delaySec = getRetryDelaySec(workflow, currentAttempts);
    const retryAfter = new Date(Date.now() + delaySec * 1000).toISOString();
    updateExecutionState(run.id, {
      waitingFor: context.waitingFor ?? "automatic retry",
      stalledReason: `${context.messagePrefix}: ${errorMessage}`,
    });
    updateRun(run.id, {
      status: "retry_wait",
      retryCount,
      retryAfter,
      lastError: errorMessage,
    });
    appendEvent(run.id, context.eventType, "retry_wait", `${context.messagePrefix}: ${errorMessage}`, {
      retryCount,
      retryAfter,
      delaySec,
    });
    await syncWorkflowWorkpad({
      runId: run.id,
      workflow,
      note: `${context.messagePrefix}: ${errorMessage}. Retrying automatically.`,
      waitingFor: context.waitingFor ?? "automatic retry",
    });
  };

  const ensureExecutionLane = async (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    target: LinearWorkflowDefinition["target"],
    issue: NormalizedLinearIssue
  ): Promise<string | null> => {
    if (target.type === "mission" || target.type === "review_gate") {
      return null;
    }
    if (run.executionLaneId) return run.executionLaneId;
    if (target.laneSelection === "operator_prompt") {
      return null;
    }
    const preferredPrimary = await primaryLane();
    if (target.laneSelection !== "fresh_issue_lane") {
      return preferredPrimary.id;
    }
    const lane = await args.laneService.create({
      name: (target.freshLaneName?.trim() || `${issue.identifier} ${issue.title}`).slice(0, 72),
      description: `Linear workflow ${workflow.name} for ${issue.identifier}`,
      parentLaneId: preferredPrimary.id,
    });
    appendEvent(run.id, "run.lane_created", "completed", `Created dedicated lane '${lane.name}'.`, {
      laneId: lane.id,
      laneName: lane.name,
      parentLaneId: preferredPrimary.id,
    });
    return lane.id;
  };

  const syncPrState = async (runId: string, prId: string): Promise<Awaited<ReturnType<typeof args.prService.getStatus>> | null> => {
    try {
      const status = await args.prService.getStatus(prId);
      updateRun(runId, {
        prState: status.state,
        prChecksStatus: status.checksStatus,
        prReviewStatus: status.reviewStatus,
      });
      return status;
    } catch {
      return null;
    }
  };

  const isPrReviewReady = (status: Awaited<ReturnType<typeof args.prService.getStatus>> | null): boolean => {
    if (!status) return false;
    return status.state === "open" && status.checksStatus !== "failing" && status.reviewStatus !== "changes_requested";
  };

  const ensureLinkedPr = async (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    target: LinearWorkflowDefinition["target"],
    laneIdOverride?: string | null
  ): Promise<string | null> => {
    if (run.linkedPrId) {
      await syncPrState(run.id, run.linkedPrId);
      return run.linkedPrId;
    }
    const laneId = laneIdOverride ?? await resolveRunLaneId(run);
    if (!laneId) return null;
    const existing = args.prService.getForLane(laneId);
    if (existing) {
      updateRun(run.id, { linkedPrId: existing.id, executionLaneId: laneId });
      await syncPrState(run.id, existing.id);
      appendEvent(run.id, "run.pr_linked", "completed", `Linked PR #${existing.githubPrNumber}.`, { prId: existing.id, laneId });
      emitRunEvent({ ...run, linkedPrId: existing.id, executionLaneId: laneId }, "pr_linked", `Linked PR #${existing.githubPrNumber}.`);
      await syncWorkflowWorkpad({
        runId: run.id,
        workflow,
        note: `Linked PR #${existing.githubPrNumber}.`,
        waitingFor: "pull request progress",
      });
      return existing.id;
    }

    if (!target.prStrategy || target.prStrategy.kind === "manual") {
      return null;
    }

    const created = await args.prService.createFromLane({
      laneId,
      title: `${run.identifier}: ${run.title}`,
      body: `Automated PR for Linear workflow ${workflow.name}.\n\nIssue: ${run.identifier}`,
      draft: true,
    });
    updateRun(run.id, { linkedPrId: created.id, executionLaneId: laneId });
    await syncPrState(run.id, created.id);
    appendEvent(run.id, "run.pr_created", "completed", `Created PR #${created.githubPrNumber}.`, { prId: created.id, laneId });
    emitRunEvent({ ...run, linkedPrId: created.id, executionLaneId: laneId }, "pr_linked", `Created PR #${created.githubPrNumber}.`);
    await syncWorkflowWorkpad({
      runId: run.id,
      workflow,
      note: `Created PR #${created.githubPrNumber}.`,
      waitingFor: "pull request progress",
    });
    return created.id;
  };

  type TargetCompletionEvaluation = {
    state: "waiting" | "completed" | "failed" | "cancelled";
    payload: Record<string, unknown>;
    runPatch?: Partial<{
      executionLaneId: string | null;
      linkedSessionId: string | null;
    }>;
  };

  const findReplacementEmployeeSession = async (
    run: LinearWorkflowRun,
  ): Promise<{ sessionId: string; laneId: string | null; status: string } | null> => {
    const launchContext = getLaunchContext(run.id);
    const identityKey = typeof launchContext.sessionIdentityKey === "string" ? launchContext.sessionIdentityKey.trim() : "";
    const preferredLaneId = typeof launchContext.laneId === "string" ? launchContext.laneId.trim() : "";
    if (!identityKey) return null;
    const sessions = await args.agentChatService.listSessions();
    const activeSessions = sessions
      .filter((entry) => entry.identityKey === identityKey && entry.status !== "ended")
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
    if (!activeSessions.length) return null;
    const preferred = activeSessions.find((entry) => entry.laneId === preferredLaneId) ?? activeSessions[0]!;
    return {
      sessionId: preferred.sessionId,
      laneId: preferred.laneId ?? null,
      status: preferred.status,
    };
  };

  const evaluateTargetCompletion = async (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    step: LinearWorkflowStep,
  ): Promise<TargetCompletionEvaluation> => {
    const target = getActiveTarget(run, workflow);
    const targetStatus = resolveWorkflowTargetStatus(target.type, step.targetStatus);

    // Check for a manual completion signal stored in the step payload by resolveRunAction.
    const manualStepRow = getStepRows(run.id).find((r) => r.workflow_step_id === step.id);
    if (manualStepRow) {
      const manualPayload = safeJsonParse<Record<string, unknown> | null>(manualStepRow.payload_json, null);
      if (
        manualPayload?.completionSource === "manual"
        && manualPayload.stageId === buildTargetStageId(run, workflow, step)
      ) {
        return { state: "completed", payload: { ...manualPayload, targetStatus } };
      }
    }

    if (target.type === "mission") {
      if (!run.linkedMissionId) {
        return { state: "failed", payload: { targetStatus, reason: "missing_mission_link" } };
      }
      const mission = args.missionService.get(run.linkedMissionId);
      if (!mission) {
        return { state: "failed", payload: { targetStatus, missionId: run.linkedMissionId, reason: "mission_not_found" } };
      }
      if (mission.status === "completed") {
        return {
          state: targetStatusAllowsTerminalSuccess(targetStatus) ? "completed" : "waiting",
          payload: { targetStatus, missionId: run.linkedMissionId, missionStatus: mission.status },
        };
      }
      if (mission.status === "failed") {
        return {
          state: "failed",
          payload: { targetStatus, missionId: run.linkedMissionId, missionStatus: mission.status },
        };
      }
      if (mission.status === "canceled") {
        return {
          state: "cancelled",
          payload: { targetStatus, missionId: run.linkedMissionId, missionStatus: mission.status },
        };
      }
      return {
        state: "waiting",
        payload: { targetStatus, missionId: run.linkedMissionId, missionStatus: mission.status },
      };
    }

    if (target.type === "employee_session") {
      const launchContext = getLaunchContext(run.id);
      const identityKey = typeof launchContext.sessionIdentityKey === "string" ? launchContext.sessionIdentityKey.trim() : "";
      const sessions = await args.agentChatService.listSessions();
      const linkedSession = run.linkedSessionId
        ? sessions.find((entry) => entry.sessionId === run.linkedSessionId) ?? null
        : null;
      if (linkedSession && linkedSession.status !== "ended") {
        return {
          state: "waiting",
          payload: {
            targetStatus,
            linkedSessionId: linkedSession.sessionId,
            sessionStatus: linkedSession.status,
            identityKey,
            waitingFor: "explicit_completion",
          },
        };
      }
      const replacement = await findReplacementEmployeeSession(run);
      if (replacement && replacement.sessionId !== run.linkedSessionId) {
        appendEvent(run.id, "run.session_relinked", "completed", "Relinked workflow to the current employee session.", {
          previousSessionId: run.linkedSessionId,
          sessionId: replacement.sessionId,
          laneId: replacement.laneId,
          identityKey,
        });
        return {
          state: "waiting",
          payload: {
            targetStatus,
            linkedSessionId: replacement.sessionId,
            sessionStatus: replacement.status,
            identityKey,
            waitingFor: "explicit_completion",
            sessionRelinked: true,
          },
          runPatch: {
            linkedSessionId: replacement.sessionId,
            executionLaneId: replacement.laneId ?? run.executionLaneId,
          },
        };
      }
      return {
        state: targetStatusAllowsTerminalSuccess(targetStatus) ? "completed" : "waiting",
        payload: {
          targetStatus,
          linkedSessionId: run.linkedSessionId,
          sessionStatus: linkedSession?.status ?? "ended",
          identityKey,
          ...(targetStatusAllowsTerminalSuccess(targetStatus)
            ? { autoCompleted: true }
            : { waitingFor: "explicit_completion" }),
        },
      };
    }

    if (target.type === "worker_run" || target.type === "pr_resolution") {
      if (!run.linkedWorkerRunId) {
        return { state: "failed", payload: { targetStatus, reason: "missing_worker_run_link" } };
      }
      const runs = args.workerHeartbeatService.listRuns({ limit: 200 });
      const workerRun = runs.find((entry) => entry.id === run.linkedWorkerRunId);
      if (!workerRun) {
        return {
          state: "failed",
          payload: { targetStatus, workerRunId: run.linkedWorkerRunId, reason: "worker_run_not_found" },
        };
      }
      if (workerRun.status === "failed") {
        return {
          state: "failed",
          payload: { targetStatus, workerRunId: workerRun.id, workerRunStatus: workerRun.status },
        };
      }
      if (workerRun.status === "cancelled" || workerRun.status === "skipped") {
        return {
          state: "cancelled",
          payload: { targetStatus, workerRunId: workerRun.id, workerRunStatus: workerRun.status },
        };
      }
      if (workerRun.status === "completed") {
        return {
          state: targetStatusAllowsTerminalSuccess(targetStatus) ? "completed" : "waiting",
          payload: {
            targetStatus,
            workerRunId: workerRun.id,
            workerRunStatus: workerRun.status,
            ...(targetStatusAllowsTerminalSuccess(targetStatus) ? {} : { waitingFor: "explicit_completion" }),
          },
        };
      }
      return {
        state: "waiting",
        payload: {
          targetStatus,
          workerRunId: workerRun.id,
          workerRunStatus: workerRun.status,
        },
      };
    }

    return {
      state:
        run.reviewState === "approved"
          ? "completed"
          : run.reviewState === "rejected"
            ? "cancelled"
            : "waiting",
      payload: {
        targetStatus,
        reviewState: run.reviewState,
      },
    };
  };

  const executeTarget = async (
    run: LinearWorkflowRun,
    policy: LinearWorkflowConfig,
    workflow: LinearWorkflowDefinition,
    issue: NormalizedLinearIssue
  ): Promise<Partial<LinearWorkflowRun> & Record<string, unknown>> => {
    const target = getActiveTarget(run, workflow);
    const stageIndex = getActiveTargetStageIndex(run, workflow);
    const totalStages = getTargetStages(workflow.target).length;
    const override = run.executionContext?.employeeOverride ?? null;
    const overrideSource = override ? "operator" : null;
    const worker = resolveWorker(policy, target, override);
    const employeeTarget = resolveEmployeeTarget(policy, target, issue, override);

    updateExecutionState(run.id, {
      activeTargetType: target.type,
      activeStageIndex: stageIndex,
      totalStages,
      downstreamPending: stageIndex < totalStages - 1,
      employeeOverride: override,
      overrideSource,
    });

    if (target.type === "mission") {
      const rendered = args.templateService.renderTemplate({
        templateId: target.missionTemplate ?? "default",
        issue,
        route: {
          workflowId: workflow.id,
          workflowName: workflow.name,
        },
        worker: worker ? { id: worker.id, slug: worker.slug } : {},
      });
      const mission = args.missionService.create({
        title: `${issue.identifier}: ${issue.title}`,
        prompt: rendered.prompt,
        priority: issue.priorityLabel === "urgent" ? "urgent" : issue.priorityLabel === "high" ? "high" : issue.priorityLabel === "low" ? "low" : "normal",
        autostart: false,
        launchMode: target.runMode === "manual" ? "manual" : "autopilot",
        employeeAgentId: worker?.id,
        ...(target.prStrategy ? { executionPolicy: { prStrategy: target.prStrategy } } : {}),
        ...(target.phaseProfile ? { phaseProfileId: target.phaseProfile } : {}),
      });
      await args.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: target.runMode === "manual" ? "manual" : "autopilot",
        metadata: {
          source: "linear_workflow",
          linearIssueId: issue.id,
          workflowId: workflow.id,
        },
      });
      updateRun(run.id, {
        linkedMissionId: mission.id,
        status: "waiting_for_target",
      });
      updateExecutionState(run.id, {
        waitingFor: "delegated work",
        stalledReason: null,
        workerId: worker?.id ?? null,
        workerSlug: worker?.slug ?? null,
        sessionLabel: null,
      });
      const missionPatch: Partial<LinearWorkflowRun> & Record<string, unknown> = {
        linkedMissionId: mission.id,
        status: "waiting_for_target",
        workerId: worker?.id ?? null,
        workerSlug: worker?.slug ?? null,
        sessionLabel: null,
        activeTargetType: target.type,
      };
      return missionPatch;
    }

    if (target.type === "employee_session") {
      if (!employeeTarget || !employeeTarget.identityKey) {
        appendEvent(run.id, "run.awaiting_delegation", "waiting", `No employee could be resolved for workflow '${workflow.name}'. Queued for manual delegation.`);
        emitRunEvent(run, "delegated", `Awaiting manual delegation for ${run.identifier}.`);
        updateExecutionState(run.id, {
          waitingFor: "manual delegation",
          stalledReason: "No employee could be resolved for this workflow.",
          employeeOverride: override,
          overrideSource,
          workerId: null,
          workerSlug: null,
          sessionLabel: employeeTarget?.label ?? null,
        });
        return {
          status: "awaiting_delegation" as LinearWorkflowRunStatus,
          workerId: null,
          workerSlug: null,
          sessionLabel: employeeTarget?.label ?? null,
          activeTargetType: target.type,
        };
      }
      const laneId = await ensureExecutionLane(run, workflow, target, issue);
      if (!laneId) {
        appendEvent(run.id, "run.awaiting_lane_choice", "waiting", `Workflow '${workflow.name}' is paused until an operator chooses an execution lane.`, {
          laneSelection: target.laneSelection ?? "primary",
        });
        updateExecutionState(run.id, {
          waitingFor: "operator lane choice",
          stalledReason: "Workflow contract requires an operator to choose the execution lane.",
          employeeOverride: override,
          overrideSource,
          workerId: employeeTarget.worker?.id ?? null,
          workerSlug: employeeTarget.worker?.slug ?? null,
          sessionLabel: employeeTarget.label,
        });
        return {
          status: "awaiting_lane_choice" as LinearWorkflowRunStatus,
          workerId: employeeTarget.worker?.id ?? null,
          workerSlug: employeeTarget.worker?.slug ?? null,
          sessionLabel: employeeTarget.label,
          activeTargetType: target.type,
        };
      }
      const session = await args.agentChatService.ensureIdentitySession({
        identityKey: employeeTarget.identityKey,
        laneId,
        reuseExisting: target.sessionReuse !== "fresh_session" && target.laneSelection !== "fresh_issue_lane",
      });
      if (employeeTarget.worker) {
        const taskKey = args.workerTaskSessionService.deriveTaskKey({
          agentId: employeeTarget.worker.id,
          laneId,
          workflowRunId: run.id,
          linearIssueId: issue.id,
          chatSessionId: session.id,
          summary: issue.title,
        });
        args.workerTaskSessionService.ensureTaskSession({
          agentId: employeeTarget.worker.id,
          adapterType: employeeTarget.worker.adapterType,
          taskKey,
          payload: {
            source: "linear_workflow",
            workflowId: workflow.id,
            workflowName: workflow.name,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            ...(issue.url ? { issueUrl: issue.url } : {}),
            laneId,
            runId: run.id,
            continuity: {
              scope: {
                runId: run.id,
                laneId,
                issueId: issue.id,
                issueIdentifier: issue.identifier,
              },
            },
          },
        });
      }
      updateRun(run.id, {
        executionLaneId: laneId,
        linkedSessionId: session.id,
        status: "waiting_for_target",
      });
      await args.agentChatService.sendMessage({
        sessionId: session.id,
        text: buildDelegationPrompt(run, workflow, target, issue),
      });
      updateExecutionState(run.id, {
        waitingFor: "explicit completion",
        stalledReason: null,
        employeeOverride: override,
        overrideSource,
        workerId: employeeTarget.worker?.id ?? null,
        workerSlug: employeeTarget.worker?.slug ?? null,
        sessionLabel: employeeTarget.label,
      });
      const sessionPatch: Partial<LinearWorkflowRun> & Record<string, unknown> = {
        executionLaneId: laneId,
        linkedSessionId: session.id,
        status: "waiting_for_target",
        workerId: employeeTarget.worker?.id ?? null,
        workerSlug: employeeTarget.worker?.slug ?? null,
        sessionIdentityKey: employeeTarget.identityKey,
        sessionLabel: employeeTarget.label,
        laneId,
        activeTargetType: target.type,
      };
      if (target.prStrategy && target.prTiming === "after_start") {
        const linkedPrId = await ensureLinkedPr({ ...run, ...sessionPatch }, workflow, target, laneId);
        if (linkedPrId) {
          sessionPatch.linkedPrId = linkedPrId;
        }
      }
      return sessionPatch;
    }

    if (target.type === "worker_run" || target.type === "pr_resolution") {
      if (!worker) throw new Error(`Workflow '${workflow.name}' could not resolve a worker.`);
      const laneId = await ensureExecutionLane(run, workflow, target, issue);
      if (!laneId) {
        appendEvent(run.id, "run.awaiting_lane_choice", "waiting", `Workflow '${workflow.name}' is paused until an operator chooses an execution lane.`, {
          laneSelection: target.laneSelection ?? "primary",
        });
        updateExecutionState(run.id, {
          waitingFor: "operator lane choice",
          stalledReason: "Workflow contract requires an operator to choose the execution lane.",
          employeeOverride: override,
          overrideSource,
          workerId: worker.id,
          workerSlug: worker.slug,
          sessionLabel: null,
        });
        return {
          status: "awaiting_lane_choice" as LinearWorkflowRunStatus,
          workerId: worker.id,
          workerSlug: worker.slug,
          sessionLabel: null,
          activeTargetType: target.type,
        };
      }
      const taskKey = args.workerTaskSessionService.deriveTaskKey({
        agentId: worker.id,
        laneId,
        workflowRunId: run.id,
        linearIssueId: issue.id,
        summary: issue.title,
      });
      args.workerTaskSessionService.ensureTaskSession({
        agentId: worker.id,
        adapterType: worker.adapterType,
        taskKey,
        payload: {
          source: "linear_workflow",
          workflowId: workflow.id,
          workflowName: workflow.name,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          ...(issue.url ? { issueUrl: issue.url } : {}),
          laneId,
          runId: run.id,
          continuity: {
            scope: {
              runId: run.id,
              laneId,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
            },
          },
        },
      });
      const wake = await args.workerHeartbeatService.triggerWakeup({
        agentId: worker.id,
        reason: "assignment",
        taskKey,
        issueKey: issue.identifier,
        prompt: buildDelegationPrompt(run, workflow, target, issue),
        context: {
          source: "linear_workflow",
          issueId: issue.id,
          workflowId: workflow.id,
          prStrategy: target.prStrategy ?? null,
          laneId,
          runId: run.id,
        },
      });
      updateRun(run.id, {
        executionLaneId: laneId,
        linkedWorkerRunId: wake.runId,
        status: target.type === "pr_resolution" ? "waiting_for_pr" : "waiting_for_target",
      });
      updateExecutionState(run.id, {
        waitingFor: target.type === "pr_resolution" ? "pull request progress" : "delegated work",
        stalledReason: null,
        employeeOverride: override,
        overrideSource,
        workerId: worker.id,
        workerSlug: worker.slug,
        sessionLabel: null,
      });
      const workerPatch: Partial<LinearWorkflowRun> & Record<string, unknown> = {
        executionLaneId: laneId,
        linkedWorkerRunId: wake.runId,
        status: target.type === "pr_resolution" ? "waiting_for_pr" : "waiting_for_target",
        workerId: worker.id,
        workerSlug: worker.slug,
        sessionLabel: null,
        laneId,
        activeTargetType: target.type,
      };
      if (target.prStrategy && target.prTiming === "after_start") {
        const linkedPrId = await ensureLinkedPr({ ...run, ...workerPatch }, workflow, target, laneId);
        if (linkedPrId) {
          workerPatch.linkedPrId = linkedPrId;
        }
      }
      return workerPatch;
    }

    updateExecutionState(run.id, {
      waitingFor: "supervisor review",
      stalledReason: null,
      employeeOverride: override,
      overrideSource,
    });
    return {
      reviewState: "pending",
      status: "awaiting_human_review",
      activeTargetType: target.type,
    };
  };

  const finalizeRun = async (run: LinearWorkflowRun, workflow: LinearWorkflowDefinition, outcome: "completed" | "failed" | "cancelled", summary: string): Promise<void> => {
    const issue = run.sourceIssueSnapshot as NormalizedLinearIssue;
    await args.closeoutService.applyOutcome({
      run,
      workflow,
      issue,
      outcome,
      summary,
    });
    updateRun(run.id, {
      status: outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled",
      closeoutState: "applied",
      terminalOutcome: outcome,
      lastError: outcome === "completed" ? null : summary,
    });
    appendEvent(run.id, "run.finalized", outcome, summary, null);
    const refreshed = toRun(getRunRow(run.id)!);
    if (outcome === "completed") {
      emitRunEvent(refreshed, "completed", summary);
      emitNotification(refreshed, `${refreshed.identifier} is ready`, summary, "success");
    } else {
      emitRunEvent(refreshed, "failed", summary);
      emitNotification(refreshed, `${refreshed.identifier} needs attention`, summary, "error");
    }

    if (refreshed.linkedSessionId) {
      const outcomeLabel = outcome === "completed" ? "completed successfully" : outcome === "failed" ? "failed" : "been cancelled";
      await args.agentChatService.sendMessage({
        sessionId: refreshed.linkedSessionId,
        text: `[Linear Workflow] The workflow for ${refreshed.identifier} (${refreshed.title}) has ${outcomeLabel}. ${summary}`,
      }).catch(() => {
        /* best-effort notification — don't fail finalization if chat send fails */
      });
    }
  };

  const findStepIndex = (workflow: LinearWorkflowDefinition, stepId: string | null | undefined): number =>
    workflow.steps.findIndex((entry) => entry.id === stepId);

  const resetStepsFromIndex = (runId: string, startIndex: number, workflow: LinearWorkflowDefinition): void => {
    const stepRows = getStepRows(runId);
    for (let index = startIndex; index < workflow.steps.length; index += 1) {
      const workflowStep = workflow.steps[index];
      if (!workflowStep) continue;
      const row = stepRows.find((entry) => entry.workflow_step_id === workflowStep.id);
      if (!row) continue;
      updateStep(row.id, {
        status: "pending",
        startedAt: null,
        completedAt: null,
        payload: null,
      });
    }
  };

  const hasFutureStepType = (workflow: LinearWorkflowDefinition, startIndex: number, type: LinearWorkflowStep["type"]): boolean =>
    workflow.steps.slice(startIndex + 1).some((entry) => entry.type === type);

  const maybeEmitReviewReady = (
    runId: string,
    workflow: LinearWorkflowDefinition,
    completedStepIndex: number,
    fallbackReason: LinearWorkflowRun["reviewReadyReason"],
    message: string
  ): void => {
    if (hasFutureStepType(workflow, completedStepIndex, "wait_for_pr")) return;
    if (hasFutureStepType(workflow, completedStepIndex, "request_human_review")) return;
    const current = getRunRow(runId);
    if (!current) return;
    if (!current.review_ready_reason && fallbackReason) {
      updateRun(runId, { reviewReadyReason: fallbackReason });
    }
    const refreshed = toRun(getRunRow(runId)!);
    emitRunEvent(refreshed, "review_ready", message);
    emitNotification(refreshed, `${refreshed.identifier} moved to review`, message, "success");
  };

  const buildReviewContext = (workflow: LinearWorkflowDefinition, step: LinearWorkflowStep) => ({
    reviewerIdentityKey: (step.reviewerIdentityKey ?? workflow.humanReview?.reviewers?.[0] ?? "cto") as AgentChatIdentityKey | null,
    rejectAction: step.rejectAction ?? (workflow.closeout?.reopenOnFailure ? "reopen_issue" : "cancel"),
    loopToStepId: step.loopToStepId ?? (workflow.steps.find((entry) => entry.type === "launch_target")?.id ?? null),
    instructions: step.instructions?.trim() || workflow.humanReview?.instructions?.trim() || null,
  });

  const refreshIssueSnapshot = async (runId: string, issueId: string): Promise<NormalizedLinearIssue | null> => {
    const fresh = await args.issueTracker.fetchIssueById(issueId);
    if (!fresh) return null;
    args.db.run(
      `update linear_workflow_runs set source_issue_snapshot_json = ?, updated_at = ? where id = ? and project_id = ?`,
      [JSON.stringify(fresh), nowIso(), runId, args.projectId]
    );
    return fresh;
  };

  const preserveDurableLaunchAfterError = (
    runId: string,
    workflow: LinearWorkflowDefinition,
    policy: LinearWorkflowConfig,
    error: unknown,
  ): LinearWorkflowRun | null => {
    const currentRow = getRunRow(runId);
    if (!currentRow) return null;
    const currentRun = toRun(currentRow);
    if (!hasDurableLaunchMarker(currentRun)) {
      return null;
    }

    const currentStep = currentRun.currentStepId
      ? workflow.steps.find((entry) => entry.id === currentRun.currentStepId) ?? null
      : workflow.steps[currentRun.currentStepIndex] ?? null;
    const currentStepRow = currentStep
      ? getStepRows(runId).find((entry) => entry.workflow_step_id === currentStep.id) ?? null
      : null;

    if (currentStep?.type === "launch_target" && currentStepRow && currentStepRow.status !== "completed") {
      updateStep(currentStepRow.id, {
        status: "completed",
        completedAt: nowIso(),
        payload: buildLaunchPayloadFromRun(currentRun, workflow, policy),
      });
      updateRun(runId, {
        currentStepIndex: currentRun.currentStepIndex + 1,
        currentStepId: workflow.steps[currentRun.currentStepIndex + 1]?.id ?? null,
      });
    }

    appendEvent(
      runId,
      "run.launch_preserved_after_error",
      "warning",
      `Preserved launched target after error: ${error instanceof Error ? error.message : String(error)}`,
      buildLaunchPayloadFromRun(toRun(getRunRow(runId)!), workflow, policy),
    );
    return toRun(getRunRow(runId)!);
  };

  const advanceRun = async (runId: string, policy: LinearWorkflowConfig): Promise<LinearWorkflowRun | null> => {
    const row = getRunRow(runId);
    if (!row) return null;
    const run = toRun(row);
    const workflow = policy.workflows.find((entry) => entry.id === run.workflowId);
    if (!workflow) {
      updateRun(run.id, {
        status: "failed",
        closeoutState: "failed",
        terminalOutcome: "failed",
        lastError: `Workflow '${run.workflowId}' no longer exists.`,
      });
      return toRun(getRunRow(run.id)!);
    }

    try {
      const refreshedIssue = await refreshIssueSnapshot(run.id, run.issueId);
      if (refreshedIssue && (refreshedIssue.stateType === "completed" || refreshedIssue.stateType === "canceled")) {
        const reason = refreshedIssue.stateType === "completed" ? "completed" : "cancelled";
        appendEvent(run.id, "run.cancelled", "cancelled", `Issue ${run.identifier} is no longer open (state: ${refreshedIssue.stateName}).`);
        await finalizeRun(run, workflow, "cancelled", `Issue ${run.identifier} was ${reason} externally.`);
        return toRun(getRunRow(run.id)!);
      }

      const steps = getStepRows(run.id);
      for (let index = run.currentStepIndex; index < steps.length; index += 1) {
        const stepRow = steps[index]!;
        const step = workflow.steps.find((entry) => entry.id === stepRow.workflow_step_id);
        if (!step) continue;
        updateRun(run.id, { currentStepIndex: index, currentStepId: step.id, status: "in_progress" });
        if (stepRow.status === "completed") continue;
        updateStep(stepRow.id, { status: "running", startedAt: stepRow.started_at ?? nowIso() });

      if (step.type === "launch_target") {
        const liveRun = toRun(getRunRow(run.id)!);
        const patch = await executeTarget(liveRun, policy, workflow, liveRun.sourceIssueSnapshot as NormalizedLinearIssue);
        const launchedTargetType = String((patch.activeTargetType as string | undefined) ?? liveRun.executionContext?.activeTargetType ?? liveRun.targetType);
        updateRun(run.id, { ...patch, currentStepIndex: index + 1, currentStepId: workflow.steps[index + 1]?.id ?? null });
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso(), payload: patch });
        appendEvent(run.id, "step.launch_target", "completed", `Launched ${launchedTargetType}.`, patch as Record<string, unknown>);
        emitRunEvent(toRun(getRunRow(run.id)!), "delegated", `Delegated to ${launchedTargetType}.`);
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note: `Delegated to ${launchedTargetType.replace(/_/g, " ")}.`,
          waitingFor:
            patch.status === "waiting_for_target"
              ? "delegated work"
              : patch.status === "waiting_for_pr"
                ? "pull request"
                : patch.status === "awaiting_human_review"
                  ? "supervisor review"
                  : patch.status === "awaiting_delegation"
                    ? "manual delegation"
                    : patch.status === "awaiting_lane_choice"
                      ? "operator lane choice"
                      : null,
        });
        const nextStep = workflow.steps[index + 1] ?? null;
        const shouldPauseAfterLaunch =
          patch.status === "awaiting_human_review"
          || patch.status === "awaiting_delegation"
          || patch.status === "awaiting_lane_choice"
          || (patch.status === "waiting_for_target" && nextStep?.type === "wait_for_target_status")
          || (patch.status === "waiting_for_pr" && nextStep?.type === "wait_for_pr");
        if (shouldPauseAfterLaunch) {
          return toRun(getRunRow(run.id)!);
        }
        continue;
      }

      if (step.type === "wait_for_target_status") {
        const liveRun = toRun(getRunRow(run.id)!);
        const activeTarget = getActiveTarget(liveRun, workflow);
        const stages = getTargetStages(workflow.target);
        const activeStageIndex = getActiveTargetStageIndex(liveRun, workflow);
        const nextTarget = stages[activeStageIndex + 1] ?? null;
        const evaluation = await evaluateTargetCompletion(liveRun, workflow, step);
        if (evaluation.runPatch) {
          updateRun(run.id, evaluation.runPatch);
        }
        if (evaluation.state === "waiting") {
          const waitFor = String((evaluation.payload as { waitingFor?: string }).waitingFor ?? "delegated work");
          updateExecutionState(run.id, {
            waitingFor: waitFor,
            stalledReason:
              waitFor === "explicit_completion"
                ? "Waiting for an explicit ADE completion signal."
                : null,
          });
          updateRun(run.id, { status: activeTarget.type === "pr_resolution" ? "waiting_for_pr" : "waiting_for_target" });
          updateStep(stepRow.id, { status: "waiting", payload: evaluation.payload });
          await syncWorkflowWorkpad({
            runId: run.id,
            workflow,
            note:
              evaluation.payload && typeof evaluation.payload.sessionRelinked === "boolean" && evaluation.payload.sessionRelinked
                ? "Relinked the delegated session and resumed waiting."
                : "Delegated work is still in progress.",
            waitingFor: waitFor,
          });
          return toRun(getRunRow(run.id)!);
        }
        if (evaluation.state === "failed" || evaluation.state === "cancelled") {
          updateExecutionState(run.id, {
            waitingFor: null,
            stalledReason: `Target ${evaluation.state}.`,
          });
          updateStep(stepRow.id, { status: "failed", completedAt: nowIso(), payload: evaluation.payload });
          await finalizeRun(
            toRun(getRunRow(run.id)!),
            workflow,
            evaluation.state === "failed" ? "failed" : "cancelled",
            `Target ${evaluation.state}.`,
          );
          return toRun(getRunRow(run.id)!);
        }

        if (nextTarget) {
          const nextStageIndex = activeStageIndex + 1;
          const currentOverride = liveRun.executionContext?.employeeOverride ?? null;
          const shouldClearOverride =
            Boolean(currentOverride)
            && (
              nextTarget.type !== activeTarget.type
              || !isEmployeeOverrideCompatibleWithTarget(policy, nextTarget.type, currentOverride)
            );
          updateRun(run.id, {
            linkedMissionId: null,
            linkedSessionId: null,
            linkedWorkerRunId: null,
          });
          updateExecutionState(run.id, {
            activeStageIndex: nextStageIndex,
            activeTargetType: nextTarget.type,
            downstreamPending: nextStageIndex < stages.length - 1,
            waitingFor: null,
            stalledReason: null,
            ...(shouldClearOverride ? { employeeOverride: null, overrideSource: null } : {}),
          });
          const stagedRun = toRun(getRunRow(run.id)!);
          const plannedDownstreamTargetType = String(nextTarget.type);
          const waitForPrIndex =
            plannedDownstreamTargetType === "pr_resolution"
              ? workflow.steps.findIndex((entry, stepIndex) => stepIndex > index && entry.type === "wait_for_pr")
              : -1;
          if (plannedDownstreamTargetType === "pr_resolution" && waitForPrIndex < 0) {
            throw new Error(`Workflow '${workflow.name}' launched a PR-resolution stage without a later wait_for_pr step.`);
          }
          const downstreamPatch = await executeTarget(stagedRun, policy, workflow, stagedRun.sourceIssueSnapshot as NormalizedLinearIssue);
          const downstreamTargetType = String((downstreamPatch.activeTargetType as string | undefined) ?? plannedDownstreamTargetType);
          if ((downstreamPatch.status === "waiting_for_pr" || downstreamTargetType === "pr_resolution") && waitForPrIndex < 0) {
            throw new Error(`Workflow '${workflow.name}' launched a PR-resolution stage without a later wait_for_pr step.`);
          }
          if (downstreamPatch.status === "waiting_for_pr" && waitForPrIndex >= 0) {
            updateRun(run.id, {
              ...downstreamPatch,
              currentStepIndex: waitForPrIndex,
              currentStepId: workflow.steps[waitForPrIndex]?.id ?? null,
            });
            updateStep(stepRow.id, {
              status: "completed",
              completedAt: nowIso(),
              payload: {
                ...evaluation.payload,
                downstreamStageIndex: nextStageIndex,
                downstreamTargetType,
              },
            });
            appendEvent(run.id, "run.downstream_target_started", "completed", `Started downstream stage ${downstreamTargetType}.`, {
              downstreamStageIndex: nextStageIndex,
              downstreamTargetType,
            });
            await syncWorkflowWorkpad({
              runId: run.id,
              workflow,
              note: `Stage ${activeStageIndex + 1} finished; delegated to ${downstreamTargetType.replace(/_/g, " ")}.`,
              waitingFor: "pull request",
            });
            return toRun(getRunRow(run.id)!);
          }

          const downstreamWaitingFor =
            downstreamPatch.status === "awaiting_human_review"
              ? "supervisor review"
              : downstreamPatch.status === "awaiting_delegation"
                ? "manual delegation"
                : downstreamPatch.status === "awaiting_lane_choice"
                  ? "operator lane choice"
                  : downstreamPatch.status === "waiting_for_pr"
                    ? "pull request"
                    : "delegated work";
          updateRun(run.id, {
            ...downstreamPatch,
            currentStepIndex: index,
            currentStepId: step.id,
          });
          updateStep(stepRow.id, {
            status: "waiting",
            payload: {
              ...stripManualCompletionState(evaluation.payload),
              downstreamStageIndex: nextStageIndex,
              downstreamTargetType,
              waitingFor: downstreamWaitingFor,
            },
          });
          appendEvent(run.id, "run.downstream_target_started", "completed", `Started downstream stage ${downstreamTargetType}.`, {
            downstreamStageIndex: nextStageIndex,
            downstreamTargetType,
          });
          await syncWorkflowWorkpad({
            runId: run.id,
            workflow,
            note: `Stage ${activeStageIndex + 1} finished; delegated to ${downstreamTargetType.replace(/_/g, " ")}.`,
            waitingFor: downstreamWaitingFor,
          });
          return toRun(getRunRow(run.id)!);
        }

        clearExecutionWaitState(run.id);
        if ((workflow.closeout?.reviewReadyWhen ?? "work_complete") === "work_complete") {
          updateRun(run.id, { reviewReadyReason: "work_complete" });
        }
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso(), payload: evaluation.payload });
        maybeEmitReviewReady(run.id, workflow, index, "work_complete", "Delegated work finished and the workflow is review-ready.");
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note: "Delegated work finished and the workflow is review-ready.",
        });
        continue;
      }

      if (step.type === "wait_for_pr") {
        const refreshed = toRun(getRunRow(run.id)!);
        const target = getActiveTarget(refreshed, workflow);
        const linkedPrId = await ensureLinkedPr(refreshed, workflow, target);
        if (!linkedPrId) {
          updateRun(run.id, { status: "waiting_for_pr" });
          updateStep(stepRow.id, { status: "waiting", payload: { waitingFor: "pr_link" } });
          await syncWorkflowWorkpad({
            runId: run.id,
            workflow,
            note: "Waiting for a PR to be linked or created.",
            waitingFor: "pull request",
          });
          return toRun(getRunRow(run.id)!);
        }
        const prStatus = await syncPrState(run.id, linkedPrId);
        const reviewReadyWhen = workflow.closeout?.reviewReadyWhen ?? "pr_created";
        if (reviewReadyWhen === "pr_ready" && !isPrReviewReady(prStatus)) {
          updateRun(run.id, { status: "waiting_for_pr" });
          updateStep(stepRow.id, {
            status: "waiting",
            payload: {
              waitingFor: "pr_review_ready",
              linkedPrId,
              prState: prStatus?.state ?? null,
              prChecksStatus: prStatus?.checksStatus ?? null,
              prReviewStatus: prStatus?.reviewStatus ?? null,
            },
          });
          await syncWorkflowWorkpad({
            runId: run.id,
            workflow,
            note: "PR is linked, but it is not review-ready yet.",
            waitingFor: "review-ready PR",
          });
          return toRun(getRunRow(run.id)!);
        }
        updateRun(run.id, { reviewReadyReason: reviewReadyWhen === "pr_ready" ? "pr_ready" : "pr_created" });
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
        maybeEmitReviewReady(
          run.id,
          workflow,
          index,
          reviewReadyWhen === "pr_ready" ? "pr_ready" : "pr_created",
          reviewReadyWhen === "pr_ready"
            ? "PR is open and review-ready."
            : "A PR is linked and the workflow is review-ready."
        );
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note:
            reviewReadyWhen === "pr_ready"
              ? "PR is open and review-ready."
              : "A PR is linked and the workflow is review-ready.",
        });
        continue;
      }

      if (step.type === "request_human_review") {
        const reviewContext = buildReviewContext(workflow, step);
        const liveRun = toRun(getRunRow(run.id)!);

        // Check for review timeout — default 48 hours.
        if (liveRun.status === "awaiting_human_review" && stepRow.status === "waiting" && stepRow.started_at) {
          const REVIEW_TIMEOUT_MS = 48 * 60 * 60 * 1000;
          const elapsedMs = Date.now() - Date.parse(stepRow.started_at);
          if (elapsedMs >= REVIEW_TIMEOUT_MS) {
            updateStep(stepRow.id, {
              status: "failed",
              completedAt: nowIso(),
              payload: { reviewState: "timeout", note: "Review timed out after 48 hours." },
            });
            appendEvent(run.id, "step.review_timeout", "failed", "Supervisor review timed out after 48 hours.", {
              reviewerIdentityKey: reviewContext.reviewerIdentityKey,
              elapsedMs,
            });
            await finalizeRun(
              toRun(getRunRow(run.id)!),
              workflow,
              "failed",
              "Supervisor review timed out after 48 hours without a response."
            );
            return toRun(getRunRow(run.id)!);
          }
        }

        if (liveRun.reviewState === "approved") {
          updateStep(stepRow.id, {
            status: "completed",
            completedAt: nowIso(),
            payload: {
              reviewState: "approved",
              reviewerIdentityKey: reviewContext.reviewerIdentityKey,
              note: liveRun.latestReviewNote ?? null,
            },
          });
          appendEvent(run.id, "run.review_approved", "completed", liveRun.latestReviewNote ?? "Supervisor approved the handoff.", {
            reviewerIdentityKey: reviewContext.reviewerIdentityKey,
          });
          maybeEmitReviewReady(run.id, workflow, index, liveRun.reviewReadyReason ?? "supervisor_approved", "Supervisor approved the workflow handoff.");
          continue;
        }
        if (liveRun.reviewState === "rejected" || liveRun.reviewState === "changes_requested") {
          if (reviewContext.rejectAction === "loop_back") {
            const loopIndex = Math.max(0, findStepIndex(workflow, reviewContext.loopToStepId));
            resetStepsFromIndex(run.id, loopIndex, workflow);
            updateRun(run.id, {
              status: "queued",
              currentStepIndex: loopIndex,
              currentStepId: workflow.steps[loopIndex]?.id ?? null,
              reviewState: "changes_requested",
              reviewReadyReason: null,
              linkedMissionId: null,
              linkedSessionId: null,
              linkedWorkerRunId: null,
            });
            updateExecutionState(run.id, {
              activeStageIndex: 0,
              activeTargetType: null,
              downstreamPending: false,
              waitingFor: null,
              stalledReason: null,
            });
            appendEvent(run.id, "run.review_changes_requested", "queued", liveRun.latestReviewNote ?? "Supervisor requested changes.", {
              reviewerIdentityKey: reviewContext.reviewerIdentityKey,
              loopToStepId: workflow.steps[loopIndex]?.id ?? null,
            });
            return toRun(getRunRow(run.id)!);
          }
          if (reviewContext.rejectAction === "reopen_issue") {
            updateStep(stepRow.id, {
              status: "failed",
              completedAt: nowIso(),
              payload: { reviewState: liveRun.reviewState, note: liveRun.latestReviewNote ?? null },
            });
            await finalizeRun(
              toRun(getRunRow(run.id)!),
              workflow,
              "failed",
              liveRun.latestReviewNote ?? "Supervisor rejected the workflow handoff and reopened the issue."
            );
            return toRun(getRunRow(run.id)!);
          }
          updateStep(stepRow.id, {
            status: "failed",
            completedAt: nowIso(),
            payload: { reviewState: liveRun.reviewState, note: liveRun.latestReviewNote ?? null },
          });
          await finalizeRun(
            toRun(getRunRow(run.id)!),
            workflow,
            "cancelled",
            liveRun.latestReviewNote ?? "Supervisor rejected the workflow handoff."
          );
          return toRun(getRunRow(run.id)!);
        }
        updateRun(run.id, {
          reviewState: "pending",
          supervisorIdentityKey: reviewContext.reviewerIdentityKey,
          status: "awaiting_human_review",
        });
        updateStep(stepRow.id, {
          status: "waiting",
          payload: {
            reviewState: "pending",
            reviewerIdentityKey: reviewContext.reviewerIdentityKey,
            rejectAction: reviewContext.rejectAction,
            loopToStepId: reviewContext.loopToStepId,
            instructions: reviewContext.instructions,
          },
        });
        appendEvent(run.id, "step.request_human_review", "waiting", "Awaiting supervisor approval.", {
          reviewerIdentityKey: reviewContext.reviewerIdentityKey,
          rejectAction: reviewContext.rejectAction,
          loopToStepId: reviewContext.loopToStepId,
        });
        emitRunEvent(toRun(getRunRow(run.id)!), "supervisor_handoff", "Supervisor review is required before the workflow can continue.");
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note: "Workflow is waiting for supervisor review.",
          waitingFor: "supervisor review",
        });
        return toRun(getRunRow(run.id)!);
      }

      if (step.type === "comment_linear" && step.comment?.trim()) {
        await args.issueTracker.createComment(run.issueId, step.comment.trim());
      } else if (step.type === "set_linear_state" && step.state) {
        const states = await args.issueTracker.fetchWorkflowStates((run.sourceIssueSnapshot as NormalizedLinearIssue).teamKey);
        const stepState = step.state;
        const nextState = states.find((entry) => entry.type === (stepState === "done" ? "completed" : stepState === "in_progress" ? "started" : undefined))
          ?? states.find((entry) => entry.name.toLowerCase().includes(stepState.replace(/_/g, " ")));
        if (nextState) {
          await args.issueTracker.updateIssueState(run.issueId, nextState.id);
          appendEvent(run.id, "step.set_linear_state", "completed", `Moved issue to ${nextState.name}.`, {
            stateId: nextState.id,
            stateName: nextState.name,
          });
        }
      } else if (step.type === "set_linear_assignee") {
        await args.issueTracker.updateIssueAssignee(run.issueId, step.assigneeId ?? null);
        appendEvent(run.id, "step.set_linear_assignee", "completed", "Updated the Linear assignee.", {
          assigneeId: step.assigneeId ?? null,
        });
      } else if (step.type === "apply_linear_label" && step.label?.trim()) {
        await args.issueTracker.addLabel(run.issueId, step.label.trim());
        appendEvent(run.id, "step.apply_linear_label", "completed", `Applied label '${step.label.trim()}'.`, {
          label: step.label.trim(),
        });
      } else if (step.type === "attach_artifacts") {
        const refreshed = toRun(getRunRow(run.id)!);
        const issue = refreshed.sourceIssueSnapshot as NormalizedLinearIssue;
        const artifactMode = step.mode ?? workflow.closeout?.artifactMode ?? "links";
        try {
          await args.closeoutService.applyOutcome({
            run: refreshed,
            workflow,
            issue,
            outcome: "completed",
            summary: step.summary?.trim() || "Artifacts collected for the workflow run.",
          });
          appendEvent(run.id, "step.attach_artifacts", "completed", "Artifacts posted to the Linear issue.", {
            artifactMode,
          });
        } catch (error) {
          appendEvent(run.id, "step.attach_artifacts", "completed", "Artifact attachment attempted but encountered an error.", {
            artifactMode,
            error: String(error && typeof error === "object" && "message" in error ? (error as { message: string }).message : error),
          });
        }
      } else if (step.type === "complete_issue") {
        await finalizeRun(toRun(getRunRow(run.id)!), workflow, "completed", "Workflow completed successfully.");
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
        return toRun(getRunRow(run.id)!);
      } else if (step.type === "reopen_issue") {
        await finalizeRun(toRun(getRunRow(run.id)!), workflow, "failed", "Workflow requested issue reopen.");
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
        return toRun(getRunRow(run.id)!);
      } else if (step.type === "emit_app_notification") {
        const refreshed = toRun(getRunRow(run.id)!);
        if (step.notifyOn) {
          const events = getEventRows(run.id);
          const milestoneMap: Record<string, string> = {
            "step.launch_target": "delegated",
            "run.pr_linked": "pr_linked",
            "run.pr_created": "pr_linked",
            "run.review_approved": "review_ready",
            "run.finalized": "completed",
          };
          const reachedMilestones = new Set<string>();
          for (const event of events) {
            const mapped = milestoneMap[event.event_type];
            if (mapped) {
              if (mapped === "completed" && event.status === "failed") {
                reachedMilestones.add("failed");
              } else {
                reachedMilestones.add(mapped);
              }
            }
          }
          if (!reachedMilestones.has(step.notifyOn)) {
            appendEvent(run.id, "step.emit_app_notification", "skipped", `Skipped notification: milestone '${step.notifyOn}' not reached.`, {
              notifyOn: step.notifyOn,
              reachedMilestones: [...reachedMilestones],
            });
            updateStep(stepRow.id, { status: "skipped", completedAt: nowIso() });
            continue;
          }
        }
        const title = step.notificationTitle?.trim() || `${refreshed.identifier} workflow update`;
        const message = step.message?.trim() || step.body?.trim() || step.summary?.trim() || "Workflow milestone reached.";
        emitNotification(refreshed, title, message, "info");
        appendEvent(run.id, "step.emit_app_notification", "completed", message, { title, ...(step.notifyOn ? { notifyOn: step.notifyOn } : {}) });
      }

      updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
    }

      const finalRun = toRun(getRunRow(run.id)!);
      if (finalRun.status !== "completed" && finalRun.status !== "failed" && finalRun.status !== "cancelled") {
        await finalizeRun(finalRun, workflow, "completed", "Workflow completed successfully.");
      }
      return toRun(getRunRow(run.id)!);
    } catch (error) {
      const preservedRun = preserveDurableLaunchAfterError(run.id, workflow, policy, error);
      if (preservedRun) {
        return preservedRun;
      }
      await scheduleRetry(
        toRun(getRunRow(run.id) ?? row),
        workflow,
        error,
        {
          eventType: "run.retry_scheduled",
          messagePrefix: "Workflow execution failed",
          waitingFor: "automatic retry",
        },
      );
      return toRun(getRunRow(run.id)!);
    }
  };

  const createRun = (issue: NormalizedLinearIssue, match: LinearWorkflowMatchResult): LinearWorkflowRun => {
    if (!match.workflow || !match.target) {
      throw new Error("Cannot create a run without a matched workflow.");
    }
    const now = nowIso();
    const id = randomUUID();
    const routeContext: LinearWorkflowRouteContext = {
      reason: match.reason,
      matchedSignals: match.candidates.find((candidate) => candidate.workflowId === match.workflowId)?.matchedSignals ?? [],
      routeTags: match.workflow.routing?.metadataTags ?? [],
      watchOnly: match.workflow.routing?.watchOnly === true,
      candidates: match.candidates,
    };
    const executionContext: LinearWorkflowExecutionContext = {
      activeTargetType: match.target.type,
      activeStageIndex: 0,
      totalStages: getTargetStages(match.target).length,
      downstreamPending: getTargetStages(match.target).length > 1,
      routeTags: match.workflow.routing?.metadataTags ?? [],
    };
    args.db.run(
      `
        insert into linear_workflow_runs(
          id, project_id, issue_id, identifier, title, workflow_id, workflow_name, workflow_version, source, target_type,
          status, current_step_index, current_step_id, execution_lane_id, linked_mission_id, linked_session_id, linked_worker_run_id, linked_pr_id,
          review_state, supervisor_identity_key, review_ready_reason, pr_state, pr_checks_status, pr_review_status, latest_review_note,
          retry_count, retry_after, closeout_state, terminal_outcome, route_context_json, execution_context_json, source_issue_snapshot_json, last_error, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, 'pending', null, ?, ?, ?, null, ?, ?)
      `,
      [
        id,
        args.projectId,
        issue.id,
        issue.identifier,
        issue.title,
        match.workflow.id,
        match.workflow.name,
        issue.updatedAt,
        match.workflow.source ?? "generated",
        match.target.type,
        match.workflow.steps[0]?.id ?? null,
        JSON.stringify(routeContext),
        JSON.stringify(executionContext),
        JSON.stringify(issue),
        now,
        now,
      ]
    );

    match.workflow.steps.forEach((step) => {
      args.db.run(
        `
          insert into linear_workflow_run_steps(
            id, project_id, run_id, workflow_step_id, type, status, started_at, completed_at, payload_json, created_at, updated_at
          )
          values(?, ?, ?, ?, ?, 'pending', null, null, null, ?, ?)
        `,
        [randomUUID(), args.projectId, id, step.id, step.type, now, now]
      );
    });

      appendEvent(id, "run.created", "queued", `Matched workflow '${match.workflow.name}'.`, {
      candidates: match.candidates,
      nextStepsPreview: match.nextStepsPreview,
      routeTags: routeContext.routeTags,
      matchedSignals: routeContext.matchedSignals,
    });
    const created = toRun(getRunRow(id)!);
    emitRunEvent(created, "matched", `Matched workflow '${match.workflow.name}'.`);
    return created;
  };

  const findActiveRunForIssue = (issueId: string): LinearWorkflowRun | null => {
    const row = args.db.get<RunRow>(
      `
        select *
        from linear_workflow_runs
        where project_id = ?
          and issue_id = ?
          and status in ('queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'awaiting_delegation', 'awaiting_lane_choice', 'retry_wait')
        order by datetime(created_at) desc
        limit 1
      `,
      [args.projectId, issueId]
    );
    return row ? toRun(row) : null;
  };

  const cancelRun = async (runId: string, reason: string, policy: LinearWorkflowConfig): Promise<void> => {
    const row = getRunRow(runId);
    if (!row) return;
    const run = toRun(row);
    const workflow = policy.workflows.find((entry) => entry.id === run.workflowId);
    if (!workflow) {
      // No matching workflow definition — do a bare status update
      updateRun(run.id, {
        status: "cancelled",
        terminalOutcome: "cancelled",
        lastError: reason,
      });
      appendEvent(run.id, "run.finalized", "cancelled", reason, null);
      return;
    }
    await finalizeRun(run, workflow, "cancelled", reason);
  };

  const resolveRunAction = async (
    queueItemId: string,
    action: LinearSyncResolutionAction,
    note: string | undefined,
    policy: LinearWorkflowConfig,
    employeeOverride?: string,
    laneId?: string,
  ): Promise<LinearWorkflowRun | null> => {
    const row = getRunRow(queueItemId);
    const run = row ? toRun(row) : null;
    if (!run) return null;
    const workflow = policy.workflows.find((entry) => entry.id === run.workflowId);
    const currentStep = workflow?.steps.find((entry) => entry.id === run.currentStepId) ?? null;
    const currentStepRow = getStepRows(run.id).find((entry) => entry.workflow_step_id === run.currentStepId) ?? null;
    const activeTarget = workflow ? getActiveTarget(run, workflow) : null;
    const currentTargetStatus = workflow && currentStep?.type === "wait_for_target_status" && activeTarget
      ? resolveWorkflowTargetStatus(activeTarget.type, currentStep.targetStatus)
      : null;
    const reviewContext = workflow && currentStep?.type === "request_human_review"
      ? buildReviewContext(workflow, currentStep)
      : null;
    const trimmedOverride = employeeOverride?.trim();
    const trimmedLaneId = laneId?.trim();
    const resolvedOverride = trimmedOverride?.length ? resolveOverrideWorker(policy, trimmedOverride) : null;
    if (trimmedOverride !== undefined) {
      if (
        resolvedOverride === "cto"
        && (activeTarget?.type === "worker_run" || activeTarget?.type === "pr_resolution")
      ) {
        throw new Error("Choose a worker override for worker-backed targets.");
      }
      updateExecutionState(run.id, {
        employeeOverride: trimmedOverride && trimmedOverride.length ? trimmedOverride : null,
        overrideSource: trimmedOverride && trimmedOverride.length ? "operator" : null,
      });
      appendEvent(run.id, "run.override_updated", "queued", trimmedOverride?.length ? `Operator selected ${trimmedOverride}.` : "Operator cleared the employee override.", {
        employeeOverride: trimmedOverride && trimmedOverride.length ? trimmedOverride : null,
      });
    }
    if (trimmedLaneId !== undefined) {
      if (!activeTarget || activeTarget.type === "mission" || activeTarget.type === "review_gate") {
        throw new Error("This workflow target does not use an execution lane.");
      }
      const resolvedLaneId = await resolveOperatorLane(trimmedLaneId);
      if (run.executionLaneId !== resolvedLaneId) {
        updateRun(run.id, { executionLaneId: resolvedLaneId });
        updateExecutionState(run.id, {
          waitingFor: null,
          stalledReason: null,
        });
        appendEvent(run.id, "run.lane_selected", "queued", `Operator selected execution lane ${resolvedLaneId}.`, {
          laneId: resolvedLaneId,
        });
      }
    }

    if (action === "resume") {
      if (run.status !== "awaiting_delegation" && run.status !== "awaiting_lane_choice") {
        throw new Error("This workflow run is not paused for operator routing.");
      }
      const resolvedExecutionLaneId = getRunRow(run.id)?.execution_lane_id ?? null;
      if (run.status === "awaiting_lane_choice" && !resolvedExecutionLaneId) {
        throw new Error("Choose an execution lane before resuming this workflow.");
      }
      const launchTargetStepRow =
        currentStepRow?.type === "launch_target"
          ? currentStepRow
          : getStepRows(run.id).find((entry) => entry.type === "launch_target") ?? null;
      if (launchTargetStepRow) {
        updateStep(launchTargetStepRow.id, {
          status: "pending",
          startedAt: null,
          completedAt: null,
          payload: null,
        });
      }
      updateRun(run.id, {
        status: "queued",
        retryAfter: null,
        currentStepIndex: 0,
        currentStepId: null,
        latestReviewNote: note ?? run.latestReviewNote,
        linkedMissionId: null,
        linkedSessionId: null,
        linkedWorkerRunId: null,
      });
      updateExecutionState(run.id, {
        activeStageIndex: 0,
        activeTargetType: null,
        downstreamPending: false,
        waitingFor: null,
        stalledReason: null,
      });
      appendEvent(run.id, "run.resumed", "queued", note ?? "Queued with operator routing input.", {
        employeeOverride: trimmedOverride && trimmedOverride.length ? trimmedOverride : null,
        laneId: resolvedExecutionLaneId,
      });
    } else if (action === "complete") {
      if (!workflow || !currentStep || !currentStepRow || currentStep.type !== "wait_for_target_status" || currentTargetStatus !== "explicit_completion") {
        throw new Error("This workflow run is not waiting on an explicit ADE completion signal.");
      }
      const existingPayload = safeJsonParse<Record<string, unknown> | null>(currentStepRow.payload_json, null);
      // Store the manual-completion signal in the step payload but do NOT mark
      // the step as "completed" — let advanceRun evaluate the target, handle
      // downstream stage handoffs, and finalize the step through its normal path.
      updateStep(currentStepRow.id, {
        payload: {
          ...(existingPayload ?? {}),
          targetState: "completed",
          targetStatus: currentTargetStatus,
          completionSource: "manual",
          stageId: buildTargetStageId(run, workflow, currentStep),
          note: note ?? null,
        },
      });
      updateRun(run.id, {
        status: "queued",
        latestReviewNote: note ?? run.latestReviewNote,
      });
      appendEvent(run.id, "run.target_completed", "completed", note ?? "Marked complete from ADE.", {
        stepId: currentStep.id,
        targetStatus: currentTargetStatus,
      });
    } else if (action === "approve") {
      if (currentStepRow && currentStep?.type === "request_human_review") {
        updateStep(currentStepRow.id, {
          status: "completed",
          completedAt: nowIso(),
          payload: {
            reviewState: "approved",
            reviewerIdentityKey: reviewContext?.reviewerIdentityKey ?? null,
            note: note ?? null,
          },
        });
      }
      updateRun(run.id, {
        reviewState: "approved",
        latestReviewNote: note ?? null,
        status: "queued",
      });
      appendEvent(run.id, "run.approved", "completed", note ?? "Approved for dispatch.", {
        reviewerIdentityKey: reviewContext?.reviewerIdentityKey ?? null,
      });
      if (workflow) {
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note: note ?? "Supervisor approved the workflow handoff.",
        });
      }
    } else if (action === "reject") {
      updateRun(run.id, {
        reviewState: reviewContext?.rejectAction === "loop_back" ? "changes_requested" : "rejected",
        latestReviewNote: note ?? "Rejected by reviewer.",
        status: reviewContext?.rejectAction === "loop_back" ? "queued" : "in_progress",
        lastError: note ?? "Rejected by reviewer.",
        ...(reviewContext?.rejectAction === "loop_back" ? {
          linkedMissionId: null,
          linkedSessionId: null,
          linkedWorkerRunId: null,
        } : {}),
      });
      if (reviewContext?.rejectAction === "loop_back") {
        updateExecutionState(run.id, {
          activeStageIndex: 0,
          activeTargetType: null,
          downstreamPending: false,
          waitingFor: null,
          stalledReason: null,
        });
      }
      appendEvent(run.id, "run.rejected", "queued", note ?? "Rejected by reviewer.", {
        reviewerIdentityKey: reviewContext?.reviewerIdentityKey ?? null,
        rejectAction: reviewContext?.rejectAction ?? null,
      });
      if (workflow) {
        await syncWorkflowWorkpad({
          runId: run.id,
          workflow,
          note: note ?? "Supervisor requested changes.",
          waitingFor: reviewContext?.rejectAction === "loop_back" ? "re-delegation" : "manual follow-up",
        });
      }
    } else {
      const resetStep = (stepRow: StepRow | null) => {
        if (!stepRow) return;
        updateStep(stepRow.id, {
          status: "pending",
          startedAt: null,
          completedAt: null,
          payload: null,
        });
      };
      const launchTargetStepRow =
        currentStepRow?.type === "launch_target"
          ? currentStepRow
          : getStepRows(run.id).find((entry) => entry.type === "launch_target") ?? null;
      const shouldResetLaunchTarget =
        launchTargetStepRow?.status === "completed"
        && (
          run.status === "awaiting_delegation"
          || run.status === "awaiting_lane_choice"
          || currentStep?.type === "wait_for_target_status"
          || currentStep?.type === "wait_for_pr"
        );
      if (currentStepRow?.status === "failed") {
        resetStep(currentStepRow);
      }
      if (shouldResetLaunchTarget && launchTargetStepRow?.id !== currentStepRow?.id) {
        resetStep(launchTargetStepRow);
      } else if (shouldResetLaunchTarget) {
        resetStep(launchTargetStepRow);
      }
      updateRun(run.id, {
        status: "queued",
        retryAfter: null,
        retryCount: run.retryCount + 1,
        currentStepIndex: 0,
        currentStepId: null,
        latestReviewNote: note ?? run.latestReviewNote,
        linkedMissionId: null,
        linkedSessionId: null,
        linkedWorkerRunId: null,
      });
      updateExecutionState(run.id, {
        activeStageIndex: 0,
        activeTargetType: null,
        downstreamPending: false,
        waitingFor: null,
        stalledReason: null,
      });
      appendEvent(run.id, "run.retried", "queued", note ?? "Queued for retry.", null);
    }

    return toRun(getRunRow(run.id)!);
  };

  const listQueue = (): LinearSyncQueueItem[] => {
    const rows = args.db.all<RunRow>(
      `
        select *
        from linear_workflow_runs
        where project_id = ?
        order by datetime(created_at) desc
        limit 300
      `,
      [args.projectId]
    );
    return rows.map((row) => {
      const queueRun = toRun(row);
      const steps = getStepRows(row.id);
      const currentStep = steps.find((entry) => entry.workflow_step_id === row.current_step_id) ?? null;
      const launchContext = safeJsonParse<Record<string, unknown> | null>(
        steps.find((entry) => entry.type === "launch_target")?.payload_json ?? null, null
      ) ?? {};
      const delegatedContext = readDelegationContext(queueRun, launchContext);
      const status: LinearSyncQueueItem["status"] =
        row.status === "queued" || row.status === "awaiting_delegation" || row.status === "awaiting_lane_choice"
          ? "queued"
          : row.status === "retry_wait"
            ? "retry_wait"
            : row.status === "awaiting_human_review"
              ? "escalated"
              : row.status === "completed"
                ? "resolved"
                : row.status === "failed"
                  ? "failed"
                  : row.status === "cancelled"
                    ? "cancelled"
                    : "dispatched";
      return {
        id: row.id,
        runId: row.id,
        issueId: row.issue_id,
        identifier: row.identifier,
        title: row.title,
        status,
        workflowId: row.workflow_id,
        workflowName: row.workflow_name,
        targetType: row.target_type,
        laneId: row.execution_lane_id ?? (typeof launchContext.laneId === "string" ? launchContext.laneId : null),
        workerId: delegatedContext.workerId,
        workerSlug: delegatedContext.workerSlug,
        sessionLabel: delegatedContext.sessionLabel,
        missionId: row.linked_mission_id,
        sessionId: row.linked_session_id,
        workerRunId: row.linked_worker_run_id,
        prId: row.linked_pr_id,
        prState: row.pr_state,
        prChecksStatus: row.pr_checks_status,
        prReviewStatus: row.pr_review_status,
        currentStepId: row.current_step_id,
        currentStepLabel: currentStep?.workflow_step_id ?? row.current_step_id,
        reviewState: row.review_state,
        supervisorIdentityKey: (row.supervisor_identity_key ?? null) as AgentChatIdentityKey | null,
        reviewReadyReason: row.review_ready_reason,
        latestReviewNote: row.latest_review_note,
        attemptCount: row.retry_count,
        nextAttemptAt: row.retry_after,
        lastError: row.last_error,
        routeReason: queueRun.routeContext?.reason ?? null,
        matchedSignals: queueRun.routeContext?.matchedSignals ?? [],
        routeTags: queueRun.routeContext?.routeTags ?? [],
        stalledReason: queueRun.executionContext?.stalledReason ?? null,
        waitingFor: queueRun.executionContext?.waitingFor ?? null,
        employeeOverride: queueRun.executionContext?.employeeOverride ?? null,
        activeTargetType: queueRun.executionContext?.activeTargetType ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  };

  const getRunDetail = async (runId: string, policy: LinearWorkflowConfig): Promise<LinearWorkflowRunDetail | null> => {
    const row = getRunRow(runId);
    if (!row) return null;
    const run = toRun(row);
    const workflow = policy.workflows.find((entry) => entry.id === run.workflowId) ?? null;
    if (run.linkedPrId) {
      await syncPrState(run.id, run.linkedPrId);
    }
    const refreshed = toRun(getRunRow(run.id)!);
    const currentStep = workflow?.steps.find((entry) => entry.id === refreshed.currentStepId) ?? null;
    return {
      run: refreshed,
      steps: getStepRows(run.id).map((entry) => toRunStep(entry, workflow)),
      events: getEventRows(run.id).map(toRunEvent),
      ingressEvents: args.db.all(
        `
          select *
          from linear_ingress_events
          where project_id = ?
            and issue_id = ?
          order by datetime(created_at) desc
          limit 12
        `,
        [args.projectId, refreshed.issueId]
      ) as LinearIngressEventRecord[],
      issue: refreshed.sourceIssueSnapshot as NormalizedLinearIssue,
      syncEvents: args.db.all<{
        id: string;
        issueId: string | null;
        queueItemId: string | null;
        eventType: string;
        status: string | null;
        message: string | null;
        payload: string | null;
        createdAt: string;
      }>(
        `
          select id, issue_id as issueId, queue_item_id as queueItemId, event_type as eventType, status, message, payload_json as payload, created_at as createdAt
          from linear_sync_events
          where project_id = ?
            and (issue_id = ? or queue_item_id = ?)
          order by datetime(created_at) desc
          limit 12
        `,
        [args.projectId, refreshed.issueId, refreshed.id]
      ).map((entry) => ({
        id: entry.id,
        issueId: entry.issueId,
        queueItemId: entry.queueItemId,
        eventType: entry.eventType,
        status: entry.status,
        message: entry.message,
        payload: safeJsonParse<Record<string, unknown> | null>(entry.payload, null),
        createdAt: entry.createdAt,
      })),
      reviewContext: currentStep?.type === "request_human_review"
        ? buildReviewContext(workflow!, currentStep)
        : null,
    };
  };

  return {
    createRun,
    advanceRun,
    listActiveRuns,
    hasActiveRuns,
    listQueue,
    resolveRunAction,
    getRunDetail,
    findActiveRunForIssue,
    cancelRun,
  };
}

export type LinearDispatcherService = ReturnType<typeof createLinearDispatcherService>;
