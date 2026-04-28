import { randomUUID } from "node:crypto";
import type {
  ReviewDismissReason,
  ReviewFinding,
  ReviewFindingSuppressionMatch,
  ReviewSuppression,
  ReviewSuppressionScope,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse } from "../shared/utils";
import type { EmbeddingService } from "../memory/embeddingService";

const TITLE_SIM_THRESHOLD = 0.55;
const EMBEDDING_SIM_THRESHOLD = 0.78;
const PATH_GLOB_CACHE_MAX = 256;
const PATH_GLOB_CACHE = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = PATH_GLOB_CACHE.get(pattern);
  if (cached) return cached;
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` means "zero or more path segments" — needs to match both
        // `src/foo.ts` and `src/a/b/foo.ts` against `src/**/*.ts`.
        // Swallow the trailing slash and make the whole segment optional.
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if ("/.+()|^$[]{}\\".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
    i += 1;
  }
  const re = new RegExp(`^${source}$`);
  if (PATH_GLOB_CACHE.size >= PATH_GLOB_CACHE_MAX) {
    const oldest = PATH_GLOB_CACHE.keys().next().value;
    if (oldest !== undefined) PATH_GLOB_CACHE.delete(oldest);
  }
  PATH_GLOB_CACHE.set(pattern, re);
  return re;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(value: string): Set<string> {
  const tokens = normalizeTitle(value).split(" ").filter((token) => token.length >= 3);
  return new Set(tokens);
}

function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    an += a[i]! * a[i]!;
    bn += b[i]! * b[i]!;
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function pathMatchesScope(
  candidatePath: string | null,
  scope: ReviewSuppressionScope,
  pattern: string | null,
): boolean {
  if (scope === "global") return true;
  if (scope === "repo") return true;
  if (scope === "path") {
    if (!pattern) return false;
    if (!candidatePath) return false;
    return globToRegExp(pattern).test(candidatePath);
  }
  return true;
}

type ReviewSuppressionRow = {
  id: string;
  project_id: string;
  scope: string;
  repo_key: string | null;
  path_pattern: string | null;
  title: string;
  title_norm: string;
  finding_class: string | null;
  severity: string | null;
  reason: string | null;
  note: string | null;
  embedding_json: string | null;
  source_finding_id: string | null;
  hit_count: number;
  created_at: string;
  last_matched_at: string | null;
};

function mapRow(row: ReviewSuppressionRow): ReviewSuppression {
  return {
    id: row.id,
    scope: (row.scope as ReviewSuppressionScope) ?? "repo",
    repoKey: row.repo_key,
    pathPattern: row.path_pattern,
    title: row.title,
    findingClass: (row.finding_class as ReviewSuppression["findingClass"]) ?? null,
    severity: (row.severity as ReviewSuppression["severity"]) ?? null,
    reason: (row.reason as ReviewDismissReason | null) ?? null,
    note: row.note,
    embedding: safeJsonParse<number[] | null>(row.embedding_json, null),
    sourceFindingId: row.source_finding_id,
    hitCount: Number(row.hit_count ?? 0),
    createdAt: row.created_at,
    lastMatchedAt: row.last_matched_at,
  };
}

export type ReviewSuppressionService = ReturnType<typeof createReviewSuppressionService>;

export function createReviewSuppressionService({
  db,
  logger,
  projectId,
  embeddingService,
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  embeddingService?: Pick<EmbeddingService, "embed"> | null;
}) {
  async function tryEmbed(text: string): Promise<number[] | null> {
    if (!embeddingService || !text.trim()) return null;
    try {
      const vector = await embeddingService.embed(text);
      return Array.from(vector);
    } catch (error) {
      logger.warn("review.suppression.embed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function create(args: {
    scope: ReviewSuppressionScope;
    title: string;
    repoKey?: string | null;
    pathPattern?: string | null;
    findingClass?: ReviewSuppression["findingClass"];
    severity?: ReviewSuppression["severity"];
    reason?: ReviewDismissReason | null;
    note?: string | null;
    sourceFindingId?: string | null;
    seedText?: string | null;
  }): Promise<ReviewSuppression> {
    const embeddingText = args.seedText ?? args.title;
    const embedding = await tryEmbed(embeddingText);
    const row: ReviewSuppression = {
      id: `rsup_${randomUUID()}`,
      scope: args.scope,
      repoKey: args.repoKey ?? null,
      pathPattern: args.pathPattern ?? null,
      title: args.title,
      findingClass: args.findingClass ?? null,
      severity: args.severity ?? null,
      reason: args.reason ?? null,
      note: args.note ?? null,
      embedding,
      sourceFindingId: args.sourceFindingId ?? null,
      hitCount: 0,
      createdAt: nowIso(),
      lastMatchedAt: null,
    };
    db.run(
      `insert into review_suppressions (
        id, project_id, scope, repo_key, path_pattern, title, title_norm,
        finding_class, severity, reason, note, embedding_json, source_finding_id,
        hit_count, created_at, last_matched_at
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id,
        projectId,
        row.scope,
        row.repoKey,
        row.pathPattern,
        row.title,
        normalizeTitle(row.title),
        row.findingClass,
        row.severity,
        row.reason,
        row.note,
        embedding ? JSON.stringify(embedding) : null,
        row.sourceFindingId,
        0,
        row.createdAt,
        null,
      ],
    );
    return row;
  }

  function list(args: {
    limit?: number | null;
    scope?: ReviewSuppressionScope | null;
  } = {}): ReviewSuppression[] {
    const limit = Math.max(1, Math.min(500, args.limit ?? 200));
    const where: string[] = ["project_id = ?"];
    const params: Array<string | number | null> = [projectId];
    if (args.scope) {
      where.push("scope = ?");
      params.push(args.scope);
    }
    const rows = db.all<ReviewSuppressionRow>(
      `select * from review_suppressions where ${where.join(" and ")} order by created_at desc limit ${limit}`,
      params,
    );
    return rows.map(mapRow);
  }

  function remove(suppressionId: string): boolean {
    const row = db.get<{ id: string }>(
      "select id from review_suppressions where id = ? and project_id = ? limit 1",
      [suppressionId, projectId],
    );
    if (!row) return false;
    db.run("delete from review_suppressions where id = ?", [suppressionId]);
    return true;
  }

  function recordHit(suppressionId: string): void {
    db.run(
      "update review_suppressions set hit_count = hit_count + 1, last_matched_at = ? where id = ?",
      [nowIso(), suppressionId],
    );
  }

  async function match(args: {
    finding: Pick<ReviewFinding, "title" | "body" | "filePath" | "findingClass" | "severity">;
    repoKey?: string | null;
  }): Promise<ReviewFindingSuppressionMatch | null> {
    const rows = db.all<ReviewSuppressionRow>(
      "select * from review_suppressions where project_id = ? order by created_at desc limit 500",
      [projectId],
    );
    if (rows.length === 0) return null;

    const findingText = `${args.finding.title} ${args.finding.body}`.trim();
    const candidateEmbedding = await tryEmbed(findingText);
    const findingTokens = tokenize(args.finding.title);

    let best: { row: ReviewSuppression; similarity: number } | null = null;
    for (const raw of rows) {
      const suppression = mapRow(raw);
      if (!pathMatchesScope(args.finding.filePath, suppression.scope, suppression.pathPattern)) continue;
      if (suppression.scope === "repo" && suppression.repoKey && args.repoKey && suppression.repoKey !== args.repoKey) {
        continue;
      }
      if (suppression.findingClass && args.finding.findingClass && suppression.findingClass !== args.finding.findingClass) {
        continue;
      }

      // Score each candidate against its strongest signal:
      // - if both sides have embeddings, trust cosine with the embedding bar
      // - otherwise fall back to Jaccard-over-title-tokens with a lower bar
      // Previously we mixed the two (jaccard could overwrite cosine but then
      // get compared to the embedding threshold), which rejected real
      // title-matches when embeddings happened to be weak.
      const haveBothEmbeddings = Boolean(candidateEmbedding && suppression.embedding);
      const cosineScore = haveBothEmbeddings
        ? cosine(candidateEmbedding, suppression.embedding)
        : 0;
      if (haveBothEmbeddings && cosineScore >= EMBEDDING_SIM_THRESHOLD) {
        const score = cosineScore;
        if (!best || score > best.similarity) best = { row: suppression, similarity: score };
        continue;
      }
      const titleScore = jaccard(findingTokens, tokenize(suppression.title));
      if (titleScore < TITLE_SIM_THRESHOLD) continue;
      const score = Math.max(cosineScore, titleScore);

      if (!best || score > best.similarity) {
        best = { row: suppression, similarity: score };
      }
    }

    if (!best) return null;
    recordHit(best.row.id);
    return {
      suppressionId: best.row.id,
      similarity: Number(best.similarity.toFixed(4)),
      reason: best.row.reason,
      scope: best.row.scope,
    };
  }

  return { create, list, remove, match };
}
