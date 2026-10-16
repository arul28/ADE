import fs from "node:fs";
import path from "node:path";
import chokidar, { type ChokidarOptions } from "chokidar";

/**
 * Watches a directory tree and reports `add`, `change`, `unlink`, `addDir` and
 * `unlinkDir` with absolute paths, as chokidar does.
 *
 * On Linux this is chokidar. On macOS and Windows chokidar has two modes and
 * neither fits a tree: the native one opens one watch per directory, and
 * opening or closing thousands of those blocks the event loop (on Windows it
 * also stats the whole tree first, seconds on a large repository); the polling
 * one (`chokidarOptions.ts`) checks every path under the root once a second for
 * as long as the watcher lives.
 *
 * So macOS and Windows get one recursive native watch per root (FSEvents,
 * ReadDirectoryChangesW), which costs nothing while the tree is still, and one
 * handle to close. Linux has no native recursive watch. The native event only says where
 * to look. What happened is decided as a poller decides it: the path is read
 * again and compared with what was there before. A new directory is walked
 * and a removed one is reported entry by entry, so callers receive the events
 * chokidar sends.
 */

export type TreeWatcherEvent = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export type TreeWatcher = {
  on(event: TreeWatcherEvent, listener: (absPath: string) => void): TreeWatcher;
  on(event: "error", listener: (error: unknown) => void): TreeWatcher;
  on(event: "ready", listener: () => void): TreeWatcher;
  once(event: "ready", listener: () => void): TreeWatcher;
  close(): Promise<void>;
};

export type TreeWatcherOptions = {
  ignored?: ChokidarOptions["ignored"];
  /** Report a new or changed file once its size has held still this long. */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
};

type Entry = { dir: boolean; mtimeMs: number; size: number };
type Listener = (payload?: unknown) => void;

/** Native events for one burst are handled together, parents first. */
const EVENT_BATCH_MS = 25;
const SCAN_CONCURRENCY = 32;

export function watchTree(rootPath: string, options: TreeWatcherOptions = {}): TreeWatcher {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return chokidar.watch(rootPath, {
      ignoreInitial: true,
      ...(options.awaitWriteFinish ? { awaitWriteFinish: options.awaitWriteFinish } : {}),
      ...(options.ignored ? { ignored: options.ignored } : {}),
    }) as unknown as TreeWatcher;
  }
  return createNativeTreeWatcher(rootPath, options);
}

function buildIgnore(ignored: TreeWatcherOptions["ignored"]): (absPath: string) => boolean {
  const matchers = (Array.isArray(ignored) ? ignored : ignored ? [ignored] : []) as unknown[];
  return (absPath) => matchers.some((matcher) => {
    if (matcher instanceof RegExp) return matcher.test(absPath);
    if (typeof matcher === "function") return Boolean((matcher as (candidate: string) => boolean)(absPath));
    if (typeof matcher === "string") return absPath === matcher || absPath.startsWith(`${matcher}${path.sep}`);
    return false;
  });
}

function createNativeTreeWatcher(rootPath: string, options: TreeWatcherOptions): TreeWatcher {
  const root = path.resolve(rootPath);
  const isIgnored = buildIgnore(options.ignored);
  const settle = options.awaitWriteFinish ?? null;
  const listeners = new Map<string, Set<Listener>>();
  /** Everything known under the root, by absolute path (as reached from the root, through links). */
  const entries = new Map<string, Entry>();
  /**
   * Directories reached through a symlink: real directory -> the paths it is
   * known by. A native event names the real path, and the poller reported the
   * change under every path that leads to it.
   */
  const aliases = new Map<string, Set<string>>();
  const nativeWatchers = new Map<string, fs.FSWatcher>();
  const pendingEvents = new Set<string>();
  const settling = new Map<string, { timer: NodeJS.Timeout; size: number; since: number; kind: "add" | "change" }>();
  let batchTimer: NodeJS.Timeout | null = null;
  let ready = false;
  let closed = false;
  let work: Promise<void> = Promise.resolve();

  const emit = (event: string, payload?: unknown): void => {
    if (closed) return;
    for (const listener of [...(listeners.get(event) ?? [])]) {
      try {
        listener(payload);
      } catch {
        // A listener's failure is its own; the watcher keeps going.
      }
    }
  };

  const statOrNull = async (absPath: string): Promise<fs.Stats | null> => {
    try {
      return await fs.promises.stat(absPath);
    } catch {
      return null;
    }
  };

  /** Known direct children of each known directory. */
  const childrenOf = new Map<string, Set<string>>();
  const remember = (absPath: string, entry: Entry): void => {
    if (!entries.has(absPath) && absPath !== root) {
      const parent = path.dirname(absPath);
      let siblings = childrenOf.get(parent);
      if (!siblings) {
        siblings = new Set();
        childrenOf.set(parent, siblings);
      }
      siblings.add(absPath);
    }
    entries.set(absPath, entry);
  };
  const drop = (absPath: string): void => {
    entries.delete(absPath);
    childrenOf.delete(absPath);
    childrenOf.get(path.dirname(absPath))?.delete(absPath);
  };

  const descendantsOf = (absPath: string): string[] => {
    const found: string[] = [];
    const collect = (dir: string): void => {
      for (const child of childrenOf.get(dir) ?? []) {
        collect(child);
        // After its own contents, so a directory is reported after what was in it.
        found.push(child);
      }
    };
    collect(absPath);
    return found;
  };

  const forget = (absPath: string, announce: boolean): void => {
    const entry = entries.get(absPath);
    if (!entry) return;
    if (entry.dir) {
      for (const child of descendantsOf(absPath)) {
        const childEntry = entries.get(child)!;
        drop(child);
        cancelSettle(child);
        if (announce) emit(childEntry.dir ? "unlinkDir" : "unlink", child);
      }
      for (const [real, known] of aliases) {
        for (const alias of [...known]) {
          if (alias === absPath || alias.startsWith(`${absPath}${path.sep}`)) known.delete(alias);
        }
        if (known.size === 0) {
          aliases.delete(real);
          const external = nativeWatchers.get(real);
          if (external && real !== root) {
            external.close();
            nativeWatchers.delete(real);
          }
        }
      }
    }
    drop(absPath);
    cancelSettle(absPath);
    if (absPath === root && process.platform === "win32") {
      // A Windows watch follows the directory it opened, not the path: after a
      // move it would report the moved tree as if it were still here. The
      // parent's watch sees the root come back and opens a new one.
      nativeWatchers.get(root)?.close();
      nativeWatchers.delete(root);
    }
    if (announce) emit(entry.dir ? "unlinkDir" : "unlink", absPath);
  };

  function cancelSettle(absPath: string): void {
    const pending = settling.get(absPath);
    if (!pending) return;
    clearTimeout(pending.timer);
    settling.delete(absPath);
  }

  /** Report a new or changed file, after its size holds still when asked to wait. */
  const announceFile = (absPath: string, kind: "add" | "change", stat: fs.Stats): void => {
    if (!settle) {
      remember(absPath, { dir: false, mtimeMs: stat.mtimeMs, size: stat.size });
      emit(kind, absPath);
      return;
    }
    const existing = settling.get(absPath);
    // A file that is still being announced as new stays new.
    const pendingKind = existing?.kind === "add" ? "add" : kind;
    if (existing) clearTimeout(existing.timer);
    const check = async (): Promise<void> => {
      const pending = settling.get(absPath);
      if (!pending || closed) return;
      const current = await statOrNull(absPath);
      if (settling.get(absPath) !== pending || closed) return;
      if (!current || current.isDirectory()) {
        settling.delete(absPath);
        enqueue(absPath);
        return;
      }
      const now = Date.now();
      if (current.size !== pending.size) {
        pending.size = current.size;
        pending.since = now;
      }
      if (now - pending.since >= settle.stabilityThreshold) {
        settling.delete(absPath);
        remember(absPath, { dir: false, mtimeMs: current.mtimeMs, size: current.size });
        emit(pending.kind, absPath);
        return;
      }
      pending.timer = setTimeout(() => { void check(); }, settle.pollInterval);
    };
    settling.set(absPath, {
      kind: pendingKind,
      size: stat.size,
      since: Date.now(),
      timer: setTimeout(() => { void check(); }, settle.pollInterval),
    });
  };

  /** One recursive native watch on `dir`. False when the OS refused it. */
  function openNativeWatch(dir: string): boolean {
    if (closed) return false;
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        onNativeEvent(dir, filename);
      });
      watcher.on("error", (error) => emit("error", error));
      nativeWatchers.set(dir, watcher);
      return true;
    } catch (error) {
      emit("error", error);
      return false;
    }
  }

  const watchExternal = (realDir: string): void => {
    if (nativeWatchers.has(realDir) || realDir === root || realDir.startsWith(`${root}${path.sep}`)) return;
    openNativeWatch(realDir);
  };

  /** At most this many directory reads and stats at once, across the whole walk. */
  let ioActive = 0;
  const ioWaiting: Array<() => void> = [];
  const io = async <T,>(task: () => Promise<T>): Promise<T> => {
    if (ioActive >= SCAN_CONCURRENCY) await new Promise<void>((resolve) => ioWaiting.push(resolve));
    ioActive += 1;
    try {
      return await task();
    } finally {
      ioActive -= 1;
      ioWaiting.shift()?.();
    }
  };

  /**
   * Bring one directory's direct children in line with the disk, walking into
   * what is new. `announce` is false for the first walk (`ignoreInitial`).
   * `visitedReal` holds the real directories above this one, so a link back up
   * the tree is not followed forever.
   */
  const syncDirectory = async (absDir: string, announce: boolean, visitedReal: Set<string>): Promise<void> => {
    if (closed) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await io(() => fs.promises.readdir(absDir, { withFileTypes: true }));
    } catch {
      return;
    }
    const present = new Set<string>();
    const subdirectories: Array<{ path: string; linked: boolean }> = [];
    await Promise.all(dirents.map(async (dirent) => {
      const child = path.join(absDir, dirent.name);
      if (isIgnored(child)) return;
      const linked = dirent.isSymbolicLink();
      // A plain directory needs no stat; a file needs its time and size; a
      // link is whatever it points at.
      const stat = dirent.isDirectory() ? null : await io(() => statOrNull(child));
      if (closed) return;
      const isDirectory = dirent.isDirectory() || Boolean(stat?.isDirectory());
      if (!isDirectory && !stat?.isFile()) return;
      present.add(child);
      const known = entries.get(child);
      if (isDirectory) {
        if (known && !known.dir) forget(child, announce);
        if (!entries.has(child)) {
          remember(child, { dir: true, mtimeMs: 0, size: 0 });
          if (announce) emit("addDir", child);
          subdirectories.push({ path: child, linked });
        }
        return;
      }
      if (known?.dir) forget(child, announce);
      const before = entries.get(child);
      if (!before) {
        if (announce) announceFile(child, "add", stat!);
        else remember(child, { dir: false, mtimeMs: stat!.mtimeMs, size: stat!.size });
      } else if (before.mtimeMs !== stat!.mtimeMs || before.size !== stat!.size) {
        if (announce) announceFile(child, "change", stat!);
        else remember(child, { dir: false, mtimeMs: stat!.mtimeMs, size: stat!.size });
      }
    }));
    for (const known of [...(childrenOf.get(absDir) ?? [])]) {
      if (!present.has(known) && !settling.has(known)) forget(known, announce);
    }
    await Promise.all(subdirectories.map((child) =>
      child.linked ? walkLinkedDirectory(child.path, announce, visitedReal) : syncDirectory(child.path, announce, visitedReal)));
  };

  /** Walk a directory reached through a link; chokidar follows links too. */
  const walkLinkedDirectory = async (absDir: string, announce: boolean, visitedReal: Set<string>): Promise<void> => {
    let real: string;
    try {
      real = await io(() => fs.promises.realpath(absDir));
    } catch {
      return;
    }
    if (closed || visitedReal.has(real)) return;
    let known = aliases.get(real);
    if (!known) {
      known = new Set();
      aliases.set(real, known);
    }
    known.add(absDir);
    watchExternal(real);
    await syncDirectory(absDir, announce, new Set(visitedReal).add(real));
  };

  /** Walk a directory that was not known before. */
  const walkDirectory = async (absDir: string, announce: boolean, visitedReal: Set<string>): Promise<void> => {
    let linked = false;
    try {
      linked = (await fs.promises.lstat(absDir)).isSymbolicLink();
    } catch {
      return;
    }
    if (linked) await walkLinkedDirectory(absDir, announce, visitedReal);
    else await syncDirectory(absDir, announce, visitedReal);
  };

  const ancestorsReal = async (absDir: string): Promise<Set<string>> => {
    const visited = new Set<string>();
    let current = absDir;
    while (current.startsWith(root)) {
      try {
        visited.add(await fs.promises.realpath(current));
      } catch {
        // A missing ancestor is handled by its own event.
      }
      if (current === root) break;
      current = path.dirname(current);
    }
    return visited;
  };

  /** Look at one path again and report what changed there. */
  const inspect = async (absPath: string): Promise<void> => {
    if (closed || isIgnored(absPath)) return;
    if (absPath !== root && !absPath.startsWith(`${root}${path.sep}`)) return;
    const parent = path.dirname(absPath);
    if (absPath !== root && !entries.has(parent) && parent !== root) {
      // The parent is new too; its walk finds this path.
      await inspect(parent);
      return;
    }
    const stat = await statOrNull(absPath);
    if (closed) return;
    const known = entries.get(absPath);
    if (!stat) {
      if (known) {
        forget(absPath, true);
      } else if (entries.has(root) && !(await statOrNull(root))) {
        // The event for a root that was moved away or deleted names a path
        // that never existed. The root takes its whole tree with it.
        if (!closed) forget(root, true);
      }
      return;
    }
    // A root that came back is diffed against an empty tree.
    if (!entries.has(root)) remember(root, { dir: true, mtimeMs: 0, size: 0 });
    if (!nativeWatchers.has(root)) openNativeWatch(root);
    if (stat.isDirectory()) {
      if (known && !known.dir) forget(absPath, true);
      const visited = await ancestorsReal(parent);
      if (!entries.has(absPath)) {
        remember(absPath, { dir: true, mtimeMs: stat.mtimeMs, size: 0 });
        emit("addDir", absPath);
        await walkDirectory(absPath, true, visited);
        return;
      }
      await syncDirectory(absPath, true, visited.add(await fs.promises.realpath(absPath).catch(() => absPath)));
      return;
    }
    if (!stat.isFile()) return;
    if (known?.dir) forget(absPath, true);
    const before = entries.get(absPath);
    if (!before) announceFile(absPath, "add", stat);
    else if (before.mtimeMs !== stat.mtimeMs || before.size !== stat.size) announceFile(absPath, "change", stat);
  };

  /**
   * Read every known directory again, as after the first walk, and report what
   * differs. Directories reached through a link are read once per path, as the
   * walk does.
   */
  const resyncTree = async (absDir: string, visitedReal: Set<string>, linked: Set<string>): Promise<void> => {
    if (closed) return;
    const knownBefore = [...(childrenOf.get(absDir) ?? [])];
    // New directories are walked whole by this read; only the known ones need a pass of their own.
    await syncDirectory(absDir, true, visitedReal);
    await Promise.all(knownBefore.map(async (child) => {
      if (closed || !entries.get(child)?.dir) return;
      if (!linked.has(child)) return resyncTree(child, visitedReal, linked);
      const real = await io(() => fs.promises.realpath(child)).catch(() => null);
      if (real && !visitedReal.has(real)) await resyncTree(child, new Set(visitedReal).add(real), linked);
    }));
  };

  const flush = (): void => {
    batchTimer = null;
    if (closed || !ready) return;
    const batch = [...pendingEvents].sort((left, right) => left.length - right.length);
    pendingEvents.clear();
    // A rescan that is queued and has not started yet will see everything up
    // to the moment it starts, so a second one behind it adds nothing. Without
    // this, an install or checkout (seconds of dropped events, one batch every
    // 25 ms) queues hundreds of whole-tree reads back to back.
    const rescan = rescanPending && !rescanQueued;
    rescanPending = false;
    if (rescan) rescanQueued = true;
    work = work.then(async () => {
      if (rescan) rescanQueued = false;
      if (rescan && entries.has(root)) {
        try {
          const linked = new Set([...aliases.values()].flatMap((known) => [...known]));
          await resyncTree(root, await ancestorsReal(root), linked);
        } catch (error) {
          emit("error", error);
        }
      }
      for (const absPath of batch) {
        try {
          await inspect(absPath);
        } catch (error) {
          emit("error", error);
        }
      }
    });
  };

  function enqueue(absPath: string): void {
    // Ignored paths (`.git`, `node_modules`) are most of the traffic in a busy tree; drop them here.
    if (closed || isIgnored(absPath)) return;
    pendingEvents.add(absPath);
    if (!batchTimer && ready) batchTimer = setTimeout(flush, EVENT_BATCH_MS);
  }

  /**
   * An event without a name means the OS dropped events: Windows reports a full
   * change buffer (a checkout, an install) this way, and what changed is lost.
   * Only a read of the whole tree can tell.
   */
  let rescanPending = false;
  let rescanQueued = false;
  function onNativeEvent(watchedDir: string, filename: string | Buffer | null): void {
    if (closed) return;
    if (filename) {
      enqueueReal(path.join(watchedDir, String(filename)));
      return;
    }
    rescanPending = true;
    // Queued too, so a root that is gone is still reported as gone.
    enqueueReal(watchedDir);
    if (!batchTimer && ready) batchTimer = setTimeout(flush, EVENT_BATCH_MS);
  }

  /** A native event names a real path; queue it under every path that leads there. */
  function enqueueReal(realPath: string): void {
    if (realPath === root || realPath.startsWith(`${root}${path.sep}`)) enqueue(realPath);
    for (const [realDir, known] of aliases) {
      if (realPath !== realDir && !realPath.startsWith(`${realDir}${path.sep}`)) continue;
      for (const alias of known) enqueue(path.join(alias, realPath.slice(realDir.length)));
    }
  }

  /**
   * Windows only: the root's own watch cannot see the root deleted, moved away
   * or created again, so its parent is watched (not recursively) for that one
   * name, as chokidar does. FSEvents watches by path and needs none of this.
   */
  let parentWatcher: fs.FSWatcher | null = null;
  const watchRootParent = (): void => {
    if (process.platform !== "win32") return;
    const parent = path.dirname(root);
    if (parent === root) return;
    const name = path.basename(root).toLowerCase();
    try {
      parentWatcher = fs.watch(parent, (_event, filename) => {
        if (!filename || String(filename).toLowerCase() === name) enqueue(root);
      });
      // Losing the parent's watch only loses news of the root itself.
      parentWatcher.on("error", () => {});
    } catch {
      parentWatcher = null;
    }
  };

  const start = async (): Promise<void> => {
    const rootStat = await statOrNull(root);
    if (closed) return;
    if (!rootStat?.isDirectory()) {
      // A root that is not there yet: ready at once, as chokidar is. On
      // Windows its parent's watch is what notices it being created, after
      // which `inspect` opens the root's watch and walks the new tree.
      watchRootParent();
      ready = true;
      emit("ready");
      return;
    }
    if (!openNativeWatch(root)) {
      // No watch means no events; the caller still gets `ready`, so it does not wait on a dead watcher.
      ready = true;
      emit("ready");
      return;
    }
    watchRootParent();
    remember(root, { dir: true, mtimeMs: rootStat.mtimeMs, size: 0 });
    await walkDirectory(root, false, new Set());
    if (closed) return;
    ready = true;
    emit("ready");
    if (pendingEvents.size > 0 || rescanPending) batchTimer = setTimeout(flush, EVENT_BATCH_MS);
  };

  const api: TreeWatcher = {
    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return api;
    },
    once(event: string, listener: Listener) {
      const wrapped: Listener = (payload) => {
        listeners.get(event)?.delete(wrapped);
        listener(payload);
      };
      return api.on(event as "ready", wrapped as () => void);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (batchTimer) clearTimeout(batchTimer);
      for (const pending of settling.values()) clearTimeout(pending.timer);
      settling.clear();
      for (const watcher of nativeWatchers.values()) {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      }
      nativeWatchers.clear();
      try {
        parentWatcher?.close();
      } catch {
        // already closed
      }
      parentWatcher = null;
      entries.clear();
      childrenOf.clear();
      aliases.clear();
      pendingEvents.clear();
      listeners.clear();
    },
  } as TreeWatcher;

  void start().catch((error) => emit("error", error));
  return api;
}
