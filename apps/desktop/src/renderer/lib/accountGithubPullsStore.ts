import type {
  GithubDirectError,
  GithubDirectListState,
  GithubDirectPull,
  GithubDirectRepoRef,
  GithubDirectRequestOptions,
  GithubDirectResult,
} from "../../shared/types";
import { isGithubDirectUserState } from "../../shared/github/directClient";

/**
 * Open pull requests of one repository, read straight from GitHub with the
 * ADE account's sign-in (`window.ade.githubDirect`), with no machine.
 *
 * Request budget (ade-perf-prs: skip ticks while hidden, reuse reads):
 * - One read per repository at a time; every component that shows the same
 *   repository shares it.
 * - A refresh every 60 s, only while at least one component shows the list
 *   and the window is visible. Hidden: no timer at all. Visible again after
 *   60 s or more: one read at once.
 * - Every read is ETag'd by the client: an unchanged list is a `304`, which
 *   GitHub does not count against the rate limit.
 * - A timed refresh is a background read: the client skips it while the rate
 *   limit is below 10 %.
 * - A state only a person can fix (not connected, App not installed, ...)
 *   waits 5 minutes between reads; a rate limit or an outage waits until the
 *   time GitHub gives, at least 60 s.
 */

export const ACCOUNT_GITHUB_PULLS_REFRESH_MS = 60_000;
const USER_STATE_RETRY_MS = 5 * 60_000;

export type AccountGithubPullsSnapshot = {
  pulls: GithubDirectPull[];
  error: GithubDirectError | null;
  /** No answer yet. */
  loading: boolean;
  /** A read is running (first or later). */
  refreshing: boolean;
  fetchedAt: number | null;
  /** More open PRs exist than the five pages read. */
  truncated: boolean;
};

type ListRequest = (
  request: { op: "listPulls"; params: GithubDirectRepoRef & { state?: GithubDirectListState } },
  options?: GithubDirectRequestOptions,
) => Promise<GithubDirectResult<GithubDirectPull[]>>;

export type AccountGithubPullsStoreDeps = {
  /** Null when this window has no direct GitHub reads (an older ADE). */
  request: () => ListRequest | null;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  refreshMs?: number;
};

type Entry = {
  repo: GithubDirectRepoRef;
  state: GithubDirectListState;
  snapshot: AccountGithubPullsSnapshot;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  timer: unknown;
  nextAt: number;
};

const EMPTY: AccountGithubPullsSnapshot = { pulls: [], error: null, loading: true, refreshing: false, fetchedAt: null, truncated: false };

export function accountGithubPullsKey(repo: GithubDirectRepoRef, state: GithubDirectListState = "open"): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${state}`;
}

export function createAccountGithubPullsStore(deps: AccountGithubPullsStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const refreshMs = deps.refreshMs ?? ACCOUNT_GITHUB_PULLS_REFRESH_MS;
  const entries = new Map<string, Entry>();
  let stopVisibility: (() => void) | null = null;

  const emit = (entry: Entry, patch: Partial<AccountGithubPullsSnapshot>): void => {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener();
  };

  const unschedule = (entry: Entry): void => {
    if (entry.timer != null) clearTimer(entry.timer);
    entry.timer = null;
  };

  const schedule = (entry: Entry): void => {
    unschedule(entry);
    if (entry.listeners.size === 0 || !deps.isVisible()) return;
    const wait = Math.max(0, entry.nextAt - now());
    entry.timer = setTimer(() => {
      entry.timer = null;
      void read(entry, true);
    }, wait);
  };

  const read = async (entry: Entry, background: boolean): Promise<void> => {
    if (entry.inFlight) return await entry.inFlight;
    const request = deps.request();
    if (!request) {
      emit(entry, { loading: false, refreshing: false, error: { kind: "not_connected", message: "direct GitHub reads are not available", reason: "unsupported" } });
      return;
    }
    emit(entry, { refreshing: true });
    const work = (async () => {
      const result = await request(
        { op: "listPulls", params: { owner: entry.repo.owner, name: entry.repo.name, state: entry.state } },
        { background },
      ).catch((): GithubDirectResult<GithubDirectPull[]> => ({ ok: false, error: { kind: "github_unavailable", message: "the read failed" } }));
      if (result.ok) {
        entry.nextAt = now() + refreshMs;
        emit(entry, { pulls: result.data, error: null, loading: false, refreshing: false, fetchedAt: result.meta.fetchedAt, truncated: result.meta.truncated });
        return;
      }
      const error = result.error;
      const retryAt = error.retryAt ?? null;
      entry.nextAt = isGithubDirectUserState(error.kind)
        ? now() + USER_STATE_RETRY_MS
        : Math.max(now() + refreshMs, retryAt ?? 0);
      // A background read the client skipped (rate limit low) keeps the list.
      emit(entry, { error, loading: false, refreshing: false });
    })();
    entry.inFlight = work;
    try {
      await work;
    } finally {
      entry.inFlight = null;
      schedule(entry);
    }
  };

  const onVisibility = (): void => {
    for (const entry of entries.values()) {
      if (!deps.isVisible()) {
        unschedule(entry);
        continue;
      }
      if (entry.listeners.size === 0) continue;
      if (now() >= entry.nextAt) void read(entry, true);
      else schedule(entry);
    }
  };

  const ensureVisibilityListener = (): void => {
    const watching = [...entries.values()].some((entry) => entry.listeners.size > 0);
    if (watching && !stopVisibility) stopVisibility = deps.onVisibilityChange(onVisibility);
    if (!watching && stopVisibility) {
      stopVisibility();
      stopVisibility = null;
    }
  };

  const entryFor = (repo: GithubDirectRepoRef, state: GithubDirectListState): Entry => {
    const key = accountGithubPullsKey(repo, state);
    let entry = entries.get(key);
    if (!entry) {
      entry = { repo, state, snapshot: EMPTY, listeners: new Set(), inFlight: null, timer: null, nextAt: 0 };
      entries.set(key, entry);
    }
    return entry;
  };

  return {
    /** Starts reading when the first listener comes; stops every timer when the last one goes. */
    subscribe(repo: GithubDirectRepoRef, state: GithubDirectListState, listener: () => void): () => void {
      const entry = entryFor(repo, state);
      entry.listeners.add(listener);
      ensureVisibilityListener();
      if (entry.listeners.size === 1) {
        if (now() >= entry.nextAt && deps.isVisible()) void read(entry, entry.snapshot.fetchedAt != null);
        else schedule(entry);
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) unschedule(entry);
        ensureVisibilityListener();
      };
    },
    snapshot(repo: GithubDirectRepoRef, state: GithubDirectListState): AccountGithubPullsSnapshot {
      return entries.get(accountGithubPullsKey(repo, state))?.snapshot ?? EMPTY;
    },
    /** A person asked: read now (not a background read). */
    refresh(repo: GithubDirectRepoRef, state: GithubDirectListState): Promise<void> {
      return read(entryFor(repo, state), false);
    },
  };
}

export type AccountGithubPullsStore = ReturnType<typeof createAccountGithubPullsStore>;
