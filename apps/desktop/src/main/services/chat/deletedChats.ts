import fs from "node:fs";
import path from "node:path";
import type {
  DeletedChat,
  DeletedChatDetailArgs,
  DeletedChatListArgs,
  DeletedChatListResult,
  DeletedChatRemoveArgs,
  DeletedChatRemoveResult,
  DeletedChatReopenArgs,
  DeletedChatReopenResult,
} from "../../../shared/types/deletedChats";
import type { AgentChatImportExternalSessionArgs, AgentChatImportExternalSessionResult } from "../../../shared/types/chat";
import type { TerminalResumeMetadata } from "../../../shared/types/sessions";
import type { ExternalSessionDetail } from "../../../shared/types/externalSessionDetail";
import { importProviderLabel } from "../../../shared/externalSessionPolicy";
import {
  EXTERNAL_SESSION_PROVIDERS,
  type ExternalSessionProvider,
} from "../../../shared/types/externalSessions";
import { PROVIDER_INSTANCE_ENV_KEY, isProviderInstanceProvider } from "../../../shared/types/providerInstances";
import type { AdeDb } from "../state/kvDb";
import { discoverExternalSessionRecord } from "../externalSessions/events";
import { providerPointersFromChatRecord } from "../externalSessions/liveChatProviderRefs";
import { isWellFormedExternalSessionId } from "../externalSessions/sessionIds";
import { machineProviderUsageHomes } from "../usage/providerUsageHomes";
import { providerThreadIsInHome } from "./providerThreadMove";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { hasTable, openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { assertStorageAnswering } from "../state/unansweringRoots";

/**
 * Settings › Recently deleted. Deleting a chat removes ADE's own files for it,
 * but the agent (Claude, Codex, …) keeps its own copy of the conversation, and
 * ADE never touches that. So a delete leaves a small row here naming that
 * copy, and Reopen imports it back. A chat leaves the list when the agent no
 * longer has the copy, or when the user reopens it or removes it.
 *
 * Rows are machine-local (the copy is on this machine only) and never
 * deleted: a reopened or removed row is hidden instead, so the Claude
 * backfill below can never bring it back.
 */

type DeletedChatsDb = Pick<AdeDb, "get" | "all" | "run">;

type DeletedChatOrigin = "delete" | "lane_delete" | "backfill";
type HiddenReason = "reopened" | "removed" | "internal";

type DeletedChatRow = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  title: string | null;
  provider: string;
  externalProvider: ExternalSessionProvider;
  externalId: string;
  modelId: string | null;
  reasoningEffort: string | null;
  instanceId: string | null;
  configHome: string | null;
  cwd: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  deletedAt: string;
  origin: DeletedChatOrigin;
  /** 'cli' for a deleted agent CLI terminal; null for a chat. */
  kind: string | null;
  cliJson: string | null;
};

/**
 * What a deleted agent CLI terminal reopens as: its terminal row, minus the
 * process. Kept as JSON in `deleted_chats.cli_json`.
 */
export type DeletedCliSnapshot = {
  toolType: string;
  title: string | null;
  goal: string | null;
  resumeCommand: string | null;
  resumeMetadata: TerminalResumeMetadata | null;
  /** ADE's own recording of the terminal, which the delete leaves on disk. */
  transcriptPath: string | null;
};

const ROW_COLUMNS = `
  id,
  lane_id as laneId,
  lane_name as laneName,
  title,
  provider,
  external_provider as externalProvider,
  external_id as externalId,
  model_id as modelId,
  reasoning_effort as reasoningEffort,
  instance_id as instanceId,
  config_home as configHome,
  cwd,
  created_at as createdAt,
  last_active_at as lastActiveAt,
  deleted_at as deletedAt,
  origin,
  kind,
  cli_json as cliJson
`;

/** Newest first; enough for any real history without an unbounded read. */
const LIST_LIMIT = 500;

const EXTERNAL_PROVIDERS = new Set<string>(EXTERNAL_SESSION_PROVIDERS);

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isExternalProvider(value: string): value is ExternalSessionProvider {
  return EXTERNAL_PROVIDERS.has(value);
}

/**
 * The conversation copy a persisted chat record names: the pointer of the
 * chat's own provider first (a Claude chat's Claude session), else the first
 * one it holds. Null when the chat never reached its agent.
 */
function deletedChatSourceFromRecord(raw: unknown): { provider: ExternalSessionProvider; externalId: string } | null {
  const pointers = providerPointersFromChatRecord(raw);
  if (!pointers.length) return null;
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const chatProvider = asText(record.provider) === "unified" ? "opencode" : asText(record.provider);
  const own = pointers.find((pointer) => pointer.provider === chatProvider) ?? pointers[0]!;
  if (!isWellFormedExternalSessionId(own.provider, own.externalId)) return null;
  return { provider: own.provider, externalId: own.externalId };
}

/** Reads one persisted chat record (`.ade/cache/chat-sessions/<id>.json`); null when missing or unreadable. */
export function readPersistedChatRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type RecordDeletedChatInput = Omit<DeletedChatRow, "deletedAt" | "origin" | "externalProvider" | "externalId" | "kind" | "cliJson"> & {
  origin: DeletedChatOrigin;
  /** The persisted chat record, for the conversation pointer and account. */
  record: Record<string, unknown> | null;
  /** Internal deletes (a failed import's cleanup, a closed side chat) are kept hidden. */
  hidden?: boolean;
  deletedAt?: string;
};

/** Saves one deleted chat. A chat that never reached its agent has nothing to reopen and is skipped. */
function recordDeletedChat(db: DeletedChatsDb, input: RecordDeletedChatInput): boolean {
  const source = deletedChatSourceFromRecord(input.record);
  if (!source) return false;
  const record = input.record ?? {};
  const deletedAt = input.deletedAt ?? new Date().toISOString();
  db.run(
    `insert into deleted_chats(
       id, lane_id, lane_name, title, provider, external_provider, external_id,
       model_id, reasoning_effort, instance_id, config_home, cwd,
       created_at, last_active_at, deleted_at, origin, hidden_at, hidden_reason, reopened_chat_id
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
     on conflict(id) do update set
       lane_id = excluded.lane_id,
       lane_name = excluded.lane_name,
       title = excluded.title,
       provider = excluded.provider,
       external_provider = excluded.external_provider,
       external_id = excluded.external_id,
       model_id = excluded.model_id,
       reasoning_effort = excluded.reasoning_effort,
       instance_id = excluded.instance_id,
       config_home = excluded.config_home,
       cwd = excluded.cwd,
       created_at = excluded.created_at,
       last_active_at = excluded.last_active_at,
       deleted_at = excluded.deleted_at,
       origin = excluded.origin,
       hidden_at = excluded.hidden_at,
       hidden_reason = excluded.hidden_reason,
       reopened_chat_id = null`,
    [
      input.id,
      input.laneId,
      input.laneName,
      input.title,
      asText(record.provider) === "unified" ? "opencode" : (asText(record.provider) ?? input.provider),
      source.provider,
      source.externalId,
      input.modelId ?? asText(record.modelId) ?? asText(record.model),
      input.reasoningEffort ?? asText(record.reasoningEffort),
      input.instanceId ?? asText(record.instanceId),
      input.configHome,
      input.cwd,
      input.createdAt,
      input.lastActiveAt ?? asText(record.updatedAt),
      deletedAt,
      input.origin,
      input.hidden ? deletedAt : null,
      input.hidden ? "internal" : null,
    ],
  );
  return true;
}

export type RecordDeletedCliInput = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  title: string | null;
  /** The CLI's agent (`claude`, `codex`, `cursor`, …), the resume provider. */
  provider: ExternalSessionProvider;
  /** The agent's own conversation id, when ADE learned it; null starts fresh on reopen. */
  externalId: string | null;
  modelId: string | null;
  instanceId: string | null;
  cwd: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  snapshot: DeletedCliSnapshot;
  hidden?: boolean;
  deletedAt?: string;
};

/**
 * Saves one deleted agent CLI terminal. Unlike a chat it is kept even without
 * a conversation id: reopening it still brings the CLI back in its lane, fresh.
 */
function recordDeletedCli(db: DeletedChatsDb, input: RecordDeletedCliInput): boolean {
  const deletedAt = input.deletedAt ?? new Date().toISOString();
  const externalId = input.externalId && isWellFormedExternalSessionId(input.provider, input.externalId)
    ? input.externalId
    : "";
  db.run(
    `insert into deleted_chats(
       id, lane_id, lane_name, title, provider, external_provider, external_id,
       model_id, reasoning_effort, instance_id, config_home, cwd,
       created_at, last_active_at, deleted_at, origin, hidden_at, hidden_reason, reopened_chat_id,
       kind, cli_json
     ) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, ?, ?, ?, ?, 'delete', ?, ?, null, 'cli', ?)
     on conflict(id) do update set
       lane_id = excluded.lane_id,
       lane_name = excluded.lane_name,
       title = excluded.title,
       provider = excluded.provider,
       external_provider = excluded.external_provider,
       external_id = excluded.external_id,
       model_id = excluded.model_id,
       reasoning_effort = null,
       instance_id = excluded.instance_id,
       config_home = null,
       cwd = excluded.cwd,
       created_at = excluded.created_at,
       last_active_at = excluded.last_active_at,
       deleted_at = excluded.deleted_at,
       origin = excluded.origin,
       hidden_at = excluded.hidden_at,
       hidden_reason = excluded.hidden_reason,
       reopened_chat_id = null,
       kind = 'cli',
       cli_json = excluded.cli_json`,
    [
      input.id,
      input.laneId,
      input.laneName,
      input.title,
      input.provider,
      input.provider,
      externalId,
      input.modelId,
      input.instanceId,
      input.cwd,
      input.createdAt,
      input.lastActiveAt,
      deletedAt,
      input.hidden ? deletedAt : null,
      input.hidden ? "internal" : null,
      JSON.stringify(input.snapshot),
    ],
  );
  return true;
}

function isCliRow(row: Pick<DeletedChatRow, "kind">): boolean {
  return row.kind === "cli";
}

function parseCliSnapshot(row: DeletedChatRow): DeletedCliSnapshot | null {
  if (!isCliRow(row) || !row.cliJson) return null;
  try {
    const parsed = JSON.parse(row.cliJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const toolType = asText(record.toolType);
    if (!toolType) return null;
    const metadata = record.resumeMetadata;
    return {
      toolType,
      title: asText(record.title),
      goal: asText(record.goal),
      resumeCommand: asText(record.resumeCommand),
      resumeMetadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as TerminalResumeMetadata
        : null,
      transcriptPath: asText(record.transcriptPath),
    };
  } catch {
    return null;
  }
}

const CHAT_TOOL_TYPE_SQL = "(s.tool_type = 'cursor' or s.tool_type like '%-chat')";

/**
 * Deleting a lane removes its chats' rows in one statement, not through the
 * chat delete. Called just before that statement, so those chats can still be
 * reopened (as a copy, in a lane the user picks).
 */
export function recordChatsDeletedWithLane(db: DeletedChatsDb, args: {
  laneId: string;
  laneName: string | null;
  worktreePath: string | null;
  chatSessionsDir: string;
}): number {
  const rows = db.all<{ id: string; title: string | null; toolType: string; startedAt: string | null; endedAt: string | null }>(
    `select s.id, s.title, s.tool_type as toolType, s.started_at as startedAt, s.ended_at as endedAt
       from terminal_sessions s
      where s.lane_id = ? and ${CHAT_TOOL_TYPE_SQL}`,
    [args.laneId],
  );
  let recorded = 0;
  for (const row of rows) {
    const record = readPersistedChatRecord(path.join(args.chatSessionsDir, `${row.id}.json`));
    if (!record) continue;
    // Subagents and side chats go with their parent; only chats the user had are listed.
    if (asText(record.spawnKind) === "subagent" || asText(record.sideChatParentSessionId)) continue;
    if (recordDeletedChat(db, {
      id: row.id,
      laneId: args.laneId,
      laneName: args.laneName,
      title: asText(row.title),
      provider: row.toolType.replace(/-chat$/u, ""),
      modelId: null,
      reasoningEffort: null,
      instanceId: null,
      configHome: null,
      cwd: args.worktreePath,
      createdAt: row.startedAt,
      lastActiveAt: row.endedAt,
      origin: "lane_delete",
      record,
    })) recorded += 1;
  }
  return recorded;
}

/**
 * Claude chats deleted before this list existed: their `claude_sessions`
 * pointer outlives the chat row. `insert or ignore` keeps every row already
 * here (hidden ones included), so a reopened or removed chat never returns.
 */
function backfillClaudeDeletedChats(db: DeletedChatsDb): void {
  db.run(
    `insert or ignore into deleted_chats(
       id, lane_id, lane_name, title, provider, external_provider, external_id,
       cwd, created_at, last_active_at, deleted_at, origin
     )
     select c.chat_session_id, c.lane_id, l.name, c.title, 'claude', 'claude', c.session_id,
            l.worktree_path, c.created_at, c.updated_at, c.updated_at, 'backfill'
       from claude_sessions c
       left join lanes l on l.id = c.lane_id
      where c.chat_session_id is not null
        and not exists (select 1 from terminal_sessions t where t.id = c.chat_session_id)`,
  );
}

/**
 * A row is written just before the chat's own row goes. If that delete then
 * failed, the chat is still live and must not be offered for reopening.
 */
const CHAT_GONE_SQL = "not exists (select 1 from terminal_sessions t where t.id = d.id)";

function listDeletedChatRows(db: DeletedChatsDb): DeletedChatRow[] {
  return db.all<DeletedChatRow>(
    `select ${ROW_COLUMNS} from deleted_chats d
      where d.hidden_at is null and ${CHAT_GONE_SQL}
      order by d.deleted_at desc limit ?`,
    [LIST_LIMIT],
  ).filter((row) => isExternalProvider(row.externalProvider));
}

/**
 * A deleted chat in a project that is not open here, read from its database
 * without booting it. Whether its conversation can still be reopened is
 * unknown until the project opens, so `reopenable` is null.
 */
export function readDeletedChatOnDisk(
  projectRoot: string,
  sessionId: string,
  onError: (error: unknown) => void,
): { deletedAt: string; title: string | null; reopenable: null } | null {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    // Before any native call: a folder on a hung mount or behind a permission prompt is skipped, not waited on.
    assertStorageAnswering(dbPath);
    if (!fs.existsSync(dbPath)) return null;
    db = openReadOnlyDatabase(dbPath);
    // A busy database is skipped, never waited on: this runs on the brain's thread for each project.
    db.exec("PRAGMA busy_timeout = 0");
    if (!hasTable(db, "deleted_chats")) return null;
    const row = db.prepare(
      `select deleted_at as deletedAt, title from deleted_chats d where d.id = ? and d.hidden_at is null
         and ${hasTable(db, "terminal_sessions") ? CHAT_GONE_SQL : "1"} limit 1`,
    ).get<{ deletedAt?: string; title?: string | null }>(sessionId);
    return row?.deletedAt ? { deletedAt: row.deletedAt, title: row.title ?? null, reopenable: null } : null;
  } catch (error) {
    onError(error);
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function getDeletedChatRow(db: DeletedChatsDb, id: string): DeletedChatRow | null {
  const row = db.get<DeletedChatRow>(
    `select ${ROW_COLUMNS} from deleted_chats d where d.id = ? and d.hidden_at is null and ${CHAT_GONE_SQL} limit 1`,
    [id],
  );
  return row && isExternalProvider(row.externalProvider) ? row : null;
}

function hideDeletedChats(
  db: DeletedChatsDb,
  ids: readonly string[],
  reason: HiddenReason,
  reopenedChatId: string | null = null,
): number {
  let hidden = 0;
  const now = new Date().toISOString();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    const present = db.get<{ present: number }>(
      "select 1 as present from deleted_chats where id = ? and hidden_at is null limit 1",
      [trimmed],
    );
    if (!present) continue;
    db.run(
      "update deleted_chats set hidden_at = ?, hidden_reason = ?, reopened_chat_id = ? where id = ?",
      [now, reason, reopenedChatId, trimmed],
    );
    hidden += 1;
  }
  return hidden;
}

// ── Where the agent's copy is ─────────────────────────────────────────────

type DeletedChatSource = {
  /** The account folder holding the copy (Claude / Codex); null for the others. */
  configHome: string | null;
  /** The env the session readers need to look in that folder. */
  env: NodeJS.ProcessEnv | undefined;
};

/** Every Claude transcript on this machine by session id, built once per list. */
type ClaudeIndex = Map<string, { configHome: string; mtimeMs: number }>;

async function buildClaudeIndex(homes: readonly string[]): Promise<ClaudeIndex> {
  const index: ClaudeIndex = new Map();
  for (const home of homes) {
    const projectsDir = path.join(home, "projects");
    let projects: fs.Dirent[];
    try {
      projects = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
      let files: string[];
      try {
        files = await fs.promises.readdir(path.join(projectsDir, project.name));
      } catch {
        return;
      }
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        let mtimeMs = 0;
        try {
          mtimeMs = (await fs.promises.stat(path.join(projectsDir, project.name, name))).mtimeMs;
        } catch {
          continue;
        }
        // A moved chat leaves its old copy behind; the newest one is the live one.
        const existing = index.get(id);
        if (!existing || existing.mtimeMs < mtimeMs) index.set(id, { configHome: home, mtimeMs });
      }
    }));
  }
  return index;
}

function accountEnv(provider: ExternalSessionProvider, configHome: string | null): NodeJS.ProcessEnv | undefined {
  if (!configHome || !isProviderInstanceProvider(provider)) return undefined;
  return { ...process.env, [PROVIDER_INSTANCE_ENV_KEY[provider]]: configHome };
}

type LoggerLike = { warn: (message: string, fields?: Record<string, unknown>) => void };

/** Rows whose copy no agent folder holds still exist; this reports them as gone. */
function createDeletedChatLocator(logger: LoggerLike) {
  let claudeIndex: { builtAt: number; index: Promise<ClaudeIndex> } | null = null;
  const CLAUDE_INDEX_TTL_MS = 5_000;
  const otherCache = new Map<string, { at: number; found: boolean }>();
  const OTHER_TTL_MS = 30_000;

  const homesFor = (provider: "claude" | "codex", preferred: string | null): string[] => {
    const machine = machineProviderUsageHomes()[provider];
    const ordered = preferred ? [preferred, ...machine] : machine;
    return [...new Set(ordered.map((home) => path.resolve(home)))];
  };

  const claude = (): Promise<ClaudeIndex> => {
    const now = Date.now();
    if (!claudeIndex || now - claudeIndex.builtAt > CLAUDE_INDEX_TTL_MS) {
      claudeIndex = { builtAt: now, index: buildClaudeIndex(homesFor("claude", null)) };
    }
    return claudeIndex.index;
  };

  const locate = async (row: DeletedChatRow): Promise<DeletedChatSource | null> => {
    if (row.externalProvider === "claude") {
      const hit = (await claude()).get(row.externalId);
      return hit ? { configHome: hit.configHome, env: accountEnv("claude", hit.configHome) } : null;
    }
    if (row.externalProvider === "codex") {
      const home = homesFor("codex", row.configHome)
        .find((candidate) => providerThreadIsInHome("codex", row.externalId, candidate));
      return home ? { configHome: home, env: accountEnv("codex", home) } : null;
    }
    const key = `${row.externalProvider}:${row.externalId}`;
    const cached = otherCache.get(key);
    if (cached && Date.now() - cached.at < OTHER_TTL_MS) {
      return cached.found ? { configHome: null, env: undefined } : null;
    }
    const record = await discoverExternalSessionRecord(row.externalProvider, row.externalId, { includeAdeOwned: true })
      .catch((error: unknown) => {
        // Reported as gone (the row stays hidden), but said, so a reader
        // failure is not mistaken for the agent clearing its copy.
        logger.warn("deleted_chats.locate_failed", {
          provider: row.externalProvider,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    otherCache.set(key, { at: Date.now(), found: record != null });
    return record ? { configHome: null, env: undefined } : null;
  };

  return {
    locate,
    /** After a reopen or a Claude thread move, look again instead of trusting the cache. */
    invalidate: () => {
      claudeIndex = null;
      otherCache.clear();
    },
  };
}

/** Runs `fn` over `items` at most `limit` at a time, keeping order. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function toDeletedChat(
  row: DeletedChatRow,
  lane: { name: string | null; color: string | null; live: boolean } | null,
  cliResumable?: boolean,
): DeletedChat {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    sourceProvider: row.externalProvider,
    modelId: row.modelId,
    laneId: row.laneId,
    laneName: lane?.name ?? row.laneName,
    laneColor: lane?.color ?? null,
    laneExists: lane?.live === true,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    deletedAt: row.deletedAt,
    ...(isCliRow(row)
      ? { kind: "cli" as const, toolType: parseCliSnapshot(row)?.toolType ?? row.provider, resumable: cliResumable === true }
      : {}),
  };
}

// ── The service ───────────────────────────────────────────────────────────

/** Where Reopen found the conversation, handed to the import. */
export type DeletedChatReopenSource = {
  adeOwned: true;
  /** The account that holds the conversation, so the chat reopens on it. */
  instanceId: string | null;
  configHome: string | null;
  env: NodeJS.ProcessEnv | undefined;
};

export type DeletedChatsServiceDeps = {
  /** The project database; null in a runtime without one. */
  db: () => DeletedChatsDb | null;
  logger: LoggerLike;
  getLane: (laneId: string) => Promise<{ id: string; archivedAt?: string | null; worktreePath?: string | null } | null>;
  /** Every provider session a live chat holds, so one is never opened twice. */
  listLiveProviderRefs: () => Promise<ReadonlyArray<{ provider: string; externalId: string }>>;
  /** The account id whose config home is `configHome`, or null. */
  instanceIdForHome: (provider: ExternalSessionProvider, configHome: string) => string | null;
  importSession: (args: AgentChatImportExternalSessionArgs, reopen: DeletedChatReopenSource) => Promise<AgentChatImportExternalSessionResult>;
  loadDetail: (
    args: { provider: ExternalSessionProvider; sessionId: string; before?: string },
    options: { includeAdeOwned: true; env?: NodeJS.ProcessEnv },
  ) => Promise<ExternalSessionDetail>;
  /**
   * Relaunches a deleted agent CLI in `laneId`, resuming its own conversation
   * when `resumeTargetId` is set. Absent in a runtime without terminals.
   */
  reopenCli?: (args: {
    id: string;
    laneId: string;
    sameLane: boolean;
    provider: ExternalSessionProvider;
    resumeTargetId: string | null;
    title: string | null;
    snapshot: DeletedCliSnapshot;
  }) => Promise<{ sessionId: string; mode: "continue" | "fresh"; notice: string | null }>;
  /** The last of a deleted CLI's own terminal recording, for the preview when the agent's copy is unknown. */
  readCliTerminalTail?: (transcriptPath: string) => Promise<string | null>;
};

const LOCATE_CONCURRENCY = 6;

export function createDeletedChatsService(deps: DeletedChatsServiceDeps) {
  const locator = createDeletedChatLocator(deps.logger);
  let backfilled = false;
  /** One reopen per deleted chat at a time: two would open the session twice. */
  const reopening = new Set<string>();

  const requireDb = (): DeletedChatsDb => {
    const db = deps.db();
    if (!db) throw new Error("Recently deleted chats aren't available here.");
    if (!backfilled) {
      backfilled = true;
      try {
        backfillClaudeDeletedChats(db);
      } catch (error) {
        deps.logger.warn("deleted_chats.backfill_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return db;
  };

  const liveRefKeys = async (): Promise<Set<string>> =>
    new Set((await deps.listLiveProviderRefs()).map((ref) => `${ref.provider}:${ref.externalId}`));

  const requireRow = async (rawId: unknown): Promise<{ row: DeletedChatRow; source: DeletedChatSource }> => {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) throw new Error("Deleted chat id is required.");
    const row = getDeletedChatRow(requireDb(), id);
    if (!row) throw new Error("That chat isn't in Recently deleted anymore.");
    const source = await locator.locate(row);
    if (!source) {
      throw new Error(`${importProviderLabel(row.externalProvider)} no longer has this conversation, so it can't be reopened.`);
    }
    return { row, source };
  };

  /**
   * Saves one deleted chat; true when Recently deleted now holds it. Never
   * throws: a failure to remember it must not fail the delete the person asked for.
   */
  const remember = (input: RecordDeletedChatInput): boolean => {
    const db = deps.db();
    if (!db) return false;
    try {
      return recordDeletedChat(db, input);
    } catch (error) {
      deps.logger.warn("deleted_chats.record_failed", {
        sessionId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /** Saves one deleted agent CLI; true when Recently deleted now holds it. Never throws. */
  const rememberCli = (input: RecordDeletedCliInput): boolean => {
    const db = deps.db();
    if (!db) return false;
    try {
      return recordDeletedCli(db, input) && !input.hidden;
    } catch (error) {
      deps.logger.warn("deleted_chats.record_cli_failed", {
        sessionId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const list = async (args: DeletedChatListArgs = {}): Promise<DeletedChatListResult> => {
    const db = requireDb();
    const live = await liveRefKeys();
    const rows = listDeletedChatRows(db)
      // Opened again some other way (an import, another reopen): already a live chat.
      .filter((row) => !row.externalId || !live.has(`${row.externalProvider}:${row.externalId}`));
    const present = await mapWithLimit(
      rows,
      LOCATE_CONCURRENCY,
      async (row) => (row.externalId ? (await locator.locate(row)) != null : false),
    );
    // A CLI stays listed without its agent's copy: Reopen starts it fresh in its lane.
    const kept = rows.filter((row, index) => present[index] || isCliRow(row));
    const resumable = new Map(rows.map((row, index) => [row.id, present[index] === true]));
    const laneIds = [...new Set(kept.map((row) => row.laneId).filter((laneId): laneId is string => Boolean(laneId)))];
    const lanes = new Map<string, { name: string | null; color: string | null; live: boolean }>();
    if (laneIds.length) {
      const laneRows = db.all<{ id: string; name: string | null; color: string | null; archivedAt: string | null }>(
        `select id, name, color, archived_at as archivedAt from lanes where id in (${laneIds.map(() => "?").join(", ")})`,
        laneIds,
      );
      for (const lane of laneRows) lanes.set(lane.id, { name: lane.name, color: lane.color, live: !lane.archivedAt });
    }
    const query = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
    const chats = kept
      .map((row) => toDeletedChat(row, row.laneId ? lanes.get(row.laneId) ?? null : null, resumable.get(row.id)))
      .filter((chat) => !query
        || (chat.title ?? "").toLowerCase().includes(query)
        || (chat.laneName ?? "").toLowerCase().includes(query));
    return { chats };
  };

  /**
   * A deleted agent CLI and where its agent keeps the conversation (null when
   * ADE never learned the id or the agent cleared it). Null when `rawId` is a chat.
   */
  const requireCliRow = async (rawId: unknown): Promise<{ row: DeletedChatRow; source: DeletedChatSource | null } | null> => {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) throw new Error("Deleted chat id is required.");
    const row = getDeletedChatRow(requireDb(), id);
    if (!row) throw new Error("That chat isn't in Recently deleted anymore.");
    if (!isCliRow(row)) return null;
    return { row, source: row.externalId ? await locator.locate(row) : null };
  };

  /** The preview of a CLI whose agent's copy ADE cannot read: the tail of ADE's own terminal recording. */
  const cliTerminalDetail = async (row: DeletedChatRow): Promise<ExternalSessionDetail> => {
    const snapshot = parseCliSnapshot(row);
    const tail = snapshot?.transcriptPath && deps.readCliTerminalTail
      ? await deps.readCliTerminalTail(snapshot.transcriptPath).catch(() => null)
      : null;
    const at = Date.parse(row.lastActiveAt ?? row.deletedAt);
    return {
      provider: row.externalProvider,
      id: row.externalId || row.id,
      cwd: row.cwd,
      title: row.title,
      model: row.modelId,
      createdAt: Number.isFinite(Date.parse(row.createdAt ?? "")) ? Date.parse(row.createdAt!) : null,
      updatedAt: Number.isFinite(at) ? at : null,
      messageCount: tail ? 1 : 0,
      messages: tail
        ? [{ role: "assistant", text: `Terminal (last lines):\n${tail}`, at: Number.isFinite(at) ? at : null }]
        : [],
      sourcePath: null,
      watchable: false,
    };
  };

  const reopenCli = async (
    row: DeletedChatRow,
    source: DeletedChatSource | null,
    args: DeletedChatReopenArgs,
  ): Promise<DeletedChatReopenResult> => {
    if (!deps.reopenCli) throw new Error("CLI sessions can't be reopened on this machine.");
    const snapshot = parseCliSnapshot(row);
    if (!snapshot) throw new Error("ADE no longer knows how this CLI was launched, so it can't be reopened.");
    if (reopening.has(row.id)) throw new Error("This CLI session is already being reopened.");
    reopening.add(row.id);
    try {
      const requestedLaneId = typeof args?.laneId === "string" ? args.laneId.trim() : "";
      const targetLaneId = requestedLaneId || row.laneId || "";
      const lane = targetLaneId ? await deps.getLane(targetLaneId).catch(() => null) : null;
      if (!lane || lane.archivedAt) {
        throw new Error(requestedLaneId
          ? "That lane isn't available. Pick another lane to reopen this CLI in."
          : "This CLI's lane was deleted. Pick a lane to reopen it in.");
      }
      // Its own conversation only resumes in the folder it ran in, and only
      // while no live chat holds it (two would run it twice).
      const sameLane = lane.id === row.laneId;
      const liveElsewhere = row.externalId
        ? (await liveRefKeys()).has(`${row.externalProvider}:${row.externalId}`)
        : false;
      const resumeTargetId = sameLane && source && !liveElsewhere ? row.externalId : null;
      const result = await deps.reopenCli({
        id: row.id,
        laneId: lane.id,
        sameLane,
        provider: row.externalProvider,
        resumeTargetId,
        title: row.title,
        snapshot,
      });
      hideDeletedChats(requireDb(), [row.id], "reopened", result.sessionId);
      locator.invalidate();
      const label = importProviderLabel(row.externalProvider);
      const notice = result.notice ?? (result.mode === "fresh"
        ? !sameLane
          ? `Started a new ${label} CLI in this lane: its conversation is tied to the folder it ran in.`
          : liveElsewhere
            ? `Started a new ${label} CLI: its conversation is already open in a chat.`
            : row.externalId
              ? `Started a new ${label} CLI: ${label} no longer has its conversation.`
              : `Started a new ${label} CLI: ADE never learned its conversation id, so it couldn't resume.`
        : null);
      return {
        chatSessionId: result.sessionId,
        laneId: lane.id,
        mode: result.mode,
        kind: "cli",
        notice,
      };
    } finally {
      reopening.delete(row.id);
    }
  };

  const detail = async (args: DeletedChatDetailArgs): Promise<ExternalSessionDetail> => {
    const cli = await requireCliRow(args?.id);
    if (cli && !cli.source) return cliTerminalDetail(cli.row);
    const { row, source } = cli ? { row: cli.row, source: cli.source! } : await requireRow(args?.id);
    const before = typeof args?.before === "string" && args.before.trim() ? args.before.trim() : null;
    return deps.loadDetail(
      { provider: row.externalProvider, sessionId: row.externalId, ...(before ? { before } : {}) },
      { includeAdeOwned: true, ...(source.env ? { env: source.env } : {}) },
    );
  };

  const reopen = async (args: DeletedChatReopenArgs): Promise<DeletedChatReopenResult> => {
    const cli = await requireCliRow(args?.id);
    if (cli) return reopenCli(cli.row, cli.source, args);
    const { row, source } = await requireRow(args?.id);
    if (reopening.has(row.id)) throw new Error("This chat is already being reopened.");
    reopening.add(row.id);
    try {
      if ((await liveRefKeys()).has(`${row.externalProvider}:${row.externalId}`)) {
        hideDeletedChats(requireDb(), [row.id], "reopened");
        throw new Error("This conversation is already open in another chat.");
      }
      const requestedLaneId = typeof args?.laneId === "string" ? args.laneId.trim() : "";
      const targetLaneId = requestedLaneId || row.laneId || "";
      const lane = targetLaneId ? await deps.getLane(targetLaneId).catch(() => null) : null;
      if (!lane || lane.archivedAt) {
        throw new Error(requestedLaneId
          ? "That lane isn't available. Pick another lane to reopen this chat in."
          : "This chat's lane was deleted. Pick a lane to reopen it in.");
      }
      // Same lane: pick the conversation up where it stopped. Another lane: a
      // copy, because the agent's session is tied to the folder it ran in.
      const sameLane = lane.id === row.laneId;
      const result = await deps.importSession({
        provider: row.externalProvider,
        externalSessionId: row.externalId,
        laneId: lane.id,
        cwd: sameLane ? row.cwd ?? lane.worktreePath ?? null : row.cwd,
        fork: !sameLane,
        ...(row.title ? { title: row.title } : {}),
        ...(row.modelId ? { sourceModel: row.modelId } : {}),
        ...(row.reasoningEffort ? { sourceReasoningEffort: row.reasoningEffort } : {}),
      }, {
        adeOwned: true,
        instanceId: source.configHome ? deps.instanceIdForHome(row.externalProvider, source.configHome) : null,
        configHome: source.configHome,
        env: source.env,
      });
      hideDeletedChats(requireDb(), [row.id], "reopened", result.chatSessionId);
      locator.invalidate();
      return {
        chatSessionId: result.chatSessionId,
        laneId: lane.id,
        mode: sameLane ? "continue" : "copy",
        chatSummary: result.chatSummary,
      };
    } finally {
      reopening.delete(row.id);
    }
  };

  const remove = (args: DeletedChatRemoveArgs): DeletedChatRemoveResult => {
    const ids = Array.isArray(args?.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
    return { removed: hideDeletedChats(requireDb(), ids, "removed") };
  };

  /** One chat of Recently deleted, for "where did this chat go?"; null when it isn't there. Never throws. */
  const find = async (rawId: string): Promise<{ deletedAt: string; title: string | null; reopenable: boolean } | null> => {
    const db = deps.db();
    if (!db) return null;
    try {
      const row = getDeletedChatRow(db, rawId.trim());
      if (!row) return null;
      // A CLI can always come back: fresh in its lane when its conversation is gone.
      if (isCliRow(row)) return { deletedAt: row.deletedAt, title: row.title, reopenable: true };
      return { deletedAt: row.deletedAt, title: row.title, reopenable: (await locator.locate(row)) != null };
    } catch (error) {
      deps.logger.warn("deleted_chats.find_failed", { sessionId: rawId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  return { remember, rememberCli, list, detail, reopen, remove, find };
}

export type DeletedChatsService = ReturnType<typeof createDeletedChatsService>;
