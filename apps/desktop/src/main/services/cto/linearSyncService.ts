import { randomUUID } from "node:crypto";
import type {
  CtoResolveLinearSyncQueueItemArgs,
  LinearAutoDispatchAction,
  LinearRouteDecision,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearSyncQueueStatus,
  MissionPriority,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { FlowPolicyService } from "./flowPolicyService";
import type { LinearRoutingService } from "./linearRoutingService";
import type { LinearTemplateService } from "./linearTemplateService";
import type { LinearOutboundService } from "./linearOutboundService";
import type { IssueTracker } from "./issueTracker";
import type { WorkerAgentService } from "./workerAgentService";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import { isRecord, nowIso, safeJsonParse } from "../shared/utils";

const ACTIVE_CLAIM_STATUS = "active";
const DEFAULT_RETRY_BASE_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;
const TEAM_STATE_CACHE_TTL_MS = 5 * 60_000;

const ACTIVE_MISSION_STATUSES = new Set(["queued", "planning", "plan_review", "in_progress", "intervention_required"]);

type QueueRow = {
  id: string;
  issue_id: string;
  identifier: string;
  title: string;
  status: LinearSyncQueueStatus;
  action: LinearAutoDispatchAction;
  worker_id: string | null;
  worker_slug: string | null;
  mission_id: string | null;
  route_json: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  id: string;
  issue_id: string;
  queue_item_id: string | null;
  worker_id: string | null;
  worker_slug: string | null;
  mission_id: string | null;
  linear_assignee_id: string | null;
  status: string;
};

type TeamState = {
  id: string;
  name: string;
  type: string;
  teamId: string;
  teamKey: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mapMissionPriority(priorityLabel: NormalizedLinearIssue["priorityLabel"]): MissionPriority {
  if (priorityLabel === "urgent") return "urgent";
  if (priorityLabel === "high") return "high";
  if (priorityLabel === "low") return "low";
  return "normal";
}

function compareIssuePriority(left: NormalizedLinearIssue, right: NormalizedLinearIssue): number {
  const leftPriority = left.priority === 0 ? 99 : left.priority;
  const rightPriority = right.priority === 0 ? 99 : right.priority;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.identifier.localeCompare(right.identifier);
}

function nextRetryDelaySeconds(attemptCount: number): number {
  const delay = DEFAULT_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attemptCount));
  return Math.min(MAX_RETRY_DELAY_SECONDS, Math.floor(delay));
}

function plusSecondsIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function toQueueItem(row: QueueRow): LinearSyncQueueItem {
  return {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    action: row.action,
    workerId: row.worker_id,
    workerSlug: row.worker_slug,
    missionId: row.mission_id,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLinearSyncService(args: {
  db: AdeDb;
  logger?: Logger | null;
  projectId: string;
  projectRoot: string;
  issueTracker: IssueTracker;
  flowPolicyService: FlowPolicyService;
  routingService: LinearRoutingService;
  templateService: LinearTemplateService;
  outboundService: LinearOutboundService;
  workerAgentService: WorkerAgentService;
  missionService: ReturnType<typeof createMissionService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  autoStart?: boolean;
}) {
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const teamStateCache = new Map<string, { fetchedAt: number; states: TeamState[] }>();

  const logDebug = (event: string, payload: Record<string, unknown>) => {
    try {
      args.logger?.debug(`linear_sync.${event}`, payload);
    } catch {
      // best effort
    }
  };

  const logWarn = (event: string, payload: Record<string, unknown>) => {
    try {
      args.logger?.warn(`linear_sync.${event}`, payload);
    } catch {
      // best effort
    }
  };

  const setSyncState = (patch: {
    enabled?: boolean;
    running?: boolean;
    lastPollAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    health?: Record<string, unknown>;
  }): void => {
    const now = nowIso();
    const existing = args.db.get<{
      enabled: number;
      running: number;
      last_poll_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      health_json: string | null;
    }>(
      `
        select enabled, running, last_poll_at, last_success_at, last_error, health_json
        from linear_sync_state
        where project_id = ?
        limit 1
      `,
      [args.projectId]
    );

    const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : existing?.enabled ?? 0;
    const running = patch.running != null ? (patch.running ? 1 : 0) : existing?.running ?? 0;
    const lastPollAt = patch.lastPollAt !== undefined ? patch.lastPollAt : existing?.last_poll_at ?? null;
    const lastSuccessAt = patch.lastSuccessAt !== undefined ? patch.lastSuccessAt : existing?.last_success_at ?? null;
    const lastError = patch.lastError !== undefined ? patch.lastError : existing?.last_error ?? null;
    const existingHealth = safeJsonParse<Record<string, unknown>>(existing?.health_json ?? "{}", {});
    const health = { ...existingHealth, ...(patch.health ?? {}) };

    args.db.run(
      `
        insert into linear_sync_state(project_id, enabled, running, last_poll_at, last_success_at, last_error, health_json, updated_at)
        values(?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id) do update set
          enabled = excluded.enabled,
          running = excluded.running,
          last_poll_at = excluded.last_poll_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          health_json = excluded.health_json,
          updated_at = excluded.updated_at
      `,
      [args.projectId, enabled, running, lastPollAt, lastSuccessAt, lastError, JSON.stringify(health), now]
    );
  };

  const appendSyncEvent = (eventType: string, payload: {
    issueId?: string | null;
    queueItemId?: string | null;
    status?: string | null;
    message?: string | null;
    data?: Record<string, unknown>;
  } = {}): void => {
    args.db.run(
      `
        insert into linear_sync_events(id, project_id, issue_id, queue_item_id, event_type, status, message, payload_json, created_at)
        values(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        args.projectId,
        payload.issueId ?? null,
        payload.queueItemId ?? null,
        eventType,
        payload.status ?? null,
        payload.message ?? null,
        payload.data ? JSON.stringify(payload.data) : null,
        nowIso(),
      ]
    );
  };

  const scheduleNext = (delayMs: number): void => {
    if (disposed) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      timer = null;
      void runCycle("timer");
    }, Math.max(1_000, Math.floor(delayMs)));
  };

  const getTeamStates = async (teamKey: string): Promise<TeamState[]> => {
    const cached = teamStateCache.get(teamKey);
    if (cached && Date.now() - cached.fetchedAt < TEAM_STATE_CACHE_TTL_MS) {
      return cached.states;
    }
    const states = await args.issueTracker.fetchWorkflowStates(teamKey);
    teamStateCache.set(teamKey, {
      fetchedAt: Date.now(),
      states,
    });
    return states;
  };

  const resolveStateId = async (issue: NormalizedLinearIssue, stateKey: "todo" | "in_progress" | "in_review" | "done" | "canceled" | "blocked") => {
    const policy = args.flowPolicyService.getPolicy();
    const projectPolicy = (policy.projects ?? []).find((entry) => entry.slug.toLowerCase() === issue.projectSlug.toLowerCase()) ?? null;
    const mapped = projectPolicy?.stateMap?.[stateKey];

    const states = await getTeamStates(issue.teamKey);
    if (mapped) {
      const byId = states.find((entry) => entry.id === mapped);
      if (byId) return byId.id;
      const byName = states.find((entry) => entry.name.toLowerCase() === mapped.toLowerCase());
      if (byName) return byName.id;
    }

    const matchByName = (...needles: string[]) => states.find((entry) => needles.some((needle) => entry.name.toLowerCase().includes(needle)));
    const byType = (type: string) => states.find((entry) => entry.type.toLowerCase() === type.toLowerCase());

    if (stateKey === "done") {
      return byType("completed")?.id ?? null;
    }
    if (stateKey === "canceled") {
      return byType("canceled")?.id ?? null;
    }
    if (stateKey === "in_progress") {
      return matchByName("in progress", "doing", "active")?.id ?? byType("started")?.id ?? null;
    }
    if (stateKey === "in_review") {
      return matchByName("review", "qa", "test", "verify")?.id ?? byType("started")?.id ?? null;
    }
    if (stateKey === "blocked") {
      return matchByName("blocked", "waiting")?.id ?? null;
    }
    return matchByName("todo", "to do", "backlog", "triage")?.id ?? byType("unstarted")?.id ?? null;
  };

  const upsertSnapshot = (issue: NormalizedLinearIssue): { changed: boolean } => {
    const existing = args.db.get<{ updated_at_linear: string | null }>(
      `
        select updated_at_linear
        from linear_issue_snapshots
        where project_id = ?
          and issue_id = ?
        limit 1
      `,
      [args.projectId, issue.id]
    );

    const changed = existing?.updated_at_linear !== issue.updatedAt;
    args.db.run(
      `
        insert into linear_issue_snapshots(id, project_id, issue_id, identifier, state_type, assignee_id, updated_at_linear, payload_json, hash, created_at, updated_at)
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, issue_id) do update set
          identifier = excluded.identifier,
          state_type = excluded.state_type,
          assignee_id = excluded.assignee_id,
          updated_at_linear = excluded.updated_at_linear,
          payload_json = excluded.payload_json,
          hash = excluded.hash,
          updated_at = excluded.updated_at
      `,
      [
        `${args.projectId}:${issue.id}`,
        args.projectId,
        issue.id,
        issue.identifier,
        issue.stateType,
        issue.assigneeId,
        issue.updatedAt,
        JSON.stringify(issue),
        issue.updatedAt,
        nowIso(),
        nowIso(),
      ]
    );

    return { changed };
  };

  const listQueueRows = (params: { statuses?: LinearSyncQueueStatus[]; limit?: number } = {}): QueueRow[] => {
    const clauses: string[] = ["project_id = ?"];
    const values: Array<string | number> = [args.projectId];

    if (params.statuses?.length) {
      const placeholders = params.statuses.map(() => "?").join(",");
      clauses.push(`status in (${placeholders})`);
      values.push(...params.statuses);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(params.limit ?? 200)));
    values.push(limit);

    return args.db.all<QueueRow>(
      `
        select id, issue_id, identifier, title, status, action, worker_id, worker_slug, mission_id, route_json,
               attempt_count, next_attempt_at, last_error, created_at, updated_at
        from linear_dispatch_queue
        where ${clauses.join(" and ")}
        order by created_at asc
        limit ?
      `,
      values
    );
  };

  const getQueueRow = (queueItemId: string): QueueRow | null =>
    args.db.get<QueueRow>(
      `
        select id, issue_id, identifier, title, status, action, worker_id, worker_slug, mission_id, route_json,
               attempt_count, next_attempt_at, last_error, created_at, updated_at
        from linear_dispatch_queue
        where project_id = ? and id = ?
        limit 1
      `,
      [args.projectId, queueItemId]
    );

  const findOpenQueueForIssue = (issueId: string): QueueRow | null =>
    args.db.get<QueueRow>(
      `
        select id, issue_id, identifier, title, status, action, worker_id, worker_slug, mission_id, route_json,
               attempt_count, next_attempt_at, last_error, created_at, updated_at
        from linear_dispatch_queue
        where project_id = ?
          and issue_id = ?
          and status in ('queued', 'retry_wait', 'escalated', 'dispatched')
        order by created_at desc
        limit 1
      `,
      [args.projectId, issueId]
    );

  const updateQueueRow = (queueItemId: string, patch: Partial<{
    status: LinearSyncQueueStatus;
    action: LinearAutoDispatchAction;
    workerId: string | null;
    workerSlug: string | null;
    missionId: string | null;
    attemptCount: number;
    nextAttemptAt: string | null;
    lastError: string | null;
    routeJson: string | null;
    title: string;
    identifier: string;
  }>): void => {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.status != null) {
      clauses.push("status = ?");
      values.push(patch.status);
    }
    if (patch.action != null) {
      clauses.push("action = ?");
      values.push(patch.action);
    }
    if (patch.workerId !== undefined) {
      clauses.push("worker_id = ?");
      values.push(patch.workerId);
    }
    if (patch.workerSlug !== undefined) {
      clauses.push("worker_slug = ?");
      values.push(patch.workerSlug);
    }
    if (patch.missionId !== undefined) {
      clauses.push("mission_id = ?");
      values.push(patch.missionId);
    }
    if (patch.attemptCount !== undefined) {
      clauses.push("attempt_count = ?");
      values.push(Math.max(0, Math.floor(patch.attemptCount)));
    }
    if (patch.nextAttemptAt !== undefined) {
      clauses.push("next_attempt_at = ?");
      values.push(patch.nextAttemptAt);
    }
    if (patch.lastError !== undefined) {
      clauses.push("last_error = ?");
      values.push(patch.lastError);
    }
    if (patch.routeJson !== undefined) {
      clauses.push("route_json = ?");
      values.push(patch.routeJson);
    }
    if (patch.title !== undefined) {
      clauses.push("title = ?");
      values.push(patch.title);
    }
    if (patch.identifier !== undefined) {
      clauses.push("identifier = ?");
      values.push(patch.identifier);
    }

    clauses.push("updated_at = ?");
    values.push(nowIso());
    values.push(args.projectId, queueItemId);

    args.db.run(
      `
        update linear_dispatch_queue
        set ${clauses.join(", ")}
        where project_id = ?
          and id = ?
      `,
      values
    );
  };

  const enqueueIssue = (issue: NormalizedLinearIssue, decision: LinearRouteDecision): void => {
    const existing = findOpenQueueForIssue(issue.id);
    if (existing) {
      const nextStatus: LinearSyncQueueStatus =
        existing.status === "dispatched"
          ? "dispatched"
          : decision.action === "auto"
            ? "queued"
            : "escalated";
      updateQueueRow(existing.id, {
        title: issue.title,
        identifier: issue.identifier,
        action: decision.action,
        workerId: decision.workerId,
        workerSlug: decision.workerSlug,
        routeJson: JSON.stringify(decision),
        ...(existing.status !== "dispatched"
          ? {
              status: nextStatus,
              nextAttemptAt: null,
              ...(nextStatus === "queued" ? { lastError: null } : {}),
            }
          : {}),
      });
      appendSyncEvent("queue.route_updated", {
        issueId: issue.id,
        queueItemId: existing.id,
        status: nextStatus,
        message: decision.reason,
        data: {
          action: decision.action,
          workerSlug: decision.workerSlug,
          matchedRuleId: decision.matchedRuleId,
        },
      });
      return;
    }

    const status: LinearSyncQueueStatus =
      decision.action === "auto"
        ? "queued"
        : decision.action === "queue-night-shift"
          ? "escalated"
          : "escalated";

    const queueId = randomUUID();
    const timestamp = nowIso();
    args.db.run(
      `
        insert into linear_dispatch_queue(
          id, project_id, issue_id, identifier, title, status, action,
          worker_id, worker_slug, mission_id, route_json, attempt_count,
          next_attempt_at, last_error, note, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, 0, null, null, null, ?, ?)
      `,
      [
        queueId,
        args.projectId,
        issue.id,
        issue.identifier,
        issue.title,
        status,
        decision.action,
        decision.workerId,
        decision.workerSlug,
        JSON.stringify(decision),
        timestamp,
        timestamp,
      ]
    );

    appendSyncEvent("queue.enqueued", {
      issueId: issue.id,
      queueItemId: queueId,
      status,
      message: decision.reason,
      data: {
        action: decision.action,
        workerSlug: decision.workerSlug,
        matchedRuleId: decision.matchedRuleId,
      },
    });
  };

  const getActiveClaimByIssue = (issueId: string): ClaimRow | null =>
    args.db.get<ClaimRow>(
      `
        select id, issue_id, queue_item_id, worker_id, worker_slug, mission_id, linear_assignee_id, status
        from linear_issue_claims
        where project_id = ?
          and issue_id = ?
          and status = ?
        limit 1
      `,
      [args.projectId, issueId, ACTIVE_CLAIM_STATUS]
    );

  const claimIssue = (params: {
    issue: NormalizedLinearIssue;
    queueItem: QueueRow;
  }): { ok: boolean; claimId: string | null } => {
    const claimId = randomUUID();
    try {
      args.db.run(
        `
          insert into linear_issue_claims(
            id, project_id, issue_id, queue_item_id, worker_id, worker_slug, mission_id,
            linear_assignee_id, status, claimed_at, released_at, updated_at
          ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)
        `,
        [
          claimId,
          args.projectId,
          params.issue.id,
          params.queueItem.id,
          params.queueItem.worker_id,
          params.queueItem.worker_slug,
          params.queueItem.mission_id,
          params.issue.assigneeId,
          ACTIVE_CLAIM_STATUS,
          nowIso(),
          nowIso(),
        ]
      );
      return { ok: true, claimId };
    } catch {
      return { ok: false, claimId: null };
    }
  };

  const releaseClaim = (issueId: string, status: "released" | "completed" | "cancelled", missionId?: string | null): void => {
    args.db.run(
      `
        update linear_issue_claims
        set status = ?,
            mission_id = coalesce(?, mission_id),
            released_at = ?,
            updated_at = ?
        where project_id = ?
          and issue_id = ?
          and status = ?
      `,
      [status, missionId ?? null, nowIso(), nowIso(), args.projectId, issueId, ACTIVE_CLAIM_STATUS]
    );
  };

  const markRetryWait = (queueItem: QueueRow, error: string): void => {
    const attempt = queueItem.attempt_count + 1;
    const delaySec = nextRetryDelaySeconds(attempt);
    updateQueueRow(queueItem.id, {
      status: "retry_wait",
      attemptCount: attempt,
      nextAttemptAt: plusSecondsIso(delaySec),
      lastError: error,
    });
    appendSyncEvent("queue.retry_wait", {
      issueId: queueItem.issue_id,
      queueItemId: queueItem.id,
      status: "retry_wait",
      message: error,
      data: { attempt, delaySec },
    });
  };

  const attachMissionLinearMetadata = (missionId: string, issue: NormalizedLinearIssue, decision: LinearRouteDecision): void => {
    const row = args.db.get<{ metadata_json: string | null }>(
      `
        select metadata_json
        from missions
        where id = ?
          and project_id = ?
        limit 1
      `,
      [missionId, args.projectId]
    );
    const base = safeJsonParse<Record<string, unknown>>(row?.metadata_json ?? "{}", {});
    const next = {
      ...base,
      linearSync: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueUrl: issue.url,
        projectSlug: issue.projectSlug,
        workerSlug: decision.workerSlug,
        matchedRuleId: decision.matchedRuleId,
        updatedAt: nowIso(),
      },
    };
    args.db.run(
      `
        update missions
        set metadata_json = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [JSON.stringify(next), nowIso(), missionId, args.projectId]
    );
  };

  const maybeAssignIssue = async (queueItem: QueueRow, issue: NormalizedLinearIssue): Promise<void> => {
    const policy = args.flowPolicyService.getPolicy();
    if (!policy.assignment?.setAssigneeOnDispatch) return;
    if (!queueItem.worker_id) return;

    const worker = args.workerAgentService.getAgent(queueItem.worker_id);
    if (!worker || !isRecord(worker.adapterConfig)) return;

    const adapterConfig = worker.adapterConfig as Record<string, unknown>;
    const linearAssigneeId = asString(adapterConfig["linearAssigneeId"]);
    if (!linearAssigneeId) return;

    await args.issueTracker.updateIssueAssignee(issue.id, linearAssigneeId);

    args.db.run(
      `
        update linear_issue_claims
        set linear_assignee_id = ?,
            updated_at = ?
        where project_id = ?
          and issue_id = ?
          and status = ?
      `,
      [linearAssigneeId, nowIso(), args.projectId, issue.id, ACTIVE_CLAIM_STATUS]
    );
  };

  const dispatchQueueRow = async (queueItem: QueueRow): Promise<boolean> => {
    const issue = await args.issueTracker.fetchIssueById(queueItem.issue_id);
    if (!issue) {
      updateQueueRow(queueItem.id, {
        status: "failed",
        lastError: "Issue no longer exists in Linear.",
      });
      appendSyncEvent("dispatch.issue_missing", {
        issueId: queueItem.issue_id,
        queueItemId: queueItem.id,
        status: "failed",
      });
      return false;
    }

    if (issue.stateType === "completed" || issue.stateType === "canceled") {
      updateQueueRow(queueItem.id, {
        status: "cancelled",
        lastError: `Issue is already ${issue.stateType}.`,
      });
      return false;
    }

    if (getActiveClaimByIssue(issue.id)) {
      markRetryWait(queueItem, "Issue is already claimed by another active dispatch.");
      return false;
    }

    const claim = claimIssue({ issue, queueItem });
    if (!claim.ok) {
      markRetryWait(queueItem, "Failed to acquire dispatch claim.");
      return false;
    }

    const routeDecision = safeJsonParse<LinearRouteDecision | null>(queueItem.route_json ?? "{}", null)
      ?? await args.routingService.routeIssue({ issue });

    try {
      const worker = routeDecision.workerId ? args.workerAgentService.getAgent(routeDecision.workerId) : null;
      const rendered = args.templateService.renderTemplate({
        templateId: routeDecision.templateId,
        issue,
        route: routeDecision as unknown as Record<string, unknown>,
        worker: (worker as unknown as Record<string, unknown>) ?? {},
      });

      const mission = args.missionService.create({
        title: `${issue.identifier}: ${issue.title}`,
        prompt: rendered.prompt,
        priority: mapMissionPriority(issue.priorityLabel),
        autostart: false,
        launchMode: "autopilot",
      });

      attachMissionLinearMetadata(mission.id, issue, routeDecision);

      await args.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        metadata: {
          source: "linear_sync",
          linearIssueId: issue.id,
          linearIssueIdentifier: issue.identifier,
        },
      });

      const inProgressStateId = await resolveStateId(issue, "in_progress");
      if (inProgressStateId) {
        await args.issueTracker.updateIssueState(issue.id, inProgressStateId);
      }

      await maybeAssignIssue(queueItem, issue);

      await args.outboundService.publishMissionStart({
        issue,
        missionId: mission.id,
        missionTitle: mission.title,
        templateId: rendered.templateId,
        routeReason: routeDecision.reason,
        workerName: routeDecision.workerName,
      });

      updateQueueRow(queueItem.id, {
        status: "dispatched",
        missionId: mission.id,
        workerId: routeDecision.workerId,
        workerSlug: routeDecision.workerSlug,
        lastError: null,
        nextAttemptAt: null,
      });

      args.db.run(
        `
          update linear_issue_claims
          set mission_id = ?,
              worker_id = ?,
              worker_slug = ?,
              updated_at = ?
          where project_id = ?
            and issue_id = ?
            and status = ?
        `,
        [mission.id, routeDecision.workerId, routeDecision.workerSlug, nowIso(), args.projectId, issue.id, ACTIVE_CLAIM_STATUS]
      );

      appendSyncEvent("dispatch.started", {
        issueId: issue.id,
        queueItemId: queueItem.id,
        status: "dispatched",
        message: routeDecision.reason,
        data: {
          missionId: mission.id,
          workerSlug: routeDecision.workerSlug,
          templateId: routeDecision.templateId,
        },
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      releaseClaim(issue.id, "released");
      markRetryWait(queueItem, `Dispatch failed: ${message}`);
      logWarn("dispatch_failed", {
        queueItemId: queueItem.id,
        issueId: queueItem.issue_id,
        error: message,
      });
      return false;
    }
  };

  const processRetryQueue = (): void => {
    args.db.run(
      `
        update linear_dispatch_queue
        set status = 'queued',
            next_attempt_at = null,
            updated_at = ?
        where project_id = ?
          and status = 'retry_wait'
          and next_attempt_at is not null
          and next_attempt_at <= ?
      `,
      [nowIso(), args.projectId, nowIso()]
    );
  };

  const processQueue = async (): Promise<void> => {
    const policy = args.flowPolicyService.getPolicy();
    const globalLimit = Math.max(1, policy.concurrency?.global ?? 5);

    const activeClaims = args.db.get<{ count: number }>(
      `
        select count(*) as count
        from linear_issue_claims
        where project_id = ?
          and status = ?
      `,
      [args.projectId, ACTIVE_CLAIM_STATUS]
    )?.count ?? 0;

    let available = Math.max(0, globalLimit - activeClaims);
    if (available <= 0) return;

    const queueRows = listQueueRows({ statuses: ["queued"], limit: 200 });
    for (const queueItem of queueRows) {
      if (available <= 0) break;
      if (queueItem.next_attempt_at && queueItem.next_attempt_at > nowIso()) continue;

      if (queueItem.action === "queue-night-shift") {
        updateQueueRow(queueItem.id, {
          status: "escalated",
          lastError: "Queued for night shift approval.",
        });
        continue;
      }

      if (queueItem.action !== "auto") {
        updateQueueRow(queueItem.id, {
          status: "escalated",
        });
        continue;
      }

      const started = await dispatchQueueRow(queueItem);
      if (started) available -= 1;
    }
  };

  const cancelActiveRunsForMission = async (missionId: string, reason: string): Promise<void> => {
    const runs = args.orchestratorService
      .listRuns({ missionId, limit: 50 })
      .filter((run) => run.status === "active" || run.status === "bootstrapping" || run.status === "paused");

    for (const run of runs) {
      try {
        await args.aiOrchestratorService.cancelRunGracefully({ runId: run.id, reason });
      } catch {
        try {
          args.orchestratorService.cancelRun({ runId: run.id, reason });
        } catch {
          // ignore
        }
      }
    }
  };

  const reconcileDispatchedQueue = async (): Promise<void> => {
    const policy = args.flowPolicyService.getPolicy();
    const stallTimeoutSec = Math.max(30, policy.reconciliation?.stalledTimeoutSec ?? 300);

    const dispatched = listQueueRows({ statuses: ["dispatched"], limit: 500 });
    for (const queueItem of dispatched) {
      if (!queueItem.mission_id) {
        updateQueueRow(queueItem.id, { status: "failed", lastError: "Dispatched queue item is missing mission id." });
        releaseClaim(queueItem.issue_id, "released");
        continue;
      }

      const issue = await args.issueTracker.fetchIssueById(queueItem.issue_id);
      if (!issue) {
        updateQueueRow(queueItem.id, { status: "failed", lastError: "Issue disappeared during reconciliation." });
        releaseClaim(queueItem.issue_id, "released", queueItem.mission_id);
        continue;
      }

      const mission = args.missionService.get(queueItem.mission_id);
      if (!mission) {
        updateQueueRow(queueItem.id, { status: "failed", lastError: "Mission no longer exists." });
        releaseClaim(queueItem.issue_id, "released", queueItem.mission_id);
        continue;
      }

      const activeClaim = getActiveClaimByIssue(queueItem.issue_id);
      if (activeClaim?.linear_assignee_id && issue.assigneeId && issue.assigneeId !== activeClaim.linear_assignee_id) {
        await cancelActiveRunsForMission(mission.id, "Linear issue reassigned externally.");
        args.missionService.update({ missionId: mission.id, status: "canceled", outcomeSummary: "Canceled due to external reassignment." });
        await args.outboundService.publishMissionCloseout({
          issue,
          missionId: mission.id,
          status: "canceled",
          summary: "Mission canceled because the Linear issue was reassigned externally.",
          artifactMode: policy.artifacts?.mode ?? "links",
        });
        updateQueueRow(queueItem.id, { status: "cancelled", lastError: "Issue reassigned externally." });
        releaseClaim(queueItem.issue_id, "cancelled", mission.id);
        continue;
      }

      if ((issue.stateType === "completed" || issue.stateType === "canceled") && ACTIVE_MISSION_STATUSES.has(mission.status)) {
        await cancelActiveRunsForMission(mission.id, `Linear issue moved to ${issue.stateType}.`);
        args.missionService.update({
          missionId: mission.id,
          status: "canceled",
          outcomeSummary: `Canceled because Linear issue moved to ${issue.stateType}.`,
        });
        await args.outboundService.publishMissionCloseout({
          issue,
          missionId: mission.id,
          status: "canceled",
          summary: `Mission canceled because issue moved to ${issue.stateType} in Linear.`,
          artifactMode: policy.artifacts?.mode ?? "links",
        });
        updateQueueRow(queueItem.id, { status: "cancelled", lastError: `Issue moved to ${issue.stateType}.` });
        releaseClaim(queueItem.issue_id, "cancelled", mission.id);
        continue;
      }

      if (ACTIVE_MISSION_STATUSES.has(mission.status)) {
        const missionUpdatedAtMs = Date.parse(mission.updatedAt);
        const ageMs = Date.now() - (Number.isFinite(missionUpdatedAtMs) ? missionUpdatedAtMs : Date.now());
        if (ageMs > stallTimeoutSec * 1000) {
          await cancelActiveRunsForMission(mission.id, `Mission stalled for ${Math.floor(ageMs / 1000)}s`);
          args.missionService.update({
            missionId: mission.id,
            status: "failed",
            lastError: `Linear sync stall timeout after ${Math.floor(ageMs / 1000)}s.`,
          });
          releaseClaim(queueItem.issue_id, "released", mission.id);
          markRetryWait(queueItem, `Mission stalled for more than ${stallTimeoutSec}s.`);
          continue;
        }

        await args.outboundService.publishMissionProgress({
          issue,
          missionId: mission.id,
          status: mission.status,
          stepSummary:
            mission.totalSteps > 0
              ? `${mission.completedSteps}/${mission.totalSteps} mission steps completed.`
              : undefined,
          lastError: mission.lastError,
        });
        continue;
      }

      if (mission.status === "completed") {
        const doneStateId = await resolveStateId(issue, "done");
        if (doneStateId) {
          await args.issueTracker.updateIssueState(issue.id, doneStateId);
        }
        await args.issueTracker.addLabel(issue.id, "ade");

        const artifacts = mission.artifacts
          .map((artifact) => artifact.uri)
          .filter((uri): uri is string => typeof uri === "string" && uri.trim().length > 0);

        await args.outboundService.publishMissionCloseout({
          issue,
          missionId: mission.id,
          status: "completed",
          summary: mission.outcomeSummary ?? "Mission completed successfully.",
          prLinks: mission.artifacts
            .filter((artifact) => artifact.artifactType === "pr")
            .map((artifact) => artifact.uri)
            .filter((uri): uri is string => typeof uri === "string" && uri.trim().length > 0),
          artifactPaths: artifacts,
          artifactMode: policy.artifacts?.mode ?? "links",
        });

        updateQueueRow(queueItem.id, {
          status: "resolved",
          lastError: null,
          nextAttemptAt: null,
        });
        releaseClaim(queueItem.issue_id, "completed", mission.id);
        continue;
      }

      if (mission.status === "failed" || mission.status === "canceled") {
        const blockedStateId = await resolveStateId(issue, "blocked");
        if (blockedStateId) {
          await args.issueTracker.updateIssueState(issue.id, blockedStateId);
        }

        const summary = mission.lastError ?? mission.outcomeSummary ?? "Mission exited without a success state.";
        await args.outboundService.publishMissionCloseout({
          issue,
          missionId: mission.id,
          status: mission.status === "canceled" ? "canceled" : "failed",
          summary,
          artifactMode: policy.artifacts?.mode ?? "links",
        });

        releaseClaim(queueItem.issue_id, mission.status === "canceled" ? "cancelled" : "released", mission.id);

        const maxRetries = 3;
        if (queueItem.attempt_count < maxRetries) {
          markRetryWait(queueItem, summary);
        } else {
          updateQueueRow(queueItem.id, {
            status: "failed",
            lastError: summary,
          });
        }
      }
    }
  };

  const ingestCandidates = async (): Promise<void> => {
    const policy = args.flowPolicyService.getPolicy();
    setSyncState({ enabled: policy.enabled === true });
    if (!policy.enabled) return;

    const projectSlugs = (policy.projects ?? []).map((entry) => entry.slug.trim()).filter((entry) => entry.length > 0);
    if (!projectSlugs.length) return;

    const issues = await args.issueTracker.fetchCandidateIssues({
      projectSlugs,
      stateTypes: ["unstarted", "started"],
    });

    const filtered = issues
      .filter((issue) => !(issue.stateType === "unstarted" && issue.hasOpenBlockers))
      .sort(compareIssuePriority);

    for (const issue of filtered) {
      const snapshot = upsertSnapshot(issue);
      if (!snapshot.changed) continue;

      const route = await args.routingService.routeIssue({ issue, policy });
      enqueueIssue(issue, route);
    }
  };

  const runCycle = async (trigger: "timer" | "manual"): Promise<void> => {
    if (inFlight || disposed) return;
    inFlight = true;
    setSyncState({ running: true, lastPollAt: nowIso(), lastError: null });

    try {
      await ingestCandidates();
      processRetryQueue();
      await processQueue();
      await reconcileDispatchedQueue();
      setSyncState({ running: false, lastSuccessAt: nowIso(), lastError: null, health: { lastTrigger: trigger } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncState({ running: false, lastError: message, health: { lastTrigger: trigger } });
      appendSyncEvent("cycle.error", { status: "failed", message });
      logWarn("cycle_failed", { trigger, error: message });
    } finally {
      inFlight = false;
      if (!disposed) {
        const intervalSec = Math.max(5, args.flowPolicyService.getPolicy().pollingIntervalSec ?? 300);
        scheduleNext(intervalSec * 1_000);
      }
    }
  };

  const listQueue = (params: { statuses?: LinearSyncQueueStatus[]; limit?: number } = {}): LinearSyncQueueItem[] => {
    return listQueueRows(params).map(toQueueItem);
  };

  const resolveQueueItem = async (input: CtoResolveLinearSyncQueueItemArgs): Promise<LinearSyncQueueItem | null> => {
    const queueItem = getQueueRow(input.queueItemId);
    if (!queueItem) return null;

    if (input.action === "reject") {
      updateQueueRow(queueItem.id, {
        status: "resolved",
        lastError: input.note ? `Rejected: ${input.note}` : "Rejected by user.",
        nextAttemptAt: null,
      });
      releaseClaim(queueItem.issue_id, "cancelled", queueItem.mission_id);
      return getQueueRow(queueItem.id) ? toQueueItem(getQueueRow(queueItem.id)!) : null;
    }

    if (input.action === "approve") {
      updateQueueRow(queueItem.id, {
        status: "queued",
        action: "auto",
        nextAttemptAt: null,
        lastError: input.note ?? null,
      });
      await processQueue();
      return getQueueRow(queueItem.id) ? toQueueItem(getQueueRow(queueItem.id)!) : null;
    }

    updateQueueRow(queueItem.id, {
      status: "queued",
      nextAttemptAt: null,
      lastError: input.note ?? null,
    });
    await processQueue();
    return getQueueRow(queueItem.id) ? toQueueItem(getQueueRow(queueItem.id)!) : null;
  };

  const getDashboard = (): LinearSyncDashboard => {
    const policy = args.flowPolicyService.getPolicy();
    const state = args.db.get<{
      running: number;
      last_poll_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>(
      `
        select running, last_poll_at, last_success_at, last_error
        from linear_sync_state
        where project_id = ?
        limit 1
      `,
      [args.projectId]
    );

    const counts = args.db.all<{ status: string; count: number }>(
      `
        select status, count(*) as count
        from linear_dispatch_queue
        where project_id = ?
        group by status
      `,
      [args.projectId]
    );

    const statusCount = (status: string): number => counts.find((entry) => entry.status === status)?.count ?? 0;

    const claimsActive = args.db.get<{ count: number }>(
      `
        select count(*) as count
        from linear_issue_claims
        where project_id = ?
          and status = ?
      `,
      [args.projectId, ACTIVE_CLAIM_STATUS]
    )?.count ?? 0;

    return {
      enabled: policy.enabled === true,
      running: Boolean(state?.running),
      pollingIntervalSec: policy.pollingIntervalSec ?? 300,
      lastPollAt: state?.last_poll_at ?? null,
      lastSuccessAt: state?.last_success_at ?? null,
      lastError: state?.last_error ?? null,
      queue: {
        queued: statusCount("queued"),
        retryWaiting: statusCount("retry_wait"),
        escalated: statusCount("escalated"),
        dispatched: statusCount("dispatched"),
        failed: statusCount("failed"),
      },
      claimsActive,
    };
  };

  const runSyncNow = async (): Promise<LinearSyncDashboard> => {
    await runCycle("manual");
    return getDashboard();
  };

  const start = (): void => {
    if (disposed) return;
    scheduleNext(2_000);
  };

  const dispose = (): void => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  if (args.autoStart !== false) {
    start();
  }

  return {
    start,
    dispose,
    runSyncNow,
    getDashboard,
    listQueue,
    resolveQueueItem,
  };
}

export type LinearSyncService = ReturnType<typeof createLinearSyncService>;
