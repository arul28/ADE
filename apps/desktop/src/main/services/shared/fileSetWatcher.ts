import fs from "node:fs";

/**
 * Watches a few single files and reports each create, change and removal.
 *
 * A file that exists gets a native watch: kqueue on macOS, inotify on Linux,
 * and on Windows a watch of its folder that libuv filters to the one name. It
 * costs nothing while the file stays the same. The polling watch it replaces
 * woke the process about three times a second for each file.
 *
 * A native event only says where to look. The file's stamp (inode, size,
 * mtime) is read again and compared with the last one, so an event that
 * changed nothing is dropped, and a change made between two events is still
 * reported once.
 *
 * A save that writes a new file and renames it over the old one leaves a
 * kqueue or inotify watch on the old inode. So when the inode changes, the
 * watch moves to the file that is now at the path.
 *
 * A missing file has nothing to hold a native watch, and a native watch can
 * fail (too many open files, a file system without events). Only those files
 * are checked by the 5 s poll, and only while they need it.
 *
 * A file with a native watch is also checked by a slower safety poll. On a
 * network volume an edit made on another machine sends no native event; the
 * safety poll still sees the new stamp. An unchanged stamp reports nothing.
 */

export const FILE_SET_WATCHER_POLL_MS = 5_000;
export const FILE_SET_WATCHER_SAFETY_POLL_MS = 30_000;

export type FileSetWatcher = {
  close(): void;
};

type Stamp = { ino: number; size: number; mtimeMs: number };

type WatchedFile = {
  filePath: string;
  stamp: Stamp | null;
  watcher: fs.FSWatcher | null;
  checking: boolean;
  checkAgain: boolean;
};

async function readStamp(filePath: string): Promise<Stamp | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return null;
    return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    // Missing, or not readable now: the poll looks again.
    return null;
  }
}

function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export async function watchFileSet(
  filePaths: readonly string[],
  onChange: (filePath: string) => void,
  options: { pollMs?: number; safetyPollMs?: number } = {},
): Promise<FileSetWatcher> {
  const pollMs = options.pollMs ?? FILE_SET_WATCHER_POLL_MS;
  const safetyPollMs = options.safetyPollMs ?? FILE_SET_WATCHER_SAFETY_POLL_MS;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let safetyTimer: ReturnType<typeof setInterval> | null = null;
  const files: WatchedFile[] = [...new Set(filePaths)].map((filePath) => ({
    filePath,
    stamp: null,
    watcher: null,
    checking: false,
    checkAgain: false,
  }));

  const updatePoll = (): void => {
    const needsPoll = !closed && files.some((file) => file.watcher === null);
    if (needsPoll && !pollTimer) {
      pollTimer = setInterval(() => {
        for (const file of files) {
          if (file.watcher === null) void check(file);
        }
      }, pollMs);
      pollTimer.unref?.();
    } else if (!needsPoll && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const needsSafetyPoll = !closed && files.some((file) => file.watcher !== null);
    if (needsSafetyPoll && !safetyTimer) {
      safetyTimer = setInterval(() => {
        for (const file of files) {
          if (file.watcher !== null) void check(file);
        }
      }, safetyPollMs);
      safetyTimer.unref?.();
    } else if (!needsSafetyPoll && safetyTimer) {
      clearInterval(safetyTimer);
      safetyTimer = null;
    }
  };

  const unwatch = (file: WatchedFile): void => {
    const watcher = file.watcher;
    file.watcher = null;
    try {
      watcher?.close();
    } catch {
      // Already closed.
    }
  };

  const arm = (file: WatchedFile): void => {
    unwatch(file);
    if (closed || file.stamp === null) return;
    try {
      const watcher = fs.watch(file.filePath, { persistent: false }, () => {
        void check(file);
      });
      watcher.on("error", () => {
        if (file.watcher !== watcher) return;
        unwatch(file);
        updatePoll();
      });
      file.watcher = watcher;
    } catch {
      // The file went away since its stat, or the system refused a watch.
      file.watcher = null;
    }
  };

  const check = async (file: WatchedFile): Promise<void> => {
    if (closed) return;
    if (file.checking) {
      file.checkAgain = true;
      return;
    }
    file.checking = true;
    try {
      do {
        file.checkAgain = false;
        const previous = file.stamp;
        const next = await readStamp(file.filePath);
        if (closed) return;
        if (sameStamp(previous, next)) {
          // A poll found the file again after a failed watch: try native once more.
          if (next !== null && file.watcher === null) {
            arm(file);
            updatePoll();
          }
          continue;
        }
        file.stamp = next;
        if (next === null || previous === null || previous.ino !== next.ino || file.watcher === null) {
          arm(file);
          updatePoll();
          // A write between the stat and the new watch has no event to report it.
          if (file.watcher !== null) file.checkAgain = true;
        }
        try {
          onChange(file.filePath);
        } catch {
          // The listener's failure is its own; the watch goes on.
        }
      } while (file.checkAgain && !closed);
    } finally {
      file.checking = false;
    }
  };

  await Promise.all(files.map(async (file) => {
    file.stamp = await readStamp(file.filePath);
  }));
  if (!closed) {
    for (const file of files) arm(file);
    updatePoll();
    // A write between the first stat and the watch has no event to report it.
    for (const file of files) {
      if (file.watcher !== null) void check(file);
    }
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      for (const file of files) unwatch(file);
      updatePoll();
    },
  };
}
