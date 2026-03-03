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

export function createMemoryService(db: AdeDb) {
  function addMemory(opts: AddMemoryOpts): Memory {
    const id = randomUUID();
    const now = new Date().toISOString();
    const importance = opts.importance ?? "medium";
    db.run(
      `INSERT INTO memories (id, project_id, scope, category, content, importance, source_session_id, source_pack_key, created_at, last_accessed_at, access_count, status, agent_id, confidence, promoted_at, source_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'promoted', ?, 1.0, ?, ?)`,
      [id, opts.projectId, opts.scope, opts.category, opts.content, importance, opts.sourceSessionId ?? null, opts.sourcePackKey ?? null, now, now, opts.agentId ?? null, now, opts.sourceRunId ?? null]
    );
    return {
      id, projectId: opts.projectId, scope: opts.scope, category: opts.category,
      content: opts.content, importance, sourceSessionId: opts.sourceSessionId ?? null,
      sourcePackKey: opts.sourcePackKey ?? null, createdAt: now, lastAccessedAt: now, accessCount: 0,
      status: "promoted", agentId: opts.agentId ?? null, confidence: 1.0, promotedAt: now, sourceRunId: opts.sourceRunId ?? null
    };
  }

  function addCandidateMemory(opts: AddCandidateMemoryOpts): Memory {
    const id = randomUUID();
    const now = new Date().toISOString();
    const importance = opts.importance ?? "medium";
    const confidence = opts.confidence ?? 0.5;
    db.run(
      `INSERT INTO memories (id, project_id, scope, category, content, importance, source_session_id, source_pack_key, created_at, last_accessed_at, access_count, status, agent_id, confidence, promoted_at, source_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'candidate', ?, ?, NULL, ?)`,
      [id, opts.projectId, opts.scope, opts.category, opts.content, importance, opts.sourceSessionId ?? null, opts.sourcePackKey ?? null, now, now, opts.agentId ?? null, confidence, opts.sourceRunId ?? null]
    );
    return {
      id, projectId: opts.projectId, scope: opts.scope, category: opts.category,
      content: opts.content, importance, sourceSessionId: opts.sourceSessionId ?? null,
      sourcePackKey: opts.sourcePackKey ?? null, createdAt: now, lastAccessedAt: now, accessCount: 0,
      status: "candidate", agentId: opts.agentId ?? null, confidence, promotedAt: null, sourceRunId: opts.sourceRunId ?? null
    };
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

  function getMemoryBudget(projectId: string, level: MemoryBudgetLevel): Memory[] {
    const limits: Record<MemoryBudgetLevel, number> = { lite: 3, standard: 8, deep: 20 };
    const limit = limits[level];
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'promoted'
       ORDER BY
         CASE importance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         access_count DESC,
         last_accessed_at DESC
       LIMIT ?`,
      [projectId, limit]
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
