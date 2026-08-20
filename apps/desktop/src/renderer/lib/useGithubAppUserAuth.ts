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
const listeners = new Set<(status: GitHubAppUserAuthStatus | null) => void>();

function publish(status: GitHubAppUserAuthStatus | null): void {
  cachedStatus = status;
  hasLoaded = true;
  for (const listener of listeners) listener(status);
}

/** Re-reads the status from the host and tells every consumer. */
export function refreshGithubAppUserAuth(): Promise<GitHubAppUserAuthStatus | null> {
  if (inFlight) return inFlight;
  const read = window.ade?.github?.getAppUserAuthStatus;
  if (!read) {
    publish(null);
    return Promise.resolve(null);
  }
  inFlight = window.ade.github
    .getAppUserAuthStatus!()
    .then((status) => status ?? null)
    .catch(() => null)
    .then((status) => {
      publish(status);
      return status;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drops the shared status so one test cannot leak into the next. */
export function resetGithubAppUserAuthForTests(): void {
  cachedStatus = null;
  hasLoaded = false;
  inFlight = null;
  listeners.clear();
}

export type UseGithubAppUserAuthResult = {
  appAuth: GitHubAppUserAuthStatus | null;
  /** False until the first read lands, which is not the same as "no token". */
  loaded: boolean;
  refresh: () => Promise<GitHubAppUserAuthStatus | null>;
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
    publish(status);
  }, []);

  return { appAuth, loaded, refresh: refreshGithubAppUserAuth, set };
}
