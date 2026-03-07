import { createHash, randomUUID } from "node:crypto";
import type { AgentTaskSession, AdapterType } from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { safeJsonParse, nowIso } from "../shared/utils";

type WorkerTaskSessionServiceArgs = {
  db: AdeDb;
  projectId: string;
};

type EnsureTaskSessionArgs = {
  agentId: string;
  adapterType: AdapterType;
  taskKey: string;
  payload: Record<string, unknown>;
};

type DeriveTaskKeyArgs = {
  agentId: string;
  laneId?: string | null;
  missionId?: string | null;
  linearIssueId?: string | null;
  chatSessionId?: string | null;
  summary?: string | null;
};

function normalizeTaskKey(taskKey: string): string {
  const normalized = taskKey.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-");
  return normalized.slice(0, 160) || "task:default";
}

function digestTaskSeed(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function stringifyPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload ?? {});
}

export function createWorkerTaskSessionService(args: WorkerTaskSessionServiceArgs) {
  const mapRow = (row: Record<string, unknown>): AgentTaskSession => {
    return {
      id: String(row.id ?? ""),
      agentId: String(row.agent_id ?? ""),
      adapterType: String(row.adapter_type ?? "process") as AdapterType,
      taskKey: String(row.task_key ?? ""),
      payload: safeJsonParse(String(row.payload_json ?? "{}"), {}),
      clearedAt: typeof row.cleared_at === "string" && row.cleared_at.trim().length ? row.cleared_at.trim() : null,
      createdAt: String(row.created_at ?? nowIso()),
      updatedAt: String(row.updated_at ?? nowIso()),
    };
  };

  const deriveTaskKey = (input: DeriveTaskKeyArgs): string => {
    const contextParts = [
      `agent:${input.agentId.trim()}`,
      input.missionId ? `mission:${input.missionId.trim()}` : "",
      input.linearIssueId ? `linear:${input.linearIssueId.trim()}` : "",
      input.chatSessionId ? `chat:${input.chatSessionId.trim()}` : "",
      input.laneId ? `lane:${input.laneId.trim()}` : "",
      input.summary ? `summary:${input.summary.trim()}` : "",
    ].filter((part) => part.length > 0);
    const seed = contextParts.join("|") || `agent:${input.agentId.trim()}:manual`;
    return normalizeTaskKey(`task:${digestTaskSeed(seed)}`);
  };

  const ensureTaskSession = (input: EnsureTaskSessionArgs): AgentTaskSession => {
    const taskKey = normalizeTaskKey(input.taskKey);
    const current = args.db.get<Record<string, unknown>>(
      `
        select id, agent_id, adapter_type, task_key, payload_json, cleared_at, created_at, updated_at
        from worker_agent_task_sessions
        where project_id = ? and agent_id = ? and adapter_type = ? and task_key = ?
        limit 1
      `,
      [args.projectId, input.agentId, input.adapterType, taskKey]
    );
    const timestamp = nowIso();
    if (current?.id) {
      args.db.run(
        `
          update worker_agent_task_sessions
          set payload_json = ?, cleared_at = null, updated_at = ?
          where id = ?
        `,
        [stringifyPayload(input.payload), timestamp, String(current.id)]
      );
      const refreshed = args.db.get<Record<string, unknown>>(
        `select id, agent_id, adapter_type, task_key, payload_json, cleared_at, created_at, updated_at from worker_agent_task_sessions where id = ? limit 1`,
        [String(current.id)]
      );
      return mapRow(refreshed ?? current);
    }

    const id = randomUUID();
    args.db.run(
      `
        insert into worker_agent_task_sessions(
          id, project_id, agent_id, adapter_type, task_key, payload_json, cleared_at, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, null, ?, ?)
      `,
      [id, args.projectId, input.agentId, input.adapterType, taskKey, stringifyPayload(input.payload), timestamp, timestamp]
    );
    return {
      id,
      agentId: input.agentId,
      adapterType: input.adapterType,
      taskKey,
      payload: input.payload,
      clearedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  };

  const getTaskSession = (agentId: string, adapterType: AdapterType, taskKey: string): AgentTaskSession | null => {
    const row = args.db.get<Record<string, unknown>>(
      `
        select id, agent_id, adapter_type, task_key, payload_json, cleared_at, created_at, updated_at
        from worker_agent_task_sessions
        where project_id = ? and agent_id = ? and adapter_type = ? and task_key = ?
        limit 1
      `,
      [args.projectId, agentId, adapterType, normalizeTaskKey(taskKey)]
    );
    return row ? mapRow(row) : null;
  };

  const listAgentTaskSessions = (agentId: string, limit = 40): AgentTaskSession[] => {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = args.db.all<Record<string, unknown>>(
      `
        select id, agent_id, adapter_type, task_key, payload_json, cleared_at, created_at, updated_at
        from worker_agent_task_sessions
        where project_id = ? and agent_id = ?
        order by datetime(updated_at) desc
        limit ?
      `,
      [args.projectId, agentId, safeLimit]
    );
    return rows.map(mapRow);
  };

  const clearAgentTaskSession = (argsInput: {
    agentId: string;
    adapterType?: AdapterType;
    taskKey?: string;
  }): number => {
    const timestamp = nowIso();
    if (argsInput.adapterType && argsInput.taskKey) {
      args.db.run(
        `
          update worker_agent_task_sessions
          set cleared_at = ?, payload_json = ?, updated_at = ?
          where project_id = ? and agent_id = ? and adapter_type = ? and task_key = ?
        `,
        [timestamp, "{}", timestamp, args.projectId, argsInput.agentId, argsInput.adapterType, normalizeTaskKey(argsInput.taskKey)]
      );
      const hit = args.db.get<{ count: number }>(
        `
          select count(*) as count
          from worker_agent_task_sessions
          where project_id = ? and agent_id = ? and adapter_type = ? and task_key = ? and cleared_at = ?
        `,
        [args.projectId, argsInput.agentId, argsInput.adapterType, normalizeTaskKey(argsInput.taskKey), timestamp]
      );
      return Number(hit?.count ?? 0);
    }

    if (argsInput.adapterType) {
      args.db.run(
        `
          update worker_agent_task_sessions
          set cleared_at = ?, payload_json = ?, updated_at = ?
          where project_id = ? and agent_id = ? and adapter_type = ?
        `,
        [timestamp, "{}", timestamp, args.projectId, argsInput.agentId, argsInput.adapterType]
      );
      const hit = args.db.get<{ count: number }>(
        `
          select count(*) as count
          from worker_agent_task_sessions
          where project_id = ? and agent_id = ? and adapter_type = ? and cleared_at = ?
        `,
        [args.projectId, argsInput.agentId, argsInput.adapterType, timestamp]
      );
      return Number(hit?.count ?? 0);
    }

    args.db.run(
      `
        update worker_agent_task_sessions
        set cleared_at = ?, payload_json = ?, updated_at = ?
        where project_id = ? and agent_id = ?
      `,
      [timestamp, "{}", timestamp, args.projectId, argsInput.agentId]
    );
    const hit = args.db.get<{ count: number }>(
      `
        select count(*) as count
        from worker_agent_task_sessions
        where project_id = ? and agent_id = ? and cleared_at = ?
      `,
      [args.projectId, argsInput.agentId, timestamp]
    );
    return Number(hit?.count ?? 0);
  };

  return {
    deriveTaskKey,
    ensureTaskSession,
    getTaskSession,
    listAgentTaskSessions,
    clearAgentTaskSession,
  };
}

export type WorkerTaskSessionService = ReturnType<typeof createWorkerTaskSessionService>;

