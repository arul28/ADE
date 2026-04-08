import type { AdeDb } from "../state/kvDb";
import type { createEmbeddingService } from "./embeddingService";
import type {
  Memory,
  MemoryImportance,
  MemoryStatus,
  MemoryTier,
  MemoryScope,
} from "./memoryService";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MMR_LAMBDA = 0.7;
const MIN_VECTOR_RESULTS = 40;

type HybridSearchRow = Record<string, unknown> & {
  embedding_blob?: Uint8Array | null;
  dimensions?: number | null;
  match_info?: Uint8Array | null;
};

type SearchHybridOpts = {
  projectId: string;
  query: string;
  scope?: MemoryScope;
  scopeOwnerId?: string | null;
  limit?: number;
  status?: MemoryStatus | ReadonlyArray<MemoryStatus>;
  tiers?: MemoryTier[];
};

type HybridSearchCandidate = {
  memory: Memory;
  vector: Float32Array | null;
  hasEmbedding: boolean;
  bm25Score: number;
  bm25Normalized: number;
  cosineSimilarity: number;
  hybridScore: number;
  compositeScore: number;
};

export type HybridSearchHit = HybridSearchCandidate;
export type HybridSearchService = ReturnType<typeof createHybridSearchService>;

type CreateHybridSearchServiceOpts = {
  db: AdeDb;
  embeddingService: Pick<ReturnType<typeof createEmbeddingService>, "embed" | "getModelId">;
  logger?: Pick<import("../logging/logger").Logger, "warn"> | null;
  now?: () => Date;
};

export class HybridSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HybridSearchUnavailableError";
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeText(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  return normalizeText(query).split(/[^a-z0-9_]+/).map((token) => token.trim()).filter(Boolean);
}

function buildFtsQuery(query: string): string {
  return tokenizeQuery(query)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

function normalizeMemoryImportance(value: unknown): MemoryImportance {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "medium";
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "candidate" || normalized === "promoted" || normalized === "archived") return normalized;
  return "promoted";
}

function normalizeMemoryTier(value: unknown): MemoryTier {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 2 || numeric === 3) return numeric;
  return 2;
}

function mapMemoryRow(row: Record<string, unknown>): Memory {
  const pinned = Number(row.pinned ?? 0) === 1;
  const tier = normalizeMemoryTier(row.tier);
  return {
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    scope: String(row.scope ?? "project") as MemoryScope,
    scopeOwnerId: row.scope_owner_id ? String(row.scope_owner_id) : null,
    tier,
    category: String(row.category ?? "fact") as Memory["category"],
    content: String(row.content ?? ""),
    importance: normalizeMemoryImportance(row.importance),
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    sourcePackKey: row.source_pack_key ? String(row.source_pack_key) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? row.created_at ?? ""),
    lastAccessedAt: String(row.last_accessed_at ?? row.updated_at ?? row.created_at ?? ""),
    accessCount: Number(row.access_count ?? 0),
    observationCount: Number(row.observation_count ?? 1),
    status: normalizeMemoryStatus(row.status),
    agentId: row.agent_id ? String(row.agent_id) : null,
    confidence: clamp01(Number(row.confidence ?? 1)),
    promotedAt: row.promoted_at ? String(row.promoted_at) : null,
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    sourceType: String(row.source_type ?? "agent") as Memory["sourceType"],
    sourceId: row.source_id ? String(row.source_id) : null,
    fileScopePattern: row.file_scope_pattern ? String(row.file_scope_pattern) : null,
    pinned: pinned || tier === 1,
    accessScore: Number(row.access_score ?? row.composite_score ?? 0),
    compositeScore: Number(row.composite_score ?? 0),
    writeGateReason: row.write_gate_reason ? String(row.write_gate_reason) : null,
    embedded: row.embedding_blob != null,
  };
}

function computeRecencyScore(lastAccessedAt: string, updatedAt: string, now: Date): number {
  const source = lastAccessedAt || updatedAt;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) return 0.25;
  const ageMs = Math.max(0, now.getTime() - timestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / 30);
}

function computeImportanceScore(importance: MemoryImportance): number {
  if (importance === "high") return 1;
  if (importance === "medium") return 0.6;
  return 0.3;
}

function computeAccessScore(memory: Memory): number {
  return clamp01(Math.max(memory.accessCount, 0) / 10);
}

function normalizeStatuses(status: SearchHybridOpts["status"]): MemoryStatus[] {
  if (Array.isArray(status)) {
    return status.map((value) => normalizeMemoryStatus(value)).filter((value) => value !== "archived");
  }
  if (status) {
    const normalized = normalizeMemoryStatus(status);
    return normalized === "archived" ? [] : [normalized];
  }
  return ["promoted"];
}

function matchesSearchFilters(memory: Memory, opts: SearchHybridOpts, allowedStatuses: ReadonlySet<MemoryStatus>): boolean {
  if (memory.status === "archived") return false;
  if (memory.projectId !== opts.projectId) return false;
  if (opts.scope && memory.scope !== opts.scope) return false;
  if (opts.scopeOwnerId !== undefined) {
    const expected = String(opts.scopeOwnerId ?? "");
    const actual = String(memory.scopeOwnerId ?? "");
    if (actual !== expected) return false;
  }
  if (!allowedStatuses.has(memory.status)) return false;
  if (opts.tiers?.length && !opts.tiers.includes(memory.tier)) return false;
  return true;
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function toFloat32Array(blob: unknown, dimensions?: number | null): Float32Array | null {
  const bytes = toUint8Array(blob);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (dimensions != null && Number.isFinite(dimensions) && vector.length !== Number(dimensions)) return null;
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function decodeMatchInfo(blob: unknown): number[] {
  const bytes = toUint8Array(blob);
  if (!bytes || bytes.byteLength === 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset + 4 <= view.byteLength; offset += 4) {
    values.push(view.getUint32(offset, true));
  }
  return values;
}

export function computeBm25Score(matchInfoBlob: unknown, k1 = BM25_K1, b = BM25_B): number {
  const values = decodeMatchInfo(matchInfoBlob);
  if (values.length < 3) return 0;

  const phraseCount = values[0] ?? 0;
  const columnCount = values[1] ?? 0;
  const totalDocs = values[2] ?? 0;
  if (phraseCount <= 0 || columnCount <= 0 || totalDocs <= 0) return 0;

  const averagesOffset = 3;
  const lengthsOffset = averagesOffset + columnCount;
  const statsOffset = lengthsOffset + columnCount;

  let score = 0;
  for (let phraseIndex = 0; phraseIndex < phraseCount; phraseIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const statIndex = statsOffset + ((phraseIndex * columnCount) + columnIndex) * 3;
      const termFrequency = values[statIndex] ?? 0;
      const docsWithHits = values[statIndex + 2] ?? 0;
      const documentLength = values[lengthsOffset + columnIndex] ?? 0;
      const averageLength = values[averagesOffset + columnIndex] ?? 0;

      if (termFrequency <= 0 || docsWithHits <= 0 || averageLength <= 0) continue;

      const idf = Math.log(((totalDocs - docsWithHits + 0.5) / (docsWithHits + 0.5)) + 1);
      const denominator = termFrequency + k1 * (1 - b + b * (documentLength / averageLength));
      if (denominator <= 0) continue;
      score += idf * ((termFrequency * (k1 + 1)) / denominator);
    }
  }

  return Number.isFinite(score) ? score : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle] ?? 0;
}

function normalizeBm25Scores(candidates: HybridSearchCandidate[]): HybridSearchCandidate[] {
  const nonZeroScores = candidates.map((candidate) => candidate.bm25Score).filter((score) => score > 0);
  const k = Math.max(median(nonZeroScores), Number.EPSILON);

  return candidates.map((candidate) => ({
    ...candidate,
    bm25Normalized: candidate.bm25Score > 0 ? clamp01(candidate.bm25Score / (candidate.bm25Score + k)) : 0,
  }));
}

export function computeHybridCompositeScore(args: {
  memory: Memory;
  bm25Normalized: number;
  cosineSimilarity: number;
  hasEmbedding: boolean;
  now: Date;
}): { hybridScore: number; compositeScore: number } {
  const hybridScore = args.hasEmbedding
    ? clamp01((0.30 * clamp01(args.bm25Normalized)) + (0.70 * clamp01(args.cosineSimilarity)))
    : clamp01(args.bm25Normalized);

  const compositeScore =
    (0.40 * hybridScore) +
    (0.20 * computeRecencyScore(args.memory.lastAccessedAt, args.memory.updatedAt, args.now)) +
    (0.15 * computeImportanceScore(args.memory.importance)) +
    (0.15 * clamp01(args.memory.confidence)) +
    (0.10 * computeAccessScore(args.memory));

  return {
    hybridScore,
    compositeScore: Number.isFinite(compositeScore) ? compositeScore : 0,
  };
}

function rerankWithMmr(candidates: HybridSearchCandidate[], limit: number): HybridSearchCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  const remaining = [...candidates];
  const selected: HybridSearchCandidate[] = [];

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      let score = candidate.compositeScore;

      if (candidate.vector) {
        let redundancyPenalty = 0;
        for (const prior of selected) {
          if (!prior.vector) continue;
          redundancyPenalty = Math.max(redundancyPenalty, cosineSimilarity(candidate.vector, prior.vector));
        }
        score = (MMR_LAMBDA * candidate.hybridScore) - ((1 - MMR_LAMBDA) * redundancyPenalty);
      }

      if (
        score > bestScore
        || (score === bestScore && candidate.compositeScore > (remaining[bestIndex]?.compositeScore ?? Number.NEGATIVE_INFINITY))
      ) {
        bestScore = score;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }

  return selected;
}

export function createHybridSearchService(opts: CreateHybridSearchServiceOpts) {
  const { db, embeddingService, now = () => new Date() } = opts;

  function readLexicalCandidates(query: string, searchOpts: SearchHybridOpts): HybridSearchCandidate[] {
    const matchQuery = buildFtsQuery(query);
    if (!matchQuery.length) return [];

    const allowedStatuses = new Set(normalizeStatuses(searchOpts.status));
    if (allowedStatuses.size === 0) return [];

    const rows = (() => {
      try {
        return db.all<HybridSearchRow>(
          `
            SELECT m.*, e.embedding_blob, e.dimensions, matchinfo(unified_memories_fts, 'pcnalx') AS match_info
            FROM unified_memories_fts
            JOIN unified_memories m
              ON m.rowid = unified_memories_fts.rowid
            LEFT JOIN unified_memory_embeddings e
              ON e.memory_id = m.id
             AND e.embedding_model = ?
            WHERE unified_memories_fts MATCH ?
          `,
          [embeddingService.getModelId(), matchQuery],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isFtsMissing = /no such module: fts[45]/i.test(message)
          || /unable to use function (matchinfo|MATCH)/i.test(message);
        if (isFtsMissing) return [];
        throw error;
      }
    })();

    return rows
      .map((row) => {
        const memory = mapMemoryRow(row);
        if (!matchesSearchFilters(memory, searchOpts, allowedStatuses)) return null;
        const vector = toFloat32Array(row.embedding_blob, row.dimensions);
        return {
          memory,
          vector,
          hasEmbedding: vector != null,
          bm25Score: computeBm25Score(row.match_info),
          bm25Normalized: 0,
          cosineSimilarity: 0,
          hybridScore: 0,
          compositeScore: 0,
        } satisfies HybridSearchCandidate;
      })
      .filter((candidate): candidate is HybridSearchCandidate => Boolean(candidate));
  }

  function readVectorCandidates(searchOpts: SearchHybridOpts, queryVector: Float32Array): HybridSearchCandidate[] {
    const allowedStatuses = new Set(normalizeStatuses(searchOpts.status));
    if (allowedStatuses.size === 0) return [];

    const rows = db.all<HybridSearchRow>(
      `
        SELECT m.*, e.embedding_blob, e.dimensions
        FROM unified_memory_embeddings e
        JOIN unified_memories m
          ON m.id = e.memory_id
        WHERE e.embedding_model = ?
          AND m.status != 'archived'
      `,
      [embeddingService.getModelId()],
    );

    return rows
      .reduce<HybridSearchCandidate[]>((candidates, row) => {
        const memory = mapMemoryRow(row);
        if (!matchesSearchFilters(memory, searchOpts, allowedStatuses)) return candidates;
        const vector = toFloat32Array(row.embedding_blob, row.dimensions);
        if (!vector) return candidates;
        candidates.push({
          memory,
          vector,
          hasEmbedding: true,
          bm25Score: 0,
          bm25Normalized: 0,
          cosineSimilarity: clamp01(cosineSimilarity(queryVector, vector)),
          hybridScore: 0,
          compositeScore: 0,
        });
        return candidates;
      }, [])
      .sort((left, right) => right.cosineSimilarity - left.cosineSimilarity)
      .slice(0, Math.max(MIN_VECTOR_RESULTS, (searchOpts.limit ?? 10) * 8));
  }

  async function search(searchOpts: SearchHybridOpts): Promise<HybridSearchHit[]> {
    const limit = Math.max(1, Math.min(100, searchOpts.limit ?? 10));
    const normalizedQuery = normalizeText(searchOpts.query);
    if (!normalizedQuery.length) return [];

    let queryVector: Float32Array | null = null;
    try {
      queryVector = await embeddingService.embed(searchOpts.query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      opts.logger?.warn?.("memory.hybrid_search.fallback_to_lexical", {
        reason: message,
        query: searchOpts.query.slice(0, 100),
      });
      // Fall through — we'll degrade to lexical-only search below.
    }

    const lexicalCandidates = readLexicalCandidates(searchOpts.query, searchOpts);
    const lexicalById = new Map(lexicalCandidates.map((candidate) => [candidate.memory.id, candidate]));

    if (queryVector) {
      for (const candidate of lexicalCandidates) {
        if (candidate.vector) {
          candidate.cosineSimilarity = clamp01(cosineSimilarity(queryVector, candidate.vector));
        }
      }
    }

    const combined = new Map<string, HybridSearchCandidate>(lexicalById);
    if (queryVector) {
      for (const candidate of readVectorCandidates(searchOpts, queryVector)) {
        const existing = combined.get(candidate.memory.id);
        if (!existing) {
          combined.set(candidate.memory.id, candidate);
          continue;
        }
        if (!existing.vector && candidate.vector) {
          existing.vector = candidate.vector;
          existing.hasEmbedding = true;
        }
        existing.cosineSimilarity = Math.max(existing.cosineSimilarity, candidate.cosineSimilarity);
      }
    }

    const scored = normalizeBm25Scores([...combined.values()]).map((candidate) => {
      const nextNow = now();
      const { hybridScore, compositeScore } = computeHybridCompositeScore({
        memory: candidate.memory,
        bm25Normalized: candidate.bm25Normalized,
        cosineSimilarity: candidate.cosineSimilarity,
        hasEmbedding: candidate.hasEmbedding,
        now: nextNow,
      });
      return {
        ...candidate,
        hybridScore,
        compositeScore,
      } satisfies HybridSearchCandidate;
    });

    const sorted = scored.sort((left, right) => {
      if (right.compositeScore !== left.compositeScore) return right.compositeScore - left.compositeScore;
      if (right.hybridScore !== left.hybridScore) return right.hybridScore - left.hybridScore;
      return String(right.memory.lastAccessedAt).localeCompare(String(left.memory.lastAccessedAt));
    });

    return rerankWithMmr(sorted, limit);
  }

  return {
    search,
  };
}
