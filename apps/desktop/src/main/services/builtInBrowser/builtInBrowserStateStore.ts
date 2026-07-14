import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";

const STATE_VERSION = 1;
const MAX_COLLECTIONS = 100;
const MAX_TABS_PER_COLLECTION = 10;
const WRITE_DEBOUNCE_MS = 200;

export type BuiltInBrowserRestoredCollection = {
  tabs: Array<{ url: string }>;
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
  const collections = new Map<string, StoredCollection>(loadState(args.filePath));
  let writeTimer: NodeJS.Timeout | null = null;
  let writeChain = Promise.resolve();
  let dirty = false;

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
      const tabs = value.tabs
        .map((tab) => ({ url: restorableBrowserUrl(tab.url) }))
        .filter((tab): tab is { url: string } => Boolean(tab.url))
        .slice(0, MAX_TABS_PER_COLLECTION);
      const activeIndex = tabs.length === 0
        ? 0
        : Math.max(0, Math.min(tabs.length - 1, Math.floor(value.activeIndex)));
      const next: StoredCollection = {
        tabs,
        activeIndex,
        updatedAt: new Date().toISOString(),
      };
      const previous = collections.get(collectionKey);
      if (
        previous
        && previous.activeIndex === next.activeIndex
        && previous.tabs.length === next.tabs.length
        && previous.tabs.every((tab, index) => tab.url === next.tabs[index]?.url)
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

function loadState(filePath: string): Array<[string, StoredCollection]> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.collections)) return [];
    return Object.entries(parsed.collections)
      .map(([key, value]): [string, StoredCollection] | null => {
        if (!isPersistentCollectionKey(key) || !isRecord(value) || !Array.isArray(value.tabs)) return null;
        const tabs = value.tabs
          .map((tab) => isRecord(tab) ? restorableBrowserUrl(tab.url) : null)
          .filter((url): url is string => Boolean(url))
          .slice(0, MAX_TABS_PER_COLLECTION)
          .map((url) => ({ url }));
        const rawActiveIndex = typeof value.activeIndex === "number" ? Math.floor(value.activeIndex) : 0;
        return [key, {
          tabs,
          activeIndex: tabs.length === 0 ? 0 : Math.max(0, Math.min(tabs.length - 1, rawActiveIndex)),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
        }];
      })
      .filter((entry): entry is [string, StoredCollection] => Boolean(entry))
      .slice(0, MAX_COLLECTIONS);
  } catch {
    return [];
  }
}

function isPersistentCollectionKey(value: string): boolean {
  return value === "window" || value === "personal" || /^project-[a-f0-9]{16}$/.test(value);
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
