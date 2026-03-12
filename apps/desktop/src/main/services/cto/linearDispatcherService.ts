import { randomUUID } from "node:crypto";
import type {
  AdapterType,
  LinearSyncQueueItem,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowEventPayload,
  LinearWorkflowMatchResult,
  LinearWorkflowRun,
  LinearWorkflowRunStatus,
  LinearWorkflowStep,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { nowIso } from "../shared/utils";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { createLaneService } from "../lanes/laneService";
import type { createPrService } from "../prs/prService";
import type { createWorkerHeartbeatService } from "./workerHeartbeatService";
import type { IssueTracker } from "./issueTracker";
import type { LinearCloseoutService } from "./linearCloseoutService";
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
  linked_mission_id: string | null;
  linked_session_id: string | null;
  linked_worker_run_id: string | null;
  linked_pr_id: string | null;
  review_state: LinearWorkflowRun["reviewState"];
  retry_count: number;
  retry_after: string | null;
  closeout_state: LinearWorkflowRun["closeoutState"];
  terminal_outcome: LinearWorkflowRun["terminalOutcome"];
  source_issue_snapshot_json: string;
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
    linkedMissionId: row.linked_mission_id,
    linkedSessionId: row.linked_session_id,
    linkedWorkerRunId: row.linked_worker_run_id,
    linkedPrId: row.linked_pr_id,
    reviewState: row.review_state,
    retryCount: row.retry_count,
    retryAfter: row.retry_after,
    closeoutState: row.closeout_state,
    terminalOutcome: row.terminal_outcome,
    sourceIssueSnapshot: JSON.parse(row.source_issue_snapshot_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildPrompt(issue: NormalizedLinearIssue): string {
  return [
    `${issue.identifier}: ${issue.title}`,
    "",
    issue.description || "No description provided.",
    "",
    `Project: ${issue.projectSlug}`,
    `Priority: ${issue.priorityLabel}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
  ].join("\n");
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

  const parsePayload = <T = Record<string, unknown>>(value: string | null): T | null => {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
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
            and status in ('queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'retry_wait')
          order by datetime(created_at) asc
        `,
        [args.projectId]
      )
      .map(toRun);

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

  const updateRun = (runId: string, patch: Partial<{
    status: LinearWorkflowRunStatus;
    currentStepIndex: number;
    currentStepId: string | null;
    linkedMissionId: string | null;
    linkedSessionId: string | null;
    linkedWorkerRunId: string | null;
    linkedPrId: string | null;
    reviewState: LinearWorkflowRun["reviewState"];
    retryCount: number;
    retryAfter: string | null;
    closeoutState: LinearWorkflowRun["closeoutState"];
    terminalOutcome: LinearWorkflowRun["terminalOutcome"];
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
            linked_mission_id = ?,
            linked_session_id = ?,
            linked_worker_run_id = ?,
            linked_pr_id = ?,
            review_state = ?,
            retry_count = ?,
            retry_after = ?,
            closeout_state = ?,
            terminal_outcome = ?,
            last_error = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        patch.status ?? existing.status,
        patch.currentStepIndex ?? existing.current_step_index,
        patch.currentStepId === undefined ? existing.current_step_id : patch.currentStepId,
        patch.linkedMissionId === undefined ? existing.linked_mission_id : patch.linkedMissionId,
        patch.linkedSessionId === undefined ? existing.linked_session_id : patch.linkedSessionId,
        patch.linkedWorkerRunId === undefined ? existing.linked_worker_run_id : patch.linkedWorkerRunId,
        patch.linkedPrId === undefined ? existing.linked_pr_id : patch.linkedPrId,
        patch.reviewState === undefined ? existing.review_state : patch.reviewState,
        patch.retryCount ?? existing.retry_count,
        patch.retryAfter === undefined ? existing.retry_after : patch.retryAfter,
        patch.closeoutState ?? existing.closeout_state,
        patch.terminalOutcome === undefined ? existing.terminal_outcome : patch.terminalOutcome,
        patch.lastError === undefined ? existing.last_error : patch.lastError,
        nowIso(),
        runId,
        args.projectId,
      ]
    );
  };

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

  const resolveWorker = (workflow: LinearWorkflowDefinition): { id: string; slug: string; adapterType: string } | null => {
    const selector = workflow.target.workerSelector;
    const workers = args.workerAgentService.listAgents({ includeDeleted: false });
    if (!selector || selector.mode === "none") return null;
    if (selector.mode === "id") {
      const match = workers.find((entry) => entry.id === selector.value);
      return match ? { id: match.id, slug: match.slug, adapterType: match.adapterType } : null;
    }
    if (selector.mode === "slug") {
      const match = workers.find((entry) => entry.slug === selector.value);
      return match ? { id: match.id, slug: match.slug, adapterType: match.adapterType } : null;
    }
    if (selector.mode === "capability") {
      const match = workers.find((entry) => entry.capabilities.includes(selector.value));
      return match ? { id: match.id, slug: match.slug, adapterType: match.adapterType } : null;
    }
    return null;
  };

  const resolveWorkerFromAssignee = (issue: NormalizedLinearIssue): { id: string; slug: string; adapterType: string } | null => {
    const assigneeValues = new Set(
      [issue.assigneeId, issue.assigneeName]
        .map((value) => (value ?? "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (!assigneeValues.size) return null;
    const workers = args.workerAgentService.listAgents({ includeDeleted: false });
    for (const worker of workers) {
      const aliases = new Set(
        [
          worker.id,
          worker.slug,
          worker.name,
          ...(worker.linearIdentity?.userIds ?? []),
          ...(worker.linearIdentity?.displayNames ?? []),
          ...(worker.linearIdentity?.aliases ?? []),
        ]
          .map((value) => (value ?? "").trim().toLowerCase())
          .filter(Boolean)
      );
      if ([...assigneeValues].some((value) => aliases.has(value))) {
        return { id: worker.id, slug: worker.slug, adapterType: worker.adapterType };
      }
    }
    return null;
  };

  const resolveEmployeeTarget = (workflow: LinearWorkflowDefinition, issue: NormalizedLinearIssue) => {
    const explicitIdentity = workflow.target.employeeIdentityKey?.trim() ?? "";
    if (explicitIdentity.startsWith("agent:")) {
      const agentId = explicitIdentity.slice("agent:".length);
      const direct = args.workerAgentService.getAgent(agentId);
      if (direct) {
        return { id: direct.id, slug: direct.slug, adapterType: direct.adapterType };
      }
    }
    return resolveWorkerFromAssignee(issue) ?? resolveWorker(workflow);
  };

  const primaryLaneId = async (): Promise<string> => {
    const lanes = await args.laneService.list({ includeArchived: false, includeStatus: false });
    const preferred = lanes.find((entry) => entry.laneType === "primary") ?? lanes[0];
    if (!preferred) throw new Error("No lane available for employee session launch.");
    return preferred.id;
  };

  const buildDelegationPrompt = (workflow: LinearWorkflowDefinition, issue: NormalizedLinearIssue): string => {
    const rendered = args.templateService.renderTemplate({
      templateId: workflow.target.sessionTemplate ?? workflow.target.missionTemplate ?? "default",
      issue,
      route: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        runMode: workflow.target.runMode ?? "autopilot",
      },
      worker: {
        assigneeId: issue.assigneeId,
        assigneeName: issue.assigneeName,
      },
    });
    const prMode = workflow.target.prStrategy ? `PR behavior: ${workflow.target.prStrategy}` : "PR behavior: only if the workflow reaches a PR step.";
    return [
      rendered.prompt,
      "",
      "Execution contract:",
      `- Start work immediately for Linear issue ${issue.identifier}.`,
      "- Keep progress observable in ADE and Linear.",
      `- ${prMode}`,
      "- When implementation is ready, leave the session in a state where ADE can move the issue to review.",
    ].join("\n");
  };

  const getLaunchContext = (runId: string): Record<string, unknown> => {
    const step = getStepRows(runId).find((entry) => entry.type === "launch_target");
    return parsePayload<Record<string, unknown>>(step?.payload_json ?? null) ?? {};
  };

  const resolveRunLaneId = async (run: LinearWorkflowRun): Promise<string | null> => {
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

  const ensureLinkedPr = async (run: LinearWorkflowRun, workflow: LinearWorkflowDefinition): Promise<string | null> => {
    if (run.linkedPrId) return run.linkedPrId;
    const laneId = await resolveRunLaneId(run);
    if (!laneId) return null;
    const existing = args.prService.getForLane(laneId);
    if (existing) {
      updateRun(run.id, { linkedPrId: existing.id });
      appendEvent(run.id, "run.pr_linked", "completed", `Linked PR #${existing.githubPrNumber}.`, { prId: existing.id, laneId });
      emitRunEvent({ ...run, linkedPrId: existing.id }, "pr_linked", `Linked PR #${existing.githubPrNumber}.`);
      return existing.id;
    }

    if (!workflow.target.prStrategy && workflow.closeout?.reviewReadyWhen === "work_complete") {
      return null;
    }

    const created = await args.prService.createFromLane({
      laneId,
      title: `${run.identifier}: ${run.title}`,
      body: `Automated PR for Linear workflow ${workflow.name}.\n\nIssue: ${run.identifier}`,
      draft: true,
    });
    updateRun(run.id, { linkedPrId: created.id });
    appendEvent(run.id, "run.pr_created", "completed", `Created PR #${created.githubPrNumber}.`, { prId: created.id, laneId });
    emitRunEvent({ ...run, linkedPrId: created.id }, "pr_linked", `Created PR #${created.githubPrNumber}.`);
    return created.id;
  };

  const executeTarget = async (
    run: LinearWorkflowRun,
    workflow: LinearWorkflowDefinition,
    issue: NormalizedLinearIssue
  ): Promise<Partial<LinearWorkflowRun> & Record<string, unknown>> => {
    const worker = resolveWorker(workflow);
    const employeeWorker = resolveEmployeeTarget(workflow, issue);

    if (workflow.target.type === "mission") {
      const rendered = args.templateService.renderTemplate({
        templateId: workflow.target.missionTemplate ?? "default",
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
        launchMode: workflow.target.runMode === "manual" ? "manual" : "autopilot",
        employeeAgentId: worker?.id,
        ...(workflow.target.prStrategy ? { executionPolicy: { prStrategy: workflow.target.prStrategy } } : {}),
      });
      await args.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: workflow.target.runMode === "manual" ? "manual" : "autopilot",
        metadata: {
          source: "linear_workflow",
          linearIssueId: issue.id,
          workflowId: workflow.id,
        },
      });
      return {
        linkedMissionId: mission.id,
        status: "waiting_for_target",
        workerId: worker?.id ?? null,
        workerSlug: worker?.slug ?? null,
      };
    }

    if (workflow.target.type === "employee_session") {
      if (!employeeWorker) throw new Error(`Workflow '${workflow.name}' could not resolve an employee session owner.`);
      const laneId = await primaryLaneId();
      const session = await args.agentChatService.ensureIdentitySession({
        identityKey: `agent:${employeeWorker.id}`,
        laneId,
      });
      const taskKey = args.workerTaskSessionService.deriveTaskKey({
        agentId: employeeWorker.id,
        laneId,
        linearIssueId: issue.id,
        chatSessionId: session.id,
        summary: issue.title,
      });
      args.workerTaskSessionService.ensureTaskSession({
        agentId: employeeWorker.id,
        adapterType: employeeWorker.adapterType as AdapterType,
        taskKey,
        payload: {
          source: "linear_workflow",
          workflowId: workflow.id,
          workflowName: workflow.name,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          issueUrl: issue.url,
          laneId,
          runId: run.id,
        },
      });
      await args.agentChatService.sendMessage({
        sessionId: session.id,
        text: buildDelegationPrompt(workflow, issue),
      });
      return {
        linkedSessionId: session.id,
        status: "waiting_for_target",
        workerId: employeeWorker.id,
        workerSlug: employeeWorker.slug,
        laneId,
      };
    }

    if (workflow.target.type === "worker_run" || workflow.target.type === "pr_resolution") {
      if (!worker) throw new Error(`Workflow '${workflow.name}' could not resolve a worker.`);
      const laneId = await primaryLaneId();
      const wake = await args.workerHeartbeatService.triggerWakeup({
        agentId: worker.id,
        reason: "assignment",
        taskKey: `linear:${issue.identifier}`,
        issueKey: issue.identifier,
        prompt: buildDelegationPrompt(workflow, issue),
        context: {
          source: "linear_workflow",
          issueId: issue.id,
          workflowId: workflow.id,
          prStrategy: workflow.target.prStrategy ?? null,
          laneId,
          runId: run.id,
        },
      });
      return {
        linkedWorkerRunId: wake.runId,
        status: workflow.target.type === "pr_resolution" ? "waiting_for_pr" : "waiting_for_target",
        workerId: worker.id,
        workerSlug: worker.slug,
        laneId,
      };
    }

    return {
      reviewState: "pending",
      status: "awaiting_human_review",
    };
  };

  const waitForTarget = async (run: LinearWorkflowRun): Promise<"waiting" | "completed" | "failed" | "cancelled"> => {
    if (run.linkedMissionId) {
      const mission = args.missionService.get(run.linkedMissionId);
      if (!mission) return "failed";
      if (mission.status === "completed") return "completed";
      if (mission.status === "failed") return "failed";
      if (mission.status === "canceled") return "cancelled";
      return "waiting";
    }
    if (run.linkedSessionId) {
      const sessions = await args.agentChatService.listSessions();
      const session = sessions.find((entry) => entry.sessionId === run.linkedSessionId);
      if (!session) return "failed";
      return session.status === "ended" ? "completed" : "waiting";
    }
    if (run.linkedWorkerRunId) {
      const runs = args.workerHeartbeatService.listRuns({ limit: 200 });
      const workerRun = runs.find((entry) => entry.id === run.linkedWorkerRunId);
      if (!workerRun) return "failed";
      if (workerRun.status === "completed") return "completed";
      if (workerRun.status === "failed") return "failed";
      if (workerRun.status === "cancelled" || workerRun.status === "skipped") return "cancelled";
      return "waiting";
    }
    return run.reviewState === "approved" ? "completed" : run.reviewState === "rejected" ? "cancelled" : "waiting";
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

    const steps = getStepRows(run.id);
    for (let index = run.currentStepIndex; index < steps.length; index += 1) {
      const stepRow = steps[index]!;
      const step = workflow.steps.find((entry) => entry.id === stepRow.workflow_step_id);
      if (!step) continue;
      updateRun(run.id, { currentStepIndex: index, currentStepId: step.id, status: "in_progress" });
      if (stepRow.status === "completed") continue;
      updateStep(stepRow.id, { status: "running", startedAt: stepRow.started_at ?? nowIso() });

      if (step.type === "launch_target") {
        const patch = await executeTarget(run, workflow, run.sourceIssueSnapshot as NormalizedLinearIssue);
        updateRun(run.id, { ...patch, currentStepIndex: index + 1, currentStepId: workflow.steps[index + 1]?.id ?? null });
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso(), payload: patch });
        appendEvent(run.id, "step.launch_target", "completed", `Launched ${workflow.target.type}.`, patch as Record<string, unknown>);
        emitRunEvent(toRun(getRunRow(run.id)!), "delegated", `Delegated to ${workflow.target.type}.`);
        if (patch.status === "awaiting_human_review" || patch.status === "waiting_for_target" || patch.status === "waiting_for_pr") {
          return toRun(getRunRow(run.id)!);
        }
        continue;
      }

      if (step.type === "wait_for_target_status") {
        const targetState = await waitForTarget(toRun(getRunRow(run.id)!));
        if (targetState === "waiting") {
          updateRun(run.id, { status: "waiting_for_target" });
          updateStep(stepRow.id, { status: "waiting", payload: { targetState } });
          return toRun(getRunRow(run.id)!);
        }
        if (targetState === "failed" || targetState === "cancelled") {
          updateStep(stepRow.id, { status: "failed", completedAt: nowIso(), payload: { targetState } });
          await finalizeRun(toRun(getRunRow(run.id)!), workflow, targetState === "failed" ? "failed" : "cancelled", `Target ${targetState}.`);
          return toRun(getRunRow(run.id)!);
        }
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso(), payload: { targetState } });
        continue;
      }

      if (step.type === "wait_for_pr") {
        const refreshed = toRun(getRunRow(run.id)!);
        const linkedPrId = await ensureLinkedPr(refreshed, workflow);
        if (!linkedPrId) {
          updateRun(run.id, { status: "waiting_for_pr" });
          updateStep(stepRow.id, { status: "waiting" });
          return toRun(getRunRow(run.id)!);
        }
        updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
        const linkedRun = toRun(getRunRow(run.id)!);
        emitRunEvent(linkedRun, "review_ready", `PR linked for ${linkedRun.identifier}.`);
        emitNotification(linkedRun, `${linkedRun.identifier} moved to review`, "A PR is linked and the workflow is review-ready.", "success");
        continue;
      }

      if (step.type === "request_human_review") {
        updateRun(run.id, { reviewState: "pending", status: "awaiting_human_review" });
        updateStep(stepRow.id, { status: "waiting", payload: { reviewState: "pending" } });
        appendEvent(run.id, "step.request_human_review", "waiting", "Awaiting approval.", null);
        return toRun(getRunRow(run.id)!);
      }

      if (step.type === "comment_linear" && step.comment?.trim()) {
        await args.issueTracker.createComment(run.issueId, step.comment.trim());
      } else if (step.type === "set_linear_state" && step.state) {
        const states = await args.issueTracker.fetchWorkflowStates((run.sourceIssueSnapshot as NormalizedLinearIssue).teamKey);
        const stepState = step.state;
        const nextState = states.find((entry) => entry.type === (stepState === "done" ? "completed" : stepState === "in_progress" ? "started" : undefined))
          ?? states.find((entry) => entry.name.toLowerCase().includes(stepState.replace(/_/g, " ")));
        if (nextState) await args.issueTracker.updateIssueState(run.issueId, nextState.id);
      } else if (step.type === "set_linear_assignee") {
        await args.issueTracker.updateIssueAssignee(run.issueId, step.assigneeId ?? null);
      } else if (step.type === "apply_linear_label" && step.label?.trim()) {
        await args.issueTracker.addLabel(run.issueId, step.label.trim());
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
        const title = step.notificationTitle?.trim() || `${refreshed.identifier} workflow update`;
        const message = step.message?.trim() || step.body?.trim() || step.summary?.trim() || "Workflow milestone reached.";
        emitNotification(refreshed, title, message, "info");
        appendEvent(run.id, "step.emit_app_notification", "completed", message, { title });
      }

      updateStep(stepRow.id, { status: "completed", completedAt: nowIso() });
    }

    const finalRun = toRun(getRunRow(run.id)!);
    if (finalRun.status !== "completed" && finalRun.status !== "failed" && finalRun.status !== "cancelled") {
      await finalizeRun(finalRun, workflow, "completed", "Workflow completed successfully.");
    }
    return toRun(getRunRow(run.id)!);
  };

  const createRun = (issue: NormalizedLinearIssue, match: LinearWorkflowMatchResult): LinearWorkflowRun => {
    if (!match.workflow || !match.target) {
      throw new Error("Cannot create a run without a matched workflow.");
    }
    const now = nowIso();
    const id = randomUUID();
    args.db.run(
      `
        insert into linear_workflow_runs(
          id, project_id, issue_id, identifier, title, workflow_id, workflow_name, workflow_version, source, target_type,
          status, current_step_index, current_step_id, linked_mission_id, linked_session_id, linked_worker_run_id, linked_pr_id,
          review_state, retry_count, retry_after, closeout_state, terminal_outcome, source_issue_snapshot_json, last_error, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, null, null, null, null, null, 0, null, 'pending', null, ?, null, ?, ?)
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
        JSON.stringify(issue),
        now,
        now,
      ]
    );

    match.workflow.steps.forEach((step, index) => {
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
          and status in ('queued', 'in_progress', 'waiting_for_target', 'waiting_for_pr', 'awaiting_human_review', 'retry_wait')
        order by datetime(created_at) desc
        limit 1
      `,
      [args.projectId, issueId]
    );
    return row ? toRun(row) : null;
  };

  const resolveRunAction = async (queueItemId: string, action: "approve" | "reject" | "retry", note?: string): Promise<LinearWorkflowRun | null> => {
    const row = getRunRow(queueItemId);
    const run = row ? toRun(row) : null;
    if (!run) return null;

    if (action === "approve") {
      updateRun(run.id, { reviewState: "approved", status: "in_progress" });
      appendEvent(run.id, "run.approved", "completed", note ?? "Approved for dispatch.", null);
    } else if (action === "reject") {
      updateRun(run.id, { reviewState: "rejected", status: "cancelled", terminalOutcome: "cancelled", lastError: note ?? "Rejected by reviewer." });
      appendEvent(run.id, "run.rejected", "cancelled", note ?? "Rejected by reviewer.", null);
    } else {
      updateRun(run.id, { status: "queued", retryAfter: null, retryCount: run.retryCount + 1 });
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
      const steps = getStepRows(row.id);
      const currentStep = steps.find((entry) => entry.workflow_step_id === row.current_step_id) ?? null;
      const launchContext = parsePayload<Record<string, unknown>>(
        steps.find((entry) => entry.type === "launch_target")?.payload_json ?? null
      ) ?? {};
      const status: LinearSyncQueueItem["status"] =
        row.status === "queued"
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
        workerId: typeof launchContext.workerId === "string" ? launchContext.workerId : null,
        workerSlug: typeof launchContext.workerSlug === "string" ? launchContext.workerSlug : null,
        missionId: row.linked_mission_id,
        sessionId: row.linked_session_id,
        workerRunId: row.linked_worker_run_id,
        prId: row.linked_pr_id,
        currentStepId: row.current_step_id,
        currentStepLabel: currentStep?.workflow_step_id ?? null,
        reviewState: row.review_state,
        attemptCount: row.retry_count,
        nextAttemptAt: row.retry_after,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  };

  return {
    createRun,
    advanceRun,
    listActiveRuns,
    listQueue,
    resolveRunAction,
    findActiveRunForIssue,
  };
}

export type LinearDispatcherService = ReturnType<typeof createLinearDispatcherService>;
