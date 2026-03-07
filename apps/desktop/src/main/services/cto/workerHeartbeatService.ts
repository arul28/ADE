import { randomUUID } from "node:crypto";
import type {
  AgentIdentity,
  AgentSessionLogEntry,
  AgentStatus,
  AgentCoreMemory,
  CtoTriggerAgentWakeupArgs,
  CtoTriggerAgentWakeupResult,
  WorkerAgentRun,
  WorkerAgentRunStatus,
  WorkerAgentWakeupReason,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb, SqlValue } from "../state/kvDb";
import { safeJsonParse, nowIso, looksSensitiveKey } from "../shared/utils";
import type { WorkerAdapterRuntimeService } from "./workerAdapterRuntimeService";
import type { WorkerAgentService } from "./workerAgentService";
import type { WorkerBudgetService } from "./workerBudgetService";
import type { WorkerTaskSessionService } from "./workerTaskSessionService";

const RUN_STATUSES = new Set<WorkerAgentRunStatus>([
  "queued",
  "deferred",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

const WAKEUP_REASONS = new Set<WorkerAgentWakeupReason>([
  "timer",
  "manual",
  "user_message",
  "assignment",
  "api",
  "deferred_promotion",
  "startup_recovery",
]);

type WorkerHeartbeatServiceArgs = {
  db: AdeDb;
  projectId: string;
  workerAgentService: WorkerAgentService;
  workerAdapterRuntimeService: WorkerAdapterRuntimeService;
  workerTaskSessionService: WorkerTaskSessionService;
  workerBudgetService?: WorkerBudgetService | null;
  logger?: Logger | null;
  staleLockMs?: number;
  maintenanceIntervalMs?: number;
  autoStart?: boolean;
};

type WorkerRunRow = {
  id: string;
  project_id: string;
  agent_id: string;
  status: string;
  wakeup_reason: string;
  task_key: string | null;
  issue_key: string | null;
  execution_run_id: string | null;
  execution_locked_at: string | null;
  context_json: string | null;
  result_json: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkerWakeupInput = {
  agentId: string;
  reason: WorkerAgentWakeupReason;
  taskKey?: string | null;
  issueKey?: string | null;
  prompt?: string | null;
  context?: Record<string, unknown>;
};

type TimerEntry = {
  timer: NodeJS.Timeout;
  intervalSec: number;
};

const SENSITIVE_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{12,}/i,
  /\bsk-[a-z0-9]{12,}/i,
  /\bgh[pousr]_[a-z0-9]{16,}/i,
  /\bxox[baprs]-[a-z0-9-]{10,}/i,
];

function clampLimit(limit: number | undefined, fallback = 80): number {
  const candidate = Number(limit ?? fallback);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(candidate)));
}

function normalizeStatus(value: unknown): WorkerAgentRunStatus {
  const asString = typeof value === "string" ? value.trim() : "";
  if (RUN_STATUSES.has(asString as WorkerAgentRunStatus)) {
    return asString as WorkerAgentRunStatus;
  }
  return "failed";
}

function normalizeReason(value: unknown): WorkerAgentWakeupReason {
  const asString = typeof value === "string" ? value.trim() : "";
  if (WAKEUP_REASONS.has(asString as WorkerAgentWakeupReason)) {
    return asString as WorkerAgentWakeupReason;
  }
  return "api";
}

function rowToRun(row: WorkerRunRow): WorkerAgentRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: normalizeStatus(row.status),
    wakeupReason: normalizeReason(row.wakeup_reason),
    taskKey: row.task_key,
    issueKey: row.issue_key,
    executionRunId: row.execution_run_id,
    executionLockedAt: row.execution_locked_at,
    context: safeJsonParse<Record<string, unknown>>(row.context_json, {}),
    result: safeJsonParse<Record<string, unknown> | null>(row.result_json, null),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHourMinute(value: string | null | undefined): number | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function resolveMinutesForTimezone(date: Date, timezone: string): number {
  const tz = timezone.trim().toLowerCase();
  if (!tz.length || tz === "local") {
    return date.getHours() * 60 + date.getMinutes();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const hours = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return hours * 60 + minutes;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function withinActiveHours(agent: AgentIdentity, at = new Date()): boolean {
  const heartbeat = agent.runtimeConfig?.heartbeat;
  const activeHours = heartbeat?.activeHours;
  if (!activeHours) return true;
  const start = parseHourMinute(activeHours.start);
  const end = parseHourMinute(activeHours.end);
  if (start == null || end == null) return true;
  const current = resolveMinutesForTimezone(at, activeHours.timezone || "local");
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function sanitizeContext(input: unknown): Record<string, unknown> {
  const looksSensitiveValue = (value: string): boolean =>
    SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));

  const walk = (value: unknown, keyPath = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${keyPath}[${index}]`));
    if (value && typeof value === "object") {
      const next: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (looksSensitiveKey(key)) {
          next[key] = "[REDACTED]";
          continue;
        }
        next[key] = walk(child, keyPath ? `${keyPath}.${key}` : key);
      }
      return next;
    }
    if (typeof value === "string" && looksSensitiveValue(value.trim())) {
      return "[REDACTED]";
    }
    if (typeof value === "string" && value.length > 4_000) {
      return `${value.slice(0, 4_000)}…`;
    }
    return value;
  };

  const walked = walk(input);
  return walked && typeof walked === "object" && !Array.isArray(walked)
    ? walked as Record<string, unknown>
    : {};
}

function outputPreview(outputText: string): string {
  const trimmed = outputText.trim();
  if (!trimmed.length) return "";
  return trimmed.length <= 600 ? trimmed : `${trimmed.slice(0, 600)}…`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createWorkerHeartbeatService(args: WorkerHeartbeatServiceArgs) {
  const staleLockMs = Math.max(30_000, Math.floor(args.staleLockMs ?? 300_000));
  const maintenanceIntervalMs = Math.max(5_000, Math.floor(args.maintenanceIntervalMs ?? 30_000));
  const timers = new Map<string, TimerEntry>();
  const inFlightAgents = new Set<string>();
  let maintenanceTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const logDebug = (event: string, payload: Record<string, unknown>) => {
    try {
      args.logger?.debug(`worker_heartbeat.${event}`, payload);
    } catch {
      // best effort logging
    }
  };

  const getRunById = (runId: string): WorkerRunRow | null => {
    return args.db.get<WorkerRunRow>(
      `select * from worker_agent_runs where project_id = ? and id = ? limit 1`,
      [args.projectId, runId]
    );
  };

  const updateRunFields = (runId: string, fields: Record<string, unknown>): void => {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
    const params: SqlValue[] = entries.map(([, value]) => {
      if (value == null) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      return JSON.stringify(value);
    });
    args.db.run(
      `update worker_agent_runs set ${setSql}, updated_at = ? where project_id = ? and id = ?`,
      [...params, nowIso(), args.projectId, runId]
    );
  };

  const insertRun = (input: WorkerWakeupInput, status: WorkerAgentRunStatus): WorkerAgentRun => {
    const id = randomUUID();
    const timestamp = nowIso();
    const context = sanitizeContext({
      ...(input.context ?? {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
    args.db.run(
      `
        insert into worker_agent_runs(
          id, project_id, agent_id, status, wakeup_reason, task_key, issue_key, execution_run_id, execution_locked_at,
          context_json, result_json, error_message, started_at, finished_at, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, null, null, ?, null, null, null, null, ?, ?)
      `,
      [
        id,
        args.projectId,
        input.agentId,
        status,
        input.reason,
        input.taskKey ?? null,
        input.issueKey ?? null,
        JSON.stringify(context),
        timestamp,
        timestamp,
      ]
    );
    const row = getRunById(id);
    return rowToRun(row!);
  };

  const findRunningRunForAgent = (agentId: string): WorkerRunRow | null => {
    return args.db.get<WorkerRunRow>(
      `
        select * from worker_agent_runs
        where project_id = ? and agent_id = ? and status = 'running'
        order by datetime(created_at) asc
        limit 1
      `,
      [args.projectId, agentId]
    );
  };

  const findNextPendingRun = (agentId: string): WorkerRunRow | null => {
    return args.db.get<WorkerRunRow>(
      `
        select * from worker_agent_runs
        where project_id = ?
          and agent_id = ?
          and status in ('queued', 'deferred')
        order by datetime(created_at) asc
        limit 1
      `,
      [args.projectId, agentId]
    );
  };

  const listDeferredAgentIds = (): string[] => {
    const rows = args.db.all<{ agent_id: string }>(
      `
        select distinct agent_id
        from worker_agent_runs
        where project_id = ?
          and status = 'deferred'
      `,
      [args.projectId]
    );
    return rows.map((row) => String(row.agent_id)).filter(Boolean);
  };

  const findIssueLockConflict = (run: WorkerRunRow): WorkerRunRow | null => {
    if (!run.issue_key) return null;
    return args.db.get<WorkerRunRow>(
      `
        select *
        from worker_agent_runs
        where project_id = ?
          and issue_key = ?
          and status = 'running'
          and id != ?
        order by datetime(created_at) asc
        limit 1
      `,
      [args.projectId, run.issue_key, run.id]
    );
  };

  const isStale = (run: WorkerRunRow): boolean => {
    const basis = run.execution_locked_at || run.updated_at;
    const basisEpoch = Date.parse(basis || "");
    if (!Number.isFinite(basisEpoch)) return false;
    return Date.now() - basisEpoch >= staleLockMs;
  };

  const failRunAsOrphan = (run: WorkerRunRow, reason: string): void => {
    updateRunFields(run.id, {
      status: "failed",
      error_message: reason,
      finished_at: nowIso(),
    });
  };

  const coalesceIntoRunningRun = (runningRun: WorkerRunRow, wakeRun: WorkerRunRow): void => {
    const runningContext = safeJsonParse<Record<string, unknown>>(runningRun.context_json, {});
    const existing = Array.isArray(runningContext.coalescedWakeups) ? runningContext.coalescedWakeups : [];
    const wakeContext = safeJsonParse<Record<string, unknown>>(wakeRun.context_json, {});
    const merged = [
      ...existing,
      {
        runId: wakeRun.id,
        reason: wakeRun.wakeup_reason,
        taskKey: wakeRun.task_key,
        issueKey: wakeRun.issue_key,
        at: nowIso(),
        context: wakeContext,
      },
    ];
    runningContext.coalescedWakeups = merged;
    updateRunFields(runningRun.id, {
      context_json: JSON.stringify(sanitizeContext(runningContext)),
    });
    updateRunFields(wakeRun.id, {
      status: "skipped",
      error_message: `Coalesced into running wakeup '${runningRun.id}'.`,
      finished_at: nowIso(),
      result_json: JSON.stringify({ coalescedIntoRunId: runningRun.id }),
    });
  };

  const shouldEscalate = (run: WorkerRunRow): boolean => {
    const context = safeJsonParse<Record<string, unknown>>(run.context_json, {});
    const prompt = typeof context.prompt === "string" ? context.prompt.trim() : "";
    if (prompt.length > 0) return true;
    if (context.forceEscalation === true) return true;
    if (run.wakeup_reason !== "timer") return true;
    if (context.hasChanges === true) return true;
    const events = Number(context.eventCount ?? 0);
    if (Number.isFinite(events) && events > 0) return true;
    return false;
  };

  const buildPrompt = (agent: AgentIdentity, run: WorkerRunRow): string => {
    const context = safeJsonParse<Record<string, unknown>>(run.context_json, {});
    const explicitPrompt = typeof context.prompt === "string" ? context.prompt.trim() : "";
    if (explicitPrompt.length) return explicitPrompt;
    const lines = [
      `Worker heartbeat activation for ${agent.name}.`,
      `Reason: ${run.wakeup_reason}.`,
    ];
    if (run.issue_key) lines.push(`Issue key: ${run.issue_key}.`);
    if (run.task_key) lines.push(`Task key: ${run.task_key}.`);
    lines.push("Respond with HEARTBEAT_OK when no action is required.");
    return lines.join("\n");
  };

  const finalizeAgentAfterRun = (agentId: string): void => {
    const latest = args.workerAgentService.getAgent(agentId);
    if (latest?.status === "running") {
      args.workerAgentService.setAgentStatus(agentId, "idle");
    }
    args.workerAgentService.setAgentHeartbeatAt(agentId, nowIso());
  };

  const runWakeup = async (agent: AgentIdentity, run: WorkerRunRow): Promise<void> => {
    const startedAt = nowIso();
    args.workerAgentService.setAgentStatus(agent.id, "running");
    args.workerAgentService.setAgentHeartbeatAt(agent.id, startedAt);
    const executionRunId = randomUUID();

    let taskKey = run.task_key;
    if (!taskKey) {
      taskKey = args.workerTaskSessionService.deriveTaskKey({
        agentId: agent.id,
        linearIssueId: run.issue_key,
        summary: `${run.wakeup_reason}:${agent.name}`,
      });
      updateRunFields(run.id, { task_key: taskKey });
    }

    args.workerTaskSessionService.ensureTaskSession({
      agentId: agent.id,
      adapterType: agent.adapterType,
      taskKey,
      payload: {
        runId: run.id,
        reason: run.wakeup_reason,
        issueKey: run.issue_key,
      },
    });

    updateRunFields(run.id, {
      status: "running",
      started_at: startedAt,
      execution_run_id: executionRunId,
      execution_locked_at: startedAt,
      error_message: null,
    });

    if (!shouldEscalate(run)) {
      updateRunFields(run.id, {
        status: "completed",
        finished_at: nowIso(),
        result_json: JSON.stringify({
          escalated: false,
          heartbeatOk: true,
          outputPreview: "HEARTBEAT_OK",
        }),
      });
      return;
    }

    const prompt = buildPrompt(agent, run);
    const runtimeResult = await args.workerAdapterRuntimeService.run({
      agent,
      prompt,
      context: safeJsonParse(run.context_json, {}),
    });

    const heartbeatOk = runtimeResult.outputText.trim().toUpperCase() === "HEARTBEAT_OK";
    const finishedAt = nowIso();
    const runStatus: WorkerAgentRunStatus = runtimeResult.ok ? "completed" : "failed";
    updateRunFields(run.id, {
      status: runStatus,
      finished_at: finishedAt,
      error_message: runtimeResult.ok ? null : `Adapter run failed (${runtimeResult.adapterType}).`,
      result_json: JSON.stringify({
        escalated: true,
        adapterType: runtimeResult.adapterType,
        ok: runtimeResult.ok,
        statusCode: runtimeResult.statusCode ?? null,
        heartbeatOk,
        outputPreview: outputPreview(runtimeResult.outputText),
      }),
    });

    if (runtimeResult.usage?.costCents != null && args.workerBudgetService) {
      args.workerBudgetService.recordCostEvent({
        agentId: agent.id,
        runId: run.id,
        provider: agent.adapterType,
        modelId: typeof (agent.adapterConfig as Record<string, unknown>).modelId === "string"
          ? String((agent.adapterConfig as Record<string, unknown>).modelId)
          : null,
        inputTokens: runtimeResult.usage.inputTokens ?? null,
        outputTokens: runtimeResult.usage.outputTokens ?? null,
        costCents: Math.max(0, Math.floor(Number(runtimeResult.usage.costCents ?? 0))),
        estimated: runtimeResult.usage.estimated !== false,
        source: "manual",
      });
    }
  };

  const canWakeOnDemand = (agent: AgentIdentity, reason: WorkerAgentWakeupReason): boolean => {
    if (reason === "timer") return true;
    const heartbeat = agent.runtimeConfig?.heartbeat;
    if (!heartbeat) return true;
    return heartbeat.wakeOnDemand !== false;
  };

  const dispatchNext = async (agentId: string): Promise<void> => {
    if (disposed) return;
    if (inFlightAgents.has(agentId)) return;

    const agent = args.workerAgentService.getAgent(agentId);
    if (!agent || agent.deletedAt) return;
    if (agent.status === "paused") return;

    const next = findNextPendingRun(agentId);
    if (!next) return;

    if (!canWakeOnDemand(agent, normalizeReason(next.wakeup_reason))) {
      updateRunFields(next.id, {
        status: "skipped",
        error_message: "Wake-on-demand is disabled for this worker.",
        finished_at: nowIso(),
      });
      return;
    }

    if (!withinActiveHours(agent)) {
      if (next.status !== "deferred") {
        updateRunFields(next.id, { status: "deferred" });
      }
      return;
    }

    const conflict = findIssueLockConflict(next);
    if (conflict) {
      const conflictAgentActive = inFlightAgents.has(conflict.agent_id);
      if (!conflictAgentActive && isStale(conflict)) {
        failRunAsOrphan(conflict, `Issue lock was adopted by wakeup '${next.id}' after stale timeout.`);
      } else {
        if (next.status !== "deferred") {
          updateRunFields(next.id, {
            status: "deferred",
            error_message: `Issue '${next.issue_key}' is locked by run '${conflict.id}'.`,
          });
        }
        return;
      }
    }

    inFlightAgents.add(agentId);
    try {
      await runWakeup(agent, next);
    } catch (error) {
      updateRunFields(next.id, {
        status: "failed",
        finished_at: nowIso(),
        error_message: getErrorMessage(error),
      });
      logDebug("run_failed", { agentId, runId: next.id, error: getErrorMessage(error) });
    } finally {
      inFlightAgents.delete(agentId);
      finalizeAgentAfterRun(agentId);
      await dispatchNext(agentId);
    }
  };

  const reapOrphansOnStartup = async (): Promise<void> => {
    const rows = args.db.all<WorkerRunRow>(
      `
        select *
        from worker_agent_runs
        where project_id = ?
          and status in ('queued', 'running')
      `,
      [args.projectId]
    );
    if (rows.length) {
      const timestamp = nowIso();
      for (const row of rows) {
        updateRunFields(row.id, {
          status: "failed",
          error_message: "Orphaned by app restart; run has been recovered.",
          finished_at: timestamp,
        });
      }
      logDebug("orphan_reaped", { count: rows.length });
    }

    const deferredAgentIds = listDeferredAgentIds();
    for (const agentId of deferredAgentIds) {
      await dispatchNext(agentId);
    }
  };

  const syncFromConfig = (): void => {
    if (disposed) return;
    const agents = args.workerAgentService.listAgents({ includeDeleted: false });
    const desired = new Map<string, number>();

    for (const agent of agents) {
      const heartbeat = agent.runtimeConfig?.heartbeat;
      if (!heartbeat?.enabled) continue;
      const interval = Math.max(0, Math.floor(Number(heartbeat.intervalSec ?? 0)));
      if (interval <= 0) continue;
      if (agent.status === "paused") continue;
      desired.set(agent.id, interval);
    }

    for (const [agentId, timerEntry] of timers.entries()) {
      const nextInterval = desired.get(agentId);
      if (nextInterval != null && nextInterval === timerEntry.intervalSec) continue;
      clearInterval(timerEntry.timer);
      timers.delete(agentId);
    }

    for (const [agentId, intervalSec] of desired.entries()) {
      if (timers.has(agentId)) continue;
      const timer = setInterval(() => {
        void triggerWakeup({
          agentId,
          reason: "timer",
          context: { hasChanges: false, eventCount: 0, source: "timer" },
        }).catch((error) => {
          logDebug("timer_wakeup_failed", {
            agentId,
            error: getErrorMessage(error),
          });
        });
      }, intervalSec * 1000);
      timers.set(agentId, { timer, intervalSec });
    }
  };

  const triggerWakeup = async (input: CtoTriggerAgentWakeupArgs): Promise<CtoTriggerAgentWakeupResult> => {
    if (disposed) {
      throw new Error("Worker heartbeat service has been disposed.");
    }
    const agentId = String(input.agentId ?? "").trim();
    if (!agentId.length) throw new Error("agentId is required.");
    const agent = args.workerAgentService.getAgent(agentId);
    if (!agent || agent.deletedAt) {
      throw new Error(`Worker '${agentId}' was not found.`);
    }

    const reason = normalizeReason(input.reason ?? "api");
    const wakeRun = insertRun({
      agentId,
      reason,
      taskKey: input.taskKey ?? null,
      issueKey: input.issueKey ?? null,
      prompt: input.prompt ?? null,
      context: input.context ?? {},
    }, "queued");

    if (agent.status === "paused") {
      updateRunFields(wakeRun.id, {
        status: "skipped",
        error_message: "Worker is paused.",
        finished_at: nowIso(),
      });
      return { runId: wakeRun.id, status: "skipped" };
    }

    if (inFlightAgents.has(agentId)) {
      const running = findRunningRunForAgent(agentId);
      if (running && ((running.issue_key && running.issue_key === wakeRun.issueKey) || (running.task_key && running.task_key === wakeRun.taskKey))) {
        coalesceIntoRunningRun(running, getRunById(wakeRun.id)!);
        return { runId: wakeRun.id, status: "skipped" };
      }
      updateRunFields(wakeRun.id, { status: "deferred" });
      return { runId: wakeRun.id, status: "deferred" };
    }

    if (!withinActiveHours(agent)) {
      updateRunFields(wakeRun.id, { status: "deferred" });
      return { runId: wakeRun.id, status: "deferred" };
    }

    await dispatchNext(agentId);
    const updated = getRunById(wakeRun.id);
    return { runId: wakeRun.id, status: normalizeStatus(updated?.status ?? wakeRun.status) };
  };

  const listRuns = (input: { agentId?: string; limit?: number; statuses?: WorkerAgentRunStatus[] } = {}): WorkerAgentRun[] => {
    const where: string[] = ["project_id = ?"];
    const params: SqlValue[] = [args.projectId];
    if (input.agentId) {
      where.push("agent_id = ?");
      params.push(input.agentId);
    }
    const statuses = Array.isArray(input.statuses)
      ? input.statuses.filter((status): status is WorkerAgentRunStatus => RUN_STATUSES.has(status))
      : [];
    if (statuses.length) {
      where.push(`status in (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    params.push(clampLimit(input.limit, 80));

    const rows = args.db.all<WorkerRunRow>(
      `
        select *
        from worker_agent_runs
        where ${where.join(" and ")}
        order by datetime(created_at) desc
        limit ?
      `,
      params
    );
    return rows.map(rowToRun);
  };

  const getAgentCoreMemory = (agentId: string): AgentCoreMemory => {
    return args.workerAgentService.getCoreMemory(agentId);
  };

  const updateAgentCoreMemory = (
    agentId: string,
    patch: Partial<Omit<AgentCoreMemory, "version" | "updatedAt">>
  ): AgentCoreMemory => {
    return args.workerAgentService.updateCoreMemory(agentId, patch);
  };

  const listAgentSessionLogs = (agentId: string, limit = 40): AgentSessionLogEntry[] => {
    return args.workerAgentService.listSessionLogs(agentId, limit);
  };

  const dispose = (): void => {
    disposed = true;
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = null;
    }
    for (const entry of timers.values()) {
      clearInterval(entry.timer);
    }
    timers.clear();
    inFlightAgents.clear();
  };

  const start = (): void => {
    if (disposed) return;
    syncFromConfig();
    if (!maintenanceTimer) {
      maintenanceTimer = setInterval(() => {
        if (disposed) return;
        syncFromConfig();
        const deferredAgentIds = listDeferredAgentIds();
        for (const agentId of deferredAgentIds) {
          void dispatchNext(agentId);
        }
      }, maintenanceIntervalMs);
    }
    void reapOrphansOnStartup();
  };

  if (args.autoStart !== false) {
    start();
  }

  return {
    start,
    syncFromConfig,
    triggerWakeup,
    listRuns,
    getAgentCoreMemory,
    updateAgentCoreMemory,
    listAgentSessionLogs,
    reapOrphansOnStartup,
    dispose,
  };
}

export type WorkerHeartbeatService = ReturnType<typeof createWorkerHeartbeatService>;
