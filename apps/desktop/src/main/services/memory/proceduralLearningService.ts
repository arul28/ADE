import { randomUUID } from "node:crypto";
import type {
  EpisodicMemory,
  ProcedureDetail,
  ProcedureListItem,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nowIso, toMemoryEntryDto } from "../shared/utils";
import type { Memory, MemoryService } from "./memoryService";
import { parseEpisode as parseEpisodeContent } from "./episodeFormat";

type ProcedureDetailRow = {
  memory_id: string;
  trigger: string | null;
  procedure_markdown: string | null;
  success_count: number | null;
  failure_count: number | null;
  last_used_at: string | null;
  exported_skill_path: string | null;
  exported_at: string | null;
  superseded_by_memory_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProcedureHistoryRow = {
  id: string;
  procedure_memory_id: string;
  confidence: number | null;
  outcome: string | null;
  reason: string | null;
  recorded_at: string;
};

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ");
}

function toLineList(value: ReadonlyArray<string> | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))];
}

function isPrFeedbackEpisode(memory: Memory): boolean {
  return String(memory.sourceId ?? "").trim().startsWith("pr_feedback:");
}

function isLowSignalEpisode(episode: EpisodicMemory): boolean {
  const normalizedTask = normalizeText(episode.taskDescription ?? "");
  const normalizedApproach = normalizeText(episode.approachTaken ?? "");
  const combined = `${normalizedTask} ${normalizedApproach}`.trim();
  if (!combined.length) return true;
  if (
    combined.startsWith("preview deployment")
    || combined.startsWith("learn more about")
    || combined.includes("https vercel link github")
  ) {
    return true;
  }
  const signalCount =
    toLineList(episode.patternsDiscovered).length
    + toLineList(episode.decisionsMade).length
    + toLineList(episode.gotchas).length;
  return signalCount === 0 && combined.split(/\s+/).length < 8;
}

function parseEpisode(memoryContent: string): EpisodicMemory | null {
  return parseEpisodeContent(memoryContent) as EpisodicMemory | null;
}

function overlapScore(left: string[], right: string[]): number {
  const leftSet = new Set(left.map(normalizeText).filter((entry) => entry.length > 0));
  const rightSet = new Set(right.map(normalizeText).filter((entry) => entry.length > 0));
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) overlap += 1;
  }
  return overlap / Math.max(leftSet.size, rightSet.size);
}

function buildProcedureTrigger(episodes: EpisodicMemory[]): string {
  const patternCounts = new Map<string, number>();
  for (const episode of episodes) {
    for (const entry of [...episode.patternsDiscovered, ...episode.decisionsMade].map(normalizeText)) {
      if (!entry) continue;
      patternCounts.set(entry, (patternCounts.get(entry) ?? 0) + 1);
    }
  }
  const winner = [...patternCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
  return winner || normalizeText(episodes[0]?.taskDescription ?? "") || "repeated workflow";
}

function buildProcedureMarkdown(trigger: string, episodes: EpisodicMemory[]): string {
  const tools = toLineList(episodes.flatMap((episode) => episode.toolsUsed));
  const decisions = toLineList(episodes.flatMap((episode) => episode.decisionsMade));
  const gotchas = toLineList(episodes.flatMap((episode) => episode.gotchas));
  const patterns = toLineList(episodes.flatMap((episode) => episode.patternsDiscovered));
  const approaches = toLineList(episodes.map((episode) => episode.approachTaken));

  const lines: string[] = [
    `## Trigger`,
    trigger,
    "",
    "## Recommended Procedure",
    ...approaches.slice(0, 4).map((entry, index) => `${index + 1}. ${entry}`),
  ];

  if (tools.length > 0) {
    lines.push("", "## Useful Tools", ...tools.slice(0, 10).map((entry) => `- ${entry}`));
  }
  if (decisions.length > 0) {
    lines.push("", "## Key Decisions", ...decisions.slice(0, 8).map((entry) => `- ${entry}`));
  }
  if (patterns.length > 0) {
    lines.push("", "## Patterns", ...patterns.slice(0, 8).map((entry) => `- ${entry}`));
  }
  if (gotchas.length > 0) {
    lines.push("", "## Watch Outs", ...gotchas.slice(0, 8).map((entry) => `- ${entry}`));
  }

  return lines.join("\n").trim();
}

function buildProcedureContent(trigger: string, markdown: string): string {
  return `Trigger: ${trigger}\n\n${markdown}`.trim();
}


function procedureFromRows(memory: Memory, detailRow: ProcedureDetailRow | null, sourceEpisodeIds: string[]): ProcedureListItem {
  const successCount = Math.max(0, Number(detailRow?.success_count ?? 0) || 0);
  const failureCount = Math.max(0, Number(detailRow?.failure_count ?? 0) || 0);
  return {
    memory: toMemoryEntryDto(memory),
    procedural: {
      id: memory.id,
      trigger: detailRow?.trigger?.trim() || "repeated workflow",
      procedure: detailRow?.procedure_markdown?.trim() || memory.content,
      confidence: memory.confidence,
      successCount,
      failureCount,
      sourceEpisodeIds,
      lastUsed: detailRow?.last_used_at ?? null,
      createdAt: detailRow?.created_at ?? memory.createdAt,
    },
    exportedSkillPath: detailRow?.exported_skill_path ?? null,
    exportedAt: detailRow?.exported_at ?? null,
    supersededByMemoryId: detailRow?.superseded_by_memory_id ?? null,
  };
}

export function createProceduralLearningService(args: {
  db: AdeDb;
  projectId: string;
  logger?: Pick<Logger, "warn"> | null;
  memoryService: Pick<
    MemoryService,
    "getMemory" | "listMemories" | "addCandidateMemory" | "promoteMemory" | "archiveMemory" | "pinMemory" | "writeMemory"
  >;
  onProcedurePromoted?: (memoryId: string) => void;
}) {
  const { db, projectId, memoryService } = args;

  const ensureProcedureDetail = (input: {
    memoryId: string;
    trigger: string;
    procedureMarkdown: string;
    successCount?: number;
    failureCount?: number;
    lastUsedAt?: string | null;
  }): void => {
    const now = nowIso();
    db.run(
      `
        insert into memory_procedure_details(
          memory_id, trigger, procedure_markdown, success_count, failure_count,
          last_used_at, exported_skill_path, exported_at, superseded_by_memory_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
        on conflict(memory_id) do update set
          trigger = excluded.trigger,
          procedure_markdown = excluded.procedure_markdown,
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          last_used_at = excluded.last_used_at,
          updated_at = excluded.updated_at
      `,
      [
        input.memoryId,
        input.trigger,
        input.procedureMarkdown,
        Math.max(0, Math.floor(input.successCount ?? 0)),
        Math.max(0, Math.floor(input.failureCount ?? 0)),
        input.lastUsedAt ?? null,
        now,
        now,
      ],
    );
  };

  const addProcedureHistory = (input: {
    memoryId: string;
    confidence: number;
    outcome: "success" | "failure";
    reason: string;
  }): void => {
    db.run(
      `
        insert into memory_procedure_history(
          id, procedure_memory_id, confidence, outcome, reason, recorded_at
        ) values (?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), input.memoryId, input.confidence, input.outcome, input.reason, nowIso()],
    );
  };

  const listEpisodeMemories = () => {
    return memoryService
      .listMemories({
        projectId,
        scope: "project",
        categories: ["episode"],
        limit: 500,
      })
      .map((memory) => ({
        memory,
        episode: parseEpisode(memory.content),
      }))
      .filter((entry): entry is { memory: Memory; episode: EpisodicMemory } => Boolean(entry.episode));
  };

  const listProcedures = (input: {
    status?: "candidate" | "promoted" | "archived" | "all";
    scope?: "project" | "mission" | "agent";
    query?: string;
  } = {}): ProcedureListItem[] => {
    const procedures = memoryService.listMemories({
      projectId,
      scope: input.scope,
      ...(input.status && input.status !== "all" ? { status: input.status } : {}),
      categories: ["procedure"],
      limit: 500,
    });

    return procedures
      .filter((memory) => {
        if (!input.query || !input.query.trim()) return true;
        const needle = normalizeText(input.query);
        return normalizeText(memory.content).includes(needle);
      })
      .map((memory) => {
        const detail = db.get<ProcedureDetailRow>(
          `select * from memory_procedure_details where memory_id = ? limit 1`,
          [memory.id],
        );
        const sourceRows = db.all<{ episode_memory_id: string }>(
          `select episode_memory_id from memory_procedure_sources where procedure_memory_id = ?`,
          [memory.id],
        );
        return procedureFromRows(memory, detail, sourceRows.map((row) => row.episode_memory_id));
      })
      .sort((left, right) => {
        if (right.procedural.confidence !== left.procedural.confidence) return right.procedural.confidence - left.procedural.confidence;
        const leftApplications = left.procedural.successCount + left.procedural.failureCount;
        const rightApplications = right.procedural.successCount + right.procedural.failureCount;
        if (rightApplications !== leftApplications) return rightApplications - leftApplications;
        return right.memory.updatedAt.localeCompare(left.memory.updatedAt);
      });
  };

  const getProcedureDetail = (id: string): ProcedureDetail | null => {
    const memory = memoryService.getMemory(id);
    if (!memory || memory.category !== "procedure") return null;
    const detail = db.get<ProcedureDetailRow>(
      `select * from memory_procedure_details where memory_id = ? limit 1`,
      [id],
    );
    const sources = db.all<{ episode_memory_id: string }>(
      `select episode_memory_id from memory_procedure_sources where procedure_memory_id = ? order by episode_memory_id asc`,
      [id],
    );
    const historyRows = db.all<ProcedureHistoryRow>(
      `select * from memory_procedure_history where procedure_memory_id = ? order by recorded_at desc limit 50`,
      [id],
    );
    const summary = procedureFromRows(
      memory,
      detail,
      sources.map((row) => row.episode_memory_id),
    );
    return {
      ...summary,
      sourceEpisodes: sources
        .map((row) => memoryService.getMemory(row.episode_memory_id))
        .filter((entry): entry is Memory => Boolean(entry))
        .map((entry) => toMemoryEntryDto(entry)),
      confidenceHistory: historyRows.map((row) => {
        type Outcome = "success" | "failure" | "manual" | "observation";
        let outcome: Outcome;
        switch (row.outcome) {
          case "failure":
          case "manual":
          case "observation":
            outcome = row.outcome;
            break;
          default:
            outcome = "success";
        }
        return {
          id: row.id,
          confidence: Number(row.confidence ?? memory.confidence) || memory.confidence,
          outcome,
          reason: row.reason ?? null,
          recordedAt: row.recorded_at,
        };
      }),
    };
  };

  const updateProcedureOutcome = (input: {
    memoryId: string;
    outcome: "success" | "failure";
    reason: string;
  }): void => {
    const memory = memoryService.getMemory(input.memoryId);
    if (!memory || memory.category !== "procedure") return;
    if (memory.status === "archived") return;
    const detail = db.get<ProcedureDetailRow>(
      `select * from memory_procedure_details where memory_id = ? limit 1`,
      [input.memoryId],
    );
    const successCount = Math.max(0, Number(detail?.success_count ?? 0) || 0) + (input.outcome === "success" ? 1 : 0);
    const failureCount = Math.max(0, Number(detail?.failure_count ?? 0) || 0) + (input.outcome === "failure" ? 1 : 0);
    const applications = successCount + failureCount;
    const nextConfidence = input.outcome === "success"
      ? Math.min(0.99, memory.confidence + (1 - memory.confidence) * 0.15)
      : Math.max(0.01, memory.confidence * 0.7);

    memoryService.writeMemory({
      projectId: memory.projectId,
      scope: memory.scope,
      scopeOwnerId: memory.scopeOwnerId ?? undefined,
      tier: memory.tier,
      category: memory.category,
      content: memory.content,
      importance: memory.importance,
      confidence: nextConfidence,
      status: memory.status,
      pinned: memory.pinned,
      sourceSessionId: memory.sourceSessionId ?? undefined,
      sourcePackKey: memory.sourcePackKey ?? undefined,
      agentId: memory.agentId ?? undefined,
      sourceRunId: memory.sourceRunId ?? undefined,
      sourceType: memory.sourceType ?? undefined,
      sourceId: memory.sourceId ?? undefined,
      fileScopePattern: memory.fileScopePattern ?? undefined,
    });
    ensureProcedureDetail({
      memoryId: input.memoryId,
      trigger: detail?.trigger?.trim() || "repeated workflow",
      procedureMarkdown: detail?.procedure_markdown?.trim() || memory.content,
      successCount,
      failureCount,
      lastUsedAt: nowIso(),
    });
    addProcedureHistory({
      memoryId: input.memoryId,
      confidence: nextConfidence,
      outcome: input.outcome,
      reason: input.reason,
    });

    if (!memory.pinned && input.outcome === "success" && successCount >= 3 && nextConfidence >= 0.8) {
      memoryService.pinMemory(input.memoryId);
      memoryService.promoteMemory(input.memoryId);
      try { args.onProcedurePromoted?.(input.memoryId); } catch { /* best-effort */ }
    }
    if (!memory.pinned && applications >= 5 && nextConfidence < 0.3) {
      memoryService.archiveMemory(input.memoryId);
    }
  };

  const onEpisodeSaved = async (memoryId: string): Promise<void> => {
    const episodeMemory = memoryService.getMemory(memoryId);
    if (!episodeMemory || episodeMemory.category !== "episode") return;
    if (isPrFeedbackEpisode(episodeMemory)) return;
    const episode = parseEpisode(episodeMemory.content);
    if (!episode) return;
    if (isLowSignalEpisode(episode)) return;

    const allEpisodes = listEpisodeMemories();
    const matchableCurrentSignals = toLineList([...episode.patternsDiscovered, ...episode.decisionsMade]);
    if (matchableCurrentSignals.length === 0) return;

    const similarEpisodes = allEpisodes.filter((candidate) => {
      if (isPrFeedbackEpisode(candidate.memory)) return false;
      if (isLowSignalEpisode(candidate.episode)) return false;
      const sameId = candidate.memory.id === episodeMemory.id;
      if (sameId) return true;
      const overlap = overlapScore(
        matchableCurrentSignals,
        toLineList([...candidate.episode.patternsDiscovered, ...candidate.episode.decisionsMade]),
      );
      return overlap >= 0.34;
    });

    const distinctContextIds = new Set(
      similarEpisodes.map((candidate) => candidate.episode.missionId ?? candidate.episode.sessionId ?? candidate.memory.id),
    );
    if (distinctContextIds.size < 3) return;

    const trigger = buildProcedureTrigger(similarEpisodes.map((candidate) => candidate.episode));
    const markdown = buildProcedureMarkdown(trigger, similarEpisodes.map((candidate) => candidate.episode));
    const content = buildProcedureContent(trigger, markdown);
    const procedures = memoryService.listMemories({
      projectId,
      scope: "project",
      categories: ["procedure"],
      status: ["candidate", "promoted"],
      limit: 500,
    });
    const normalizedContent = normalizeText(content);
    const existingProcedure = procedures.find((memory) => {
      const detail = db.get<ProcedureDetailRow>(
        `select * from memory_procedure_details where memory_id = ? limit 1`,
        [memory.id],
      );
      const candidateText = normalizeText(detail?.procedure_markdown?.trim() || memory.content);
      return candidateText.includes(normalizedContent) || normalizedContent.includes(candidateText) || overlapScore([candidateText], [normalizedContent]) >= 0.55;
    });

    if (existingProcedure) {
      const existingDetail = db.get<ProcedureDetailRow>(
        `select * from memory_procedure_details where memory_id = ? limit 1`,
        [existingProcedure.id],
      );
      ensureProcedureDetail({
        memoryId: existingProcedure.id,
        trigger,
        procedureMarkdown: markdown,
        successCount: Number(existingDetail?.success_count ?? 0) || 0,
        failureCount: Number(existingDetail?.failure_count ?? 0) || 0,
        lastUsedAt: nowIso(),
      });
      db.run(
        `
          insert or ignore into memory_procedure_sources(
            procedure_memory_id, episode_memory_id
          ) values (?, ?)
        `,
        [existingProcedure.id, episodeMemory.id],
      );
      updateProcedureOutcome({
        memoryId: existingProcedure.id,
        outcome: episode.outcome === "failure" ? "failure" : "success",
        reason: `Episode ${episodeMemory.id} matched an existing procedure.`,
      });
      return;
    }

    const created = memoryService.addCandidateMemory({
      projectId,
      scope: "project",
      category: "procedure",
      content,
      importance: "medium",
      confidence: 0.55,
      sourceType: "system",
      sourceId: episodeMemory.id,
      sourceRunId: episode.missionId ?? undefined,
    });
    ensureProcedureDetail({
      memoryId: created.id,
      trigger,
      procedureMarkdown: markdown,
      successCount: episode.outcome === "failure" ? 0 : similarEpisodes.filter((candidate) => candidate.episode.outcome !== "failure").length,
      failureCount: similarEpisodes.filter((candidate) => candidate.episode.outcome === "failure").length,
      lastUsedAt: nowIso(),
    });
    for (const source of similarEpisodes) {
      db.run(
        `
          insert or ignore into memory_procedure_sources(
            procedure_memory_id, episode_memory_id
          ) values (?, ?)
        `,
        [created.id, source.memory.id],
      );
    }
    addProcedureHistory({
      memoryId: created.id,
      confidence: created.confidence,
      outcome: episode.outcome === "failure" ? "failure" : "success",
      reason: `Created from ${similarEpisodes.length} related episodes.`,
    });
  };

  const markExportedSkill = (memoryId: string, skillPath: string): void => {
    const detail = db.get<ProcedureDetailRow>(
      `select * from memory_procedure_details where memory_id = ? limit 1`,
      [memoryId],
    );
    ensureProcedureDetail({
      memoryId,
      trigger: detail?.trigger?.trim() || "repeated workflow",
      procedureMarkdown: detail?.procedure_markdown?.trim() || memoryService.getMemory(memoryId)?.content || "",
      successCount: Number(detail?.success_count ?? 0) || 0,
      failureCount: Number(detail?.failure_count ?? 0) || 0,
      lastUsedAt: detail?.last_used_at ?? null,
    });
    db.run(
      `
        update memory_procedure_details
        set exported_skill_path = ?, exported_at = ?, updated_at = ?
        where memory_id = ?
      `,
      [skillPath, nowIso(), nowIso(), memoryId],
    );
  };

  const updateProcedureOutcomes = (inputs: Array<{
    memoryId: string;
    outcome: "success" | "failure";
    reason: string;
  }>): void => {
    for (const input of inputs) {
      updateProcedureOutcome(input);
    }
  };

  const markProcedureSuperseded = (input: {
    memoryId: string;
    supersededByMemoryId: string;
    archive?: boolean;
  }): void => {
    const detail = db.get<ProcedureDetailRow>(
      `select * from memory_procedure_details where memory_id = ? limit 1`,
      [input.memoryId],
    );
    const memory = memoryService.getMemory(input.memoryId);
    if (!memory || memory.category !== "procedure") return;
    ensureProcedureDetail({
      memoryId: input.memoryId,
      trigger: detail?.trigger?.trim() || "repeated workflow",
      procedureMarkdown: detail?.procedure_markdown?.trim() || memory.content,
      successCount: Number(detail?.success_count ?? 0) || 0,
      failureCount: Number(detail?.failure_count ?? 0) || 0,
      lastUsedAt: detail?.last_used_at ?? null,
    });
    db.run(
      `
        update memory_procedure_details
        set superseded_by_memory_id = ?, updated_at = ?
        where memory_id = ?
      `,
      [input.supersededByMemoryId, nowIso(), input.memoryId],
    );
    if (input.archive !== false) {
      memoryService.archiveMemory(input.memoryId);
    }
  };

  return {
    onEpisodeSaved,
    listProcedures,
    getProcedureDetail,
    updateProcedureOutcome,
    updateProcedureOutcomes,
    markExportedSkill,
    markProcedureSuperseded,
  };
}

export type ProceduralLearningService = ReturnType<typeof createProceduralLearningService>;
