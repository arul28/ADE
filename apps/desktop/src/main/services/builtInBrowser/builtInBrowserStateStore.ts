import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { BUILT_IN_BROWSER_TAB_LIMIT_MAX } from "../../../shared/types/builtInBrowser";

/**
 * v1 persisted whatever the pane had open, including the google.com home page
 * ADE used to force onto every new tab. v2 exists only to drop that default on
 * read once: without it, "new tab no longer loads google" would still be
 * undone on the next launch by a restored tab.
 *
 * v3 changed how a project collection key is derived: the hash now runs over
 * `pathKey(resolve(projectRoot))` instead of the raw string, so `C:\Users\dev`
 * and `c:\users\dev` stop producing two invisible collections on Windows. The
 * old key cannot be recomputed from the file (only the digest was stored), so a
 * v2 read keeps the unhashed `window`/`personal` collections and drops the
 * `project-*` ones — one launch of restored tabs, once.
 */
const STATE_VERSION = 3;
const LEGACY_STATE_VERSION = 1;
const REKEYED_COLLECTION_STATE_VERSION = 2;

/**
 * Home pages ADE itself put there. A google *search* URL is a real thing the
 * person navigated to and is left alone; a bare home page is the old default.
 */
const LEGACY_DEFAULT_TAB_URL_PATTERN =
  /^https?:\/\/(?:www\.)?google\.[a-z.]{2,6}\/?$/i;

function isLegacyDefaultTabUrl(value: string): boolean {
  return LEGACY_DEFAULT_TAB_URL_PATTERN.test(value.trim());
}
const MAX_COLLECTIONS = 100;
// Persist the maximum the setting allows; the live limit slices on restore.
// Capping at the default 10 dropped every tab an agent opened above 10 when
// the machine was configured for more.
const MAX_TABS_PER_COLLECTION = BUILT_IN_BROWSER_TAB_LIMIT_MAX;
const WRITE_DEBOUNCE_MS = 200;

/**
 * One saved tab. Only `url` is required: files written before the rest were
 * saved restore as tabs a person opened, under new ids.
 */
export type BuiltInBrowserPersistedTab = {
  url: string;
  /** The tab's id, kept so an id an agent saved still works after a restart. */
  id?: string;
  /** Who opened it; a tab a chat opened is not restored unless a person kept it. */
  openedBy?: "human" | "chat";
  openedByChatSessionId?: string | null;
  openedByLaneId?: string | null;
  /** The lane the tab is outlined with. */
  groupLaneId?: string | null;
  /** A person navigated it or handed it to a chat: it is theirs to keep. */
  keptByPerson?: boolean;
};

export type BuiltInBrowserRestoredCollection = {
  tabs: BuiltInBrowserPersistedTab[];
  activeIndex: number;
};

type StoredCollection = BuiltInBrowserRestoredCollection & {
  updatedAt: string;
};

type StoredState = {
  version: typeof STATE_VERSION;
  collections: Record<string, StoredCollection>;
};

export function createBuiltInBrowserStateStore(args: {
  filePath: string;
  getLogger?: () => Logger | null;
}) {
  const loaded = loadState(args.filePath);
  const collections = new Map<string, StoredCollection>(loaded.entries);
  let writeTimer: NodeJS.Timeout | null = null;
  let writeChain = Promise.resolve();
  // A migrated file is dirty on load so the upgrade is persisted even if the
  // person never opens the browser again this session.
  let dirty = loaded.migrated;

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const snapshot = (): StoredState => ({
    version: STATE_VERSION,
    collections: Object.fromEntries(
      [...collections.entries()]
        .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
        .slice(0, MAX_COLLECTIONS),
    ),
  });

  const writeNow = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    const state = snapshot();
    try {
      await writeJsonAtomically(args.filePath, state);
    } catch (error) {
      dirty = true;
      logger()?.warn("built_in_browser.state_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const enqueueWrite = (): Promise<void> => {
    writeChain = writeChain.then(writeNow, writeNow);
    return writeChain;
  };

  const scheduleWrite = (): void => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void enqueueWrite().catch(() => {});
    }, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  };

  return {
    restore(collectionKey: string): BuiltInBrowserRestoredCollection | null {
      const stored = collections.get(collectionKey);
      if (!stored) return null;
      return {
        tabs: stored.tabs.map((tab) => ({ ...tab })),
        activeIndex: stored.activeIndex,
      };
    },
    record(collectionKey: string, value: BuiltInBrowserRestoredCollection): void {
      if (!isPersistentCollectionKey(collectionKey)) return;
      const activeTab = value.tabs[Math.floor(value.activeIndex)] ?? null;
      const kept = value.tabs
        .map((tab) => ({ source: tab, saved: persistedTab(tab) }))
        .filter((entry): entry is { source: BuiltInBrowserPersistedTab; saved: BuiltInBrowserPersistedTab } => Boolean(entry.saved))
        .slice(0, MAX_TABS_PER_COLLECTION);
      const tabs = kept.map((entry) => entry.saved);
      const activeIndex = Math.max(0, kept.findIndex((entry) => entry.source === activeTab));
      const next: StoredCollection = {
        tabs,
        activeIndex,
        updatedAt: new Date().toISOString(),
      };
      const previous = collections.get(collectionKey);
      if (
        previous
        && previous.activeIndex === next.activeIndex
        && JSON.stringify(previous.tabs) === JSON.stringify(next.tabs)
      ) {
        return;
      }
      collections.set(collectionKey, next);
      dirty = true;
      scheduleWrite();
    },
    async flush(): Promise<void> {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      await enqueueWrite();
    },
  };
}

function loadState(filePath: string): { entries: Array<[string, StoredCollection]>; migrated: boolean } {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.collections)) return { entries: [], migrated: false };
    const migrated = parsed.version === LEGACY_STATE_VERSION;
    const rekeyed = parsed.version === REKEYED_COLLECTION_STATE_VERSION;
    if (parsed.version !== STATE_VERSION && !migrated && !rekeyed) return { entries: [], migrated: false };
    const entries = Object.entries(parsed.collections)
      .map(([key, value]): [string, StoredCollection] | null => {
        if (!isPersistentCollectionKey(key) || !isRecord(value) || !Array.isArray(value.tabs)) return null;
        // Project keys written before v3 hash a different input, so they would
        // restore into a collection nothing ever looks at.
        if ((migrated || rekeyed) && key.startsWith("project-")) return null;
        const tabs = value.tabs
          .map((tab) => isRecord(tab) ? persistedTab(tab) : null)
          .filter((tab): tab is BuiltInBrowserPersistedTab => Boolean(tab))
          // Drop the home page ADE used to force onto new tabs, but only while
          // upgrading a v1 file — after that a google tab is the person's own.
          .filter((tab) => !migrated || !isLegacyDefaultTabUrl(tab.url))
          .slice(0, MAX_TABS_PER_COLLECTION);
        const rawActiveIndex = typeof value.activeIndex === "number" ? Math.floor(value.activeIndex) : 0;
        return [key, {
          tabs,
          activeIndex: tabs.length === 0 ? 0 : Math.max(0, Math.min(tabs.length - 1, rawActiveIndex)),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
        }];
      })
      .filter((entry): entry is [string, StoredCollection] => Boolean(entry))
      .slice(0, MAX_COLLECTIONS);
    return { entries, migrated: migrated || rekeyed };
  } catch {
    return { entries: [], migrated: false };
  }
}

function isPersistentCollectionKey(value: string): boolean {
  return value === "window" || value === "personal" || /^project-[a-f0-9]{16}$/.test(value);
}

const TAB_ID_PATTERN = /^tab-[A-Za-z0-9-]{8,80}$/;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A tab as it is saved, or null when it must not come back after a restart. */
function persistedTab(value: Record<string, unknown> | BuiltInBrowserPersistedTab): BuiltInBrowserPersistedTab | null {
  const url = restorableBrowserUrl(value.url);
  if (!url || isOneTimeBrowserUrl(url)) return null;
  const id = typeof value.id === "string" && TAB_ID_PATTERN.test(value.id) ? value.id : null;
  const openedBy = value.openedBy === "chat" || value.openedBy === "human" ? value.openedBy : null;
  const openedByChatSessionId = optionalString(value.openedByChatSessionId);
  const openedByLaneId = optionalString(value.openedByLaneId);
  const groupLaneId = optionalString(value.groupLaneId);
  return {
    url,
    ...(id ? { id } : {}),
    ...(openedBy ? { openedBy } : {}),
    ...(openedByChatSessionId ? { openedByChatSessionId } : {}),
    ...(openedByLaneId ? { openedByLaneId } : {}),
    ...(groupLaneId ? { groupLaneId } : {}),
    ...(value.keptByPerson === true ? { keptByPerson: true } : {}),
  };
}

/**
 * A page that works once: an OAuth consent or callback page carries a
 * one-time `state`, `code` or PKCE challenge. Loaded again after a restart it
 * fails, or starts a sign-in nobody asked for, so it is never saved.
 */
export function isOneTimeBrowserUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const params = parsed.searchParams;
  if (params.has("code_challenge") || params.has("id_token") || params.has("access_token")) return true;
  if (params.has("state") && (params.has("code") || params.has("redirect_uri") || params.has("client_id"))) return true;
  return /(^|[^a-z])(oauth|callback)([^a-z]|$)/i.test(parsed.pathname) && params.has("state");
}

function restorableBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
