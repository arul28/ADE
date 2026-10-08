/**
 * One cache of single issues, for any tracker: what the viewer, the sheet and
 * hover cards share. Each entry is read once at a time (concurrent loads share
 * one promise), counts as fresh for `staleMs`, and the least recently written
 * entries drop out past `maxEntries`.
 *
 * Edits are optimistic: the new copy shows at once, then the tracker's copy
 * replaces it, or the old copy comes back if the tracker refuses. Two quick
 * edits on one issue: only the newest one's result lands, so a slow first
 * reply cannot overwrite the second edit or undo it on failure.
 */

export type IssueEntryStatus = "idle" | "loading" | "ready" | "missing" | "error";

export type IssueEntry<T> = {
  status: IssueEntryStatus;
  issue: T | null;
  error: string | null;
  fetchedAt: number;
  /** An edit is in flight; pickers show it as pending. */
  editing: boolean;
};

type InternalEntry<T> = IssueEntry<T> & { promise: Promise<T | null> | null; editSequence: number };

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function createIssueEntryCache<T>(options: { maxEntries: number; staleMs: number; notify: () => void }) {
  const empty: IssueEntry<T> = { status: "idle", issue: null, error: null, fetchedAt: 0, editing: false };
  const entries = new Map<string, InternalEntry<T>>();

  const write = (key: string, patch: Partial<InternalEntry<T>>): void => {
    const current = entries.get(key) ?? { ...empty, promise: null, editSequence: 0 };
    // Re-insert so the Map's order is least-recently-written first.
    entries.delete(key);
    entries.set(key, { ...current, ...patch });
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    options.notify();
  };

  const read = (key: string | null): IssueEntry<T> => (key ? entries.get(key) ?? empty : empty);

  const peek = (key: string): T | null => entries.get(key)?.issue ?? null;

  /**
   * Read through `fetch` unless a fresh copy is held or a read is in flight.
   * A failed re-read keeps the last copy and records the error beside it.
   */
  const load = (
    key: string,
    fetch: (() => Promise<T | null>) | null,
    messages: { unavailable: string; failed: string },
    loadOptions: { force?: boolean } = {},
  ): Promise<T | null> => {
    const current = entries.get(key);
    if (current?.promise) return current.promise;
    if (!loadOptions.force && current?.status === "ready" && Date.now() - current.fetchedAt < options.staleMs) {
      return Promise.resolve(current.issue);
    }
    if (!fetch) {
      write(key, { status: "error", error: messages.unavailable, promise: null });
      return Promise.resolve(null);
    }
    const promise = fetch()
      .then((issue) => {
        write(key, { status: issue ? "ready" : "missing", issue, error: null, fetchedAt: Date.now(), promise: null });
        return issue;
      })
      .catch((error: unknown) => {
        write(key, {
          status: current?.issue ? "ready" : "error",
          error: errorMessage(error, messages.failed),
          promise: null,
        });
        return current?.issue ?? null;
      });
    write(key, { status: current?.issue ? current.status : "loading", promise });
    return promise;
  };

  /**
   * Show `optimistic` under every key at once, then send. Resolves with the
   * tracker's copy when this was still the newest edit, or `null` when a later
   * edit superseded it. Throws (after rolling back, if still newest) on failure.
   */
  const edit = async (
    keys: string[],
    snapshot: T,
    optimistic: T,
    send: () => Promise<T | null>,
    failed: string,
  ): Promise<T | null> => {
    const primary = keys[0]!;
    const sequence = (entries.get(primary)?.editSequence ?? 0) + 1;
    for (const key of keys) write(key, { issue: optimistic, status: "ready", editing: true, editSequence: sequence });
    const isLatest = () => entries.get(primary)?.editSequence === sequence;
    try {
      const updated = await send();
      if (!isLatest()) return null;
      for (const key of keys) write(key, { issue: updated ?? optimistic, editing: false, fetchedAt: Date.now(), error: null });
      return updated ?? optimistic;
    } catch (error) {
      if (isLatest()) {
        for (const key of keys) write(key, { issue: snapshot, editing: false });
      }
      throw new Error(errorMessage(error, failed));
    }
  };

  return { entries, empty, write, read, peek, load, edit };
}
