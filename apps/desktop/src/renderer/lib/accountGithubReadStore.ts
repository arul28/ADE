import type {
  GithubDirectData,
  GithubDirectError,
  GithubDirectOp,
  GithubDirectRequest,
  GithubDirectRequestOptions,
  GithubDirectResult,
} from "../../shared/types";
import { GITHUB_DIRECT_ACCOUNT_CHANGED } from "../../shared/types";
import { isGithubDirectUserState } from "../../shared/github/directClient";

/**
 * Reads of one repository's pull requests and issues, straight from GitHub
 * with the ADE account's sign-in (`window.ade.githubDirect`), with no machine.
 * One store for every direct read (a list, one issue, its comments).
 *
 * Request budget (ade-perf-prs: skip ticks while hidden, reuse reads):
 * - One read per request at a time; every component that shows the same
 *   request shares it.
 * - A refresh every 60 s, only while at least one component shows it and the
 *   window is visible. Hidden: no timer at all. Visible again after 60 s or
 *   more: one read at once.
 * - Every read is ETag'd by the client: an unchanged answer is a `304`, which
 *   GitHub does not count against the rate limit.
 * - A timed refresh is a background read: the client skips it while the rate
 *   limit is below 10 %.
 * - A state only a person can fix (not connected, App not installed, ...)
 *   waits 5 minutes between reads; a rate limit or an outage waits until the
 *   time GitHub gives, at least 60 s.
 *
 * Each answer names the ADE account it belongs to (`meta.scope`). An answer
 * for another account than the stored data's (a sign-out and a sign-in in the
 * same window) drops every other entry's data, and a state only a person can
 * fix drops the entry's data: one account's reads are never shown for another.
 */

export const ACCOUNT_GITHUB_READ_REFRESH_MS = 60_000;
const USER_STATE_RETRY_MS = 5 * 60_000;

export type AccountGithubReadSnapshot<T> = {
  data: T | null;
  error: GithubDirectError | null;
  /** No answer yet. */
  loading: boolean;
  /** A read is running (first or later). */
  refreshing: boolean;
  fetchedAt: number | null;
  /** More items exist than the pages read. */
  truncated: boolean;
};

type DirectRequest = <O extends GithubDirectOp>(
  request: Extract<GithubDirectRequest, { op: O }>,
  options?: GithubDirectRequestOptions,
) => Promise<GithubDirectResult<GithubDirectData[O]>>;

export type AccountGithubReadStoreDeps = {
  /** Null when this window has no direct GitHub reads (an older ADE). */
  request: () => DirectRequest | null;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  refreshMs?: number;
};

type Entry = {
  request: GithubDirectRequest;
  snapshot: AccountGithubReadSnapshot<unknown>;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  timer: unknown;
  nextAt: number;
  /** The account the entry's data belongs to. */
  scope: string | null;
};

const EMPTY: AccountGithubReadSnapshot<never> = { data: null, error: null, loading: true, refreshing: false, fetchedAt: null, truncated: false };

/** One key per request: owner and name in any case are the same repository. */
export function accountGithubReadKey(request: GithubDirectRequest): string {
  const params = { ...((request as { params?: Record<string, unknown> }).params ?? {}) };
  if (typeof params.owner === "string") params.owner = params.owner.toLowerCase();
  if (typeof params.name === "string") params.name = params.name.toLowerCase();
  if ((request.op === "listPulls" || request.op === "listIssues") && params.state === undefined) params.state = "open";
  return `${request.op}:${JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]))}`;
}

export function createAccountGithubReadStore(deps: AccountGithubReadStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const refreshMs = deps.refreshMs ?? ACCOUNT_GITHUB_READ_REFRESH_MS;
  const entries = new Map<string, Entry>();
  let stopVisibility: (() => void) | null = null;
  /** The account of the latest answer. */
  let currentScope: string | null = null;

  const emit = (entry: Entry, patch: Partial<AccountGithubReadSnapshot<unknown>>): void => {
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
      const result = await request(entry.request as Extract<GithubDirectRequest, { op: GithubDirectOp }>, { background })
        .catch((): GithubDirectResult<unknown> => ({ ok: false, error: { kind: "github_unavailable", message: "the read failed" } }));
      if (result.ok) {
        const scope = result.meta.scope ?? null;
        if (scope !== null && scope !== currentScope) {
          currentScope = scope;
          for (const other of entries.values()) if (other !== entry && other.scope !== scope) forget(other);
        }
        entry.scope = scope;
        entry.nextAt = now() + refreshMs;
        emit(entry, { data: result.data, error: null, loading: false, refreshing: false, fetchedAt: result.meta.fetchedAt, truncated: result.meta.truncated });
        return;
      }
      const error = result.error;
      const retryAt = error.retryAt ?? null;
      entry.nextAt = isGithubDirectUserState(error.kind)
        ? now() + USER_STATE_RETRY_MS
        : Math.max(now() + refreshMs, retryAt ?? 0);
      // A background read the client skipped (rate limit low) keeps the data;
      // a state only a person can fix (signed out, say) and an account
      // switch during the read do not.
      if (isGithubDirectUserState(error.kind) || error.reason === GITHUB_DIRECT_ACCOUNT_CHANGED) {
        entry.scope = null;
        emit(entry, { data: null, error, loading: false, refreshing: false, fetchedAt: null, truncated: false });
      } else {
        emit(entry, { error, loading: false, refreshing: false });
      }
    })();
    entry.inFlight = work;
    try {
      await work;
    } finally {
      entry.inFlight = null;
      schedule(entry);
    }
  };

  /** Another account's data: gone, and read again when someone shows it. */
  const forget = (entry: Entry): void => {
    entry.scope = null;
    entry.nextAt = 0;
    emit(entry, EMPTY);
    if (entry.listeners.size > 0 && deps.isVisible()) void read(entry, false);
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

  const entryFor = (request: GithubDirectRequest): Entry => {
    const key = accountGithubReadKey(request);
    let entry = entries.get(key);
    if (!entry) {
      entry = { request, snapshot: EMPTY, listeners: new Set(), inFlight: null, timer: null, nextAt: 0, scope: null };
      entries.set(key, entry);
    }
    return entry;
  };

  return {
    /** Starts reading when the first listener comes; stops every timer when the last one goes. */
    subscribe(request: GithubDirectRequest, listener: () => void): () => void {
      const entry = entryFor(request);
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
    snapshot<O extends GithubDirectOp>(request: Extract<GithubDirectRequest, { op: O }>): AccountGithubReadSnapshot<GithubDirectData[O]> {
      return (entries.get(accountGithubReadKey(request))?.snapshot ?? EMPTY) as AccountGithubReadSnapshot<GithubDirectData[O]>;
    },
    /** A person asked: read now (not a background read). */
    refresh(request: GithubDirectRequest): Promise<void> {
      return read(entryFor(request), false);
    },
  };
}

export type AccountGithubReadStore = ReturnType<typeof createAccountGithubReadStore>;
