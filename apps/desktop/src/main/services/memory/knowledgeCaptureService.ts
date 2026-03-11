import { createHash, randomUUID } from "node:crypto";
import type { PrComment, PrReview } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { isRecord, nowIso, safeJsonParse } from "../shared/utils";
import type { ProceduralLearningService } from "./proceduralLearningService";
import type { Memory, UnifiedMemoryService } from "./unifiedMemoryService";

type CaptureLedgerRow = {
  id: string;
  source_type: string;
  source_key: string;
  memory_id: string | null;
  episode_memory_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

type CaptureCategory = "convention" | "preference" | "pattern" | "gotcha";

type CaptureDraft = {
  category: CaptureCategory;
  content: string;
  confidence: number;
  importance: "medium" | "high";
  fileScopePattern?: string | null;
};

type CaptureSourceType = "intervention" | "error_capture" | "error_cluster" | "pr_feedback";

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return cleanText(value).toLowerCase();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function splitGuidanceLines(value: string): string[] {
  return value
    .split(/\n+|(?<=[.!?])\s+/)
    .map(cleanText)
    .filter((line) => line.length >= 8)
    .filter((line, index, arr) => arr.findIndex((entry) => normalizeText(entry) === normalizeText(line)) === index);
}

function stripSourcePrefixes(value: string): string {
  return cleanText(
    value
      .replace(/^resolved by steering directive \([^)]+\):/i, "")
      .replace(/^resolved by steering directive:/i, "")
      .replace(/^review feedback:/i, "")
      .replace(/^intervention:/i, "")
  );
}

function inferCaptureCategory(value: string): CaptureCategory | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (
    normalized.includes("don't ") ||
    normalized.includes("do not ") ||
    normalized.includes("never ") ||
    normalized.includes("always ") ||
    normalized.includes("must ") ||
    normalized.includes("should ")
  ) {
    return "convention";
  }
  if (
    normalized.includes("prefer ") ||
    normalized.includes("nit") ||
    normalized.includes("style") ||
    normalized.includes("readability")
  ) {
    return "preference";
  }
  if (
    normalized.includes("break") ||
    normalized.includes("regression") ||
    normalized.includes("failing") ||
    normalized.includes("failure") ||
    normalized.includes("missing test") ||
    normalized.includes("causes ")
  ) {
    return "gotcha";
  }
  if (
    normalized.includes("when ") ||
    normalized.includes("for ") ||
    normalized.includes("before ") ||
    normalized.includes("after ")
  ) {
    return "pattern";
  }
  return null;
}

function inferConfidence(category: CaptureCategory, text: string): number {
  const normalized = normalizeText(text);
  if (category === "gotcha") return normalized.includes("break") || normalized.includes("regression") ? 0.72 : 0.62;
  if (category === "convention") return normalized.includes("must") || normalized.includes("never") ? 0.68 : 0.58;
  if (category === "pattern") return 0.56;
  return 0.52;
}

function inferImportance(category: CaptureCategory): "medium" | "high" {
  return category === "gotcha" ? "high" : "medium";
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(/[^a-z0-9_]+/).filter(Boolean));
  const rightTokens = new Set(normalizeText(right).split(/[^a-z0-9_]+/).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const union = leftTokens.size + rightTokens.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function toEpisodeContent(args: {
  sourceLabel: string;
  summary: string;
  patterns?: string[];
  gotchas?: string[];
  decisions?: string[];
  missionId?: string | null;
  sessionId?: string | null;
  fileScopePattern?: string | null;
}): string {
  return JSON.stringify({
    id: randomUUID(),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.missionId ? { missionId: args.missionId } : {}),
    taskDescription: args.sourceLabel,
    approachTaken: args.summary,
    outcome: "partial",
    toolsUsed: [],
    patternsDiscovered: args.patterns ?? [],
    gotchas: args.gotchas ?? [],
    decisionsMade: args.decisions ?? [],
    duration: 0,
    createdAt: nowIso(),
    ...(args.fileScopePattern ? { fileScopePattern: args.fileScopePattern } : {}),
  });
}

function firstFileScopePattern(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.map((entry) => cleanText(entry)).find((entry) => entry.length > 0);
    return first ?? null;
  }
  return null;
}

function extractActionableDrafts(lines: string[], fallbackCategory?: CaptureCategory | null): CaptureDraft[] {
  const drafts: CaptureDraft[] = [];
  for (const rawLine of lines) {
    const content = stripSourcePrefixes(rawLine);
    if (content.length < 8) continue;
    const category = inferCaptureCategory(content) ?? fallbackCategory ?? null;
    if (!category) continue;
    drafts.push({
      category,
      content,
      confidence: inferConfidence(category, content),
      importance: inferImportance(category),
    });
    if (drafts.length >= 2) break;
  }
  return drafts;
}

export function createKnowledgeCaptureService(args: {
  db: AdeDb;
  projectId: string;
  logger?: Pick<Logger, "warn"> | null;
  memoryService: Pick<UnifiedMemoryService, "addMemory" | "writeMemory" | "listMemories" | "search">;
  proceduralLearningService?: Pick<ProceduralLearningService, "onEpisodeSaved"> | null;
  prService?: {
    getComments(prId: string): Promise<PrComment[]>;
    getReviews(prId: string): Promise<PrReview[]>;
  } | null;
}) {
  const { db, projectId, memoryService, proceduralLearningService } = args;

  const readLedger = (sourceType: CaptureSourceType, sourceKey: string): CaptureLedgerRow | null => {
    return db.get<CaptureLedgerRow>(
      `
        select *
        from memory_capture_ledger
        where project_id = ?
          and source_type = ?
          and source_key = ?
        limit 1
      `,
      [projectId, sourceType, sourceKey],
    ) ?? null;
  };

  const writeLedger = (input: {
    sourceType: CaptureSourceType;
    sourceKey: string;
    memoryId?: string | null;
    episodeMemoryId?: string | null;
    metadata?: Record<string, unknown>;
  }): void => {
    const existing = readLedger(input.sourceType, input.sourceKey);
    const now = nowIso();
    db.run(
      `
        insert into memory_capture_ledger(
          id, project_id, source_type, source_key, memory_id, episode_memory_id,
          metadata_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, source_type, source_key) do update set
          memory_id = coalesce(excluded.memory_id, memory_capture_ledger.memory_id),
          episode_memory_id = coalesce(excluded.episode_memory_id, memory_capture_ledger.episode_memory_id),
          metadata_json = coalesce(excluded.metadata_json, memory_capture_ledger.metadata_json),
          updated_at = excluded.updated_at
      `,
      [
        existing?.id ?? randomUUID(),
        projectId,
        input.sourceType,
        input.sourceKey,
        input.memoryId ?? null,
        input.episodeMemoryId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : existing?.metadata_json ?? null,
        existing?.created_at ?? now,
        now,
      ],
    );
  };

  const saveCompanionEpisode = async (input: {
    sourceType: CaptureSourceType;
    sourceKey: string;
    sourceLabel: string;
    summary: string;
    category: CaptureCategory;
    missionId?: string | null;
    sessionId?: string | null;
    fileScopePattern?: string | null;
  }): Promise<string | null> => {
    const existing = readLedger(input.sourceType, input.sourceKey);
    if (existing?.episode_memory_id) return existing.episode_memory_id;
    const episode = memoryService.addMemory({
      projectId,
      scope: "project",
      category: "episode",
      content: toEpisodeContent({
        sourceLabel: input.sourceLabel,
        summary: input.summary,
        patterns: input.category === "pattern" ? [input.summary] : [],
        gotchas: input.category === "gotcha" ? [input.summary] : [],
        decisions: input.category === "convention" || input.category === "preference" ? [input.summary] : [],
        missionId: input.missionId,
        sessionId: input.sessionId,
        fileScopePattern: input.fileScopePattern,
      }),
      importance: "medium",
      sourceType: "system",
      sourceId: `${input.sourceType}:${input.sourceKey}`,
      ...(input.fileScopePattern ? { fileScopePattern: input.fileScopePattern } : {}),
    });
    await proceduralLearningService?.onEpisodeSaved?.(episode.id);
    return episode.id;
  };

  const recordCandidate = (input: {
    sourceType: CaptureSourceType;
    sourceKey: string;
    draft: CaptureDraft;
    sourceRunId?: string | null;
    sourceId?: string | null;
  }): Memory | null => {
    const result = memoryService.writeMemory({
      projectId,
      scope: "project",
      category: input.draft.category,
      content: input.draft.content,
      importance: input.draft.importance,
      confidence: input.draft.confidence,
      status: "candidate",
      sourceType: "system",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      sourceId: input.sourceId ?? `${input.sourceType}:${input.sourceKey}`,
      ...(input.draft.fileScopePattern ? { fileScopePattern: input.draft.fileScopePattern } : {}),
    });
    return result.memory ?? null;
  };

  const findRecurringGotchaMatches = async (seed: Memory): Promise<Memory[]> => {
    const query = seed.content.trim().slice(0, 300);
    const searchMatches = query.length > 0
      ? await memoryService.search({
          projectId,
          query,
          scope: "project",
          status: ["candidate", "promoted"],
          limit: 20,
        })
      : [];
    const listMatches = memoryService.listMemories({
      projectId,
      scope: "project",
      categories: ["gotcha"],
      status: ["candidate", "promoted"],
      limit: 300,
    });
    const merged = new Map<string, Memory>();
    for (const item of [...searchMatches, ...listMatches]) {
      if (item.category !== "gotcha") continue;
      if (item.id === seed.id || lexicalSimilarity(item.content, seed.content) >= 0.6) {
        merged.set(item.id, item);
      }
    }
    return [...merged.values()];
  };

  const promoteRecurringErrorCluster = async (seed: Memory, sourceKey: string): Promise<void> => {
    const matches = await findRecurringGotchaMatches(seed);
    const distinctOrigins = new Set(
      matches.map((item) => cleanText(item.sourceRunId || item.sourceId || item.id)).filter(Boolean),
    );
    if (distinctOrigins.size < 3) return;

    const canonical = [...matches].sort((left, right) =>
      (right.observationCount - left.observationCount)
      || (right.confidence - left.confidence)
      || left.createdAt.localeCompare(right.createdAt)
    )[0];
    if (!canonical) return;

    const result = memoryService.writeMemory({
      projectId,
      scope: "project",
      category: "gotcha",
      content: canonical.content,
      importance: "high",
      confidence: Math.min(0.95, Math.max(canonical.confidence, 0.8)),
      status: "promoted",
      sourceType: canonical.sourceType,
      sourceId: canonical.sourceId ?? `error_cluster:${sourceKey}`,
      ...(canonical.sourceRunId ? { sourceRunId: canonical.sourceRunId } : {}),
      ...(canonical.fileScopePattern ? { fileScopePattern: canonical.fileScopePattern } : {}),
    }).memory;
    if (!result) return;

    const clusterSourceKey = `cluster:${canonical.id}`;
    if (readLedger("error_cluster", clusterSourceKey)) return;
    const episodeId = await saveCompanionEpisode({
      sourceType: "error_cluster",
      sourceKey: clusterSourceKey,
      sourceLabel: "Recurring failure cluster",
      summary: canonical.content,
      category: "gotcha",
      missionId: canonical.sourceRunId ?? null,
      sessionId: `error-cluster:${canonical.id}`,
      fileScopePattern: canonical.fileScopePattern,
    });
    writeLedger({
      sourceType: "error_cluster",
      sourceKey: clusterSourceKey,
      memoryId: result.id,
      episodeMemoryId: episodeId,
      metadata: {
        canonicalMemoryId: result.id,
        distinctOrigins: distinctOrigins.size,
      },
    });
  };

  const captureResolvedIntervention = async (input: {
    missionId: string;
    intervention: {
      id: string;
      interventionType: string;
      status: string;
      title: string;
      body: string;
      resolutionNote?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }): Promise<void> => {
    if (input.intervention.interventionType !== "manual_input" || input.intervention.status !== "resolved") return;
    const sourceKey = input.intervention.id.trim();
    if (!sourceKey || readLedger("intervention", sourceKey)) return;

    const resolution = cleanText(input.intervention.resolutionNote);
    const body = cleanText(input.intervention.body);
    const title = cleanText(input.intervention.title);
    const lines = extractActionableDrafts(
      splitGuidanceLines([resolution, body, title].filter(Boolean).join("\n")),
    );
    if (lines.length === 0) return;

    const metadata = isRecord(input.intervention.metadata) ? input.intervention.metadata : null;
    const stepId = cleanText(metadata?.stepId);
    const runId = cleanText(metadata?.runId) || null;
    let fileScopePattern =
      firstFileScopePattern(metadata?.fileScopes)
      ?? firstFileScopePattern(metadata?.fileScopePattern)
      ?? null;
    if (!fileScopePattern && stepId) {
      const row = db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_steps where id = ? and project_id = ? limit 1`,
        [stepId, projectId],
      );
      const parsedStepMeta = safeJsonParse<Record<string, unknown> | null>(row?.metadata_json ?? "", null);
      const stepMeta = isRecord(parsedStepMeta) ? parsedStepMeta : null;
      fileScopePattern = firstFileScopePattern(stepMeta?.fileScopes) ?? firstFileScopePattern(stepMeta?.fileScopePattern) ?? null;
    }

    let memoryId: string | null = null;
    let episodeId: string | null = null;
    for (const draft of lines) {
      const nextDraft = fileScopePattern && !draft.fileScopePattern ? { ...draft, fileScopePattern } : draft;
      const memory = recordCandidate({
        sourceType: "intervention",
        sourceKey,
        draft: nextDraft,
        sourceRunId: runId,
        sourceId: `intervention:${sourceKey}`,
      });
      if (!memoryId && memory) memoryId = memory.id;
      if (!episodeId && memory) {
        episodeId = await saveCompanionEpisode({
          sourceType: "intervention",
          sourceKey,
          sourceLabel: `Resolved intervention for mission ${input.missionId}`,
          summary: nextDraft.content,
          category: nextDraft.category,
          missionId: input.missionId,
          sessionId: runId,
          fileScopePattern,
        });
      }
    }

    if (memoryId || episodeId) {
      writeLedger({
        sourceType: "intervention",
        sourceKey,
        memoryId,
        episodeMemoryId: episodeId,
        metadata: {
          missionId: input.missionId,
          runId,
          stepId: stepId || null,
          fileScopePattern,
        },
      });
    }
  };

  const captureFailureGotcha = async (input: {
    missionId: string;
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    stepKey?: string | null;
    summary: string;
    errorMessage?: string | null;
    fileScopePattern?: string | null;
  }): Promise<void> => {
    const sourceKey = cleanText(input.attemptId) || `${input.runId}:${cleanText(input.stepId) || cleanText(input.stepKey) || hashText(input.summary)}`;
    if (!sourceKey || readLedger("error_capture", sourceKey)) return;

    const summary = cleanText(input.summary);
    const errorText = cleanText(input.errorMessage);
    const content = cleanText(errorText ? `${summary} Error: ${errorText}` : summary).slice(0, 1200);
    if (!content) return;
    const memory = recordCandidate({
      sourceType: "error_capture",
      sourceKey,
      draft: {
        category: "gotcha",
        content,
        confidence: errorText ? 0.68 : 0.62,
        importance: "high",
        fileScopePattern: input.fileScopePattern ?? null,
      },
      sourceRunId: input.runId,
      sourceId: `failure:${sourceKey}`,
    });
    if (!memory) return;

    writeLedger({
      sourceType: "error_capture",
      sourceKey,
      memoryId: memory.id,
      metadata: {
        missionId: input.missionId,
        runId: input.runId,
        stepId: input.stepId ?? null,
        attemptId: input.attemptId ?? null,
      },
    });
    await promoteRecurringErrorCluster(memory, sourceKey);
  };

  const extractPrFeedbackDraft = (text: string, fileScopePattern?: string | null): CaptureDraft | null => {
    const actionable = extractActionableDrafts(splitGuidanceLines(text));
    const first = actionable[0];
    if (!first) return null;
    return fileScopePattern && !first.fileScopePattern ? { ...first, fileScopePattern } : first;
  };

  const capturePrFeedback = async (argsInput: {
    prId: string;
    prNumber?: number | null;
  }): Promise<void> => {
    if (!args.prService) return;
    const [comments, reviews] = await Promise.all([
      args.prService.getComments(argsInput.prId).catch(() => [] as PrComment[]),
      args.prService.getReviews(argsInput.prId).catch(() => [] as PrReview[]),
    ]);

    for (const comment of comments) {
      const body = cleanText(comment.body);
      if (!body) continue;
      const sourceKey = `comment:${comment.id}`;
      if (readLedger("pr_feedback", sourceKey)) continue;
      const draft = extractPrFeedbackDraft(body, cleanText(comment.path) || null);
      if (!draft) continue;
      const memory = recordCandidate({
        sourceType: "pr_feedback",
        sourceKey,
        draft,
        sourceId: `pr:${argsInput.prId}:${sourceKey}`,
      });
      const episodeId = memory
        ? await saveCompanionEpisode({
            sourceType: "pr_feedback",
            sourceKey,
            sourceLabel: `PR feedback for ${argsInput.prNumber ? `#${argsInput.prNumber}` : argsInput.prId}`,
            summary: draft.content,
            category: draft.category,
            sessionId: `pr:${argsInput.prId}`,
            fileScopePattern: draft.fileScopePattern ?? null,
          })
        : null;
      writeLedger({
        sourceType: "pr_feedback",
        sourceKey,
        memoryId: memory?.id ?? null,
        episodeMemoryId: episodeId,
        metadata: {
          prId: argsInput.prId,
          path: comment.path ?? null,
          line: comment.line ?? null,
          source: comment.source,
        },
      });
    }

    for (const review of reviews) {
      const body = cleanText(review.body);
      if (!body) continue;
      const reviewFingerprint = hashText(`${review.reviewer}:${review.submittedAt ?? ""}:${body}`);
      const sourceKey = `review:${reviewFingerprint}`;
      if (readLedger("pr_feedback", sourceKey)) continue;
      const fallbackCategory = review.state === "changes_requested" ? "convention" : null;
      const draft = extractActionableDrafts(splitGuidanceLines(body), fallbackCategory)[0];
      if (!draft) continue;
      const memory = recordCandidate({
        sourceType: "pr_feedback",
        sourceKey,
        draft,
        sourceId: `pr:${argsInput.prId}:${sourceKey}`,
      });
      const episodeId = memory
        ? await saveCompanionEpisode({
            sourceType: "pr_feedback",
            sourceKey,
            sourceLabel: `PR review feedback for ${argsInput.prNumber ? `#${argsInput.prNumber}` : argsInput.prId}`,
            summary: draft.content,
            category: draft.category,
            sessionId: `pr:${argsInput.prId}`,
          })
        : null;
      writeLedger({
        sourceType: "pr_feedback",
        sourceKey,
        memoryId: memory?.id ?? null,
        episodeMemoryId: episodeId,
        metadata: {
          prId: argsInput.prId,
          reviewer: review.reviewer,
          state: review.state,
          submittedAt: review.submittedAt ?? null,
        },
      });
    }
  };

  return {
    captureResolvedIntervention,
    captureFailureGotcha,
    capturePrFeedback,
  };
}

export type KnowledgeCaptureService = ReturnType<typeof createKnowledgeCaptureService>;
