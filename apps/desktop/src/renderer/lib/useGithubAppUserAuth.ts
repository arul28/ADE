import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubAppUserAuthStatus, OpenProjectBinding } from "../../shared/types";

/**
 * The ADE GitHub App account status, shared by every surface that renders it.
 *
 * There is exactly one such credential per machine, and two surfaces show it:
 * the install panel, where it is authorized and disconnected, and the Settings
 * connection ladder right above it. With a fetch and a piece of state per
 * component, disconnecting in the panel left the ladder badge reporting an
 * authorization that had just been removed one card away.
 *
 * Module-level state rather than context: the two consumers are not siblings
 * under a common provider, and the panel is also mounted on its own during
 * onboarding.
 */
type MachineAuthState = {
  cachedStatus: GitHubAppUserAuthStatus | null;
  hasLoaded: boolean;
  inFlight: Promise<GitHubAppUserAuthStatus | null> | null;
  /**
   * Only the newest-started read may publish.
   *
   * A forced read runs BESIDE the older one it exists to replace, and completion
   * order is not guaranteed. Without this, the older read settles last and
   * publishes the state from before the action — the exact staleness `force` was
   * added to avoid.
   */
  readSeq: number;
  publishedSeq: number;
  listeners: Set<(status: GitHubAppUserAuthStatus | null) => void>;
};

/**
 * One state per machine. Settings shows a page per machine, and each machine
 * has its own credential: a shared slot let This computer's status land on the
 * Mac Studio page (and the other way round) whenever both had been visited.
 * Unpinned callers (the tab's own machine, onboarding) share one key.
 */
const UNPINNED_KEY = "\u0000unpinned";
const machines = new Map<string, MachineAuthState>();

function machineKey(pin: OpenProjectBinding | null | undefined): string {
  return pin ? pin.key : UNPINNED_KEY;
}

function machineState(key: string): MachineAuthState {
  let state = machines.get(key);
  if (!state) {
    state = {
      cachedStatus: null,
      hasLoaded: false,
      inFlight: null,
      readSeq: 0,
      publishedSeq: 0,
      listeners: new Set(),
    };
    machines.set(key, state);
  }
  return state;
}

function publish(state: MachineAuthState, status: GitHubAppUserAuthStatus | null, seq: number): void {
  if (seq < state.publishedSeq) return;
  state.publishedSeq = seq;
  state.cachedStatus = status;
  state.hasLoaded = true;
  for (const listener of state.listeners) listener(status);
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
  /** The machine to read. Absent or null reads through the tab's own binding. */
  pin?: OpenProjectBinding | null;
};

/** Re-reads the status from the machine's host and tells every consumer of it. */
export function refreshGithubAppUserAuth(
  options: RefreshGithubAppUserAuthOptions = {},
): Promise<GitHubAppUserAuthStatus | null> {
  const pin = options.pin ?? null;
  const state = machineState(machineKey(pin));
  if (state.inFlight && !options.force) return state.inFlight;
  const seq = ++state.readSeq;
  const read = window.ade?.github?.getAppUserAuthStatus;
  if (!read) {
    publish(state, null, seq);
    return Promise.resolve(null);
  }
  const pending: Promise<GitHubAppUserAuthStatus | null> = (pin
    ? window.ade.github.getAppUserAuthStatus!(pin)
    : window.ade.github.getAppUserAuthStatus!())
    .then((status) => status ?? null)
    .catch(() => null)
    .then((status) => {
      publish(state, status, seq);
      return status;
    })
    .finally(() => {
      // Only this read may clear the slot: a forced read runs beside an earlier
      // one, and whichever finishes first must not orphan the other.
      if (state.inFlight === pending) state.inFlight = null;
    });
  state.inFlight = pending;
  return pending;
}

/** Drops every machine's status so one test cannot leak into the next. */
export function resetGithubAppUserAuthForTests(): void {
  machines.clear();
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

export function useGithubAppUserAuth(pin: OpenProjectBinding | null = null): UseGithubAppUserAuthResult {
  const key = machineKey(pin);
  const [appAuth, setAppAuth] = useState<GitHubAppUserAuthStatus | null>(() => machineState(key).cachedStatus);
  const [loaded, setLoaded] = useState<boolean>(() => machineState(key).hasLoaded);
  // The pin's identity can change while its key does not; reads use the
  // latest one without re-subscribing.
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    const state = machineState(key);
    const listener = (status: GitHubAppUserAuthStatus | null): void => {
      setAppAuth(status);
      setLoaded(true);
    };
    state.listeners.add(listener);
    if (!state.hasLoaded) {
      // Another machine's answer must not stay on screen while this one loads.
      setAppAuth(null);
      setLoaded(false);
      void refreshGithubAppUserAuth({ pin: pinRef.current });
    } else {
      listener(state.cachedStatus);
    }
    return () => {
      state.listeners.delete(listener);
    };
  }, [key]);

  // Keyed on the machine so a caller that loads on `refresh` reloads when the
  // page's machine changes.
  const refresh = useCallback(
    (options: RefreshGithubAppUserAuthOptions = {}) =>
      refreshGithubAppUserAuth({ ...options, pin: pinRef.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const set = useCallback((status: GitHubAppUserAuthStatus | null) => {
    // Claims a sequence of its own: an action's result is newer than every read
    // that started before it, so a read still in flight must not overwrite it.
    const state = machineState(key);
    publish(state, status, ++state.readSeq);
  }, [key]);

  return { appAuth, loaded, refresh, set };
}
