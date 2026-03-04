import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";

export type MemoryScope = "user" | "project" | "lane" | "mission";
export type MemoryCategory = "fact" | "preference" | "pattern" | "decision" | "gotcha";
export type MemoryImportance = "low" | "medium" | "high";

export type MemoryStatus = "candidate" | "promoted" | "archived";

export type Memory = {
  id: string;
  projectId: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  importance: MemoryImportance;
  sourceSessionId: string | null;
  sourcePackKey: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  status: MemoryStatus;
  agentId: string | null;
  confidence: number;
  promotedAt: string | null;
  sourceRunId: string | null;
};

export type SharedFact = {
  id: string;
  runId: string;
  stepId: string | null;
  factType: "api_pattern" | "schema_change" | "config" | "architectural" | "gotcha";
  content: string;
  createdAt: string;
};

export type AddMemoryOpts = {
  projectId: string;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  importance?: MemoryImportance;
  sourceSessionId?: string;
  sourcePackKey?: string;
  agentId?: string;
  sourceRunId?: string;
};

export type AddCandidateMemoryOpts = AddMemoryOpts & {
  confidence?: number;
};

export type MemoryBudgetLevel = "lite" | "standard" | "deep";

function normalizeMemoryForDedup(content: string): string {
  return String(content ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function memoryImportanceRank(importance: MemoryImportance): number {
  if (importance === "high") return 3;
  if (importance === "medium") return 2;
  return 1;
}

function resolveHigherImportance(left: MemoryImportance, right: MemoryImportance): MemoryImportance {
  return memoryImportanceRank(left) >= memoryImportanceRank(right) ? left : right;
}

function memoryStatusRank(status: MemoryStatus): number {
  if (status === "promoted") return 3;
  if (status === "candidate") return 2;
  return 1;
}

function toMemoryStatus(value: unknown): MemoryStatus {
  const raw = String(value ?? "").trim();
  if (raw === "promoted" || raw === "candidate" || raw === "archived") return raw;
  return "candidate";
}

function resolveHigherStatus(left: MemoryStatus, right: MemoryStatus): MemoryStatus {
  return memoryStatusRank(left) >= memoryStatusRank(right) ? left : right;
}

export function createMemoryService(db: AdeDb) {
  function upsertMemory(args: {
    projectId: string;
    scope: MemoryScope;
    category: MemoryCategory;
    content: string;
    importance: MemoryImportance;
    status: MemoryStatus;
    sourceSessionId?: string;
    sourcePackKey?: string;
    agentId?: string;
    sourceRunId?: string;
    confidence: number;
  }): Memory {
    const now = new Date().toISOString();
    const normalized = normalizeMemoryForDedup(args.content);
    const existingRows = normalized.length > 0
      ? db.all<Record<string, unknown>>(
          `
            SELECT *
            FROM memories
            WHERE project_id = ?
              AND scope = ?
              AND category = ?
            ORDER BY
              CASE status WHEN 'promoted' THEN 3 WHEN 'candidate' THEN 2 ELSE 1 END DESC,
              CASE importance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
              confidence DESC,
              last_accessed_at DESC
          `,
          [args.projectId, args.scope, args.category]
        )
      : [];
    const existing = existingRows.find((row) => normalizeMemoryForDedup(String(row.content ?? "")) === normalized) ?? null;

    if (existing?.id) {
      const currentImportance = String(existing.importance ?? "medium") as MemoryImportance;
      const nextImportance = resolveHigherImportance(currentImportance, args.importance);
      const currentStatus = toMemoryStatus(existing.status);
      const nextStatus = resolveHigherStatus(currentStatus, args.status);
      const promotedAt = nextStatus === "promoted"
        ? String(existing.promoted_at ?? "").trim() || now
        : null;
      db.run(
        `
          UPDATE memories
          SET
            status = ?,
            importance = ?,
            source_session_id = COALESCE(?, source_session_id),
            source_pack_key = COALESCE(?, source_pack_key),
            last_accessed_at = ?,
            access_count = access_count + 1,
            agent_id = COALESCE(?, agent_id),
            confidence = CASE WHEN ? > confidence THEN ? ELSE confidence END,
            promoted_at = ?,
            source_run_id = COALESCE(?, source_run_id)
          WHERE id = ?
        `,
        [
          nextStatus,
          nextImportance,
          args.sourceSessionId ?? null,
          args.sourcePackKey ?? null,
          now,
          args.agentId ?? null,
          args.confidence,
          args.confidence,
          promotedAt,
          args.sourceRunId ?? null,
          String(existing.id)
        ]
      );

      const refreshed = db.get<Record<string, unknown>>(`SELECT * FROM memories WHERE id = ? LIMIT 1`, [String(existing.id)]);
      if (refreshed) return mapMemoryRow(refreshed);
    }

    const id = randomUUID();
    const promotedAt = args.status === "promoted" ? now : null;
    db.run(
      `INSERT INTO memories (
         id, project_id, scope, category, content, importance, source_session_id, source_pack_key,
         created_at, last_accessed_at, access_count, status, agent_id, confidence, promoted_at, source_run_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        args.projectId,
        args.scope,
        args.category,
        args.content,
        args.importance,
        args.sourceSessionId ?? null,
        args.sourcePackKey ?? null,
        now,
        now,
        args.status,
        args.agentId ?? null,
        args.confidence,
        promotedAt,
        args.sourceRunId ?? null
      ]
    );
    return {
      id,
      projectId: args.projectId,
      scope: args.scope,
      category: args.category,
      content: args.content,
      importance: args.importance,
      sourceSessionId: args.sourceSessionId ?? null,
      sourcePackKey: args.sourcePackKey ?? null,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      status: args.status,
      agentId: args.agentId ?? null,
      confidence: args.confidence,
      promotedAt,
      sourceRunId: args.sourceRunId ?? null
    };
  }

  function addMemory(opts: AddMemoryOpts): Memory {
    const importance = opts.importance ?? "medium";
    return upsertMemory({
      projectId: opts.projectId,
      scope: opts.scope,
      category: opts.category,
      content: opts.content,
      importance,
      sourceSessionId: opts.sourceSessionId,
      sourcePackKey: opts.sourcePackKey,
      agentId: opts.agentId,
      sourceRunId: opts.sourceRunId,
      status: "promoted",
      confidence: 1.0
    });
  }

  function addCandidateMemory(opts: AddCandidateMemoryOpts): Memory {
    const importance = opts.importance ?? "medium";
    const confidence = opts.confidence ?? 0.5;
    return upsertMemory({
      projectId: opts.projectId,
      scope: opts.scope,
      category: opts.category,
      content: opts.content,
      importance,
      sourceSessionId: opts.sourceSessionId,
      sourcePackKey: opts.sourcePackKey,
      agentId: opts.agentId,
      sourceRunId: opts.sourceRunId,
      status: "candidate",
      confidence
    });
  }

  function promoteMemory(id: string): void {
    const now = new Date().toISOString();
    db.run(
      `UPDATE memories SET status = 'promoted', promoted_at = ? WHERE id = ?`,
      [now, id]
    );
  }

  function archiveMemory(id: string): void {
    db.run(
      `UPDATE memories SET status = 'archived' WHERE id = ?`,
      [id]
    );
  }

  function getCandidateMemories(projectId: string, limit = 20): Memory[] {
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'candidate' ORDER BY confidence DESC, created_at DESC LIMIT ?`,
      [projectId, limit]
    );
    return rows.map(mapMemoryRow);
  }

  function searchMemories(
    query: string,
    projectId: string,
    scope?: MemoryScope,
    limit = 10,
    status: MemoryStatus | MemoryStatus[] = "promoted"
  ): Memory[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const conditions = words.map(() => "LOWER(content) LIKE ?").join(" AND ");
    const params: (string | number | null)[] = words.map(w => `%${w}%`);
    const statuses = Array.isArray(status) ? status : [status];

    let sql = `SELECT * FROM memories WHERE project_id = ? AND ${conditions}`;
    params.unshift(projectId);

    if (scope) {
      sql += ` AND scope = ?`;
      params.push(scope);
    }

    if (statuses.length) {
      sql += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    }

    sql += ` ORDER BY CASE importance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, last_accessed_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.all<Record<string, unknown>>(sql, params as any);

    // Update access counts for returned memories
    for (const row of rows) {
      if (row.id) {
        db.run(
          `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
          [new Date().toISOString(), row.id as string]
        );
      }
    }

    return rows.map(mapMemoryRow);
  }

  function getRecentMemories(projectId: string, scope: MemoryScope, limit = 10): Memory[] {
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM memories WHERE project_id = ? AND scope = ? ORDER BY last_accessed_at DESC LIMIT ?`,
      [projectId, scope, limit]
    );
    return rows.map(mapMemoryRow);
  }

  function getMemoryBudget(
    projectId: string,
    level: MemoryBudgetLevel,
    opts?: { includeCandidates?: boolean }
  ): Memory[] {
    const limits: Record<MemoryBudgetLevel, number> = { lite: 3, standard: 8, deep: 20 };
    const limit = limits[level];
    const includeCandidates = opts?.includeCandidates === true;
    const statuses = includeCandidates ? ["promoted", "candidate"] : ["promoted"];
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM memories WHERE project_id = ? AND status IN (${statuses.map(() => "?").join(",")})
       ORDER BY
         CASE status WHEN 'promoted' THEN 2 WHEN 'candidate' THEN 1 ELSE 0 END DESC,
         CASE importance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         confidence DESC,
         access_count DESC,
         last_accessed_at DESC
       LIMIT ?`,
      [projectId, ...statuses, limit]
    );
    return rows.map(mapMemoryRow);
  }

  function addSharedFact(opts: { runId: string; stepId?: string; factType: SharedFact["factType"]; content: string }): SharedFact {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO orchestrator_shared_facts (id, run_id, step_id, fact_type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, opts.runId, opts.stepId ?? null, opts.factType, opts.content, now]
    );
    return { id, runId: opts.runId, stepId: opts.stepId ?? null, factType: opts.factType, content: opts.content, createdAt: now };
  }

  function getSharedFacts(runId: string, limit = 20): SharedFact[] {
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM orchestrator_shared_facts WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`,
      [runId, limit]
    );
    return rows.map(mapSharedFactRow);
  }

  function deleteMemory(id: string): void {
    db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  }

  return {
    addMemory,
    addCandidateMemory,
    promoteMemory,
    archiveMemory,
    getCandidateMemories,
    searchMemories,
    getRecentMemories,
    getMemoryBudget,
    addSharedFact,
    getSharedFacts,
    deleteMemory
  };
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "candidate" || s === "promoted" || s === "archived") return s;
  return "promoted";
}

function mapMemoryRow(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    scope: String(row.scope ?? "project") as MemoryScope,
    category: String(row.category ?? "fact") as MemoryCategory,
    content: String(row.content ?? ""),
    importance: String(row.importance ?? "medium") as MemoryImportance,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    sourcePackKey: row.source_pack_key ? String(row.source_pack_key) : null,
    createdAt: String(row.created_at ?? ""),
    lastAccessedAt: String(row.last_accessed_at ?? ""),
    accessCount: Number(row.access_count ?? 0),
    status: normalizeMemoryStatus(row.status),
    agentId: row.agent_id ? String(row.agent_id) : null,
    confidence: Number(row.confidence ?? 1.0),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null
  };
}

function mapSharedFactRow(row: Record<string, unknown>): SharedFact {
  return {
    id: String(row.id ?? ""),
    runId: String(row.run_id ?? ""),
    stepId: row.step_id ? String(row.step_id) : null,
    factType: String(row.fact_type ?? "architectural") as SharedFact["factType"],
    content: String(row.content ?? ""),
    createdAt: String(row.created_at ?? "")
  };
}
