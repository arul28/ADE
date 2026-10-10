/**
 * The file watches a client still holds, counted the way the watcher service
 * counts them (one reference per `watchWorkspace`, released by one
 * `stopWatching` with the same arguments).
 *
 * A page that goes away without running its cleanup (a reload, a crashed
 * renderer, a closed window, the app quitting) never sends its stops. The
 * brain outlives the page, so each lost stop leaves a watcher on a whole
 * repository until the brain restarts. Whoever sees the client go drains its
 * ledger and sends the stops the page did not.
 */

export type FileWatchRef = {
  /** The watch arguments exactly as the client sent them (no client id). */
  args: Record<string, unknown>;
  clientId: number;
};

type Entry = FileWatchRef & { count: number };

export type FileWatchLedger = {
  noteWatch(args: Record<string, unknown>, clientId: number): void;
  noteStop(args: Record<string, unknown>, clientId: number): void;
  /** Every reference still held, one entry per reference. */
  refs(): FileWatchRef[];
  /** The same references; the ledger is empty afterwards. */
  drain(): FileWatchRef[];
  readonly size: number;
};

/** `{ args: {...} }` and the bare arguments are the same watch. */
function watchKey(args: Record<string, unknown>, clientId: number): string | null {
  const nested = args.args;
  const watch = nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : args;
  const workspaceId = typeof watch.workspaceId === "string" ? watch.workspaceId.trim() : "";
  if (!workspaceId) return null;
  return `${clientId}\u0000${workspaceId}\u0000${watch.includeIgnored === true ? 1 : 0}`;
}

export function createFileWatchLedger(): FileWatchLedger {
  const entries = new Map<string, Entry>();
  const refs = (): FileWatchRef[] => {
    const held: FileWatchRef[] = [];
    for (const entry of entries.values()) {
      for (let index = 0; index < entry.count; index += 1) {
        held.push({ args: entry.args, clientId: entry.clientId });
      }
    }
    return held;
  };
  return {
    noteWatch(args, clientId) {
      const key = watchKey(args, clientId);
      if (!key) return;
      const entry = entries.get(key);
      if (entry) entry.count += 1;
      else entries.set(key, { args, clientId, count: 1 });
    },
    noteStop(args, clientId) {
      const key = watchKey(args, clientId);
      const entry = key ? entries.get(key) : undefined;
      if (!key || !entry) return;
      entry.count -= 1;
      if (entry.count <= 0) entries.delete(key);
    },
    refs,
    drain() {
      const held = refs();
      entries.clear();
      return held;
    },
    get size() {
      return entries.size;
    },
  };
}
