import { useCallback, useSyncExternalStore } from "react";
import type { PrFile } from "../../../../shared/types/prs";
import { summarizePrChangeKinds, type PrChangeKindSummary } from "../../../../shared/prChangeKind";
import { setBounded } from "../../../../shared/boundedMap";

/**
 * The code / tests / docs / generated split of PRs whose file lists this
 * window already holds, keyed by GitHub coordinates.
 *
 * Fed for free by the detail pane (live or cached files) and the PRs
 * provider's snapshot warm-up, so a list row can show its split without a
 * GitHub read. A row whose PR is not here reads its files only when the user
 * hovers its diff stat (`requestPrChangeSplit`), once per PR per minute, and
 * not while the PRs surface's GitHub brake is on.
 *
 * GitHub's answer is the same from every machine, so the key carries no
 * machine; the pin decides only which machine is asked.
 */

type Entry = {
  /** Kept unsummarized until a row reads it, so warm-up costs one Map write. */
  files: readonly PrFile[] | null;
  summary: PrChangeKindSummary | null;
};

const MAX_ENTRIES = 300;
const FETCH_RETRY_MS = 60_000;
const MAX_IN_FLIGHT = 2;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Set<string>();
const lastFetchAt = new Map<string, number>();
/** The PRs surface's poll governor: while it stands down, hover reads wait. */
let standDown: (() => boolean) | null = null;

/**
 * Lets the PRs provider share its GitHub brake. A row's split is a detail,
 * not something the user asked GitHub for, so it waits out a failure ladder or
 * the quota reserve like the automatic reads do. Returns the unregister.
 */
export function setPrChangeSplitStandDown(check: () => boolean): () => void {
  standDown = check;
  return () => {
    if (standDown === check) standDown = null;
  };
}

export function prChangeSplitKey(coords: { repoOwner: string; repoName: string; githubPrNumber: number }): string {
  return `${coords.repoOwner.toLowerCase()}/${coords.repoName.toLowerCase()}#${coords.githubPrNumber}`;
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function store(key: string, entry: Entry): void {
  setBounded(entries, key, entry, MAX_ENTRIES);
  notify(key);
}

/** Records a file list; summarized the first time anything reads it. */
export function notePrChangeFiles(key: string, files: readonly PrFile[]): void {
  if (files.length === 0) return;
  const existing = entries.get(key);
  if (existing && existing.files === files) return;
  store(key, { files, summary: null });
}

export function readPrChangeSplit(key: string | null): PrChangeKindSummary | null {
  if (!key) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (!entry.summary && entry.files) {
    entry.summary = summarizePrChangeKinds(entry.files);
    entry.files = null;
  }
  return entry.summary;
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

const NOOP_UNSUBSCRIBE = () => {};

/** The split for one PR, re-rendering only that subscriber when it arrives. */
export function usePrChangeSplit(key: string | null): PrChangeKindSummary | null {
  const subscribeKey = useCallback(
    (listener: () => void) => (key ? subscribe(key, listener) : NOOP_UNSUBSCRIBE),
    [key],
  );
  const getSnapshot = useCallback(() => readPrChangeSplit(key), [key]);
  return useSyncExternalStore(subscribeKey, getSnapshot, getSnapshot);
}

/**
 * Reads one PR's files for its split, on a user's hover. Coalesced per PR,
 * at most one read per PR per minute (success or failure), and at most two
 * in flight across the window, so sweeping the pointer down a list cannot
 * become a burst of GitHub reads.
 */
export function requestPrChangeSplit(key: string, load: () => Promise<readonly PrFile[]>): void {
  if (inFlight.has(key) || inFlight.size >= MAX_IN_FLIGHT) return;
  // Not counted against the retry window: the next hover after the brake lifts reads.
  if (standDown?.()) return;
  const last = lastFetchAt.get(key);
  if (last != null && Date.now() - last < FETCH_RETRY_MS) return;
  setBounded(lastFetchAt, key, Date.now(), MAX_ENTRIES);
  inFlight.add(key);
  void load()
    .then((files) => {
      // Summarize now and drop the files: a row needs only the counts, and a
      // large PR's patches are megabytes.
      if (files.length > 0) store(key, { files: null, summary: summarizePrChangeKinds(files) });
    })
    .catch(() => {
      // No split for this PR until the retry window passes.
    })
    .finally(() => {
      inFlight.delete(key);
    });
}
