import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import type {
  SyncRosterChat,
  SyncRosterChatStatus,
  SyncRosterLane,
  SyncRosterProject,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";

// Anchor builtin resolution to the active runtime, mirroring kvDb / the cheap
// cross-project read in recentProjectSummary.ts. The roster opens each
// project's `.ade/ade.db` read-only with `node:sqlite` — NO cr-sqlite, NO
// runtime boot — so an all-projects feed never has to activate every project.
type DatabaseSyncConstructor = new (dbPath: string, options?: { allowExtension?: boolean }) => DatabaseSyncType;
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

const PREVIEW_MAX_CHARS = 120;

// --- Narrow structural inputs (the concrete ProjectRegistry / ----------------
// ProjectScopeRegistry satisfy these; keeping them structural lets the unit
// tests seed a project dir + a stub scope registry without a runtime). --------

export type RosterProjectRecord = {
  projectId: string;
  rootPath: string;
  displayName: string;
  lastOpenedAt: number;
};

export type RosterProjectRegistry = {
  list(): RosterProjectRecord[];
};

export type RosterLiveSession = {
  sessionId: string;
  status: "active" | "idle" | "ended";
  awaitingInput?: boolean;
  provider?: string | null;
  model?: string | null;
  lastActivityAt?: string | null;
};

export type RosterAgentChatService = {
  listSessions(
    laneId?: string,
    options?: { includeArchived?: boolean },
  ): Promise<RosterLiveSession[]>;
};

export type RosterBootedScope = {
  runtime: { agentChatService?: RosterAgentChatService | null };
};

export type RosterScopeRegistry = {
  /** Non-booting lookup; null when the project is not currently booted. */
  getIfBooted(projectId: string): Promise<RosterBootedScope> | null;
};

export type BuildRosterSnapshotArgs = {
  projectRegistry: RosterProjectRegistry;
  scopeRegistry: RosterScopeRegistry;
  /** The host's own project is always booted — included with live fidelity. */
  hostProjectId?: string | null;
  logger?: Pick<Logger, "warn"> | null;
};

// --- Raw DB row shapes -------------------------------------------------------

type LaneRow = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  lane_type: string | null;
  branch_ref: string | null;
  worktree_path: string | null;
  attached_root_path: string | null;
  status: string | null;
  archived_at: string | null;
  created_at: string | null;
};

type TerminalSessionRow = {
  id: string;
  lane_id: string;
  chat_session_id: string | null;
  tool_type: string | null;
  title: string | null;
  status: string | null;
  last_output_preview: string | null;
  last_output_at: string | null;
  pinned: number | null;
  exit_code: number | null;
  started_at: string | null;
};

type DiskProjectData = {
  lanes: LaneRow[];
  chats: TerminalSessionRow[];
};

// --- Helpers -----------------------------------------------------------------

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

// A lane is renderable only if its worktree still exists on disk — mirrors
// `laneExistsOnDisk` in recentProjectSummary.ts so the roster never advertises
// lanes whose worktree was deleted out from under ADE.
function laneExistsOnDisk(row: LaneRow, projectRoot: string): boolean {
  if ((row.lane_type ?? "").trim() === "primary") {
    return fs.existsSync(projectRoot);
  }
  const candidate = normalizePath(row.worktree_path) ?? normalizePath(row.attached_root_path);
  return candidate ? fs.existsSync(candidate) : false;
}

function hasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db
      .prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get<{ present?: number }>(tableName)?.present,
  );
}

function hasColumn(db: DatabaseSyncType, tableName: string, columnName: string): boolean {
  return db
    .prepare(`pragma table_info(${tableName})`)
    .all<{ name?: string }>()
    .some((row) => row.name === columnName);
}

function truncatePreview(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : trimmed;
}

function normalizedToolType(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRosterTopLevelToolType(toolType: string | null | undefined): boolean {
  const raw = normalizedToolType(toolType);
  if (!raw) return false;
  if (raw === "codex-chat" || raw === "claude-chat" || raw === "opencode-chat" || raw === "cursor") {
    return true;
  }
  return raw.endsWith("-chat");
}

function normalizedParentSessionId(row: TerminalSessionRow): string | null {
  const parentId = row.chat_session_id?.trim() ?? "";
  if (!parentId || parentId === row.id) return null;
  return parentId;
}

function desktopVisibleRosterRows(rows: TerminalSessionRow[], visibleLaneIds: Set<string>): TerminalSessionRow[] {
  const scopedRows = rows.filter((row) => visibleLaneIds.has(row.lane_id));
  const topLevelIds = new Set(
    scopedRows
      .filter((row) => isRosterTopLevelToolType(row.tool_type))
      .map((row) => row.id),
  );

  return scopedRows.filter((row) => {
    if (isRosterTopLevelToolType(row.tool_type)) return true;
    const parentId = normalizedParentSessionId(row);
    return parentId != null && topLevelIds.has(parentId);
  });
}

/**
 * Read a project's lanes + chat sessions straight off disk (read-only). Never
 * throws: a missing, locked, or schema-shifted DB yields empty lanes/chats so
 * the project still appears in the roster (just without rows).
 */
function readProjectFromDisk(projectRoot: string, logger?: Pick<Logger, "warn"> | null): DiskProjectData {
  const empty: DiskProjectData = { lanes: [], chats: [] };
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!fs.existsSync(dbPath)) return empty;

  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 2000");
    if (!hasTable(db, "lanes")) return empty;

    const lanes = db
      .prepare(
        `
          select id, name, color, icon, lane_type, branch_ref,
                 worktree_path, attached_root_path, status, archived_at, created_at
          from lanes
          where coalesce(status, 'active') != 'archived'
            and archived_at is null
        `,
      )
      .all<LaneRow>();

    const chats = hasTable(db, "terminal_sessions")
      ? (() => {
          const activeDb = db!;
          const chatSessionIdColumn = hasColumn(activeDb, "terminal_sessions", "chat_session_id")
            ? "chat_session_id"
            : "null as chat_session_id";
          return activeDb
            .prepare(
              `
                select id, lane_id, ${chatSessionIdColumn}, tool_type, title, status, last_output_preview,
                       last_output_at, pinned, exit_code, started_at
                from terminal_sessions
                where archived_at is null
              `,
            )
            .all<TerminalSessionRow>();
        })()
      : [];

    return { lanes, chats };
  } catch (error) {
    logger?.warn?.("sync_host.roster_project_read_failed", {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  } finally {
    db?.close();
  }
}

type Sidecar = {
  provider?: string | null;
  model?: string | null;
  awaitingInput?: boolean;
};

// Best-effort read of a chat's persisted sidecar for provider/model/awaiting.
// A missing or unparsable sidecar leaves those fields null — never throws.
function readChatSidecar(chatSessionsDir: string, sessionId: string): Sidecar | null {
  try {
    const raw = fs.readFileSync(path.join(chatSessionsDir, `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      awaitingInput: parsed.awaitingInput === true,
    };
  } catch {
    return null;
  }
}

// Disk-only status (un-booted project): the truthful persisted state. `running`
// collapses to `idle` because no live runtime is streaming the turn.
function diskChatStatus(row: TerminalSessionRow, sidecarAwaiting: boolean): SyncRosterChatStatus {
  if (sidecarAwaiting) return "awaiting";
  const status = (row.status ?? "").trim();
  if (status !== "running" && row.exit_code != null && row.exit_code !== 0) return "failed";
  return status === "running" ? "idle" : "ended";
}

// Live status from a booted scope's agentChatService — true running/awaiting.
function liveChatStatus(live: RosterLiveSession): SyncRosterChatStatus {
  if (live.awaitingInput) return "awaiting";
  if (live.status === "active") return "running";
  if (live.status === "idle") return "idle";
  return "ended";
}

function mapLane(row: LaneRow): SyncRosterLane {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    laneType: row.lane_type,
    branchRef: row.branch_ref,
  };
}

// Primary lane first, then oldest-created first, then name — loosely mirrors
// `sortWorkLanesForTabs` (primary pinned to the front of the tab strip).
function compareLanes(left: LaneRow, right: LaneRow): number {
  const leftPrimary = (left.lane_type ?? "").trim() === "primary" ? 0 : 1;
  const rightPrimary = (right.lane_type ?? "").trim() === "primary" ? 0 : 1;
  if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
  const createdDelta = (left.created_at ?? "").localeCompare(right.created_at ?? "");
  if (createdDelta !== 0) return createdDelta;
  return left.name.localeCompare(right.name);
}

async function buildRosterProject(
  record: RosterProjectRecord,
  scopeRegistry: RosterScopeRegistry,
  logger?: Pick<Logger, "warn"> | null,
): Promise<SyncRosterProject> {
  const disk = readProjectFromDisk(record.rootPath, logger);
  const chatSessionsDir = resolveAdeLayout(record.rootPath).chatSessionsDir;

  // Path A overlay: only for projects already booted on the runtime. NEVER
  // boots a scope (getIfBooted is non-booting). When booted, listSessions()
  // carries true running/awaiting fidelity keyed by sessionId.
  const liveBySessionId = new Map<string, RosterLiveSession>();
  let booted = false;
  try {
    const scope = await scopeRegistry.getIfBooted(record.projectId)?.catch(() => null);
    const agentChatService = scope?.runtime.agentChatService;
    if (agentChatService) {
      booted = true;
      const liveSessions = await agentChatService
        .listSessions(undefined, { includeArchived: false })
        .catch(() => [] as RosterLiveSession[]);
      for (const live of liveSessions) {
        if (live?.sessionId) liveBySessionId.set(live.sessionId, live);
      }
    }
  } catch {
    // A booted-scope overlay is best-effort; fall back to disk-only fidelity.
  }

  const visibleLanes = disk.lanes
    .filter((lane) => laneExistsOnDisk(lane, record.rootPath))
    .sort(compareLanes);
  const visibleLaneIds = new Set(visibleLanes.map((lane) => lane.id));

  const chats: SyncRosterChat[] = [];
  let runningCount = 0;
  let attentionCount = 0;
  for (const row of desktopVisibleRosterRows(disk.chats, visibleLaneIds)) {
    const live = liveBySessionId.get(row.id);
    const sidecar = readChatSidecar(chatSessionsDir, row.id);
    const status = live ? liveChatStatus(live) : diskChatStatus(row, Boolean(sidecar?.awaitingInput));
    const awaitingInput = status === "awaiting";
    if (status === "running") runningCount += 1;
    if (status === "awaiting" || status === "failed") attentionCount += 1;
    const lastActivityAt = live?.lastActivityAt ?? row.last_output_at ?? row.started_at ?? null;
    chats.push({
      id: row.id,
      laneId: row.lane_id,
      chatSessionId: row.chat_session_id,
      title: row.title,
      provider: live?.provider ?? sidecar?.provider ?? null,
      model: live?.model ?? sidecar?.model ?? null,
      toolType: row.tool_type,
      status,
      ...(awaitingInput ? { awaitingInput: true } : {}),
      ...(row.pinned ? { pinned: true } : {}),
      lastActivityAt,
      preview: truncatePreview(row.last_output_preview),
    });
  }

  chats.sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));

  return {
    projectId: record.projectId,
    rootPath: record.rootPath,
    displayName: record.displayName,
    lastOpenedAt: record.lastOpenedAt > 0 ? new Date(record.lastOpenedAt).toISOString() : null,
    booted,
    runningCount,
    attentionCount,
    lanes: visibleLanes.map(mapLane),
    chats,
  };
}

/**
 * Build the all-projects chat roster: every registered project's lanes + chat
 * sessions, sourced cheaply from disk, with live status overlaid for any
 * already-booted scope. Projects are sorted most-recently-opened first.
 */
export async function buildRosterSnapshot(args: BuildRosterSnapshotArgs): Promise<SyncRosterProject[]> {
  const records = args.projectRegistry
    .list()
    .slice()
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);

  const projects = await Promise.all(
    records.map((record) =>
      buildRosterProject(record, args.scopeRegistry, args.logger).catch((error) => {
        args.logger?.warn?.("sync_host.roster_project_build_failed", {
          projectId: record.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        const fallback: SyncRosterProject = {
          projectId: record.projectId,
          rootPath: record.rootPath,
          displayName: record.displayName,
          lastOpenedAt: record.lastOpenedAt > 0 ? new Date(record.lastOpenedAt).toISOString() : null,
          booted: false,
          runningCount: 0,
          attentionCount: 0,
          lanes: [],
          chats: [],
        };
        return fallback;
      }),
    ),
  );
  return projects;
}
