import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";

export type MemoryScope = "user" | "project" | "lane" | "mission";
export type MemoryCategory = "fact" | "preference" | "pattern" | "decision" | "gotcha";
export type MemoryImportance = "low" | "medium" | "high";

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
};

export type MemoryBudgetLevel = "lite" | "standard" | "deep";

export function createMemoryService(db: AdeDb) {
  function addMemory(opts: AddMemoryOpts): Memory {
    const id = randomUUID();
    const now = new Date().toISOString();
    const importance = opts.importance ?? "medium";
    db.run(
      `INSERT INTO memories (id, project_id, scope, category, content, importance, source_session_id, source_pack_key, created_at, last_accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [id, opts.projectId, opts.scope, opts.category, opts.content, importance, opts.sourceSessionId ?? null, opts.sourcePackKey ?? null, now, now]
    );
    return {
      id, projectId: opts.projectId, scope: opts.scope, category: opts.category,
      content: opts.content, importance, sourceSessionId: opts.sourceSessionId ?? null,
      sourcePackKey: opts.sourcePackKey ?? null, createdAt: now, lastAccessedAt: now, accessCount: 0
    };
  }

  function searchMemories(query: string, projectId: string, scope?: MemoryScope, limit = 10): Memory[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const conditions = words.map(() => "LOWER(content) LIKE ?").join(" AND ");
    const params: (string | number | null)[] = words.map(w => `%${w}%`);

    let sql = `SELECT * FROM memories WHERE project_id = ? AND ${conditions}`;
    params.unshift(projectId);

    if (scope) {
      sql += ` AND scope = ?`;
      params.push(scope);
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
      `SELECT * FROM memories WHERE project_id = ?
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
    searchMemories,
    getRecentMemories,
    getMemoryBudget,
    addSharedFact,
    getSharedFacts,
    deleteMemory
  };
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
    accessCount: Number(row.access_count ?? 0)
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
