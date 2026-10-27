import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { fileIdentity } from "../projects/fileIdentity";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import { pathsEqual } from "../../../../desktop/src/main/services/shared/pathCompare";
import { normalizeSessionStatusNote } from "../../../../desktop/src/shared/sessionStatusNote";
import { normalizeSessionActivityReport } from "../../../../desktop/src/shared/sessionActivity";
import {
  isPersistedTurnFailureCurrent,
  isSessionSnoozed,
  lanePrWaitingReason,
} from "../../../../desktop/src/shared/sessionCanonicalState";
import type {
  AgentChatLogState,
  SyncRosterChat,
  SyncRosterChatStatus,
  SyncRosterLane,
  SyncRosterProject,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AgentChatSpawnKind } from "../../../../desktop/src/shared/types/chat";
import { isTrackedAgentCliToolType, type TerminalToolType } from "../../../../desktop/src/shared/types/sessions";
import { resolveReadableHistoryPath } from "../../../../desktop/src/main/services/storage/historyCompression";
import {
  hasTable,
  openReadOnlyDatabase,
} from "../../../../desktop/src/main/services/projects/readOnlySqlite";
import type { SyncForeignChatTranscriptResolver } from "./syncHostService";

// The roster opens each project's `.ade/ade.db` read-only with `node:sqlite`
// (`openReadOnlyDatabase`) — NO cr-sqlite, NO runtime boot — so an
// all-projects feed never has to activate every project.

const PREVIEW_MAX_CHARS = 120;

// getIfBooted may return a promise that is still pending for a mid-boot scope
// (its JSDoc allows "currently-booting"). The roster runs on the brain event
// loop (~1Hz) and fans out across every project with Promise.all, so an
// unbounded await on one slow/stuck boot would stall the whole snapshot for
// every subscribed phone. Cap the overlay wait and degrade to disk-only
// fidelity for that project this cycle.
const ROSTER_BOOT_OVERLAY_TIMEOUT_MS = 250;

// --- Narrow structural inputs (the concrete ProjectRegistry / ----------------
// ProjectScopeRegistry satisfy these; keeping them structural lets the unit
// tests seed a project dir + a stub scope registry without a runtime). --------

export type RosterProjectRecord = {
  projectId: string;
  rootPath: string;
  displayName: string;
  /**
   * Raw `origin` URL the project registry captured when the project was
   * registered (it re-reads only while unset), so the roster never spawns git.
   */
  gitOriginUrl?: string | null;
  lastOpenedAt: number;
  catalogVisibility: "recent" | "system";
};

export type RosterProjectRegistry = {
  list(): RosterProjectRecord[];
};

export type RosterLiveSession = {
  sessionId: string;
  status: "active" | "idle" | "ended";
  /** The main chat's side chat (`shared/sideChat.ts`); the side chat itself is never a roster row. */
  sideChatSessionId?: string | null;
  awaitingInput?: boolean;
  provider?: string | null;
  model?: string | null;
  lastActivityAt?: string | null;
  /**
   * Provider-reported background tasks still running after the foreground turn
   * ended. `AgentChatSessionSummary` already carries this; the roster reads it
   * so a chat whose subagents are still working is not reported as idle.
   */
  activeBackgroundTaskCount?: number | null;
  /** The chat's next scheduled wake, if one is parked. */
  nextWakeAt?: string | null;
  /**
   * Set on CTO/identity chats. Identity sessions are deliberately omitted from
   * the normal project roster, but this marker remains available as a
   * defensive signal for older or alternate roster producers.
   */
  identityKey?: string | null;
  /** Spawn lineage, so a client can file a child chat under its parent. */
  spawnKind?: AgentChatSpawnKind | null;
  orchestrationParentSessionId?: string | null;
};

/** A roster chat with the optional identity marker retained for compatibility. */
export type RosterChat = SyncRosterChat;

export type RosterAgentChatService = {
  listSessions(
    laneId?: string,
    options?: { includeArchived?: boolean; includeIdentity?: boolean },
  ): Promise<RosterLiveSession[]>;
  /** chatLogV2 freshness for a chat; live counter for loaded sessions. */
  getChatLogState?(sessionId: string): AgentChatLogState | null;
};

export type RosterPtyService = {
  hasLivePty(sessionId: string): boolean;
};

export type RosterBootedScope = {
  runtime: {
    agentChatService?: RosterAgentChatService | null;
    ptyService?: RosterPtyService | null;
  };
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
  ended_at: string | null;
  last_output_preview: string | null;
  last_output_at: string | null;
  pinned: number | null;
  exit_code: number | null;
  started_at: string | null;
  settled_at: string | null;
  status_note: string | null;
  activity_status_json: string | null;
  activity_status_changed_at: string | null;
  attention_requested_at: string | null;
  attention_message: string | null;
  last_turn_failed_at: string | null;
  snoozed_until: string | null;
  snoozed_at: string | null;
  /** Tracked CLI rows keep their spawn lineage here; chats keep it in their sidecar. */
  resume_metadata_json: string | null;
};

type PullRequestRow = {
  lane_id: string;
  state: string;
  checks_status: string | null;
  review_status: string | null;
};

type DiskProjectData = {
  lanes: LaneRow[];
  chats: TerminalSessionRow[];
  /** Lane id → why a running session there waits on its PR. */
  prWaitingReasonByLaneId: Map<string, "ci" | "review">;
};

// --- Helpers -----------------------------------------------------------------

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

// A lane is renderable only if its worktree still exists on disk — mirrors the
// desktop's recentProjectSummary.ts (its `countedLane` + `laneExistsOnDisk`
// pair) so the roster never advertises lanes whose worktree was deleted out
// from under ADE.
function laneExistsOnDisk(row: LaneRow, projectRoot: string): boolean {
  if ((row.lane_type ?? "").trim() === "primary") {
    return fs.existsSync(projectRoot);
  }
  const candidate = normalizePath(row.worktree_path) ?? normalizePath(row.attached_root_path);
  return candidate ? fs.existsSync(candidate) : false;
}

/**
 * The tool type of one session, read from a project's database on disk, or
 * null when the project has no such session (or no readable database).
 *
 * Answers "does this project own that chat" for a project whose runtime is not
 * loaded, so an unknown chat id is checked against each project's database
 * without booting a runtime per project.
 */
export function readSessionToolTypeFromDisk(projectRoot: string, sessionId: string): string | null {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 250");
    if (!hasTable(db, "terminal_sessions")) return null;
    const row = db
      .prepare("select tool_type from terminal_sessions where id = ? limit 1")
      .get<{ tool_type?: string | null }>(sessionId);
    return typeof row?.tool_type === "string" ? row.tool_type : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function truncatePreview(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : trimmed;
}

function latestActivityTimestamp(...values: Array<string | null | undefined>): string | null {
  let latest: { value: string; timestamp: number } | null = null;
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) {
      if (!latest) latest = { value: trimmed, timestamp: Number.NEGATIVE_INFINITY };
      continue;
    }
    if (!latest || timestamp > latest.timestamp) {
      latest = { value: trimmed, timestamp };
    }
  }
  return latest?.value ?? null;
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
    if (parentId != null) return topLevelIds.has(parentId);
    // Standalone CLI session (tracked terminal with no chat parent): a real
    // roster entry whether it is live or ended — the hub must list every CLI
    // session, not just agent chats.
    return true;
  });
}

/** A project with nothing to show; a fresh object each call. */
const emptyDiskProject = (): DiskProjectData => ({ lanes: [], chats: [], prWaitingReasonByLaneId: new Map() });

/**
 * Last successful disk read per project database, keyed by the database and
 * WAL file identities. Every SQLite write changes one of them (WAL append,
 * checkpoint, or a rollback-journal write to the main file), so an unchanged
 * signature means the rows are unchanged. The roster is rebuilt every few
 * seconds while agents work; without this every recent project paid a fresh
 * connection and a full schema parse (~450 tables) each time, blocking the
 * brain's event loop, even when nothing in it had moved.
 */
const diskProjectCache = new Map<string, { signature: string; at: number; data: DiskProjectData }>();
/**
 * Bounds how long a signature alone is trusted. A WAL rewritten from offset 0
 * at the same size inside one mtime tick (coarse timestamps) looks unchanged.
 */
const DISK_PROJECT_CACHE_MAX_AGE_MS = 30_000;

/**
 * Read a project's lanes + chat sessions straight off disk (read-only). Never
 * throws: a missing, locked, or schema-shifted DB yields empty lanes/chats so
 * the project still appears in the roster (just without rows).
 */
function readProjectFromDisk(projectRoot: string, logger?: Pick<Logger, "warn"> | null): DiskProjectData {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  const dbIdentity = fileIdentity(dbPath);
  if (dbIdentity === null) {
    diskProjectCache.delete(dbPath);
    return emptyDiskProject();
  }
  const signature = `${dbIdentity}|${fileIdentity(`${dbPath}-wal`) ?? "-"}`;
  const now = Date.now();
  const cached = diskProjectCache.get(dbPath);
  if (cached && cached.signature === signature && now - cached.at < DISK_PROJECT_CACHE_MAX_AGE_MS) return cached.data;
  diskProjectCache.delete(dbPath);
  const data = readProjectFromDiskUncached(dbPath, projectRoot, logger);
  if (data) diskProjectCache.set(dbPath, { signature, at: now, data });
  return data ?? emptyDiskProject();
}

/** Null when the read failed (locked, unreadable) so the caller retries next time. */
function readProjectFromDiskUncached(
  dbPath: string,
  projectRoot: string,
  logger?: Pick<Logger, "warn"> | null,
): DiskProjectData | null {
  const empty = emptyDiskProject();
  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
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
          // One PRAGMA for every column probe below: probing each column on its own
          // re-ran table_info once per column for every project database.
          const sessionColumns = new Set(
            activeDb.prepare("pragma table_info(terminal_sessions)").all<{ name?: string }>().map((row) => row.name),
          );
          const chatSessionIdColumn = sessionColumns.has("chat_session_id")
            ? "chat_session_id"
            : "null as chat_session_id";
          const settledAtColumn = sessionColumns.has("settled_at")
            ? "settled_at"
            : "null as settled_at";
          const statusNoteColumn = sessionColumns.has("status_note")
            ? "status_note"
            : "null as status_note";
          const activityStatusColumn = sessionColumns.has("activity_status_json")
            ? "activity_status_json"
            : "null as activity_status_json";
          const activityStatusChangedAtColumn = sessionColumns.has("activity_status_changed_at")
            ? "activity_status_changed_at"
            : "null as activity_status_changed_at";
          const attentionRequestedAtColumn = sessionColumns.has("attention_requested_at")
            ? "attention_requested_at"
            : "null as attention_requested_at";
          const attentionMessageColumn = sessionColumns.has("attention_message")
            ? "attention_message"
            : "null as attention_message";
          const lastTurnFailedAtColumn = sessionColumns.has("last_turn_failed_at")
            ? "last_turn_failed_at"
            : "null as last_turn_failed_at";
          const snoozedUntilColumn = sessionColumns.has("snoozed_until")
            ? "snoozed_until"
            : "null as snoozed_until";
          const snoozedAtColumn = sessionColumns.has("snoozed_at")
            ? "snoozed_at"
            : "null as snoozed_at";
          const resumeMetadataColumn = sessionColumns.has("resume_metadata_json")
            ? "resume_metadata_json"
            : "null as resume_metadata_json";
          return activeDb
            .prepare(
              `
                select id, lane_id, ${chatSessionIdColumn}, tool_type, title, status, ended_at, last_output_preview,
                       last_output_at, pinned, exit_code, started_at,
                       ${settledAtColumn}, ${statusNoteColumn}, ${activityStatusColumn}, ${activityStatusChangedAtColumn}, ${attentionRequestedAtColumn},
                       ${attentionMessageColumn}, ${lastTurnFailedAtColumn},
                       ${snoozedUntilColumn}, ${snoozedAtColumn}, ${resumeMetadataColumn}
                from terminal_sessions
                where archived_at is null
              `,
            )
            .all<TerminalSessionRow>();
        })()
      : [];

    const prWaitingReasonByLaneId = new Map<string, "ci" | "review">();
    if (hasTable(db, "pull_requests")) {
      const prsByLaneId = new Map<string, Array<{
        state: string;
        checksStatus: string | null;
        reviewStatus: string | null;
      }>>();
      const rows = db
        .prepare(
          `
            select lane_id, state, checks_status, review_status
            from pull_requests
            where state in ('open', 'draft')
          `,
        )
        .all<PullRequestRow>();
      for (const row of rows) {
        const list = prsByLaneId.get(row.lane_id) ?? [];
        list.push({
          state: row.state,
          checksStatus: row.checks_status,
          reviewStatus: row.review_status,
        });
        prsByLaneId.set(row.lane_id, list);
      }
      for (const [laneId, prs] of prsByLaneId) {
        const reason = lanePrWaitingReason(prs);
        if (reason) prWaitingReasonByLaneId.set(laneId, reason);
      }
    }

    return { lanes, chats, prWaitingReasonByLaneId };
  } catch (error) {
    logger?.warn?.("sync_host.roster_project_read_failed", {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    db?.close();
  }
}

type Sidecar = {
  provider?: string | null;
  model?: string | null;
  awaitingInput?: boolean;
  /** Persisted CTO/identity marker; see `RosterLiveSession.identityKey`. */
  identityKey?: string | null;
  /** Set on a side chat: its main chat. Side chats are never roster rows. */
  sideChatParentSessionId?: string | null;
  /** Set on a main chat that has a side chat. */
  sideChatSessionId?: string | null;
  /** Persisted chat log freshness (chatLogV2): sequence high-water + generation. */
  eventSequence?: number | null;
  historyGeneration?: number | null;
  spawnKind?: AgentChatSpawnKind | null;
  orchestrationParentSessionId?: string | null;
};

function rosterSpawnKind(value: unknown): AgentChatSpawnKind | null {
  return value === "subagent" || value === "peer" ? value : null;
}

function rosterParentId(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

/**
 * Spawn lineage of a tracked CLI row (`ade new chat --mode cli --type
 * subagent`), which keeps it in `resume_metadata_json` the way
 * `sessionService` reads it. Never throws.
 */
/** Rows already reported unreadable; the roster is rebuilt often. */
const unreadableResumeMetadataWarned = new Set<string>();

function resumeMetadataLineage(
  raw: string | null,
  sessionId: string,
  logger?: Pick<Logger, "warn"> | null,
): {
  spawnKind: AgentChatSpawnKind | null;
  orchestrationParentSessionId: string | null;
} {
  const none = { spawnKind: null, orchestrationParentSessionId: null };
  if (!raw) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!unreadableResumeMetadataWarned.has(sessionId)) {
      unreadableResumeMetadataWarned.add(sessionId);
      logger?.warn?.("sync_host.roster_resume_metadata_unreadable", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none;
  const record = parsed as Record<string, unknown>;
  return {
    spawnKind: rosterSpawnKind(record.spawnKind),
    orchestrationParentSessionId: rosterParentId(record.orchestrationParentSessionId),
  };
}

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;

/**
 * Sidecars read before, kept while the file is unchanged: a roster build reads
 * every visible chat's sidecar, and on a reconnect almost none have changed.
 * The rule is createStampedJsonCache's (durableFile.ts): a hit needs the same
 * inode, size, mtime and ctime, and only a file unchanged for SIDECAR_SETTLE_MS
 * before the read is kept, so two writes in one timestamp tick cannot share a
 * stamp. A wall clock stepped back drops every entry.
 */
const SIDECAR_SETTLE_MS = 2_000;
const SIDECAR_CACHE_MAX = 5_000;
const sidecarCache = new Map<string, { stamp: string; sidecar: Sidecar }>();
let sidecarClockLead: number | null = null;

// Best-effort read of a chat's persisted sidecar for provider/model/awaiting.
// A missing or unparsable sidecar leaves those fields null — never throws.
function readChatSidecar(chatSessionsDir: string, sessionId: string): Sidecar | null {
  const filePath = path.join(chatSessionsDir, `${sessionId}.json`);
  const wallNow = Date.now();
  const clockLead = wallNow - performance.now();
  if (sidecarClockLead !== null && clockLead < sidecarClockLead - 500) sidecarCache.clear();
  sidecarClockLead = clockLead;
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sidecarCache.delete(filePath);
    return null;
  }
  const stamp = stat.ino ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
  const cached = sidecarCache.get(filePath);
  if (stamp !== null && cached?.stamp === stamp) return { ...cached.sidecar };
  sidecarCache.delete(filePath);
  const sidecar = parseChatSidecar(filePath);
  if (sidecar && stamp !== null && Math.max(stat.mtimeMs, stat.ctimeMs) <= wallNow - SIDECAR_SETTLE_MS) {
    sidecarCache.set(filePath, { stamp, sidecar: { ...sidecar } });
    if (sidecarCache.size > SIDECAR_CACHE_MAX) {
      const oldest = sidecarCache.keys().next().value;
      if (oldest !== undefined) sidecarCache.delete(oldest);
    }
  }
  return sidecar;
}

function parseChatSidecar(filePath: string): Sidecar | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      awaitingInput: parsed.awaitingInput === true,
      identityKey: typeof parsed.identityKey === "string" ? parsed.identityKey.trim() || null : null,
      sideChatParentSessionId: typeof parsed.sideChatParentSessionId === "string" ? parsed.sideChatParentSessionId.trim() || null : null,
      sideChatSessionId: typeof parsed.sideChatSessionId === "string" ? parsed.sideChatSessionId.trim() || null : null,
      eventSequence: positiveInteger(parsed.eventSequence),
      historyGeneration: positiveInteger(parsed.historyGeneration),
      spawnKind: rosterSpawnKind(parsed.spawnKind),
      orchestrationParentSessionId: rosterParentId(parsed.orchestrationParentSessionId),
    };
  } catch {
    return null;
  }
}

// Disk-only status (un-booted project): the truthful persisted state. `running`
// collapses to `idle` because no live runtime is streaming the turn.
//
// Leave that collapse alone. `idle` is a first-class state now, not a softer
// word for "done" — see `ACTIVITY_STATE_GLYPHS.idle` in
// apps/desktop/src/renderer/components/activity/activityPresentation.ts, where
// it means "went quiet mid-work", sorts above `done` and reads "is idle". A row
// whose project is not booted is exactly that: last seen working, nothing
// streaming it now. Promoting it back to `running` would be the lie — the
// Activity island claiming live agents on a machine that has none.
function diskChatStatus(row: TerminalSessionRow, sidecarAwaiting: boolean): SyncRosterChatStatus {
  if (row.attention_requested_at || sidecarAwaiting) return "awaiting";
  if (rosterFailureIsCurrent(row)) return "failed";
  if (row.settled_at) return "ended";
  const status = (row.status ?? "").trim();
  if (status !== "running" && row.exit_code != null && row.exit_code !== 0) return "failed";
  return status === "running" ? "idle" : "ended";
}

/**
 * A persisted failure marker describes this row only until something newer
 * happens. `last_output_at` is written by real output, not by the `done` event
 * that carries the failure, so output after the failure proves the chat ran
 * again. Without the check, a chat that recovered through a route that never
 * completed a turn (restart recovery, a peer message, a runtime that kept
 * going) stayed "failed" in the account Activity feed and the phone roster —
 * and the push publisher counted it into "N chats failed" — while it was
 * demonstrably working.
 */
function rosterFailureIsCurrent(row: TerminalSessionRow): boolean {
  return isPersistedTurnFailureCurrent({
    lastTurnFailedAt: row.last_turn_failed_at,
    lastActivityAt: row.last_output_at,
  });
}

// Live status from a booted scope's agentChatService — true running/awaiting.
function liveChatStatus(live: RosterLiveSession): SyncRosterChatStatus {
  if (live.awaitingInput) return "awaiting";
  if (live.status === "active") return "running";
  // Background work keeps running after the foreground turn ends, and
  // agentChatService reports the chat `idle` for the whole of it. Desktop
  // promotes that back to the `running` phase
  // (`sessionCanonicalState.ts` — `backgroundWork`); the roster has to agree,
  // or Activity maps the session idle → stale → Done and reports a live agent
  // as finished.
  //
  // The count is cross-runtime, not Claude-only: it now also covers Codex
  // background subagents and Cursor cloud runs, so this branch fires for them
  // too without any change here. The phone deliberately reads the TOTAL rather
  // than the working/monitoring split — a roster row has one status, and
  // "something is still running" is the fact it needs.
  if ((live.activeBackgroundTaskCount ?? 0) > 0) return "running";
  if (live.status === "idle") return "idle";
  return "ended";
}

/**
 * The same normalization the desktop's cross-machine repo match applies
 * (`normalizeGitRemoteIdentity`), so the phone can compare roster rows from
 * different machines directly. It also drops any user/token in the URL.
 */
function rosterRepoOriginUrl(record: RosterProjectRecord): string | null {
  return normalizeGitRemoteIdentity(record.gitOriginUrl ?? null);
}

function mapLane(
  row: LaneRow,
  prWaitingReasonByLaneId: ReadonlyMap<string, "ci" | "review">,
): SyncRosterLane {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    laneType: row.lane_type,
    branchRef: row.branch_ref,
    prWaitingReason: prWaitingReasonByLaneId.get(row.id) ?? null,
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
  let livePtyService: RosterPtyService | null = null;
  let liveChatLogState: ((sessionId: string) => AgentChatLogState | null) | null = null;
  try {
    const bootedPromise = scopeRegistry.getIfBooted(record.projectId);
    const scope = bootedPromise
      ? await Promise.race([
          bootedPromise.catch(() => null),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), ROSTER_BOOT_OVERLAY_TIMEOUT_MS),
          ),
        ])
      : null;
    const agentChatService = scope?.runtime.agentChatService;
    livePtyService = scope?.runtime.ptyService ?? null;
    if (agentChatService) {
      booted = true;
      if (typeof agentChatService.getChatLogState === "function") {
        liveChatLogState = (sessionId) => agentChatService.getChatLogState?.(sessionId) ?? null;
      }
      const liveSessions = await agentChatService
        .listSessions(undefined, { includeArchived: false, includeIdentity: true })
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

  const visibleRows = desktopVisibleRosterRows(disk.chats, visibleLaneIds);
  // Each sidecar is read once and shared by the identity pass and the row pass
  // below; both run synchronously, so neither can see a different file.
  const sidecarBySessionId = new Map<string, Sidecar | null>();
  for (const row of visibleRows) {
    sidecarBySessionId.set(row.id, readChatSidecar(chatSessionsDir, row.id));
  }
  const identitySessionIds = new Set<string>();
  for (const row of visibleRows) {
    const liveIdentityKey = liveBySessionId.get(row.id)?.identityKey?.trim() || null;
    const diskIdentityKey = sidecarBySessionId.get(row.id)?.identityKey?.trim() || null;
    if (liveIdentityKey || diskIdentityKey) identitySessionIds.add(row.id);
  }
  let identityDescendantAdded = true;
  while (identityDescendantAdded) {
    identityDescendantAdded = false;
    for (const row of visibleRows) {
      const parentSessionId = normalizedParentSessionId(row);
      if (parentSessionId
        && identitySessionIds.has(parentSessionId)
        && !identitySessionIds.has(row.id)) {
        identitySessionIds.add(row.id);
        identityDescendantAdded = true;
      }
    }
  }

  const chats: RosterChat[] = [];
  let runningCount = 0;
  let attentionCount = 0;
  for (const row of visibleRows) {
    const live = liveBySessionId.get(row.id);
    const sidecar = sidecarBySessionId.get(row.id) ?? null;
    const identityKey = (live?.identityKey ?? sidecar?.identityKey ?? null)
      ?.trim() || null;
    // CTO/identity sessions have their own surface and attention path. They
    // must never become ordinary project-roster rows or contribute to Hub
    // counts, even when their sidecar is the only identity signal available.
    if (identitySessionIds.has(row.id)) continue;
    // A side chat lives inside its main chat; clients reach it from there.
    if (sidecar?.sideChatParentSessionId) continue;
    // CLI (terminal) sessions never appear in agentChatService; on a booted
    // scope their liveness comes from the PTY table instead.
    const hasLivePty = livePtyService?.hasLivePty(row.id) === true;
    const liveStatus = live
      ? liveChatStatus(live)
      : hasLivePty
        ? "running" as const
        : null;
    /**
     * A live FOREGROUND turn, not merely a row that reports `running`.
     * `liveChatStatus` also returns "running" for an idle chat that still owns
     * background tasks, and the desktop canonical rule is explicit that an
     * orphaned monitor must not mask a failed turn — so only `active` gets the
     * override. A live PTY has no chat summary and is always a live run.
     */
    const liveTurnRunning = live
      ? live.status === "active" && live.awaitingInput !== true
      : hasLivePty;
    const status: SyncRosterChatStatus = row.attention_requested_at
      ? "awaiting"
      // Settled is checked against a RUNNING row first, exactly as before:
      // background work keeps a settled chat's published status "running".
      : row.settled_at && liveStatus !== "running"
        ? "ended"
        // A live turn outranks every persisted verdict. A chat that is working
        // right now can never be published as failed/ended because a previous
        // turn died — the desktop `canonicalSessionState` applies the same rule.
        : liveTurnRunning
          ? "running"
          : rosterFailureIsCurrent(row)
            ? "failed"
            : liveStatus ?? diskChatStatus(row, Boolean(sidecar?.awaitingInput));
    const awaitingInput = status === "awaiting";
    const snoozed = isSessionSnoozed({
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    });
    if (status === "running" && !snoozed) runningCount += 1;
    // Attention drives hub badges AND attention-first project sorting. Only
    // chat rows (and their attached shells) count: a standalone CLI session
    // that exited non-zero months ago must not pin its project to the top
    // forever — mobile has no way to clear it (CLI rows can't be archived).
    const countsTowardAttention = isRosterTopLevelToolType(row.tool_type)
      || normalizedParentSessionId(row) != null;
    if ((status === "awaiting" || status === "failed") && countsTowardAttention) attentionCount += 1;
    const activityStatus = normalizeSessionActivityReport(row.activity_status_json);
    const activityStatusChangedAt = row.activity_status_changed_at ?? activityStatus?.updatedAt ?? null;
    const lifecycleUpdatedAt = latestActivityTimestamp(
      live?.lastActivityAt,
      row.attention_requested_at,
      row.settled_at,
      row.last_turn_failed_at,
      row.ended_at,
      row.last_output_at,
      row.started_at,
    );
    const lastActivityAt = latestActivityTimestamp(lifecycleUpdatedAt, activityStatusChangedAt);
    // chatLogV2 freshness: live counter when the project is booted, else the
    // persisted sidecar. Agent chats only — CLI rows have neither.
    let chatLog: AgentChatLogState | null = null;
    try {
      chatLog = liveChatLogState?.(row.id) ?? null;
    } catch {
      chatLog = null;
    }
    if (!chatLog && sidecar) {
      chatLog = {
        maxSequence: sidecar.eventSequence ?? 0,
        historyGeneration: sidecar.historyGeneration ?? 1,
      };
    }
    const sideChatSessionId = live ? live.sideChatSessionId : sidecar?.sideChatSessionId;
    // Spawn lineage: the live summary first (a demote or promote updates it
    // before the sidecar is rewritten), then the chat's sidecar, then a tracked
    // CLI row's resume metadata. Sent only when known, so peers and plain chats
    // add nothing to the wire.
    // Like `sessionService`, only a tracked agent CLI row reads lineage from its
    // resume metadata.
    const cliLineage = isTrackedAgentCliToolType(row.tool_type as TerminalToolType | null)
      ? resumeMetadataLineage(row.resume_metadata_json, row.id, logger)
      : null;
    const spawnKind = rosterSpawnKind(live?.spawnKind)
      ?? sidecar?.spawnKind
      ?? cliLineage?.spawnKind
      ?? null;
    const orchestrationParentSessionId = rosterParentId(live?.orchestrationParentSessionId)
      ?? sidecar?.orchestrationParentSessionId
      ?? cliLineage?.orchestrationParentSessionId
      ?? null;
    chats.push({
      id: row.id,
      laneId: row.lane_id,
      chatSessionId: row.chat_session_id,
      ...(spawnKind ? { spawnKind } : {}),
      ...(orchestrationParentSessionId ? { orchestrationParentSessionId } : {}),
      title: row.title,
      provider: live?.provider ?? sidecar?.provider ?? null,
      model: live?.model ?? sidecar?.model ?? null,
      toolType: row.tool_type,
      status,
      ...(identityKey ? { identityKey } : {}),
      ...(sideChatSessionId ? { sideChatSessionId } : {}),
      ...(awaitingInput ? { awaitingInput: true } : {}),
      ...(row.pinned ? { pinned: true } : {}),
      lastActivityAt,
      lifecycleUpdatedAt,
      activityStatusChangedAt,
      preview: truncatePreview(row.last_output_preview),
      settledAt: row.settled_at,
      statusNote: normalizeSessionStatusNote(row.status_note),
      activityStatus,
      attentionRequestedAt: row.attention_requested_at,
      attentionMessage: row.attention_message,
      lastTurnFailedAt: row.last_turn_failed_at,
      exitCode: row.exit_code,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      ...(live?.nextWakeAt ? { nextWakeAt: live.nextWakeAt } : {}),
      ...(chatLog
        ? { maxSequence: chatLog.maxSequence, historyGeneration: chatLog.historyGeneration }
        : {}),
    });
  }

  chats.sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));

  return {
    projectId: record.projectId,
    rootPath: record.rootPath,
    displayName: record.displayName,
    repoOriginUrl: rosterRepoOriginUrl(record),
    lastOpenedAt: record.lastOpenedAt > 0 ? new Date(record.lastOpenedAt).toISOString() : null,
    booted,
    runningCount,
    attentionCount,
    lanes: visibleLanes.map((lane) => mapLane(lane, disk.prWaitingReasonByLaneId)),
    chats,
  };
}

// --- Cross-project "quick look" transcript resolver --------------------------

export type ForeignChatProjectRegistry = {
  list(): { projectId: string; rootPath: string }[];
};

// A chat session id is a filename segment: reject anything that could escape
// the transcripts dir (path separators, `..`, nul) before it ever touches the
// filesystem. Real ids are UUID/nanoid-shaped.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Builds a resolver that maps (registered foreign project, sessionId) to that
 * session's on-disk chat transcript JSONL path — the security boundary for
 * cross-project chat streaming. It ONLY resolves projects present in the
 * registry and ONLY returns paths confined to that project's `.ade`
 * transcripts dir; everything else yields null. Never boots a runtime.
 */
export function createForeignChatTranscriptResolver(args: {
  projectRegistry: ForeignChatProjectRegistry;
}): SyncForeignChatTranscriptResolver {
  return {
    resolveTranscriptPath: ({ projectId, projectRootPath, sessionId }) => {
      const safeSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!SAFE_SESSION_ID.test(safeSessionId)) return null;

      const requestedProjectId = typeof projectId === "string" ? projectId.trim() : "";
      const requestedRootPath = normalizePath(projectRootPath);
      const records = args.projectRegistry.list();
      const byId = requestedProjectId
        ? records.find((entry) => entry.projectId === requestedProjectId)
        : undefined;
      // Platform path identity: case-folded on Windows and macOS, so a root
      // spelled with different casing still names the registered project.
      const byRoot = requestedRootPath
        ? records.find((entry) => pathsEqual(entry.rootPath, requestedRootPath))
        : undefined;
      // Both selectors given: the project the id names must live at that
      // root, or a request for one project could be answered from another's
      // transcripts.
      if (byId && requestedRootPath && !pathsEqual(byId.rootPath, requestedRootPath)) return null;
      const record = byId ?? byRoot;
      if (!record) return null;

      const layout = resolveAdeLayout(record.rootPath);
      const chatTranscriptsDir = path.resolve(layout.chatTranscriptsDir);
      const legacyTranscriptsDir = path.resolve(layout.transcriptsDir);
      // Mirror the chat service's candidate order: the dedicated chat dir
      // first, then the legacy `<transcripts>/<id>.chat.jsonl` location that
      // older/restored sessions may still be writing. Defense in depth: a
      // validated session id already can't traverse, but confirm each
      // resolved path stays inside its transcripts dir.
      const dedicatedPath = path.resolve(path.join(chatTranscriptsDir, `${safeSessionId}.jsonl`));
      if (!dedicatedPath.startsWith(chatTranscriptsDir + path.sep)) return null;
      const legacyPath = path.resolve(path.join(legacyTranscriptsDir, `${safeSessionId}.chat.jsonl`));
      if (!legacyPath.startsWith(legacyTranscriptsDir + path.sep)) return null;
      return resolveReadableHistoryPath(dedicatedPath)
        ?? resolveReadableHistoryPath(legacyPath)
        ?? dedicatedPath;
    },
  };
}

/**
 * Build the all-projects chat roster: every recent project plus the host's own
 * project's lanes + work sessions (agent chats, chat-owned shell rows, and
 * standalone CLI sessions — live or ended), sourced cheaply from disk, with
 * live status overlaid for any already-booted scope. Projects are sorted
 * most-recently-opened first.
 */
export async function buildRosterSnapshot(args: BuildRosterSnapshotArgs): Promise<SyncRosterProject[]> {
  const records = args.projectRegistry
    .list()
    .filter(
      (record) =>
        record.catalogVisibility === "recent" ||
        record.projectId === args.hostProjectId,
    )
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
          repoOriginUrl: rosterRepoOriginUrl(record),
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
