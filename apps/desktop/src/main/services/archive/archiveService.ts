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
import { readableHistoryBytes } from "../storage/historyCompression";
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
import { emptyArchiveCounts, isArchiveStale } from "../../../shared/archive";

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


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArchiveKind(value: unknown): value is ArchiveItemKind {
  return typeof value === "string" && (ARCHIVE_ITEM_KINDS as readonly string[]).includes(value);
}

function sessionKind(toolType: string | null): ArchiveItemKind {
  return isChatToolType(toolType) ? "chat" : "shell";
}

async function transcriptBytes(filePath: string | null): Promise<number | null> {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  return trimmed ? readableHistoryBytes(trimmed) : null;
}

async function pathExists(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function nonNegativeDays(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * The one parser for archive input from any transport (IPC, action domain,
 * sync). Unknown kinds are kept, not dropped, so `restore`/`delete` report them
 * per item instead of silently doing less than asked.
 */
function parseArchiveListArgs(raw: unknown): ArchiveListArgs {
  const record = asRecord(raw);
  const kinds = Array.isArray(record.kinds) ? record.kinds.filter(isArchiveKind) : [];
  const olderThanDays = nonNegativeDays(record.olderThanDays);
  return {
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(olderThanDays !== undefined ? { olderThanDays } : {}),
  };
}

function parseArchiveSummaryArgs(raw: unknown): ArchiveSummaryArgs {
  const olderThanDays = nonNegativeDays(asRecord(raw).olderThanDays);
  return olderThanDays !== undefined ? { olderThanDays } : {};
}

function parseArchiveActionArgs(raw: unknown): ArchiveActionArgs {
  const record = asRecord(raw);
  const items = Array.isArray(record.items) ? record.items.map(asRecord) : [];
  return {
    items: items.map((item) => ({
      // Validated per item by `requireArchived`, which names a bad kind.
      kind: String(item.kind ?? "") as ArchiveItemKind,
      id: typeof item.id === "string" ? item.id.trim() : "",
    })),
    ...(record.force === true ? { force: true } : {}),
  };
}

export function createArchiveService(deps: ArchiveServiceDeps) {
  const listArchivedLanes = async (): Promise<ArchivedItem[]> => {
    const lanes = await deps.laneService.list({ includeArchived: true, includeStatus: false });
    const archived = lanes.filter((lane): lane is typeof lane & { archivedAt: string } => Boolean(lane.archivedAt));
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
    return Promise.all(archived.map(async (lane): Promise<ArchivedItem> => {
      const worktreePresent = await pathExists(lane.worktreePath);
      return {
        kind: "lane",
        id: lane.id,
        title: lane.name,
        laneId: lane.id,
        laneName: lane.name,
        laneColor: lane.color ?? null,
        archivedAt: lane.archivedAt,
        sizeBytes: worktreePresent ? knownBytes.get(lane.id) ?? null : null,
        worktreePresent,
        branchRef: lane.branchRef || null,
      };
    }));
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

  const toSessionItem = async (row: ArchivedSessionRow): Promise<ArchivedItem> => {
    const kind = sessionKind(row.toolType);
    return {
      kind,
      id: row.id,
      title: row.title?.trim() || (kind === "chat" ? "Chat" : "Shell"),
      laneId: row.laneId ?? null,
      laneName: row.laneName ?? null,
      laneColor: row.laneColor ?? null,
      archivedAt: row.archivedAt,
      sizeBytes: await transcriptBytes(row.transcriptPath),
      toolType: row.toolType ?? null,
      ...(kind === "shell" ? { parentChatId: row.chatSessionId ?? null } : {}),
    };
  };

  const list = async (raw?: unknown): Promise<ArchiveListResult> => {
    const args = parseArchiveListArgs(raw);
    const kinds = new Set<ArchiveItemKind>(args.kinds ?? ARCHIVE_ITEM_KINDS);
    const items: ArchivedItem[] = [];
    if (kinds.has("lane")) items.push(...(await listArchivedLanes()));
    if (kinds.has("chat") || kinds.has("shell")) {
      const rows = readArchivedSessions().filter((row) => kinds.has(sessionKind(row.toolType)));
      items.push(...(await Promise.all(rows.map(toSessionItem))));
    }
    const { olderThanDays } = args;
    const filtered = olderThanDays !== undefined && olderThanDays > 0
      ? items.filter((item) => isArchiveStale(item.archivedAt, olderThanDays))
      : items;
    filtered.sort((a, b) => (Date.parse(b.archivedAt) || 0) - (Date.parse(a.archivedAt) || 0));
    return { items: filtered };
  };

  const summary = async (raw?: unknown): Promise<ArchiveSummary> => {
    const olderThanDays = parseArchiveSummaryArgs(raw).olderThanDays ?? DEFAULT_ARCHIVE_STALE_DAYS;
    const nowMs = Date.now();
    const { items } = await list();
    const byKind = emptyArchiveCounts();
    const staleByKind = emptyArchiveCounts();
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
      if (!isArchiveStale(item.archivedAt, olderThanDays, nowMs)) continue;
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

  /** Archived-at by lane id, read once per batch rather than once per lane. */
  type LaneArchiveIndex = () => Promise<Map<string, string | null>>;
  const laneArchiveIndex = (): LaneArchiveIndex => {
    let pending: Promise<Map<string, string | null>> | null = null;
    return () => {
      pending ??= deps.laneService
        .list({ includeArchived: true, includeStatus: false })
        .then((lanes) => new Map(lanes.map((lane) => [lane.id, lane.archivedAt ?? null])));
      return pending;
    };
  };

  /** The archived item behind a ref, or an error naming why it is not one. */
  const requireArchived = async (ref: ArchiveItemRef, lanes: LaneArchiveIndex): Promise<void> => {
    if (!isArchiveKind(ref.kind)) throw new Error(`Unknown archive kind '${String(ref.kind)}'.`);
    if (!ref.id) throw new Error("Item id is required.");
    if (ref.kind === "lane") {
      const index = await lanes();
      if (!index.has(ref.id)) throw new Error(`Lane '${ref.id}' not found.`);
      if (!index.get(ref.id)) throw new Error(`Lane '${ref.id}' is not archived.`);
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

  const restoreOne = async (ref: ArchiveItemRef, lanes: LaneArchiveIndex): Promise<void> => {
    await requireArchived(ref, lanes);
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

  const deleteOne = async (ref: ArchiveItemRef, lanes: LaneArchiveIndex, force: boolean): Promise<void> => {
    await requireArchived(ref, lanes);
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
    run: (ref: ArchiveItemRef, lanes: LaneArchiveIndex) => Promise<void>,
  ): Promise<ArchiveActionResult> => {
    const result: ArchiveActionResult = { done: [], failed: [] };
    const lanes = laneArchiveIndex();
    for (const ref of args.items) {
      try {
        await run(ref, lanes);
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
    restore: (raw?: unknown) => runEach(parseArchiveActionArgs(raw), "restore", restoreOne),
    delete: (raw?: unknown) => {
      const args = parseArchiveActionArgs(raw);
      return runEach(args, "delete", (ref, lanes) => deleteOne(ref, lanes, args.force === true));
    },
  };
}

export type ArchiveService = ReturnType<typeof createArchiveService>;
