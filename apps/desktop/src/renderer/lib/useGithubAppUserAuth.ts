import { useCallback, useEffect, useState } from "react";
import type { GitHubAppUserAuthStatus } from "../../shared/types";

/**
 * The ADE GitHub App account status, shared by every surface that renders it.
 *
 * There is exactly one such credential per machine, and two surfaces show it:
 * the install panel, where it is authorized and disconnected, and the Settings
 * connection ladder right above it. With a fetch and a piece of state per
 * component, disconnecting in the panel left the ladder badge reporting an
 * authorization that had just been removed one card away.
 *
 * A module-level value rather than context: the two consumers are not siblings
 * under a common provider, and the panel is also mounted on its own during
 * onboarding.
 */
let cachedStatus: GitHubAppUserAuthStatus | null = null;
let hasLoaded = false;
let inFlight: Promise<GitHubAppUserAuthStatus | null> | null = null;
/**
 * Only the newest-started read may publish.
 *
 * A forced read runs BESIDE the older one it exists to replace, and completion
 * order is not guaranteed. Without this, the older read settles last and
 * publishes the state from before the action — the exact staleness `force` was
 * added to avoid.
 */
let readSeq = 0;
let publishedSeq = 0;
const listeners = new Set<(status: GitHubAppUserAuthStatus | null) => void>();

function publish(status: GitHubAppUserAuthStatus | null, seq: number): void {
  if (seq < publishedSeq) return;
  publishedSeq = seq;
  cachedStatus = status;
  hasLoaded = true;
  for (const listener of listeners) listener(status);
}

export type RefreshGithubAppUserAuthOptions = {
  /**
   * Starts a new read even when one is already running.
   *
   * The shared read is deduped, and a caller that reads AFTER an action it just
   * performed needs the read to have started after it. Joining a read that was
   * already in flight answers with the state from before the action — which is
   * how a panel that re-reads the account right after the installation check
   * kept showing the credential the check had just replaced.
   */
  force?: boolean;
};

/** Re-reads the status from the host and tells every consumer. */
export function refreshGithubAppUserAuth(
  options: RefreshGithubAppUserAuthOptions = {},
): Promise<GitHubAppUserAuthStatus | null> {
  if (inFlight && !options.force) return inFlight;
  const seq = ++readSeq;
  const read = window.ade?.github?.getAppUserAuthStatus;
  if (!read) {
    publish(null, seq);
    return Promise.resolve(null);
  }
  const pending: Promise<GitHubAppUserAuthStatus | null> = window.ade.github
    .getAppUserAuthStatus!()
    .then((status) => status ?? null)
    .catch(() => null)
    .then((status) => {
      publish(status, seq);
      return status;
    })
    .finally(() => {
      // Only this read may clear the slot: a forced read runs beside an earlier
      // one, and whichever finishes first must not orphan the other.
      if (inFlight === pending) inFlight = null;
    });
  inFlight = pending;
  return pending;
}

/** Drops the shared status so one test cannot leak into the next. */
export function resetGithubAppUserAuthForTests(): void {
  cachedStatus = null;
  hasLoaded = false;
  inFlight = null;
  readSeq = 0;
  publishedSeq = 0;
  listeners.clear();
}

export type UseGithubAppUserAuthResult = {
  appAuth: GitHubAppUserAuthStatus | null;
  /** False until the first read lands, which is not the same as "no token". */
  loaded: boolean;
  refresh: (
    options?: RefreshGithubAppUserAuthOptions,
  ) => Promise<GitHubAppUserAuthStatus | null>;
  /** Publishes a status an action already returned, without a second read. */
  set: (status: GitHubAppUserAuthStatus | null) => void;
};

export function useGithubAppUserAuth(): UseGithubAppUserAuthResult {
  const [appAuth, setAppAuth] = useState<GitHubAppUserAuthStatus | null>(cachedStatus);
  const [loaded, setLoaded] = useState<boolean>(hasLoaded);

  useEffect(() => {
    const listener = (status: GitHubAppUserAuthStatus | null): void => {
      setAppAuth(status);
      setLoaded(true);
    };
    listeners.add(listener);
    if (!hasLoaded) void refreshGithubAppUserAuth();
    else listener(cachedStatus);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const set = useCallback((status: GitHubAppUserAuthStatus | null) => {
    // Claims a sequence of its own: an action's result is newer than every read
    // that started before it, so a read still in flight must not overwrite it.
    publish(status, ++readSeq);
  }, []);

  return { appAuth, loaded, refresh: refreshGithubAppUserAuth, set };
}
