import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { parseEpisode, formatEpisodeContent } from "./episodeFormat";

type CreateMemoryRepairServiceArgs = {
  db: AdeDb;
  projectId: string;
  logger?: Pick<Logger, "info" | "warn"> | null;
};

type MemoryRow = {
  id: string;
  category: string | null;
  content: string | null;
  source_id: string | null;
  status: string | null;
};

type LedgerRow = {
  memory_id: string | null;
  episode_memory_id: string | null;
};

type ProcedureSourceRow = {
  procedure_memory_id: string;
  episode_memory_id: string;
};

export type MemoryRepairResult = {
  repairedLegacyEpisodes: number;
  archivedPrFeedbackEpisodes: number;
  archivedLowValuePrFeedbackMemories: number;
  archivedDerivedProcedures: number;
};

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function archiveLooksDerivableFromCommit(content: string): boolean {
  return /^fixed in [0-9a-f]{7,}\b/i.test(cleanText(content));
}

function archiveLooksLikeGenericLinkNudge(content: string): boolean {
  const normalized = normalizeText(content);
  if (!normalized.length) return false;
  if (
    normalized.startsWith("preview deployment for your docs")
    || normalized.startsWith("learn more about ")
    || normalized.startsWith("read more about ")
    || normalized.startsWith("see more at ")
    || normalized.startsWith("click here ")
  ) {
    return true;
  }

  const withoutUrls = normalized.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = withoutUrls.split(/\s+/).filter(Boolean).length;
  return /https?:\/\//.test(content) && wordCount <= 8;
}

function isLowValuePrFeedbackContent(content: string): boolean {
  return archiveLooksDerivableFromCommit(content) || archiveLooksLikeGenericLinkNudge(content);
}

export type MemoryRepairService = ReturnType<typeof createMemoryRepairService>;

export function createMemoryRepairService(args: CreateMemoryRepairServiceArgs) {
  const { db, projectId, logger } = args;

  function archiveMemory(id: string): void {
    db.run(
      `
        update unified_memories
           set status = 'archived',
               tier = 3,
               pinned = 0,
               updated_at = ?
         where id = ?
           and project_id = ?
           and status != 'archived'
      `,
      [new Date().toISOString(), id, projectId],
    );
  }

  function runRepair(): MemoryRepairResult {
    const result: MemoryRepairResult = {
      repairedLegacyEpisodes: 0,
      archivedPrFeedbackEpisodes: 0,
      archivedLowValuePrFeedbackMemories: 0,
      archivedDerivedProcedures: 0,
    };

    const prFeedbackRows = db.all<LedgerRow>(
      `
        select memory_id, episode_memory_id
        from memory_capture_ledger
        where project_id = ?
          and source_type = 'pr_feedback'
      `,
      [projectId],
    );

    const prFeedbackMemoryIds = new Set(
      prFeedbackRows.map((row) => cleanText(row.memory_id)).filter((value) => value.length > 0),
    );
    const prFeedbackEpisodeIds = new Set(
      prFeedbackRows.map((row) => cleanText(row.episode_memory_id)).filter((value) => value.length > 0),
    );

    const episodeRows = db.all<MemoryRow>(
      `
        select id, category, content, source_id, status
        from unified_memories
        where project_id = ?
          and category = 'episode'
      `,
      [projectId],
    );

    for (const row of episodeRows) {
      const id = cleanText(row.id);
      const content = String(row.content ?? "");
      const legacyEpisode = parseEpisode(content);
      if (legacyEpisode) {
        db.run(
          `
            update unified_memories
               set content = ?,
                   updated_at = ?
             where id = ?
               and project_id = ?
          `,
          [formatEpisodeContent(legacyEpisode), new Date().toISOString(), id, projectId],
        );
        result.repairedLegacyEpisodes += 1;
      }

      if (prFeedbackEpisodeIds.has(id) || normalizeText(row.source_id).startsWith("pr_feedback:")) {
        if (normalizeText(row.status) !== "archived") {
          archiveMemory(id);
          result.archivedPrFeedbackEpisodes += 1;
        }
      }
    }

    const prFeedbackMemories = db.all<MemoryRow>(
      `
        select id, category, content, source_id, status
        from unified_memories
        where project_id = ?
          and status != 'archived'
      `,
      [projectId],
    );

    for (const row of prFeedbackMemories) {
      const id = cleanText(row.id);
      if (!prFeedbackMemoryIds.has(id)) continue;
      if (String(row.category ?? "") === "episode") continue;
      if (!isLowValuePrFeedbackContent(String(row.content ?? ""))) continue;
      archiveMemory(id);
      result.archivedLowValuePrFeedbackMemories += 1;
    }

    const procedureSources = db.all<ProcedureSourceRow>(
      `
        select procedure_memory_id, episode_memory_id
        from memory_procedure_sources
      `,
    );
    const procedureEpisodeMap = new Map<string, string[]>();
    for (const row of procedureSources) {
      const procedureId = cleanText(row.procedure_memory_id);
      const episodeId = cleanText(row.episode_memory_id);
      if (!procedureId || !episodeId) continue;
      const bucket = procedureEpisodeMap.get(procedureId) ?? [];
      bucket.push(episodeId);
      procedureEpisodeMap.set(procedureId, bucket);
    }

    const procedureRows = db.all<MemoryRow>(
      `
        select id, category, content, source_id, status
        from unified_memories
        where project_id = ?
          and category = 'procedure'
          and status != 'archived'
      `,
      [projectId],
    );

    for (const row of procedureRows) {
      const id = cleanText(row.id);
      const sourceEpisodes = procedureEpisodeMap.get(id) ?? [];
      const onlyPrFeedbackEpisodes = sourceEpisodes.length > 0 && sourceEpisodes.every((episodeId) => prFeedbackEpisodeIds.has(episodeId));
      if (!onlyPrFeedbackEpisodes && !isLowValuePrFeedbackContent(String(row.content ?? ""))) continue;
      archiveMemory(id);
      result.archivedDerivedProcedures += 1;
    }

    const totalChanges =
      result.repairedLegacyEpisodes
      + result.archivedPrFeedbackEpisodes
      + result.archivedLowValuePrFeedbackMemories
      + result.archivedDerivedProcedures;

    if (totalChanges > 0) {
      logger?.info?.("memory.repair.completed", {
        projectId,
        ...result,
      });
    }

    return result;
  }

  return {
    runRepair,
  };
}
