import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { FileChangeEvent } from "../../../shared/types";
import { normalizeRelative } from "../shared/utils";

type WatchCallback = (event: FileChangeEvent) => void;

type WatchSubscription = {
  watcher: FSWatcher | null;
  workspaceId: string;
  senderId: number;
  rootPath: string;
  callback: WatchCallback;
  includeIgnored: boolean;
  defaultRefCount: number;
  includeIgnoredRefCount: number;
};

const EVENT_DEBOUNCE_MS = 140;

function mapEventType(kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir"): FileChangeEvent["type"] {
  if (kind === "add" || kind === "addDir") return "created";
  if (kind === "unlink" || kind === "unlinkDir") return "deleted";
  return "modified";
}

export function createFileWatcherService() {
  const subscriptions = new Map<string, WatchSubscription>();
  const pendingBySub = new Map<string, Map<string, NodeJS.Timeout>>();

  const clearPending = (key: string): void => {
    const pending = pendingBySub.get(key);
    if (pending) {
      for (const timeout of pending.values()) {
        clearTimeout(timeout);
      }
      pendingBySub.delete(key);
    }
  };

  const closeWatcher = (subscription: WatchSubscription | undefined): void => {
    if (!subscription?.watcher) return;
    const watcher = subscription.watcher;
    subscription.watcher = null;
    void watcher.close().catch(() => {
      // ignore close errors
    });
  };

  const ALWAYS_IGNORED_PATTERNS: RegExp[] = [
    /(^|[/\\])\.git($|[/\\])/,
    /(^|[/\\])node_modules($|[/\\])/,
  ];
  const DEFAULT_IGNORED_PATTERNS: RegExp[] = [
    ...ALWAYS_IGNORED_PATTERNS,
    /(^|[/\\])\.ade($|[/\\])/,
  ];

  const ignoredPatternsFor = (includeIgnored: boolean): RegExp[] =>
    includeIgnored ? ALWAYS_IGNORED_PATTERNS : DEFAULT_IGNORED_PATTERNS;

  const startWatcher = (key: string, subscription: WatchSubscription): void => {
    closeWatcher(subscription);

    const watcher = chokidar.watch(subscription.rootPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 120,
        pollInterval: 50
      },
      ignored: ignoredPatternsFor(subscription.includeIgnored)
    });

    const forward = (kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir", absPath: string) => {
      const relRaw = path.relative(subscription.rootPath, absPath);
      const relPath = normalizeRelative(relRaw);
      if (!relPath || relPath.startsWith(".git/") || relPath === ".git") return;
      if (!subscription.includeIgnored && (relPath.startsWith(".ade/") || relPath === ".ade")) return;
      const fileKey = `${kind}:${relPath}`;
      emitDebounced(key, fileKey, () => {
        subscription.callback({
          workspaceId: subscription.workspaceId,
          type: mapEventType(kind),
          path: relPath,
          ts: new Date().toISOString()
        });
      });
    };

    watcher.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EMFILE" || code === "ENFILE") {
        clearPending(key);
        subscriptions.delete(key);
        closeWatcher(subscription);
      }
      // Other errors are non-fatal for chokidar; ignore silently
    });

    watcher.on("add", (absPath) => forward("add", absPath));
    watcher.on("change", (absPath) => forward("change", absPath));
    watcher.on("unlink", (absPath) => forward("unlink", absPath));
    watcher.on("addDir", (absPath) => forward("addDir", absPath));
    watcher.on("unlinkDir", (absPath) => forward("unlinkDir", absPath));

    subscription.watcher = watcher;
  };

  const stop = (workspaceId: string, senderId: number, includeIgnored = false): void => {
    const key = `${workspaceId}:${senderId}`;
    const current = subscriptions.get(key);
    if (!current) return;

    if (includeIgnored) {
      if (current.includeIgnoredRefCount <= 0) return;
      current.includeIgnoredRefCount -= 1;
    } else {
      if (current.defaultRefCount <= 0) return;
      current.defaultRefCount -= 1;
    }

    if (current.defaultRefCount === 0 && current.includeIgnoredRefCount === 0) {
      clearPending(key);
      subscriptions.delete(key);
      closeWatcher(current);
      return;
    }

    const nextIncludeIgnored = current.includeIgnoredRefCount > 0;
    if (nextIncludeIgnored !== current.includeIgnored) {
      current.includeIgnored = nextIncludeIgnored;
      startWatcher(key, current);
    }
  };

  const stopAllForSender = (senderId: number): void => {
    const toRemove: string[] = [];
    for (const [key, sub] of subscriptions) {
      if (sub.senderId !== senderId) continue;
      clearPending(key);
      closeWatcher(sub);
      toRemove.push(key);
    }
    for (const key of toRemove) {
      subscriptions.delete(key);
    }
  };

  const emitDebounced = (subKey: string, fileKey: string, emit: () => void) => {
    let queue = pendingBySub.get(subKey);
    if (!queue) {
      queue = new Map();
      pendingBySub.set(subKey, queue);
    }
    const prev = queue.get(fileKey);
    if (prev) clearTimeout(prev);
    const timeout = setTimeout(() => {
      queue?.delete(fileKey);
      if (queue && queue.size === 0) pendingBySub.delete(subKey);
      emit();
    }, EVENT_DEBOUNCE_MS);
    queue.set(fileKey, timeout);
  };

  return {
    watch(
      args: { workspaceId: string; rootPath: string; senderId: number; includeIgnored?: boolean },
      callback: WatchCallback
    ): void {
      const key = `${args.workspaceId}:${args.senderId}`;
      const requestedIncludeIgnored = Boolean(args.includeIgnored);
      const current = subscriptions.get(key);
      if (current) {
        const rootPathChanged = current.rootPath !== args.rootPath;
        current.callback = callback;
        current.rootPath = args.rootPath;
        if (requestedIncludeIgnored) {
          current.includeIgnoredRefCount += 1;
        } else {
          current.defaultRefCount += 1;
        }
        const nextIncludeIgnored = current.includeIgnoredRefCount > 0;
        if (rootPathChanged || current.includeIgnored !== nextIncludeIgnored || !current.watcher) {
          current.includeIgnored = nextIncludeIgnored;
          startWatcher(key, current);
        }
        return;
      }

      const subscription: WatchSubscription = {
        watcher: null,
        workspaceId: args.workspaceId,
        senderId: args.senderId,
        rootPath: args.rootPath,
        callback,
        includeIgnored: requestedIncludeIgnored,
        defaultRefCount: requestedIncludeIgnored ? 0 : 1,
        includeIgnoredRefCount: requestedIncludeIgnored ? 1 : 0
      };
      subscriptions.set(key, subscription);
      startWatcher(key, subscription);
    },

    stop,

    stopAllForSender,

    disposeAll(): void {
      for (const entry of subscriptions.values()) {
        closeWatcher(entry);
      }
      subscriptions.clear();

      for (const pending of pendingBySub.values()) {
        for (const timeout of pending.values()) {
          clearTimeout(timeout);
        }
      }
      pendingBySub.clear();
    }
  };
}
