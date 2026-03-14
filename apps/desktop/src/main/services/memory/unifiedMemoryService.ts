import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { createHybridSearchService } from "./hybridSearchService";

export type UnifiedMemoryScope = "project" | "agent" | "mission";
export type MemoryScope = UnifiedMemoryScope | "user" | "lane";

export type MemoryTier = 1 | 2 | 3;
export type MemoryCategory =
  | "fact"
  | "preference"
  | "pattern"
  | "decision"
  | "gotcha"
  | "convention"
  | "episode"
  | "procedure"
  | "digest"
  | "handoff";
export type MemoryImportance = "low" | "medium" | "high";
export type MemoryStatus = "candidate" | "promoted" | "archived";
export type MemorySourceType = "agent" | "system" | "user" | "mission_promotion" | "consolidation";
export type MemorySearchMode = "lexical" | "hybrid";

type CreateUnifiedMemoryServiceOpts = {
  onMemoryMutated?: () => void;
  onMemoryUpserted?: (event: MemoryUpsertEvent) => void;
  hybridSearchService?: Pick<ReturnType<typeof createHybridSearchService>, "search">;
};

export type MemoryUpsertEvent = {
  memory: Memory;
  created: boolean;
  deduped: boolean;
  mergedIntoId?: string;
  contentChanged: boolean;
};

export type Memory = {
  id: string;
  projectId: string;
  scope: UnifiedMemoryScope;
  scopeOwnerId: string | null;
  tier: MemoryTier;
  category: MemoryCategory;
  content: string;
  importance: MemoryImportance;
  sourceSessionId: string | null;
  sourcePackKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  observationCount: number;
  status: MemoryStatus;
  agentId: string | null;
  confidence: number;
  promotedAt: string | null;
  sourceRunId: string | null;
  sourceType: MemorySourceType;
  sourceId: string | null;
  fileScopePattern: string | null;
  pinned: boolean;
  accessScore: number;
  compositeScore: number;
  writeGateReason: string | null;
  embedded?: boolean;
};

export type AddMemoryOpts = {
  projectId: string;
  scope: MemoryScope;
  scopeOwnerId?: string;
  category: MemoryCategory;
  content: string;
  importance?: MemoryImportance;
  sourceSessionId?: string;
  sourcePackKey?: string;
  agentId?: string;
  sourceRunId?: string;
  sourceType?: MemorySourceType;
  sourceId?: string;
  fileScopePattern?: string;
  writeGateMode?: WriteGateMode;
};

export type AddCandidateMemoryOpts = AddMemoryOpts & {
  confidence?: number;
};

export type MemoryBudgetLevel = "lite" | "standard" | "deep";
export type WriteGateMode = "default" | "strict";

export type SearchMemoryOpts = {
  projectId: string;
  query: string;
  scope?: UnifiedMemoryScope;
  scopeOwnerId?: string | null;
  limit?: number;
  mode?: MemorySearchMode;
  status?: MemoryStatus | ReadonlyArray<MemoryStatus>;
  tiers?: MemoryTier[];
};

export type ListMemoriesOpts = {
  projectId: string;
  scope?: UnifiedMemoryScope;
  scopeOwnerId?: string | null;
  scopeOwnerIds?: ReadonlyArray<string | null>;
  status?: MemoryStatus | ReadonlyArray<MemoryStatus>;
  categories?: ReadonlyArray<MemoryCategory>;
  tiers?: ReadonlyArray<MemoryTier>;
  sourceRunId?: string | null;
  sourceType?: MemorySourceType | ReadonlyArray<MemorySourceType>;
  sourceId?: string | null;
  limit?: number;
};

export type WriteMemoryOpts = {
  projectId: string;
  scope: MemoryScope;
  scopeOwnerId?: string;
  tier?: MemoryTier;
  category: MemoryCategory;
  content: string;
  importance?: MemoryImportance;
  confidence?: number;
  status?: MemoryStatus;
  pinned?: boolean;
  sourceSessionId?: string;
  sourcePackKey?: string;
  agentId?: string;
  sourceRunId?: string;
  sourceType?: MemorySourceType;
  sourceId?: string;
  fileScopePattern?: string;
  writeGateMode?: WriteGateMode;
};

export type WriteMemoryResult = {
  accepted: boolean;
  memory?: Memory;
  reason?: string;
  deduped?: boolean;
  mergedIntoId?: string;
};

const CATEGORY_ALLOWLIST = new Set<MemoryCategory>([
  "fact",
  "preference",
  "pattern",
  "decision",
  "gotcha",
  "convention",
  "episode",
  "procedure",
  "digest",
  "handoff",
]);

const STRICT_WRITE_CATEGORIES = new Set<MemoryCategory>([
  "convention",
  "pattern",
  "gotcha",
  "decision",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeScope(scope: MemoryScope): UnifiedMemoryScope {
  if (scope === "agent" || scope === "project" || scope === "mission") return scope;
  if (scope === "user") return "agent";
  if (scope === "lane") return "mission";
  return "project";
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "candidate" || s === "promoted" || s === "archived") return s;
  return "promoted";
}

function normalizeMemoryImportance(value: unknown): MemoryImportance {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}

function normalizeMemoryTier(value: unknown, fallback: MemoryTier): MemoryTier {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return fallback;
}

function normalizeSourceType(value: unknown): MemorySourceType {
  const s = String(value ?? "").trim();
  if (s === "agent" || s === "system" || s === "user" || s === "mission_promotion" || s === "consolidation") return s;
  return "agent";
}

function normalizeScopeOwnerId(scope: UnifiedMemoryScope, scopeOwnerId?: string | null): string | null {
  if (scope === "project") return null;
  const value = String(scopeOwnerId ?? "").trim();
  if (!value.length) return null;
  return value;
}

function normalizeMemoryForDedup(content: string): string {
  return String(content ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeForSimilarity(content: string): string[] {
  return normalizeMemoryForDedup(content)
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenizeForSimilarity(left));
  const rightTokens = new Set(tokenizeForSimilarity(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
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

function resolveHigherStatus(left: MemoryStatus, right: MemoryStatus): MemoryStatus {
  return memoryStatusRank(left) >= memoryStatusRank(right) ? left : right;
}

function resolveHigherTier(left: MemoryTier, right: MemoryTier): MemoryTier {
  // Tier 1 (pinned) is highest precedence, then Tier 2, then Tier 3.
  return Math.min(left, right) as MemoryTier;
}

function seedAccessScore(importance: MemoryImportance, confidence: number): number {
  const importanceScore = importance === "high" ? 1 : importance === "medium" ? 0.6 : 0.3;
  return clamp01(Math.max(importanceScore, confidence));
}

function mergeMemoryContent(existing: string, incoming: string): string {
  const normalizedExisting = normalizeMemoryForDedup(existing);
  const normalizedIncoming = normalizeMemoryForDedup(incoming);

  if (!normalizedExisting.length) return incoming;
  if (!normalizedIncoming.length) return existing;

  if (normalizedExisting === normalizedIncoming) return existing;
  if (normalizedExisting.includes(normalizedIncoming)) return existing;
  if (normalizedIncoming.includes(normalizedExisting)) return incoming;

  return `${existing.trim()}\n${incoming.trim()}`;
}

function computeRecencyScore(lastAccessedAt: string, updatedAt: string): number {
  const source = lastAccessedAt || updatedAt;
  const ts = Date.parse(source);
  if (!Number.isFinite(ts)) return 0.25;
  const ageMs = Math.max(0, Date.now() - ts);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / 30);
}

function computeQueryScore(content: string, query: string): number {
  const normalizedQuery = normalizeMemoryForDedup(query);
  if (!normalizedQuery.length) return 0.5;

  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  if (!words.length) return 0.5;

  const normalizedContent = normalizeMemoryForDedup(content);
  let matched = 0;
  for (const word of words) {
    if (normalizedContent.includes(word)) matched += 1;
  }

  const wordCoverage = matched / words.length;
  const phraseBonus = normalizedContent.includes(normalizedQuery) ? 0.15 : 0;
  return clamp01(wordCoverage + phraseBonus);
}

function computeCompositeScore(memory: Memory, queryScore: number): number {
  const importanceWeight =
    memory.importance === "high" ? 1 : memory.importance === "medium" ? 0.6 : 0.3;
  const recencyScore = computeRecencyScore(memory.lastAccessedAt, memory.updatedAt);
  const accessScore = Math.min(Math.max(memory.accessCount, 0) / 10, 1);
  const tierBoost = memory.tier === 1 ? 0.15 : memory.tier === 2 ? 0.05 : -0.05;
  const pinBoost = memory.pinned ? 0.1 : 0;

  const composite =
    0.4 * clamp01(queryScore) +
    0.2 * recencyScore +
    0.15 * importanceWeight +
    0.15 * clamp01(memory.confidence) +
    0.1 * accessScore +
    tierBoost +
    pinBoost;

  if (!Number.isFinite(composite)) return 0;
  return Math.max(0, composite);
}

function mapMemoryRow(row: Record<string, unknown>): Memory {
  const scope = normalizeScope(String(row.scope ?? "project") as MemoryScope);
  const pinned = Number(row.pinned ?? 0) === 1;
  const tier = normalizeMemoryTier(row.tier, pinned ? 1 : 2);

  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    scope,
    scopeOwnerId: row.scope_owner_id ? String(row.scope_owner_id) : null,
    tier,
    category: String(row.category ?? "fact") as MemoryCategory,
    content: String(row.content ?? ""),
    importance: normalizeMemoryImportance(row.importance),
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    sourcePackKey: row.source_pack_key ? String(row.source_pack_key) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? row.created_at ?? ""),
    lastAccessedAt: String(row.last_accessed_at ?? ""),
    accessCount: Number(row.access_count ?? 0),
    observationCount: Number(row.observation_count ?? 1),
    status: normalizeMemoryStatus(row.status),
    agentId: row.agent_id ? String(row.agent_id) : null,
    confidence: clamp01(Number(row.confidence ?? 1)),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    sourceType: normalizeSourceType(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    fileScopePattern: row.file_scope_pattern ? String(row.file_scope_pattern) : null,
    pinned: pinned || tier === 1,
    accessScore: Number(row.access_score ?? row.composite_score ?? 0),
    compositeScore: Number(row.composite_score ?? 0),
    writeGateReason: row.write_gate_reason ? String(row.write_gate_reason) : null,
    embedded: row.embedded === true || Number(row.embedded ?? 0) === 1 || row.embedding_blob != null,
  };
}

export type UnifiedMemoryService = ReturnType<typeof createUnifiedMemoryService>;

export function createUnifiedMemoryService(db: AdeDb, serviceOpts: CreateUnifiedMemoryServiceOpts = {}) {
  const notifyMutation = () => {
    try {
      serviceOpts.onMemoryMutated?.();
    } catch {
      // Mutation side-effects are best-effort and must not break memory writes.
    }
  };

  const notifyMemoryUpserted = (event: MemoryUpsertEvent) => {
    try {
      serviceOpts.onMemoryUpserted?.(event);
    } catch {
      // Embedding / observer hooks are best-effort and must not break memory writes.
    }
  };

  function readById(id: string): Memory | null {
    const row = db.get<Record<string, unknown>>(
      `SELECT * FROM unified_memories WHERE id = ? LIMIT 1`,
      [id]
    );
    return row ? mapMemoryRow(row) : null;
  }

  function updateAccessStats(id: string, compositeScore?: number) {
    const now = new Date().toISOString();
    if (typeof compositeScore === "number" && Number.isFinite(compositeScore)) {
      db.run(
        `
          UPDATE unified_memories
          SET access_count = access_count + 1,
              last_accessed_at = ?,
              updated_at = ?,
              access_score = CASE
                WHEN COALESCE(access_score, 0) > ? THEN COALESCE(access_score, 0)
                ELSE ?
              END,
              composite_score = ?
          WHERE id = ?
        `,
        [now, now, compositeScore, compositeScore, compositeScore, id]
      );
      return;
    }

    db.run(
      `
        UPDATE unified_memories
        SET access_count = access_count + 1,
            last_accessed_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [now, now, id]
    );
  }

  function evaluateWriteGate(args: {
    projectId: string;
    scope: UnifiedMemoryScope;
    scopeOwnerId: string | null;
    category: MemoryCategory;
    content: string;
    importance: MemoryImportance;
    mode: WriteGateMode;
  }): {
    accepted: boolean;
    reason?: string;
    content: string;
    dedupeKey: string;
    duplicateId?: string;
    nearDuplicateId?: string;
  } {
    const trimmed = String(args.content ?? "").trim();
    if (!trimmed.length) {
      return {
        accepted: false,
        reason: "memory content is empty",
        content: "",
        dedupeKey: "",
      };
    }

    if (!CATEGORY_ALLOWLIST.has(args.category)) {
      return {
        accepted: false,
        reason: `category '${args.category}' is not allowed`,
        content: trimmed,
        dedupeKey: normalizeMemoryForDedup(trimmed),
      };
    }

    if (args.mode === "strict") {
      if (args.importance !== "high") {
        return {
          accepted: false,
          reason: "strict mode requires high importance",
          content: trimmed,
          dedupeKey: normalizeMemoryForDedup(trimmed),
        };
      }
      if (!STRICT_WRITE_CATEGORIES.has(args.category)) {
        return {
          accepted: false,
          reason: "strict mode only allows convention/pattern/gotcha/decision",
          content: trimmed,
          dedupeKey: normalizeMemoryForDedup(trimmed),
        };
      }
    }

    const bounded = trimmed.slice(0, 2000);
    const dedupeKey = normalizeMemoryForDedup(bounded);

    const candidates = db.all<Record<string, unknown>>(
      `
        SELECT id, content, dedupe_key
        FROM unified_memories
        WHERE project_id = ?
          AND scope = ?
          AND COALESCE(scope_owner_id, '') = ?
          AND status != 'archived'
          AND tier IN (1, 2)
        ORDER BY updated_at DESC
        LIMIT 120
      `,
      [args.projectId, args.scope, args.scopeOwnerId ?? ""]
    );

    let nearDuplicate: { id: string; score: number } | null = null;
    for (const row of candidates) {
      const rowId = String(row.id ?? "").trim();
      if (!rowId.length) continue;
      const rowContent = String(row.content ?? "");
      const rowDedupe = String(row.dedupe_key ?? "") || normalizeMemoryForDedup(rowContent);

      if (rowDedupe.length > 0 && rowDedupe === dedupeKey) {
        return {
          accepted: true,
          content: bounded,
          dedupeKey,
          duplicateId: rowId,
        };
      }

      const score = lexicalSimilarity(rowContent, bounded);
      if (score >= 0.85 && (!nearDuplicate || score > nearDuplicate.score)) {
        nearDuplicate = { id: rowId, score };
      }
    }

    if (nearDuplicate) {
      return {
        accepted: true,
        content: bounded,
        dedupeKey,
        nearDuplicateId: nearDuplicate.id,
      };
    }

    return {
      accepted: true,
      content: bounded,
      dedupeKey,
    };
  }

  function upsertFromWrite(opts: {
    projectId: string;
    scope: UnifiedMemoryScope;
    scopeOwnerId: string | null;
    tier: MemoryTier;
    category: MemoryCategory;
    content: string;
    importance: MemoryImportance;
    confidence: number;
    status: MemoryStatus;
    pinned: boolean;
    sourceSessionId?: string;
    sourcePackKey?: string;
    agentId?: string;
    sourceRunId?: string;
    sourceType: MemorySourceType;
    sourceId?: string;
    fileScopePattern?: string;
    writeGateMode: WriteGateMode;
  }): WriteMemoryResult {
    const now = new Date().toISOString();
    const gate = evaluateWriteGate({
      projectId: opts.projectId,
      scope: opts.scope,
      scopeOwnerId: opts.scopeOwnerId,
      category: opts.category,
      content: opts.content,
      importance: opts.importance,
      mode: opts.writeGateMode,
    });

    if (!gate.accepted) {
      return {
        accepted: false,
        reason: gate.reason ?? "write gate rejected memory",
      };
    }

    const duplicateId = gate.duplicateId ?? gate.nearDuplicateId;
    if (duplicateId) {
      const existing = readById(duplicateId);
      if (!existing) {
        return {
          accepted: false,
          reason: "write gate duplicate target not found",
        };
      }

      const mergedContent = gate.duplicateId
        ? existing.content
        : mergeMemoryContent(existing.content, gate.content);
      const nextImportance = resolveHigherImportance(existing.importance, opts.importance);
      const nextStatus = resolveHigherStatus(existing.status, opts.status);
      const nextTier = opts.pinned || existing.pinned
        ? 1
        : resolveHigherTier(existing.tier, opts.tier);
      const nextPinned = opts.pinned || existing.pinned || nextTier === 1;
      const nextObservationCount = Math.max(1, existing.observationCount) + 1;
      const boostedConfidence = clamp01(Math.max(existing.confidence, opts.confidence) + 0.05);
      const nextAccessScore = Math.max(existing.accessScore, seedAccessScore(nextImportance, boostedConfidence));
      const promotedAt = nextStatus === "promoted"
        ? existing.promotedAt ?? now
        : null;

      db.run(
        `
          UPDATE unified_memories
          SET category = ?,
              content = ?,
              importance = ?,
              confidence = ?,
              observation_count = ?,
              status = ?,
              tier = ?,
              pinned = ?,
              source_session_id = COALESCE(?, source_session_id),
              source_pack_key = COALESCE(?, source_pack_key),
              source_run_id = COALESCE(?, source_run_id),
              source_type = COALESCE(?, source_type),
              source_id = COALESCE(?, source_id),
              file_scope_pattern = COALESCE(?, file_scope_pattern),
              agent_id = COALESCE(?, agent_id),
              access_score = ?,
              promoted_at = ?,
              dedupe_key = ?,
              write_gate_reason = ?,
              updated_at = ?,
              access_count = access_count + 1,
              last_accessed_at = ?
          WHERE id = ?
        `,
        [
          opts.category,
          mergedContent,
          nextImportance,
          boostedConfidence,
          nextObservationCount,
          nextStatus,
          nextTier,
          nextPinned ? 1 : 0,
          opts.sourceSessionId ?? null,
          opts.sourcePackKey ?? null,
          opts.sourceRunId ?? null,
          opts.sourceType,
          opts.sourceId ?? null,
          opts.fileScopePattern ?? null,
          opts.agentId ?? null,
          nextAccessScore,
          promotedAt,
          gate.dedupeKey,
          gate.duplicateId ? "duplicate" : "near_duplicate",
          now,
          now,
          duplicateId,
        ]
      );

      const updated = readById(duplicateId);
      if (!updated) {
        return {
          accepted: false,
          reason: "failed to read updated memory",
        };
      }

      notifyMutation();
      notifyMemoryUpserted({
        memory: updated,
        created: false,
        deduped: true,
        mergedIntoId: duplicateId,
        contentChanged: updated.content !== existing.content,
      });

      return {
        accepted: true,
        memory: updated,
        deduped: true,
        mergedIntoId: duplicateId,
      };
    }

    const id = randomUUID();
    const pinned = opts.pinned || opts.tier === 1;
    const tier: MemoryTier = pinned ? 1 : opts.tier;
    const accessScore = seedAccessScore(opts.importance, opts.confidence);
    const promotedAt = opts.status === "promoted" ? now : null;

    db.run(
      `
        INSERT INTO unified_memories (
          id,
          project_id,
          scope,
          scope_owner_id,
          tier,
          category,
          content,
          importance,
          confidence,
          observation_count,
          status,
          source_type,
          source_id,
          source_session_id,
          source_pack_key,
          source_run_id,
          file_scope_pattern,
          agent_id,
          pinned,
          access_score,
          composite_score,
          write_gate_reason,
          dedupe_key,
          created_at,
          updated_at,
          last_accessed_at,
          access_count,
          promoted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, 0, ?
        )
      `,
      [
        id,
        opts.projectId,
        opts.scope,
        opts.scopeOwnerId,
        tier,
        opts.category,
        gate.content,
        opts.importance,
        clamp01(opts.confidence),
        opts.status,
        opts.sourceType,
        opts.sourceId ?? null,
        opts.sourceSessionId ?? null,
        opts.sourcePackKey ?? null,
        opts.sourceRunId ?? null,
        opts.fileScopePattern ?? null,
        opts.agentId ?? null,
        pinned ? 1 : 0,
        accessScore,
        gate.dedupeKey,
        now,
        now,
        now,
        promotedAt,
      ]
    );

    const inserted = readById(id);
    if (!inserted) {
      return {
        accepted: false,
        reason: "failed to read inserted memory",
      };
    }

    notifyMutation();
    notifyMemoryUpserted({
      memory: inserted,
      created: true,
      deduped: false,
      contentChanged: true,
    });

    return {
      accepted: true,
      memory: inserted,
      deduped: false,
    };
  }

  function writeMemory(opts: WriteMemoryOpts): WriteMemoryResult {
    const scope = normalizeScope(opts.scope);
    const scopeOwnerId = normalizeScopeOwnerId(scope, opts.scopeOwnerId);
    const status = normalizeMemoryStatus(opts.status ?? "promoted");
    const pinned = opts.pinned === true || opts.tier === 1;
    const tier = normalizeMemoryTier(opts.tier, status === "candidate" || status === "archived" ? 3 : 2);
    const importance = normalizeMemoryImportance(opts.importance ?? "medium");
    const confidence = clamp01(opts.confidence ?? (status === "candidate" ? 0.5 : 1));

    return upsertFromWrite({
      projectId: opts.projectId,
      scope,
      scopeOwnerId,
      tier,
      category: opts.category,
      content: opts.content,
      importance,
      confidence,
      status,
      pinned,
      sourceSessionId: opts.sourceSessionId,
      sourcePackKey: opts.sourcePackKey,
      agentId: opts.agentId,
      sourceRunId: opts.sourceRunId,
      sourceType: opts.sourceType ?? "agent",
      sourceId: opts.sourceId,
      fileScopePattern: opts.fileScopePattern,
      writeGateMode: opts.writeGateMode ?? "default",
    });
  }

  function addMemory(opts: AddMemoryOpts): Memory {
    const result = writeMemory({
      ...opts,
      status: "promoted",
      tier: 2,
      confidence: 1,
      sourceType: opts.sourceType ?? "agent",
      writeGateMode: opts.writeGateMode ?? "default",
    });

    if (!result.accepted || !result.memory) {
      throw new Error(result.reason ?? "failed to save promoted memory");
    }

    return result.memory;
  }

  function addCandidateMemory(opts: AddCandidateMemoryOpts): Memory {
    const result = writeMemory({
      ...opts,
      status: "candidate",
      tier: 3,
      confidence: clamp01(opts.confidence ?? 0.5),
      sourceType: opts.sourceType ?? "agent",
      writeGateMode: opts.writeGateMode ?? "default",
    });

    if (!result.accepted || !result.memory) {
      throw new Error(result.reason ?? "failed to save candidate memory");
    }

    return result.memory;
  }

  function promoteMemory(id: string): void {
    const now = new Date().toISOString();
    db.run(
      `
        UPDATE unified_memories
        SET status = 'promoted',
            tier = CASE WHEN pinned = 1 THEN 1 ELSE 2 END,
            promoted_at = COALESCE(promoted_at, ?),
            updated_at = ?
        WHERE id = ?
      `,
      [now, now, id]
    );
    notifyMutation();
  }

  function archiveMemory(id: string): void {
    const now = new Date().toISOString();
    db.run(
      `
        UPDATE unified_memories
        SET status = 'archived',
            tier = 3,
            pinned = 0,
            updated_at = ?
        WHERE id = ?
      `,
      [now, id]
    );
    notifyMutation();
  }

  function pinMemory(id: string): Memory | null {
    const now = new Date().toISOString();
    db.run(
      `
        UPDATE unified_memories
        SET pinned = 1,
            tier = 1,
            updated_at = ?
        WHERE id = ?
          AND status != 'archived'
      `,
      [now, id]
    );
    notifyMutation();
    return readById(id);
  }

  function unpinMemory(id: string): Memory | null {
    const now = new Date().toISOString();
    db.run(
      `
        UPDATE unified_memories
        SET pinned = 0,
            tier = CASE
              WHEN status = 'archived' THEN 3
              WHEN status = 'candidate' THEN 3
              ELSE 2
            END,
            updated_at = ?
        WHERE id = ?
      `,
      [now, id]
    );
    notifyMutation();
    return readById(id);
  }

  function getCandidateMemories(projectId: string, limit = 20): Memory[] {
    const rows = db.all<Record<string, unknown>>(
      `
        SELECT m.*, EXISTS(
          SELECT 1
          FROM unified_memory_embeddings e
          WHERE e.memory_id = m.id
        ) AS embedded
        FROM unified_memories m
        WHERE m.project_id = ?
          AND m.status = 'candidate'
        ORDER BY confidence DESC, observation_count DESC, created_at DESC
        LIMIT ?
      `,
      [projectId, limit]
    );
    return rows.map(mapMemoryRow);
  }

  function searchLexical(opts: SearchMemoryOpts): Memory[] {
    const statusList = Array.isArray(opts.status)
      ? [...opts.status]
      : opts.status
        ? [opts.status]
        : ["promoted"];

    const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
    const words = normalizeMemoryForDedup(opts.query).split(/\s+/).filter(Boolean);
    const params: Array<string | number | null> = [opts.projectId];

    let sql = `
      SELECT m.*, EXISTS(
        SELECT 1
        FROM unified_memory_embeddings e
        WHERE e.memory_id = m.id
      ) AS embedded
      FROM unified_memories m
      WHERE m.project_id = ?
    `;

    if (opts.scope) {
      sql += ` AND m.scope = ?`;
      params.push(opts.scope);
    }

    if (opts.scopeOwnerId !== undefined) {
      sql += ` AND COALESCE(m.scope_owner_id, '') = ?`;
      params.push(String(opts.scopeOwnerId ?? ""));
    }

    if (statusList.length > 0) {
      sql += ` AND m.status IN (${statusList.map(() => "?").join(",")})`;
      params.push(...statusList);
    }

    if (opts.tiers?.length) {
      sql += ` AND m.tier IN (${opts.tiers.map(() => "?").join(",")})`;
      params.push(...opts.tiers);
    }

    if (words.length > 0) {
      const contentFilters = words.map(() => `LOWER(m.content) LIKE ?`).join(" AND ");
      sql += ` AND ${contentFilters}`;
      for (const word of words) {
        params.push(`%${word}%`);
      }
    }

    const fetchLimit = limit * 4;
    sql += ` ORDER BY m.pinned DESC, m.tier ASC, m.updated_at DESC LIMIT ?`;
    params.push(fetchLimit);

    const rows = db.all<Record<string, unknown>>(sql, params);
    const scored = rows
      .map(mapMemoryRow)
      .map((entry) => {
        const queryScore = computeQueryScore(entry.content, opts.query);
        const compositeScore = computeCompositeScore(entry, queryScore);
        return {
          ...entry,
          compositeScore,
        };
      })
      .sort((left, right) => {
        if (right.compositeScore !== left.compositeScore) {
          return right.compositeScore - left.compositeScore;
        }
        if (left.tier !== right.tier) return left.tier - right.tier;
        return String(right.lastAccessedAt).localeCompare(String(left.lastAccessedAt));
      })
      .slice(0, limit);

    return scored;
  }

  async function searchHybrid(opts: SearchMemoryOpts): Promise<Memory[] | null> {
    const normalizedQuery = normalizeMemoryForDedup(opts.query);
    if (!normalizedQuery.length || !serviceOpts.hybridSearchService) return null;

    const statusList = Array.isArray(opts.status)
      ? [...opts.status]
      : opts.status
        ? [opts.status]
        : ["promoted"];

    try {
      const hits = await serviceOpts.hybridSearchService.search({
        query: opts.query,
        projectId: opts.projectId,
        scope: opts.scope,
        scopeOwnerId: opts.scopeOwnerId,
        limit: opts.limit,
        status: statusList,
        tiers: opts.tiers,
      });

      return hits.map((hit): Memory => ({
        ...hit.memory,
        compositeScore: hit.compositeScore,
      }));
    } catch {
      return null;
    }
  }

  async function search(opts: SearchMemoryOpts): Promise<Memory[]> {
    const scored = opts.mode === "lexical"
      ? searchLexical(opts)
      : (await searchHybrid(opts)) ?? searchLexical(opts);

    for (const entry of scored) {
      updateAccessStats(entry.id, entry.compositeScore);
    }

    return scored;
  }

  async function searchAcrossScopeOwners(opts: SearchMemoryOpts & { scopeOwnerIds: ReadonlyArray<string | null> }): Promise<Memory[]> {
    const ownerIds = [...new Set(opts.scopeOwnerIds.map((value) => String(value ?? "").trim()))];
    if (!ownerIds.length) {
      return await search({ ...opts, scopeOwnerId: null });
    }

    const merged = new Map<string, Memory>();
    for (const ownerId of ownerIds) {
      const hits = await search({
        ...opts,
        scopeOwnerId: ownerId.length ? ownerId : null,
        limit: Math.max(opts.limit ?? 10, 20),
      });
      for (const hit of hits) {
        const existing = merged.get(hit.id);
        if (!existing || hit.compositeScore > existing.compositeScore) {
          merged.set(hit.id, hit);
        }
      }
    }

    return [...merged.values()]
      .sort((left, right) => {
        if (right.compositeScore !== left.compositeScore) {
          return right.compositeScore - left.compositeScore;
        }
        if (left.tier !== right.tier) return left.tier - right.tier;
        return String(right.lastAccessedAt).localeCompare(String(left.lastAccessedAt));
      })
      .slice(0, Math.max(1, Math.min(100, opts.limit ?? 10)));
  }

  async function searchMemories(
    query: string,
    projectId: string,
    scope?: MemoryScope,
    limit = 10,
    status: MemoryStatus | ReadonlyArray<MemoryStatus> = "promoted",
    scopeOwnerId?: string | null,
    mode: MemorySearchMode = "hybrid"
  ): Promise<Memory[]> {
    return await search({
      query,
      projectId,
      scope: scope ? normalizeScope(scope) : undefined,
      limit,
      mode,
      status,
      ...(scopeOwnerId !== undefined ? { scopeOwnerId } : {}),
    });
  }

  function getMemoryBudget(
    projectId: string,
    level: MemoryBudgetLevel,
    opts?: { includeCandidates?: boolean; scope?: MemoryScope; scopeOwnerId?: string | null }
  ): Memory[] {
    const limits: Record<MemoryBudgetLevel, number> = {
      lite: 3,
      standard: 8,
      deep: 20,
    };

    const includeCandidates = opts?.includeCandidates === true;
    const status = includeCandidates
      ? (["promoted", "candidate"] as MemoryStatus[])
      : "promoted";

    return searchLexical({
      projectId,
      query: "",
      limit: limits[level],
      status,
      tiers: [1, 2, 3],
      ...(opts?.scope ? { scope: normalizeScope(opts.scope) } : {}),
      ...(opts?.scopeOwnerId !== undefined ? { scopeOwnerId: opts.scopeOwnerId } : {}),
    });
  }

  function listMemories(opts: ListMemoriesOpts): Memory[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const statuses = Array.isArray(opts.status)
      ? [...opts.status]
      : opts.status
        ? [opts.status]
        : undefined;
    const scopeOwnerIds = opts.scopeOwnerIds != null
      ? [...new Set(opts.scopeOwnerIds.map((value) => String(value ?? "").trim()))]
      : opts.scopeOwnerId !== undefined
        ? [String(opts.scopeOwnerId ?? "").trim()]
        : [];
    const sourceTypes = Array.isArray(opts.sourceType)
      ? [...opts.sourceType]
      : opts.sourceType
        ? [opts.sourceType]
        : undefined;

    const params: Array<string | number | null> = [opts.projectId];
    let sql = `
      SELECT m.*, EXISTS(
        SELECT 1
        FROM unified_memory_embeddings e
        WHERE e.memory_id = m.id
      ) AS embedded
      FROM unified_memories m
      WHERE m.project_id = ?
    `;

    if (opts.scope) {
      sql += ` AND m.scope = ?`;
      params.push(opts.scope);
    }

    if (scopeOwnerIds.length > 0) {
      sql += ` AND COALESCE(m.scope_owner_id, '') IN (${scopeOwnerIds.map(() => "?").join(",")})`;
      params.push(...scopeOwnerIds);
    }

    if (statuses?.length) {
      sql += ` AND m.status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }

    if (opts.categories?.length) {
      sql += ` AND m.category IN (${opts.categories.map(() => "?").join(",")})`;
      params.push(...opts.categories);
    }

    if (opts.tiers?.length) {
      sql += ` AND m.tier IN (${opts.tiers.map(() => "?").join(",")})`;
      params.push(...opts.tiers);
    }

    if (opts.sourceRunId !== undefined) {
      sql += ` AND COALESCE(m.source_run_id, '') = ?`;
      params.push(String(opts.sourceRunId ?? ""));
    }

    if (sourceTypes?.length) {
      sql += ` AND m.source_type IN (${sourceTypes.map(() => "?").join(",")})`;
      params.push(...sourceTypes);
    }

    if (opts.sourceId !== undefined) {
      sql += ` AND COALESCE(m.source_id, '') = ?`;
      params.push(String(opts.sourceId ?? ""));
    }

    sql += ` ORDER BY m.pinned DESC, m.tier ASC, m.updated_at DESC LIMIT ?`;
    params.push(limit);

    return db.all<Record<string, unknown>>(sql, params).map(mapMemoryRow);
  }

  return {
    writeMemory,
    getMemory: readById,
    listMemories,
    search,
    searchAcrossScopeOwners,
    addMemory,
    addCandidateMemory,
    promoteMemory,
    archiveMemory,
    pinMemory,
    unpinMemory,
    getCandidateMemories,
    searchMemories,
    getMemoryBudget,
  };
}
