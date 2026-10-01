import fs from "node:fs";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createPtyService } from "../pty/ptyService";
import type { createAgentChatService } from "../chat/agentChatService";
import {
  buildLaneEnvTeardown,
  releaseLaneRuntimeResources,
  restoreUnarchivedLaneRuntime,
} from "../lanes/laneRuntimeLifecycle";
import { deleteTerminalSessionWithRuntimeCleanup } from "../sessions/deleteTerminalSession";
import { resolveReadableHistoryPath } from "../storage/historyCompression";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import {
  ARCHIVE_ITEM_KINDS,
  DEFAULT_ARCHIVE_STALE_DAYS,
  type ArchiveActionArgs,
  type ArchiveActionResult,
  type ArchiveItemKind,
  type ArchiveItemRef,
  type ArchiveListArgs,
  type ArchiveListResult,
  type ArchiveSummary,
  type ArchiveSummaryArgs,
  type ArchivedItem,
} from "../../../shared/types/archive";

type LaneRuntimeDependencies = Parameters<typeof restoreUnarchivedLaneRuntime>[0];

/**
 * Everything the archive needs, as each host already holds it: the Electron
 * IPC context, the action registry's runtime, and the sync host all carry
 * these fields under these names, so each passes itself in.
 */
export type ArchiveServiceDeps = Omit<LaneRuntimeDependencies, "laneService"> & {
  db: AdeDb;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  agentChatService?: Pick<ReturnType<typeof createAgentChatService>, "unarchiveSession" | "deleteSession"> | null;
  laneProxyService?: { removeRoute: (laneId: string) => unknown } | null;
};

type ArchivedSessionRow = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  laneColor: string | null;
  title: string | null;
  toolType: string | null;
  archivedAt: string;
  transcriptPath: string | null;
  chatSessionId: string | null;
};

const DAY_MS = 24 * 60 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArchiveKind(value: unknown): value is ArchiveItemKind {
  return typeof value === "string" && (ARCHIVE_ITEM_KINDS as readonly string[]).includes(value);
}

function sessionKind(toolType: string | null): ArchiveItemKind {
  return isChatToolType(toolType) ? "chat" : "shell";
}

function fileBytes(filePath: string | null): number | null {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) return null;
  try {
    const readable = resolveReadableHistoryPath(trimmed);
    if (!readable) return null;
    return fs.statSync(readable).size;
  } catch {
    return null;
  }
}

function pathExists(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function emptyCounts(): Record<ArchiveItemKind, number> {
  return { lane: 0, chat: 0, shell: 0 };
}

function normalizeRefs(args: ArchiveActionArgs | null | undefined): ArchiveItemRef[] {
  const items = Array.isArray(args?.items) ? args.items : [];
  return items.map((item) => ({
    kind: item?.kind as ArchiveItemKind,
    id: typeof item?.id === "string" ? item.id.trim() : "",
  }));
}

export function createArchiveService(deps: ArchiveServiceDeps) {
  const listArchivedLanes = async (): Promise<ArchivedItem[]> => {
    const lanes = await deps.laneService.list({ includeArchived: true, includeStatus: false });
    const archived = lanes.filter((lane) => Boolean(lane.archivedAt));
    if (archived.length === 0) return [];
    const knownBytes = new Map<string, number>();
    try {
      // Written by storage insights when it measures or reclaims a worktree.
      // Zero means "never measured", not "empty".
      const rows = deps.db.all<{ laneId: string; bytes: number }>(
        "select lane_id as laneId, last_known_bytes as bytes from local_lane_storage_state where last_known_bytes > 0",
      );
      for (const row of rows) knownBytes.set(row.laneId, Number(row.bytes));
    } catch {
      // Older databases without the table: sizes stay unknown.
    }
    return archived.map((lane): ArchivedItem => {
      const worktreePresent = pathExists(lane.worktreePath);
      return {
        kind: "lane",
        id: lane.id,
        title: lane.name,
        laneId: lane.id,
        laneName: lane.name,
        laneColor: lane.color ?? null,
        archivedAt: lane.archivedAt as string,
        sizeBytes: worktreePresent ? knownBytes.get(lane.id) ?? null : null,
        worktreePresent,
        branchRef: lane.branchRef || null,
      };
    });
  };

  const readArchivedSessions = (sessionId?: string): ArchivedSessionRow[] =>
    deps.db.all<ArchivedSessionRow>(
      `
        select s.id as id,
               s.lane_id as laneId,
               l.name as laneName,
               l.color as laneColor,
               s.title as title,
               s.tool_type as toolType,
               s.archived_at as archivedAt,
               s.transcript_path as transcriptPath,
               s.chat_session_id as chatSessionId
          from terminal_sessions s
          left join lanes l on l.id = s.lane_id
         where s.archived_at is not null
           ${sessionId ? "and s.id = ?" : ""}
      `,
      sessionId ? [sessionId] : [],
    );

  const toSessionItem = (row: ArchivedSessionRow): ArchivedItem => {
    const kind = sessionKind(row.toolType);
    return {
      kind,
      id: row.id,
      title: row.title?.trim() || (kind === "chat" ? "Chat" : "Shell"),
      laneId: row.laneId ?? null,
      laneName: row.laneName ?? null,
      laneColor: row.laneColor ?? null,
      archivedAt: row.archivedAt,
      sizeBytes: fileBytes(row.transcriptPath),
      toolType: row.toolType ?? null,
      ...(kind === "shell" ? { parentChatId: row.chatSessionId ?? null } : {}),
    };
  };

  const list = async (args: ArchiveListArgs = {}): Promise<ArchiveListResult> => {
    const requested = Array.isArray(args?.kinds) ? args.kinds.filter(isArchiveKind) : [];
    const kinds = new Set<ArchiveItemKind>(requested.length > 0 ? requested : ARCHIVE_ITEM_KINDS);
    const items: ArchivedItem[] = [];
    if (kinds.has("lane")) items.push(...(await listArchivedLanes()));
    if (kinds.has("chat") || kinds.has("shell")) {
      for (const row of readArchivedSessions()) {
        if (kinds.has(sessionKind(row.toolType))) items.push(toSessionItem(row));
      }
    }
    const olderThanDays = Number(args?.olderThanDays);
    const filtered = Number.isFinite(olderThanDays) && olderThanDays > 0
      ? items.filter((item) => {
        const archivedMs = Date.parse(item.archivedAt);
        return Number.isFinite(archivedMs) && archivedMs <= Date.now() - olderThanDays * DAY_MS;
      })
      : items;
    filtered.sort((a, b) => (Date.parse(b.archivedAt) || 0) - (Date.parse(a.archivedAt) || 0));
    return { items: filtered };
  };

  const summary = async (args: ArchiveSummaryArgs = {}): Promise<ArchiveSummary> => {
    const requestedDays = Number(args?.olderThanDays);
    const olderThanDays = Number.isFinite(requestedDays) && requestedDays >= 0
      ? requestedDays
      : DEFAULT_ARCHIVE_STALE_DAYS;
    const cutoff = Date.now() - olderThanDays * DAY_MS;
    const { items } = await list();
    const byKind = emptyCounts();
    const staleByKind = emptyCounts();
    let staleTotal = 0;
    let staleBytes: number | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    let oldestArchivedAt: string | null = null;
    for (const item of items) {
      byKind[item.kind] += 1;
      const archivedMs = Date.parse(item.archivedAt);
      if (Number.isFinite(archivedMs) && archivedMs < oldestMs) {
        oldestMs = archivedMs;
        oldestArchivedAt = item.archivedAt;
      }
      if (!Number.isFinite(archivedMs) || archivedMs > cutoff) continue;
      staleTotal += 1;
      staleByKind[item.kind] += 1;
      if (typeof item.sizeBytes === "number") staleBytes = (staleBytes ?? 0) + item.sizeBytes;
    }
    return {
      total: items.length,
      byKind,
      olderThanDays,
      staleTotal,
      staleByKind,
      staleBytes,
      oldestArchivedAt,
    };
  };

  /** The archived item behind a ref, or an error naming why it is not one. */
  const requireArchived = async (ref: ArchiveItemRef): Promise<void> => {
    if (!isArchiveKind(ref.kind)) throw new Error(`Unknown archive kind '${String(ref.kind)}'.`);
    if (!ref.id) throw new Error("Item id is required.");
    if (ref.kind === "lane") {
      const lanes = await deps.laneService.list({ includeArchived: true, includeStatus: false });
      const lane = lanes.find((entry) => entry.id === ref.id);
      if (!lane) throw new Error(`Lane '${ref.id}' not found.`);
      if (!lane.archivedAt) throw new Error(`Lane '${ref.id}' is not archived.`);
      return;
    }
    const row = readArchivedSessions(ref.id)[0];
    if (!row) {
      const exists = deps.sessionService.get(ref.id);
      throw new Error(exists ? `${ref.kind === "chat" ? "Chat" : "Shell"} '${ref.id}' is not archived.` : `Session '${ref.id}' not found.`);
    }
    const actual = sessionKind(row.toolType);
    if (actual !== ref.kind) throw new Error(`Session '${ref.id}' is a ${actual}, not a ${ref.kind}.`);
  };

  const requireChatService = () => {
    if (!deps.agentChatService) throw new Error("Agent chat service is not available on this machine.");
    return deps.agentChatService;
  };

  const restoreOne = async (ref: ArchiveItemRef): Promise<void> => {
    await requireArchived(ref);
    if (ref.kind === "lane") {
      const result = await deps.laneService.unarchive({ laneId: ref.id });
      try {
        await restoreUnarchivedLaneRuntime(deps, ref.id, {
          worktreeRecreated: result.worktreeRecreated === true,
          onDockerError: (error) => {
            deps.logger?.warn("archive.restore.lane_docker_failed", { laneId: ref.id, error: errorMessage(error) });
          },
        });
      } catch (error) {
        // The lane is back; only its environment setup failed. Same as `lanes.unarchive`.
        deps.logger?.warn("archive.restore.lane_setup_failed", { laneId: ref.id, error: errorMessage(error) });
      }
      return;
    }
    if (ref.kind === "chat") {
      await requireChatService().unarchiveSession({ sessionId: ref.id });
      return;
    }
    deps.sessionService.unarchiveSession(ref.id);
  };

  const deleteOne = async (ref: ArchiveItemRef, force: boolean): Promise<void> => {
    await requireArchived(ref);
    if (ref.kind === "lane") {
      const teardownEnv = await buildLaneEnvTeardown(deps, ref.id, { includeArchived: true });
      // The branch is kept: a delete from the archive removes the lane and its
      // worktree, never the commits.
      await deps.laneService.delete(
        { laneId: ref.id, deleteBranch: false, deleteRemoteBranch: false, ...(force ? { force: true } : {}) },
        { teardownEnv },
      );
      releaseLaneRuntimeResources(deps, ref.id);
      return;
    }
    if (ref.kind === "chat") {
      await requireChatService().deleteSession({ sessionId: ref.id });
      return;
    }
    deleteTerminalSessionWithRuntimeCleanup({
      sessionId: ref.id,
      sessionService: deps.sessionService,
      ptyService: deps.ptyService,
    });
  };

  const runEach = async (
    args: ArchiveActionArgs,
    action: string,
    run: (ref: ArchiveItemRef) => Promise<void>,
  ): Promise<ArchiveActionResult> => {
    const result: ArchiveActionResult = { done: [], failed: [] };
    for (const ref of normalizeRefs(args)) {
      try {
        await run(ref);
        result.done.push({ kind: ref.kind, id: ref.id });
      } catch (error) {
        const message = errorMessage(error);
        deps.logger?.warn(`archive.${action}.item_failed`, { kind: ref.kind, id: ref.id, error: message });
        result.failed.push({ kind: ref.kind, id: ref.id, error: message });
      }
    }
    return result;
  };

  return {
    list,
    summary,
    restore: (args: ArchiveActionArgs) => runEach(args, "restore", restoreOne),
    delete: (args: ArchiveActionArgs) => runEach(args, "delete", (ref) => deleteOne(ref, args?.force === true)),
  };
}

export type ArchiveService = ReturnType<typeof createArchiveService>;
