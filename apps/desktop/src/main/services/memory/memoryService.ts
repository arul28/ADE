import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { createHybridSearchService } from "./hybridSearchService";

export type MemoryScope = "project" | "agent" | "mission";
export type MemoryWriteScope = MemoryScope | "user" | "lane";

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

type CreateMemoryServiceOpts = {
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
  scope: MemoryScope;
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
  scope: MemoryWriteScope;
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
  scope?: MemoryWriteScope;
  scopeOwnerId?: string | null;
  limit?: number;
  mode?: MemorySearchMode;
  status?: MemoryStatus | ReadonlyArray<MemoryStatus>;
  tiers?: MemoryTier[];
  recordRetrieval?: boolean;
  recordAccess?: boolean;
  retrievalSourceType?: string;
  retrievalSourceId?: string | null;
  injectedMemoryIds?: ReadonlyArray<string>;
};

export type ListMemoriesOpts = {
  projectId: string;
  scope?: MemoryWriteScope;
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
  scope: MemoryWriteScope;
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

export type MemoryEntityType = "file_path" | "symbol" | "error_signature" | "domain_term";

export type MemoryEntity = {
  id: string;
  projectId: string;
  entityType: MemoryEntityType;
  normalizedValue: string;
  displayValue: string;
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryHealthStats = {
  projectId: string;
  activeMemories: number;
  promotedMemories: number;
  candidateMemories: number;
  archivedMemories: number;
  embeddedMemories: number;
  entityCount: number;
  entityLinkCount: number;
  recentRetrievals: number;
  recentInjectedMemories: number;
  memoriesMissingEntityLinks: number;
};

export type AgentMemoryWritePolicy = {
  status: Extract<MemoryStatus, "candidate" | "promoted">;
  tier: MemoryTier;
  confidence: number;
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

function normalizeScope(scope: MemoryWriteScope): MemoryScope {
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

function normalizeScopeOwnerId(scope: MemoryScope, scopeOwnerId?: string | null): string | null {
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

const MEMORY_QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where", "what", "why", "how",
  "please", "could", "would", "should", "about", "before", "after", "because", "there", "their", "have",
  "has", "had", "are", "was", "were", "been", "being", "you", "your", "our", "out", "not", "but",
]);

function tokenizeMemoryQuery(query: string): string[] {
  const seen = new Set<string>();
  return normalizeMemoryForDedup(query)
    .split(/[^a-z0-9_]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !MEMORY_QUERY_STOP_WORDS.has(word))
    .filter((word) => {
      if (seen.has(word)) return false;
      seen.add(word);
      return true;
    })
    .slice(0, 16);
}

const MEMORY_ENTITY_STOP_WORDS = new Set([
  ...MEMORY_QUERY_STOP_WORDS,
  "always", "before", "after", "because", "changing", "memory", "project", "agent", "agents", "service",
  "tests", "test", "update", "updates", "using", "should", "would", "could", "need", "needs",
]);

const ENTITY_FILE_PATH_RE = /(?:^|\s)(?:\/|\.{1,2}\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s`'",;)]+?\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|go|rs|java|rb|sh|swift|m|mm|c|cc|cpp|h|hpp)(?::\d+)?\b/gi;
const ENTITY_SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)?)`|\b([A-Z][A-Za-z0-9]+(?:Service|Controller|Store|Provider|Renderer|Bridge|Client|Manager|Coordinator|Adapter|Repository|View|Model|Error|Exception))\b/g;
const ENTITY_ERROR_RE = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Failure):\s*[^\n.]{8,140})/g;

function normalizeEntityValue(value: string): string {
  return normalizeMemoryForDedup(value)
    .replace(/["'`]+/g, "")
    .replace(/[.,;:!?)]$/g, "")
    .trim()
    .slice(0, 240);
}

function addEntityCandidate(
  entities: Map<string, { entityType: MemoryEntityType; displayValue: string; source: string; weight: number }>,
  entityType: MemoryEntityType,
  displayValue: string,
  source: string,
  weight: number,
): void {
  const normalizedValue = normalizeEntityValue(displayValue);
  if (normalizedValue.length < 3) return;
  const key = `${entityType}:${normalizedValue}`;
  const existing = entities.get(key);
  if (!existing || weight > existing.weight) {
    entities.set(key, {
      entityType,
      displayValue: displayValue.trim().slice(0, 240),
      source,
      weight,
    });
  }
}

function extractMemoryEntityCandidates(args: {
  content: string;
  fileScopePattern?: string | null;
  max?: number;
}): Array<{ entityType: MemoryEntityType; normalizedValue: string; displayValue: string; source: string; weight: number }> {
  const max = Math.max(1, Math.min(48, args.max ?? 32));
  const sourceText = String(args.content ?? "");
  const entities = new Map<string, { entityType: MemoryEntityType; displayValue: string; source: string; weight: number }>();

  if (args.fileScopePattern?.trim()) {
    addEntityCandidate(entities, "file_path", args.fileScopePattern.trim(), "file_scope", 1);
  }

  ENTITY_FILE_PATH_RE.lastIndex = 0;
  for (const match of sourceText.matchAll(ENTITY_FILE_PATH_RE)) {
    addEntityCandidate(entities, "file_path", String(match[0] ?? "").trim(), "content", 1);
    if (entities.size >= max) break;
  }

  ENTITY_ERROR_RE.lastIndex = 0;
  for (const match of sourceText.matchAll(ENTITY_ERROR_RE)) {
    addEntityCandidate(entities, "error_signature", String(match[1] ?? "").trim(), "content", 0.9);
    if (entities.size >= max) break;
  }

  ENTITY_SYMBOL_RE.lastIndex = 0;
  for (const match of sourceText.matchAll(ENTITY_SYMBOL_RE)) {
    addEntityCandidate(entities, "symbol", String(match[1] ?? match[2] ?? "").trim(), "content", 0.75);
    if (entities.size >= max) break;
  }

  for (const token of normalizeMemoryForDedup(sourceText).split(/[^a-z0-9_.-]+/)) {
    const normalized = token.trim();
    if (normalized.length < 5 || normalized.length > 48) continue;
    if (/^\d+$/.test(normalized) || MEMORY_ENTITY_STOP_WORDS.has(normalized)) continue;
    addEntityCandidate(entities, "domain_term", normalized, "content", 0.35);
    if (entities.size >= max) break;
  }

  return [...entities.entries()].slice(0, max).map(([key, entity]) => ({
    ...entity,
    normalizedValue: key.slice(key.indexOf(":") + 1),
  }));
}

function countMatches(value: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of value.matchAll(pattern)) count += 1;
  return count;
}

function looksLikeRawStackTrace(value: string): boolean {
  if (/Traceback \(most recent call last\):/i.test(value)) return true;
  const atFrames = countMatches(value, /^\s*at\s+.+:\d+:\d+/gm);
  if (atFrames >= 2) return true;
  const exceptionLike = countMatches(value, /(?:^|\n)\s*(?:[A-Z][A-Za-z0-9]+)?(?:Error|Exception|Failure):\s+/gm);
  return exceptionLike >= 2;
}

function looksLikeRawDiffOrCodeDump(value: string): boolean {
  if (/```/m.test(value)) return true;
  if (/^diff --git /m.test(value)) return true;
  if (/^(?:index|@@|\+\+\+|---)\s/m.test(value)) return true;
  return false;
}

function looksLikeSessionSummary(value: string): boolean {
  return /^(?:status|progress|summary|session summary|mission summary|task summary|working on|implemented|fixed|updated|changed|added|removed|renamed|inverted|next steps?)\b/i.test(value.trim());
}

function looksLikeRawGitHistory(value: string): boolean {
  if (/^commit\s+[0-9a-f]{7,40}\b/im.test(value)) return true;
  if (/^(?:author|date):\s/im.test(value)) return true;
  return /^\s*[-*]?\s*[0-9a-f]{7,40}\s+[^\n]+/im.test(value);
}

const PATH_DUMP_LINE_RE = /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)|^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$|\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|go|rs|java|rb|sh)(?::\d+)?$/i;

function looksLikePathDump(value: string): boolean {
  let count = 0;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (line.length > 0 && PATH_DUMP_LINE_RE.test(line)) {
      count += 1;
      if (count >= 3) return true;
    }
  }
  return false;
}

function looksLikeAutomatedReviewOutput(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^\s*>?\s*@(?:copilot|coderabbit(?:ai)?|greptile)\s+review\b/i.test(trimmed)
    || /\bdo not make fixes\b/i.test(trimmed)
    || /^here(?:'|’)s the review\b/i.test(trimmed)
    || /automated review suggestions/i.test(trimmed)
    || /^#{1,6}\s+.*\bCodex Review\b/i.test(trimmed)
    || /!\[[^\]]*\b(?:P[0-3]|priority|severity|badge)\b[^\]]*\]\(/i.test(trimmed)
    || /^\*\*\[[^\]]*\b(?:critical|high|medium|low|investigate|p[0-3])\b[^\]]*\]\*\*/i.test(trimmed)
    || /\bP[0-3]\s+Badge\b/i.test(trimmed)
  );
}

function looksLikePromptQuestion(value: string): boolean {
  const normalized = normalizeMemoryForDedup(value);
  return (
    /^what should .+\?$/.test(normalized)
    || /\bwhat should this test mission accomplish\?/.test(normalized)
  );
}

function rejectCodeDerivableContent(content: string): string | null {
  if (looksLikeAutomatedReviewOutput(content)) {
    return "memory appears to be an automated review command or raw review output";
  }
  if (looksLikePromptQuestion(content)) {
    return "memory appears to be a prompt question, not a durable project memory";
  }
  if (looksLikeRawDiffOrCodeDump(content)) {
    return "memory appears to be a raw diff or code dump";
  }
  if (looksLikeRawStackTrace(content)) {
    return "memory appears to be a raw stack trace without a distilled lesson";
  }
  if (looksLikeSessionSummary(content)) {
    return "memory appears to be a session or progress summary";
  }
  if (looksLikeRawGitHistory(content)) {
    return "memory appears to be raw git history or change log output";
  }
  if (looksLikePathDump(content)) {
    return "memory appears to be a file-path or directory dump";
  }
  return null;
}

export function resolveAgentMemoryWritePolicy(args: {
  pin?: boolean;
  writeGateMode?: WriteGateMode;
}): AgentMemoryWritePolicy {
  const pinned = args.pin === true;
  const strict = args.writeGateMode === "strict";

  return {
    status: pinned || strict ? "promoted" : "candidate",
    tier: pinned ? 1 : strict ? 2 : 3,
    confidence: pinned ? 1 : strict ? 0.9 : 0.6,
  };
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

export type MemoryService = ReturnType<typeof createMemoryService>;

export function createMemoryService(db: AdeDb, serviceOpts: CreateMemoryServiceOpts = {}) {
  let retrievalEventsSincePrune = 0;

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

  function indexMemoryEntities(memory: Memory): void {
    const now = new Date().toISOString();
    const entities = extractMemoryEntityCandidates({
      content: memory.content,
      fileScopePattern: memory.fileScopePattern,
    });
    db.run("DELETE FROM memory_entity_links WHERE memory_id = ?", [memory.id]);
    if (!entities.length || memory.status === "archived") return;

    for (const entity of entities) {
      const existing = db.get<{ id: string; occurrence_count: number }>(
        `
          SELECT id, occurrence_count
          FROM memory_entities
          WHERE project_id = ?
            AND entity_type = ?
            AND normalized_value = ?
          LIMIT 1
        `,
        [memory.projectId, entity.entityType, entity.normalizedValue],
      );
      const entityId = existing?.id ?? randomUUID();
      if (existing) {
        db.run(
          `
            UPDATE memory_entities
            SET display_value = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [entity.displayValue, now, entityId],
        );
      } else {
        db.run(
          `
            INSERT INTO memory_entities (
              id, project_id, entity_type, normalized_value, display_value,
              occurrence_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          `,
          [entityId, memory.projectId, entity.entityType, entity.normalizedValue, entity.displayValue, now, now],
        );
      }

      db.run(
        `
          INSERT OR REPLACE INTO memory_entity_links (
            memory_id, entity_id, project_id, source, weight, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [memory.id, entityId, memory.projectId, entity.source, entity.weight, now],
      );
      db.run(
        `
          UPDATE memory_entities
          SET occurrence_count = (
                SELECT COUNT(*)
                FROM memory_entity_links
                WHERE entity_id = ?
              ),
              updated_at = ?
          WHERE id = ?
        `,
        [entityId, now, entityId],
      );
    }
  }

  function entityMatchesForQuery(query: string): Array<{ entityType: MemoryEntityType; normalizedValue: string; displayValue: string; source: string; weight: number }> {
    return extractMemoryEntityCandidates({ content: query, max: 16 });
  }

  function readEntityMatchedMemories(opts: SearchMemoryOpts, queryEntities: ReturnType<typeof entityMatchesForQuery>): Memory[] {
    if (!queryEntities.length) return [];
    const limit = Math.max(1, Math.min(50, (opts.limit ?? 10) * 4));
    const statusList = Array.isArray(opts.status)
      ? [...opts.status]
      : opts.status
        ? [opts.status]
        : ["promoted"];
    const params: Array<string | number | null> = [];
    let sql = `
      WITH matching_entities AS (
        SELECT id
        FROM memory_entities
        WHERE project_id = ?
          AND (
    `;
    params.push(opts.projectId);
    sql += queryEntities.map(() => "(entity_type = ? AND normalized_value = ?)").join(" OR ");
    for (const entity of queryEntities) {
      params.push(entity.entityType, entity.normalizedValue);
    }
    sql += `
          )
      )
      SELECT m.*, SUM(l.weight) AS entity_match_weight, COUNT(*) AS entity_match_count
      FROM matching_entities e
      JOIN memory_entity_links l
        ON l.entity_id = e.id
       AND l.project_id = ?
      JOIN unified_memories m
        ON m.id = l.memory_id
      WHERE m.project_id = ?
        AND m.status != 'archived'
    `;
    params.push(opts.projectId, opts.projectId);

    if (opts.scope) {
      sql += " AND m.scope = ?";
      params.push(normalizeScope(opts.scope));
    }
    if (opts.scopeOwnerId !== undefined) {
      sql += " AND COALESCE(m.scope_owner_id, '') = ?";
      params.push(String(opts.scopeOwnerId ?? ""));
    }
    if (statusList.length) {
      sql += ` AND m.status IN (${statusList.map(() => "?").join(",")})`;
      params.push(...statusList);
    }
    if (opts.tiers?.length) {
      sql += ` AND m.tier IN (${opts.tiers.map(() => "?").join(",")})`;
      params.push(...opts.tiers);
    }

    sql += `
      GROUP BY m.id
      ORDER BY entity_match_weight DESC, entity_match_count DESC, m.pinned DESC, m.tier ASC, m.updated_at DESC
      LIMIT ?
    `;
    params.push(limit);

    return db.all<Record<string, unknown>>(sql, params).map((row) => ({
      ...mapMemoryRow(row),
      compositeScore: Math.max(
        Number(row.composite_score ?? 0),
        0.45 + Math.min(0.35, Number(row.entity_match_weight ?? 0) * 0.08),
      ),
    }));
  }

  function applyEntityAugmentation(opts: SearchMemoryOpts, base: Memory[], queryEntities: ReturnType<typeof entityMatchesForQuery>): Memory[] {
    if (!queryEntities.length) return base;
    const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
    const merged = new Map<string, Memory>();
    for (const memory of base) {
      merged.set(memory.id, memory);
    }
    for (const memory of readEntityMatchedMemories(opts, queryEntities)) {
      const existing = merged.get(memory.id);
      if (!existing || memory.compositeScore > existing.compositeScore) {
        merged.set(memory.id, memory);
      }
    }
    return [...merged.values()]
      .sort((left, right) => {
        if (right.compositeScore !== left.compositeScore) return right.compositeScore - left.compositeScore;
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.tier !== right.tier) return left.tier - right.tier;
        return String(right.lastAccessedAt).localeCompare(String(left.lastAccessedAt));
      })
      .slice(0, limit);
  }

  function recordRetrievalEvent(args: {
    opts: SearchMemoryOpts;
    memories: Memory[];
    queryEntities: ReturnType<typeof entityMatchesForQuery>;
    durationMs: number;
  }): void {
    if (args.opts.recordRetrieval !== true) return;
    const query = String(args.opts.query ?? "").trim();
    if (!query.length) return;
    const now = new Date().toISOString();
    const injectedMemoryIds = [...new Set(args.opts.injectedMemoryIds ?? [])].filter(Boolean).slice(0, 20);
    try {
      db.run(
        `
          INSERT INTO memory_retrieval_ledger (
            id,
            project_id,
            query,
            scope,
            scope_owner_id,
            mode,
            status_filter_json,
            tier_filter_json,
            source_type,
            source_id,
            result_count,
            injected_count,
            top_memory_ids_json,
            injected_memory_ids_json,
            entity_matches_json,
            duration_ms,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          args.opts.projectId,
          query.slice(0, 500),
          args.opts.scope ? normalizeScope(args.opts.scope) : null,
          args.opts.scopeOwnerId ?? null,
          args.opts.mode ?? "hybrid",
          JSON.stringify(args.opts.status ?? "promoted"),
          JSON.stringify(args.opts.tiers ?? null),
          String(args.opts.retrievalSourceType ?? "service").slice(0, 80),
          args.opts.retrievalSourceId ? String(args.opts.retrievalSourceId).slice(0, 160) : null,
          args.memories.length,
          injectedMemoryIds.length,
          JSON.stringify(args.memories.slice(0, 10).map((memory) => memory.id)),
          JSON.stringify(injectedMemoryIds),
          JSON.stringify(args.queryEntities.map((entity) => ({
            type: entity.entityType,
            value: entity.normalizedValue,
          }))),
          Math.max(0, Math.floor(args.durationMs)),
          now,
        ],
      );
      retrievalEventsSincePrune += 1;
      if (retrievalEventsSincePrune >= 50) {
        const ledgerCount = db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM memory_retrieval_ledger WHERE project_id = ?",
          [args.opts.projectId],
        )?.count ?? 0;
        if (ledgerCount > 600) {
          db.run(
            `
              DELETE FROM memory_retrieval_ledger
              WHERE project_id = ?
                AND id NOT IN (
                  SELECT id
                  FROM memory_retrieval_ledger
                  WHERE project_id = ?
                  ORDER BY created_at DESC
                  LIMIT 500
                )
            `,
            [args.opts.projectId, args.opts.projectId],
          );
        }
        retrievalEventsSincePrune = 0;
      }
    } catch {
      // Retrieval telemetry must never make memory search fail.
    }
  }

  function updateAccessStats(id: string, compositeScore?: number) {
    const now = new Date().toISOString();
    if (typeof compositeScore === "number" && Number.isFinite(compositeScore)) {
      db.run(
        `
          INSERT INTO memory_access_stats (
            memory_id,
            project_id,
            access_count,
            last_accessed_at,
            access_score,
            composite_score,
            updated_at
          )
          SELECT id, project_id, 1, ?, ?, ?, ?
          FROM unified_memories
          WHERE id = ?
          ON CONFLICT(memory_id) DO UPDATE SET
            access_count = access_count + 1,
            last_accessed_at = excluded.last_accessed_at,
            access_score = CASE
              WHEN COALESCE(memory_access_stats.access_score, 0) > excluded.access_score
                THEN COALESCE(memory_access_stats.access_score, 0)
              ELSE excluded.access_score
            END,
            composite_score = excluded.composite_score,
            updated_at = excluded.updated_at
        `,
        [now, compositeScore, compositeScore, now, id]
      );
      return;
    }

    db.run(
      `
        INSERT INTO memory_access_stats (
          memory_id,
          project_id,
          access_count,
          last_accessed_at,
          updated_at
        )
        SELECT id, project_id, 1, ?, ?
        FROM unified_memories
        WHERE id = ?
        ON CONFLICT(memory_id) DO UPDATE SET
          access_count = access_count + 1,
          last_accessed_at = excluded.last_accessed_at,
          updated_at = excluded.updated_at
      `,
      [now, now, id]
    );
  }

  function evaluateWriteGate(args: {
    projectId: string;
    scope: MemoryScope;
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

    const derivableReason = rejectCodeDerivableContent(trimmed);
    if (derivableReason) {
      return {
        accepted: false,
        reason: derivableReason,
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
    scope: MemoryScope;
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

      indexMemoryEntities(updated);
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

    indexMemoryEntities(inserted);
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
    const promoted = readById(id);
    if (promoted) indexMemoryEntities(promoted);
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
    db.run("DELETE FROM memory_entity_links WHERE memory_id = ?", [id]);
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
    const words = tokenizeMemoryQuery(opts.query);
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
      const contentFilters = words.map(() => `LOWER(m.content) LIKE ?`).join(" OR ");
      sql += ` AND (${contentFilters})`;
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
        scope: opts.scope ? normalizeScope(opts.scope) : undefined,
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
    const startedAt = Date.now();
    const queryEntities = entityMatchesForQuery(opts.query);
    const base = opts.mode === "lexical"
      ? searchLexical(opts)
      : (await searchHybrid(opts)) ?? searchLexical(opts);
    const scored = applyEntityAugmentation(opts, base, queryEntities);

    if (opts.recordAccess === true) {
      for (const entry of scored) {
        updateAccessStats(entry.id, entry.compositeScore);
      }
    }

    recordRetrievalEvent({
      opts,
      memories: scored,
      queryEntities,
      durationMs: Date.now() - startedAt,
    });

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
    mode: MemorySearchMode = "hybrid",
    extra?: Pick<SearchMemoryOpts, "recordRetrieval" | "recordAccess" | "retrievalSourceType" | "retrievalSourceId" | "injectedMemoryIds">
  ): Promise<Memory[]> {
    return await search({
      query,
      projectId,
      scope: scope ? normalizeScope(scope) : undefined,
      limit,
      mode,
      status,
      ...(scopeOwnerId !== undefined ? { scopeOwnerId } : {}),
      ...(extra ?? {}),
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

  function reindexMemoryEntities(projectId: string, limit = 500): { indexedMemories: number; entityCount: number; entityLinkCount: number } {
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const memories = db.all<Record<string, unknown>>(
      `
        SELECT *
        FROM unified_memories
        WHERE project_id = ?
          AND status != 'archived'
        ORDER BY pinned DESC, tier ASC, updated_at DESC
        LIMIT ?
      `,
      [projectId, boundedLimit],
    ).map(mapMemoryRow);

    for (const memory of memories) {
      indexMemoryEntities(memory);
    }

    const entityCount = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_entities WHERE project_id = ?",
      [projectId],
    )?.count ?? 0;
    const entityLinkCount = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_entity_links WHERE project_id = ?",
      [projectId],
    )?.count ?? 0;

    return {
      indexedMemories: memories.length,
      entityCount,
      entityLinkCount,
    };
  }

  function getMemoryHealthStats(projectId: string): MemoryHealthStats {
    const activeMemories = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unified_memories WHERE project_id = ? AND status != 'archived'",
      [projectId],
    )?.count ?? 0;
    const promotedMemories = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unified_memories WHERE project_id = ? AND status = 'promoted'",
      [projectId],
    )?.count ?? 0;
    const candidateMemories = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unified_memories WHERE project_id = ? AND status = 'candidate'",
      [projectId],
    )?.count ?? 0;
    const archivedMemories = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unified_memories WHERE project_id = ? AND status = 'archived'",
      [projectId],
    )?.count ?? 0;
    const embeddedMemories = db.get<{ count: number }>(
      `
        SELECT COUNT(DISTINCT memory_id) AS count
        FROM unified_memory_embeddings
        WHERE project_id = ?
      `,
      [projectId],
    )?.count ?? 0;
    const entityCount = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_entities WHERE project_id = ?",
      [projectId],
    )?.count ?? 0;
    const entityLinkCount = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_entity_links WHERE project_id = ?",
      [projectId],
    )?.count ?? 0;
    const recentRetrievals = db.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM memory_retrieval_ledger
        WHERE project_id = ?
          AND julianday(created_at) >= julianday('now', '-7 days')
      `,
      [projectId],
    )?.count ?? 0;
    const recentInjectedMemories = db.get<{ count: number }>(
      `
        SELECT COALESCE(SUM(injected_count), 0) AS count
        FROM memory_retrieval_ledger
        WHERE project_id = ?
          AND julianday(created_at) >= julianday('now', '-7 days')
      `,
      [projectId],
    )?.count ?? 0;
    const memoriesMissingEntityLinks = db.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM unified_memories m
        WHERE m.project_id = ?
          AND m.status != 'archived'
          AND NOT EXISTS (
            SELECT 1
            FROM memory_entity_links l
            WHERE l.memory_id = m.id
          )
      `,
      [projectId],
    )?.count ?? 0;

    return {
      projectId,
      activeMemories,
      promotedMemories,
      candidateMemories,
      archivedMemories,
      embeddedMemories,
      entityCount,
      entityLinkCount,
      recentRetrievals,
      recentInjectedMemories,
      memoriesMissingEntityLinks,
    };
  }

  function listRecentRetrievals(projectId: string, limit = 20): Array<Record<string, unknown>> {
    return db.all<Record<string, unknown>>(
      `
        SELECT *
        FROM memory_retrieval_ledger
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [projectId, Math.max(1, Math.min(100, Math.floor(limit)))],
    );
  }

  function recordMemoryRetrieval(args: {
    projectId: string;
    query: string;
    scope?: MemoryWriteScope;
    scopeOwnerId?: string | null;
    mode?: MemorySearchMode;
    status?: MemoryStatus | ReadonlyArray<MemoryStatus>;
    tiers?: ReadonlyArray<MemoryTier>;
    sourceType?: string;
    sourceId?: string | null;
    resultMemoryIds?: ReadonlyArray<string>;
    injectedMemoryIds?: ReadonlyArray<string>;
    durationMs?: number;
  }): void {
    const memories = [...new Set(args.resultMemoryIds ?? [])]
      .map((id) => readById(id))
      .filter((memory): memory is Memory => Boolean(memory));
    const queryEntities = entityMatchesForQuery(args.query);
    recordRetrievalEvent({
      opts: {
        projectId: args.projectId,
        query: args.query,
        scope: args.scope,
        scopeOwnerId: args.scopeOwnerId,
        mode: args.mode ?? "hybrid",
        status: args.status ?? "promoted",
        tiers: args.tiers ? [...args.tiers] : undefined,
        recordRetrieval: true,
        retrievalSourceType: args.sourceType ?? "service",
        retrievalSourceId: args.sourceId ?? null,
        injectedMemoryIds: args.injectedMemoryIds,
      },
      memories,
      queryEntities,
      durationMs: args.durationMs ?? 0,
    });
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
    reindexMemoryEntities,
    getMemoryHealthStats,
    listRecentRetrievals,
    recordMemoryRetrieval,
  };
}
