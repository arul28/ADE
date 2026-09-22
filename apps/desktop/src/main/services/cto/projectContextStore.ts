import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { nowIso, redactSecrets, writeTextAtomic } from "../shared/utils";
import { readGitOriginUrl } from "../projects/recentProjectSummary";

/**
 * Durable project context for the one CTO.
 *
 * The chat transcript is the wrong place for this. A restart, a crash, and
 * `startFreshSession` all leave this file alone: it sits next to the other
 * CTO files under `.ade/cto/`, which is gitignored, and writes are atomic.
 * When the repo has a remote, the same rows mirror into the account settings
 * store under `ctx.*` so a second signed-in machine can hydrate them. No new
 * Cloudflare product — the existing per-key store already syncs.
 *
 * The cap is deliberate. That store allows 5,000 keys for the whole account,
 * and repo settings already spend part of it. 120 active facts per repository
 * is enough for atomic decisions and stays clear of the ceiling.
 */

const STORE_FILE = "context-store.json";
const STORE_VERSION = 1;
const MAX_ITEM_CHARS = 2_000;
const MAX_BRIEF_FIELD_CHARS = 1_200;
const MAX_ACTIVE_ITEMS = 120;
const MAX_ARCHIVED_ITEMS = 40;
const MAX_THREADS = 40;
const BRIEF_INJECT_MAX_CHARS = 1_200;
const ITEMS_INJECT_MAX_CHARS = 1_800;
const THREADS_INJECT_MAX_CHARS = 800;

const KEY_BRIEF = "ctx.brief";
const KEY_META = "ctx.meta";
const ITEM_KEY_PREFIX = "ctx.item.";
const THREAD_KEY_PREFIX = "ctx.thread.";

export const PROJECT_CONTEXT_TAG_KEYS = ["lane", "pr", "path", "topic"] as const;

export type ProjectContextKind = "fact" | "decision" | "convention" | "trap" | "environment" | "pointer";
export type ProjectContextStatus = "active" | "pinned" | "archived";
export type ProjectContextTrust = "human" | "cto" | "agent";

export type ProjectContextItem = {
  id: string;
  text: string;
  kind: ProjectContextKind;
  status: ProjectContextStatus;
  trust: ProjectContextTrust;
  tags: { lane?: string; pr?: string; path?: string; topic?: string };
  createdAt: string;
  updatedAt: string;
  /** Set after a successful account mirror. Absent means "not on the account yet". */
  accountSyncedAt?: string;
};

export type ProjectContextBrief = {
  goal: string;
  success: string;
  constraints: string;
  conventions: string;
  openLoops: string;
  updatedAt: string;
  accountSyncedAt?: string;
};

export type ProjectContextThread = {
  id: string;
  title: string;
  sessionId: string;
  laneId: string;
  objective: string;
  createdAt: string;
  accountSyncedAt?: string;
};

type ContextTombstone = {
  key: string;
  /** The `updatedAt` (or thread `createdAt`) at the moment the row was dropped. */
  updatedAt: string;
};

type StoreFile = {
  version: number;
  migratedFromMemoryAt: string | null;
  /** The migration stamp last mirrored to the account, when that push landed. */
  metaSyncedAt: string | null;
  brief: ProjectContextBrief | null;
  items: ProjectContextItem[];
  threads: ProjectContextThread[];
  /**
   * Account keys this machine dropped because of the cap. A reconcile must not
   * pull those rows back, and the next push deletes them so the other machine
   * drops them too. A newer remote edit (updatedAt after the tombstone) still wins.
   */
  tombstones: ContextTombstone[];
};

export type ProjectContextAccountPort = {
  scope: string;
  list(): Array<{ key: string; value: unknown; updatedAt: string }>;
  set(key: string, value: unknown): boolean;
  remove(key: string): boolean;
  sync(): Promise<"ready" | "unavailable" | "failed">;
};

type AccountStoreLike = {
  list(scope?: string): Array<{ key: string; value: unknown; updatedAt: string }>;
  set(scope: string, key: string, value: unknown): boolean;
  remove(scope: string, key: string): boolean;
  sync(): Promise<"ready" | "unavailable" | "failed">;
};

type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type ProjectContextStoreArgs = {
  /** Project `.ade` directory. The file is `<adeDir>/cto/context-store.json`. */
  adeDir: string;
  account?: ProjectContextAccountPort | null;
  logger?: Logger | null;
  now?: () => string;
};

function emptyStore(): StoreFile {
  return {
    version: STORE_VERSION,
    migratedFromMemoryAt: null,
    metaSyncedAt: null,
    brief: null,
    items: [],
    threads: [],
    tombstones: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(value: string, max: number): string {
  const text = redactSecrets(value.replace(/\s+/g, " ").trim());
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function clipBlock(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function asTags(value: unknown): ProjectContextItem["tags"] {
  if (!isRecord(value)) return {};
  const tags: ProjectContextItem["tags"] = {};
  for (const key of PROJECT_CONTEXT_TAG_KEYS) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) tags[key] = raw.trim().slice(0, 120);
    else if (typeof raw === "number" && Number.isFinite(raw)) tags[key] = String(raw);
  }
  return tags;
}

function decodeItem(value: unknown): ProjectContextItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!id || !text) return null;
  const kind = value.kind;
  const status = value.status;
  const trust = value.trust;
  if (kind !== "fact" && kind !== "decision" && kind !== "convention" && kind !== "trap" && kind !== "environment" && kind !== "pointer") return null;
  if (status !== "active" && status !== "pinned" && status !== "archived") return null;
  if (trust !== "human" && trust !== "cto" && trust !== "agent") return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  return {
    id,
    text: text.slice(0, MAX_ITEM_CHARS),
    kind,
    status,
    trust,
    tags: asTags(value.tags),
    createdAt,
    updatedAt,
    ...(typeof value.accountSyncedAt === "string" ? { accountSyncedAt: value.accountSyncedAt } : {}),
  };
}

function decodeBrief(value: unknown): ProjectContextBrief | null {
  if (!isRecord(value)) return null;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (!updatedAt) return null;
  return {
    goal: typeof value.goal === "string" ? value.goal : "",
    success: typeof value.success === "string" ? value.success : "",
    constraints: typeof value.constraints === "string" ? value.constraints : "",
    conventions: typeof value.conventions === "string" ? value.conventions : "",
    openLoops: typeof value.openLoops === "string" ? value.openLoops : "",
    updatedAt,
    ...(typeof value.accountSyncedAt === "string" ? { accountSyncedAt: value.accountSyncedAt } : {}),
  };
}

function decodeThread(value: unknown): ProjectContextThread | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const laneId = typeof value.laneId === "string" ? value.laneId.trim() : "";
  if (!id || !sessionId || !laneId) return null;
  return {
    id,
    title: typeof value.title === "string" ? value.title : "Thread",
    sessionId,
    laneId,
    objective: typeof value.objective === "string" ? value.objective : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
    ...(typeof value.accountSyncedAt === "string" ? { accountSyncedAt: value.accountSyncedAt } : {}),
  };
}

function decodeStore(value: unknown): StoreFile | null {
  if (!isRecord(value) || value.version !== STORE_VERSION) return null;
  const items = Array.isArray(value.items) ? value.items.map(decodeItem).filter((item): item is ProjectContextItem => item !== null) : [];
  const threads = Array.isArray(value.threads) ? value.threads.map(decodeThread).filter((thread): thread is ProjectContextThread => thread !== null) : [];
  return {
    version: STORE_VERSION,
    migratedFromMemoryAt: typeof value.migratedFromMemoryAt === "string" ? value.migratedFromMemoryAt : null,
    metaSyncedAt: typeof value.metaSyncedAt === "string" ? value.metaSyncedAt : null,
    brief: decodeBrief(value.brief),
    items,
    threads,
    tombstones: decodeTombstones(value.tombstones),
  };
}

function decodeTombstones(value: unknown): ContextTombstone[] {
  if (!Array.isArray(value)) return [];
  const tombstones: ContextTombstone[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
    if (!key || !updatedAt) continue;
    if (tombstones.some((row) => row.key === key)) continue;
    tombstones.push({ key, updatedAt });
  }
  return tombstones.slice(-200);
}

const MIGRATION_LOCK_STALE_MS = 60_000;

/** Exclusive mkdir lock. A directory left by a crash is reclaimed once it is stale. */
function claimMigrationLock(lockDir: string): boolean {
  const claim = (): "ok" | "exists" | "failed" => {
    try {
      fs.mkdirSync(lockDir);
      return "ok";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
    }
  };
  const first = claim();
  if (first === "ok") return true;
  if (first === "failed") return false;
  let mtime = 0;
  try {
    mtime = fs.statSync(lockDir).mtimeMs;
  } catch {
    return false;
  }
  if (Date.now() - mtime < MIGRATION_LOCK_STALE_MS) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return claim() === "ok";
}

/** Terms a retrieval query is made of. Short, deterministic, no model. */
export function contextQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 3 || seen.has(part)) continue;
    seen.add(part);
    terms.push(part);
  }
  return terms.slice(0, 24);
}

function statusPrior(status: ProjectContextStatus): number {
  if (status === "pinned") return 30;
  if (status === "active") return 10;
  return -20;
}

/**
 * Rank items for a query built from the live lane, PR, or the brief.
 * Every component is a number so the order is testable and stable.
 */
export function rankContextItems(items: ProjectContextItem[], query: string, limit: number): ProjectContextItem[] {
  const terms = contextQueryTerms(query);
  const scored = items.map((item) => {
    const haystack = `${item.text} ${Object.values(item.tags).join(" ")}`.toLowerCase();
    let score = statusPrior(item.status);
    if (item.trust === "human") score += 4;
    if (item.trust === "cto") score += 2;
    for (const term of terms) {
      if (haystack.includes(term)) score += 8;
      if ((item.tags.lane ?? "").toLowerCase() === term) score += 12;
      if ((item.tags.topic ?? "").toLowerCase().includes(term)) score += 6;
      if ((item.tags.path ?? "").toLowerCase().includes(term)) score += 6;
    }
    return { item, score };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.item.updatedAt !== b.item.updatedAt) return a.item.updatedAt < b.item.updatedAt ? 1 : -1;
    return a.item.id < b.item.id ? -1 : 1;
  });
  const cap = Math.max(1, limit);
  if (!terms.length) {
    return scored
      .filter((row) => row.item.status !== "archived")
      .slice(0, cap)
      .map((row) => row.item);
  }
  return scored.filter((row) => row.score > statusPrior(row.item.status)).slice(0, cap).map((row) => row.item);
}

function renderBrief(brief: ProjectContextBrief): string {
  const lines = [
    brief.goal ? `Goal: ${brief.goal}` : "",
    brief.success ? `Done when: ${brief.success}` : "",
    brief.constraints ? `Constraints: ${brief.constraints}` : "",
    brief.conventions ? `Conventions: ${brief.conventions}` : "",
    brief.openLoops ? `Open loops: ${brief.openLoops}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function renderItems(items: ProjectContextItem[]): string {
  return items.map((item) => `- (${item.status}) ${item.text}`).join("\n");
}

function renderThreads(threads: ProjectContextThread[]): string {
  return threads
    .slice()
    .reverse()
    .map((thread) => `- ${thread.title} · lane ${thread.laneId} · chat ${thread.sessionId}${thread.objective ? ` · ${thread.objective}` : ""}`)
    .join("\n");
}

/**
 * The account mirror, or null when this checkout has no remote.
 * A repository without an origin has no identity another machine can share,
 * same rule the settings store already uses.
 */
export function projectContextAccountPort(args: {
  projectRoot: string;
  store: AccountStoreLike;
}): ProjectContextAccountPort | null {
  const scope = accountRepoScopeKey(readGitOriginUrl(args.projectRoot));
  if (!scope) return null;
  return {
    scope,
    list: () => args.store.list(scope).filter((row) => row.key.startsWith("ctx.")),
    set: (key, value) => args.store.set(scope, key, value),
    remove: (key) => args.store.remove(scope, key),
    sync: () => args.store.sync(),
  };
}

export function createProjectContextStore(args: ProjectContextStoreArgs) {
  const filePath = path.join(args.adeDir, "cto", STORE_FILE);
  const logger = args.logger ?? null;
  const now = args.now ?? nowIso;
  let cache: StoreFile | null = null;
  let loadedMtime = -1;

  const warn = (message: string, error: unknown): void => {
    logger?.warn(message, { error: error instanceof Error ? error.message : String(error) });
  };

  const readFromDisk = (): StoreFile => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      loadedMtime = -1;
      return emptyStore();
    }
    if (cache && stat.mtimeMs === loadedMtime) return cache;
    try {
      const parsed = decodeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (!parsed) throw new Error("undecodable context store");
      cache = parsed;
      loadedMtime = stat.mtimeMs;
      return cache;
    } catch (error) {
      // A torn write must not wipe the previous good file, and a corrupt one
      // must not crash the CTO. Quarantine it and start clean; the account
      // mirror can fill the gap on the next reconcile.
      warn("cto_context.store_unreadable", error);
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        // The rename can fail if the file vanished between read and rename.
      }
      cache = emptyStore();
      loadedMtime = -1;
      return cache;
    }
  };

  const write = (next: StoreFile): void => {
    const compacted = compact(next);
    writeTextAtomic(filePath, `${JSON.stringify(compacted)}\n`, { mode: 0o600 });
    cache = compacted;
    try {
      loadedMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      loadedMtime = -1;
    }
  };

  const compact = (store: StoreFile): StoreFile => {
    const pinned = store.items.filter((item) => item.status === "pinned");
    const active = store.items.filter((item) => item.status === "active");
    const archived = store.items.filter((item) => item.status === "archived");
    // Pinned facts count toward the same cap. The account settings store is
    // shared by every repo on the account, so one repository cannot keep an
    // unbounded pin list and still mirror.
    const live = [...pinned, ...active];
    const stamp = now();
    const overflow = live.slice(0, Math.max(0, live.length - MAX_ACTIVE_ITEMS)).map((item) => {
      const archivedItem: ProjectContextItem = { ...item, status: "archived", updatedAt: stamp };
      delete archivedItem.accountSyncedAt;
      return archivedItem;
    });
    const keptLive = live.slice(Math.max(0, live.length - MAX_ACTIVE_ITEMS));
    const archivedPool = [...overflow, ...archived];
    const keptArchived = archivedPool.slice(-MAX_ARCHIVED_ITEMS);
    const droppedItems = archivedPool.slice(0, Math.max(0, archivedPool.length - keptArchived.length));
    const keptThreads = store.threads.slice(-MAX_THREADS);
    const droppedThreads = store.threads.slice(0, Math.max(0, store.threads.length - keptThreads.length));
    const originalById = new Map(store.items.map((item) => [item.id, item]));
    const tombstones = [...store.tombstones];
    const addTombstone = (key: string, updatedAt: string, syncedAt?: string) => {
      if (!syncedAt || tombstones.some((row) => row.key === key)) return;
      tombstones.push({ key, updatedAt });
    };
    for (const item of droppedItems) {
      const original = originalById.get(item.id) ?? item;
      addTombstone(`${ITEM_KEY_PREFIX}${item.id}`, original.updatedAt, original.accountSyncedAt);
    }
    for (const thread of droppedThreads) {
      addTombstone(`${THREAD_KEY_PREFIX}${thread.id}`, thread.createdAt, thread.accountSyncedAt);
    }
    return {
      ...store,
      items: [...keptLive, ...keptArchived],
      threads: keptThreads,
      tombstones: tombstones.slice(-200),
    };
  };

  const stampSynced = (store: StoreFile, key: string, updatedAt: string): void => {
    if (key === KEY_BRIEF && store.brief) store.brief = { ...store.brief, accountSyncedAt: updatedAt };
    if (key === KEY_META) return;
    if (key.startsWith(ITEM_KEY_PREFIX)) {
      const id = key.slice(ITEM_KEY_PREFIX.length);
      store.items = store.items.map((item) => item.id === id ? { ...item, accountSyncedAt: updatedAt } : item);
    }
    if (key.startsWith(THREAD_KEY_PREFIX)) {
      const id = key.slice(THREAD_KEY_PREFIX.length);
      store.threads = store.threads.map((thread) => thread.id === id ? { ...thread, accountSyncedAt: updatedAt } : thread);
    }
  };

  const pushUnsynced = (store: StoreFile): StoreFile => {
    const account = args.account;
    if (!account) return store;
    const next = structuredClone(store);
    const push = (key: string, value: unknown, updatedAt: string, syncedAt?: string) => {
      if (syncedAt === updatedAt) return;
      if (account.set(key, value)) stampSynced(next, key, updatedAt);
    };
    if (next.brief) push(KEY_BRIEF, next.brief, next.brief.updatedAt, next.brief.accountSyncedAt);
    if (next.migratedFromMemoryAt && next.metaSyncedAt !== next.migratedFromMemoryAt) {
      if (account.set(KEY_META, { migratedFromMemoryAt: next.migratedFromMemoryAt })) {
        next.metaSyncedAt = next.migratedFromMemoryAt;
      }
    }
    for (const item of next.items) {
      push(`${ITEM_KEY_PREFIX}${item.id}`, item, item.updatedAt, item.accountSyncedAt);
    }
    for (const thread of next.threads) {
      push(`${THREAD_KEY_PREFIX}${thread.id}`, thread, thread.createdAt, thread.accountSyncedAt);
    }
    const present = new Set(account.list().map((row) => row.key));
    const removed: string[] = [];
    for (const tombstone of next.tombstones) {
      if (!present.has(tombstone.key) || account.remove(tombstone.key)) removed.push(tombstone.key);
    }
    if (removed.length) {
      const gone = new Set(removed);
      next.tombstones = next.tombstones.filter((row) => !gone.has(row.key));
    }
    return next;
  };

  const applyRemote = (store: StoreFile, rows: Array<{ key: string; value: unknown; updatedAt: string }>): StoreFile => {
    const next = structuredClone(store);
    const tombstoneAt = new Map(next.tombstones.map((row) => [row.key, row.updatedAt]));
    const remoteIds = new Set<string>();
    const remoteThreadIds = new Set<string>();
    const dropTombstone = (key: string) => {
      next.tombstones = next.tombstones.filter((entry) => entry.key !== key);
    };
    for (const row of rows) {
      if (row.key === KEY_BRIEF) {
        const brief = decodeBrief(row.value);
        if (brief && (!next.brief || brief.updatedAt > next.brief.updatedAt)) {
          next.brief = { ...brief, accountSyncedAt: brief.updatedAt };
        }
        continue;
      }
      if (row.key === KEY_META && isRecord(row.value) && typeof row.value.migratedFromMemoryAt === "string") {
        next.migratedFromMemoryAt = next.migratedFromMemoryAt ?? row.value.migratedFromMemoryAt;
        continue;
      }
      if (row.key.startsWith(ITEM_KEY_PREFIX)) {
        const item = decodeItem(row.value);
        if (!item) continue;
        const droppedAt = tombstoneAt.get(row.key);
        if (droppedAt && item.updatedAt <= droppedAt) continue;
        if (droppedAt) dropTombstone(row.key);
        remoteIds.add(item.id);
        const local = next.items.find((entry) => entry.id === item.id);
        if (!local || item.updatedAt > local.updatedAt) {
          next.items = next.items.filter((entry) => entry.id !== item.id);
          next.items.push({ ...item, accountSyncedAt: item.updatedAt });
        }
        continue;
      }
      if (row.key.startsWith(THREAD_KEY_PREFIX)) {
        const thread = decodeThread(row.value);
        if (!thread) continue;
        const droppedAt = tombstoneAt.get(row.key);
        if (droppedAt && thread.createdAt <= droppedAt) continue;
        if (droppedAt) dropTombstone(row.key);
        remoteThreadIds.add(thread.id);
        if (!next.threads.some((entry) => entry.id === thread.id)) {
          next.threads.push({ ...thread, accountSyncedAt: thread.createdAt });
        }
      }
    }
    // A key we already mirrored, and have not edited since, that the account
    // no longer lists was deleted on another machine. Unsynced local rows stay:
    // they may simply not have uploaded, and an empty list is not a deletion.
    const keep = (syncedAt: string | undefined, updatedAt: string, id: string, ids: Set<string>): boolean => {
      if (!syncedAt) return true;
      if (ids.has(id)) return true;
      if (updatedAt > syncedAt) return true;
      return rows.length === 0;
    };
    next.items = next.items.filter((item) => keep(item.accountSyncedAt, item.updatedAt, item.id, remoteIds));
    next.threads = next.threads.filter((thread) => keep(thread.accountSyncedAt, thread.createdAt, thread.id, remoteThreadIds));
    return next;
  };

  let reconcileInFlight: Promise<void> | null = null;

  const reconcileAccount = async (): Promise<void> => {
    if (reconcileInFlight) return reconcileInFlight;
    reconcileInFlight = runReconcile().finally(() => {
      reconcileInFlight = null;
    });
    return reconcileInFlight;
  };

  const runReconcile = async (): Promise<void> => {
    const account = args.account;
    if (!account) return;
    let status: "ready" | "unavailable" | "failed" = "failed";
    try {
      status = await account.sync();
    } catch (error) {
      warn("cto_context.account_sync_failed", error);
      return;
    }
    if (status !== "ready") return;
    const current = readFromDisk();
    const merged = pushUnsynced(applyRemote(current, account.list()));
    if (JSON.stringify(merged) !== JSON.stringify(current)) write(merged);
  };

  const migrateFromMemoryFile = (memoryMarkdown: string): void => {
    if (readFromDisk().migratedFromMemoryAt) return;
    const lockDir = `${filePath}.migrate.lock`;
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const claimed = claimMigrationLock(lockDir);
    if (!claimed) return;
    try {
      const current = readFromDisk();
      if (current.migratedFromMemoryAt) return;
      const imported: ProjectContextItem[] = [];
      const stamp = now();
      for (const line of memoryMarkdown.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const text = clip(trimmed.slice(2), MAX_ITEM_CHARS);
        if (!text || imported.some((item) => item.text === text)) continue;
        imported.push({
          id: randomUUID(),
          text,
          kind: "fact",
          status: "active",
          trust: "cto",
          tags: {},
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      write({
        ...current,
        migratedFromMemoryAt: stamp,
        items: [...current.items, ...imported],
      });
    } finally {
      if (claimed) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // The import already landed. A leftover directory is reclaimed on the next attempt.
        }
      }
    }
  };

  return {
    filePath,

    /** Read the latest file. Another process (the desktop panel, the brain) may have written it. */
    read(): StoreFile {
      return readFromDisk();
    },

    async reconcile(): Promise<void> {
      await reconcileAccount();
    },

    migrateFromMemory(memoryMarkdown: string): void {
      migrateFromMemoryFile(memoryMarkdown);
    },

    setBrief(input: Omit<ProjectContextBrief, "updatedAt" | "accountSyncedAt">): ProjectContextBrief {
      const current = readFromDisk();
      const brief: ProjectContextBrief = {
        goal: clip(input.goal, MAX_BRIEF_FIELD_CHARS),
        success: clip(input.success, MAX_BRIEF_FIELD_CHARS),
        constraints: clip(input.constraints, MAX_BRIEF_FIELD_CHARS),
        conventions: clip(input.conventions, MAX_BRIEF_FIELD_CHARS),
        openLoops: clip(input.openLoops, MAX_BRIEF_FIELD_CHARS),
        updatedAt: now(),
      };
      write({ ...current, brief });
      return brief;
    },

    remember(input: {
      text: string;
      kind?: ProjectContextKind;
      trust?: ProjectContextTrust;
      status?: ProjectContextStatus;
      tags?: ProjectContextItem["tags"];
    }): { saved: boolean; item: ProjectContextItem | null } {
      const text = clip(input.text, MAX_ITEM_CHARS);
      if (!text) return { saved: false, item: null };
      const current = readFromDisk();
      const existing = current.items.find((item) => item.text === text && item.status !== "archived");
      if (existing) return { saved: false, item: existing };
      const stamp = now();
      const item: ProjectContextItem = {
        id: randomUUID(),
        text,
        kind: input.kind ?? "fact",
        status: input.status ?? "active",
        trust: input.trust ?? "cto",
        tags: input.tags ?? {},
        createdAt: stamp,
        updatedAt: stamp,
      };
      write({ ...current, items: [...current.items, item] });
      return { saved: true, item };
    },

    recordThread(input: { title: string; sessionId: string; laneId: string; objective: string }): ProjectContextThread {
      const current = readFromDisk();
      const thread: ProjectContextThread = {
        id: randomUUID(),
        title: clip(input.title || "Thread", 160),
        sessionId: input.sessionId,
        laneId: input.laneId,
        objective: clip(input.objective, 400),
        createdAt: now(),
      };
      write({ ...current, threads: [...current.threads, thread] });
      return thread;
    },

    search(query: string, limit = 8): ProjectContextItem[] {
      return rankContextItems(readFromDisk().items, query, limit);
    },

    briefText(): string | null {
      const brief = readFromDisk().brief;
      if (!brief) return null;
      const text = renderBrief(brief);
      return text.length ? text : null;
    },

    itemsText(query = ""): string | null {
      const items = rankContextItems(readFromDisk().items, query, 12);
      if (!items.length) return null;
      return renderItems(items);
    },

    threadsText(): string | null {
      const threads = readFromDisk().threads;
      if (!threads.length) return null;
      return renderThreads(threads);
    },

    injectionSections(query: string): Array<{ title: string; body: string }> {
      const store = readFromDisk();
      const sections: Array<{ title: string; body: string }> = [];
      if (store.brief) {
        const body = clipBlock(renderBrief(store.brief), BRIEF_INJECT_MAX_CHARS);
        if (body) sections.push({ title: "Project brief (the CTO owns this)", body });
      }
      const items = rankContextItems(store.items, query, 8);
      if (items.length) {
        sections.push({
          title: "Project memory",
          body: clipBlock(renderItems(items), ITEMS_INJECT_MAX_CHARS),
        });
      }
      if (store.threads.length) {
        sections.push({
          title: "Threads the CTO has directed",
          body: clipBlock(renderThreads(store.threads), THREADS_INJECT_MAX_CHARS),
        });
      }
      return sections;
    },
  };
}

export type ProjectContextStore = ReturnType<typeof createProjectContextStore>;
