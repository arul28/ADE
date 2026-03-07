import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { FileChangeEvent } from "../../../shared/types";
import { normalizeRelative } from "../shared/utils";

type WatchCallback = (event: FileChangeEvent) => void;

type WatchSubscription = {
  watcher: FSWatcher;
  workspaceId: string;
  senderId: number;
  rootPath: string;
  callback: WatchCallback;
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

  const stop = (workspaceId: string, senderId: number): void => {
    const key = `${workspaceId}:${senderId}`;
    const current = subscriptions.get(key);
    if (!current) return;

    const pending = pendingBySub.get(key);
    if (pending) {
      for (const timeout of pending.values()) {
        clearTimeout(timeout);
      }
      pendingBySub.delete(key);
    }

    subscriptions.delete(key);
    void current.watcher.close().catch(() => {
      // ignore close errors
    });
  };

  const stopAllForSender = (senderId: number): void => {
    const workspaceIds: string[] = [];
    for (const sub of subscriptions.values()) {
      if (sub.senderId !== senderId) continue;
      workspaceIds.push(sub.workspaceId);
    }
    for (const workspaceId of workspaceIds) {
      stop(workspaceId, senderId);
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
    watch(args: { workspaceId: string; rootPath: string; senderId: number }, callback: WatchCallback): void {
      const key = `${args.workspaceId}:${args.senderId}`;
      stop(args.workspaceId, args.senderId);

      const watcher = chokidar.watch(args.rootPath, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 120,
          pollInterval: 50
        },
        ignored: [
          /(^|[/\\])\.git($|[/\\])/,
          /(^|[/\\])node_modules($|[/\\])/,
          /(^|[/\\])\.ade($|[/\\])/
        ]
      });

      const forward = (kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir", absPath: string) => {
        const relRaw = path.relative(args.rootPath, absPath);
        const relPath = normalizeRelative(relRaw);
        if (!relPath || relPath.startsWith(".git/") || relPath === ".git" || relPath.startsWith(".ade/") || relPath === ".ade") return;
        const fileKey = `${kind}:${relPath}`;
        emitDebounced(key, fileKey, () => {
          callback({
            workspaceId: args.workspaceId,
            type: mapEventType(kind),
            path: relPath,
            ts: new Date().toISOString()
          });
        });
      };

      watcher.on("add", (absPath) => forward("add", absPath));
      watcher.on("change", (absPath) => forward("change", absPath));
      watcher.on("unlink", (absPath) => forward("unlink", absPath));
      watcher.on("addDir", (absPath) => forward("addDir", absPath));
      watcher.on("unlinkDir", (absPath) => forward("unlinkDir", absPath));

      subscriptions.set(key, {
        watcher,
        workspaceId: args.workspaceId,
        senderId: args.senderId,
        rootPath: args.rootPath,
        callback
      });
    },

    stop,

    stopAllForSender,

    disposeAll(): void {
      for (const entry of subscriptions.values()) {
        void entry.watcher.close().catch(() => {
          // ignore close errors
        });
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
