import fs from "node:fs";
import path from "node:path";
import type { DeletedChat } from "../../../shared/types/deletedChats";
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

export type DeletedChatOrigin = "delete" | "lane_delete" | "backfill";
type HiddenReason = "reopened" | "removed" | "internal";

export type DeletedChatRow = {
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
  origin
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
export function deletedChatSourceFromRecord(raw: unknown): { provider: ExternalSessionProvider; externalId: string } | null {
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

export type RecordDeletedChatInput = Omit<DeletedChatRow, "deletedAt" | "origin" | "externalProvider" | "externalId"> & {
  origin: DeletedChatOrigin;
  /** The persisted chat record, for the conversation pointer and account. */
  record: Record<string, unknown> | null;
  /** Internal deletes (a failed import's cleanup, a closed side chat) are kept hidden. */
  hidden?: boolean;
  deletedAt?: string;
};

/** Saves one deleted chat. A chat that never reached its agent has nothing to reopen and is skipped. */
export function recordDeletedChat(db: DeletedChatsDb, input: RecordDeletedChatInput): boolean {
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
export function backfillClaudeDeletedChats(db: DeletedChatsDb): void {
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

export function listDeletedChatRows(db: DeletedChatsDb): DeletedChatRow[] {
  return db.all<DeletedChatRow>(
    `select ${ROW_COLUMNS} from deleted_chats where hidden_at is null order by deleted_at desc limit ?`,
    [LIST_LIMIT],
  ).filter((row) => isExternalProvider(row.externalProvider));
}

export function getDeletedChatRow(db: DeletedChatsDb, id: string): DeletedChatRow | null {
  const row = db.get<DeletedChatRow>(
    `select ${ROW_COLUMNS} from deleted_chats where id = ? and hidden_at is null limit 1`,
    [id],
  );
  return row && isExternalProvider(row.externalProvider) ? row : null;
}

export function hideDeletedChats(
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

export type DeletedChatSource = {
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

/** Rows whose copy no agent folder holds still exist; this reports them as gone. */
export function createDeletedChatLocator() {
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
      .catch(() => null);
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

export type DeletedChatLocator = ReturnType<typeof createDeletedChatLocator>;

/** Runs `fn` over `items` at most `limit` at a time, keeping order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export function toDeletedChat(
  row: DeletedChatRow,
  lane: { name: string | null; color: string | null; live: boolean } | null,
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
  };
}
