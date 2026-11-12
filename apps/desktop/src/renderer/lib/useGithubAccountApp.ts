import { useCallback, useEffect, useState } from "react";
import type { GitHubAccountAppAccountStatus } from "../../shared/types";

/**
 * The ADE account's GitHub App sign-in, as Settings shows it.
 *
 * Account-scoped: the sign-in lives in the account directory, not on a
 * machine, so there is one state for the window, whichever machine a Settings
 * page shows. The calls take no pin (see `registerGithubAccountAppIpc.ts`).
 *
 * A connect opens GitHub in the browser and reads how it ended every two
 * seconds until it ends or ten minutes pass. The reads stop on their own; no
 * timer runs while nothing is pending.
 */

const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_MAX_MS = 10 * 60_000;

export type GithubAccountAppSignInPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; signInId: string; until: number }
  | { kind: "done"; githubLogin: string | null }
  | {
    kind: "failed";
    /**
     * - `denied`: the person cancelled on GitHub.
     * - `refused`: GitHub ended the sign-in with an error after it started.
     * - `expired`: the link ran out, or ten minutes passed.
     * - `error`: the sign-in could not start.
     */
    reason: "denied" | "refused" | "expired" | "error" | "unsupported" | "signed_out" | "rate_limited";
    message: string | null;
  };

type Store = {
  status: GitHubAccountAppAccountStatus | null;
  loaded: boolean;
  inFlight: Promise<GitHubAccountAppAccountStatus | null> | null;
  phase: GithubAccountAppSignInPhase;
  pollTimer: number | null;
  listeners: Set<() => void>;
};

const store: Store = {
  status: null,
  loaded: false,
  inFlight: null,
  phase: { kind: "idle" },
  pollTimer: null,
  listeners: new Set(),
};

function emit(): void {
  for (const listener of store.listeners) listener();
}

/** The account App calls this window has; null on an older ADE. */
function accountAppApi() {
  const github = window.ade?.github;
  if (!github?.getAccountAppStatus || !github.startAccountAppSignIn || !github.readAccountAppSignIn || !github.signOutAccountApp) return null;
  return {
    getStatus: github.getAccountAppStatus,
    start: github.startAccountAppSignIn,
    read: github.readAccountAppSignIn,
    signOut: github.signOutAccountApp,
  };
}

export function refreshGithubAccountApp(): Promise<GitHubAccountAppAccountStatus | null> {
  const api = accountAppApi();
  if (!api) {
    store.loaded = true;
    emit();
    return Promise.resolve(null);
  }
  if (store.inFlight) return store.inFlight;
  const pending = api.getStatus()
    .then((status) => {
      store.status = status;
      return status;
    }, () => store.status)
    .finally(() => {
      store.loaded = true;
      if (store.inFlight === pending) store.inFlight = null;
      emit();
    });
  store.inFlight = pending;
  return pending;
}

function setPhase(phase: GithubAccountAppSignInPhase): void {
  store.phase = phase;
  emit();
}

function stopPolling(): void {
  if (store.pollTimer != null) window.clearTimeout(store.pollTimer);
  store.pollTimer = null;
}

function schedulePoll(signInId: string, until: number, onDone: () => void): void {
  stopPolling();
  store.pollTimer = window.setTimeout(async () => {
    store.pollTimer = null;
    const api = accountAppApi();
    if (!api || store.phase.kind !== "waiting" || store.phase.signInId !== signInId) return;
    const result = await api.read({ signInId }).catch(() => null);
    if (store.phase.kind !== "waiting" || store.phase.signInId !== signInId) return;
    if (result?.ok && result.status === "done") {
      setPhase({ kind: "done", githubLogin: result.githubLogin });
      await refreshGithubAccountApp();
      onDone();
      return;
    }
    if (result?.ok && (result.status === "failed" || result.status === "expired")) {
      setPhase({
        kind: "failed",
        reason: result.status === "expired" ? "expired" : result.resultCode === "denied" ? "denied" : "refused",
        message: null,
      });
      return;
    }
    // The server no longer knows the sign-in (it ran out), or this window
    // left the ADE account: polling longer cannot end differently.
    if (result && !result.ok && (result.error === "not_found" || result.error === "signed_out")) {
      setPhase({ kind: "failed", reason: result.error === "not_found" ? "expired" : "signed_out", message: null });
      return;
    }
    if (Date.now() >= until) {
      setPhase({ kind: "failed", reason: "expired", message: null });
      return;
    }
    schedulePoll(signInId, until, onDone);
  }, SIGN_IN_POLL_MS);
}

/** Opens GitHub's sign-in in the browser and follows it until it ends. */
export async function startGithubAccountAppSignIn(onDone: () => void): Promise<void> {
  const api = accountAppApi();
  if (!api || store.phase.kind === "starting" || store.phase.kind === "waiting") return;
  setPhase({ kind: "starting" });
  const result = await api.start().catch(() => ({ ok: false as const, error: "unavailable", message: null }));
  if (!result.ok) {
    const reason = result.error === "unsupported" || result.error === "signed_out" || result.error === "rate_limited"
      ? result.error
      : "error";
    setPhase({ kind: "failed", reason, message: result.message });
    return;
  }
  const until = Math.min(result.expiresAt, Date.now() + SIGN_IN_MAX_MS);
  setPhase({ kind: "waiting", signInId: result.signInId, until });
  schedulePoll(result.signInId, until, onDone);
}

/** Stops following a sign-in (the person closed the browser tab and gave up). */
export function cancelGithubAccountAppSignIn(): void {
  stopPolling();
  setPhase({ kind: "idle" });
}

/** Disconnects GitHub from the ADE account; every machine of the account stops using it. */
export async function signOutGithubAccountApp(): Promise<{ ok: boolean; deletedAtGitHub: boolean; revokeAtGitHubUrl: string | null }> {
  const api = accountAppApi();
  if (!api) return { ok: false, deletedAtGitHub: false, revokeAtGitHubUrl: null };
  const result = await api.signOut().catch(() => ({ ok: false as const, error: "unavailable" }));
  stopPolling();
  setPhase({ kind: "idle" });
  await refreshGithubAccountApp();
  return result.ok
    ? { ok: true, deletedAtGitHub: result.deletedAtGitHub, revokeAtGitHubUrl: result.revokeAtGitHubUrl }
    : { ok: false, deletedAtGitHub: false, revokeAtGitHubUrl: null };
}

export function useGithubAccountApp() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    store.listeners.add(listener);
    // Read again on each open while the last answer said "not available"
    // (signed out, the server not answering): a later sign-in must show the
    // Connect flow without a window reload. A usable answer is kept.
    if ((!store.loaded || !store.status?.available) && !store.inFlight) void refreshGithubAccountApp();
    return () => {
      store.listeners.delete(listener);
    };
  }, []);
  const refresh = useCallback(() => refreshGithubAccountApp(), []);
  const status = store.status;
  return {
    /** The account directory answered and has the GitHub App sign-in. */
    supported: Boolean(status?.available),
    loaded: store.loaded,
    status,
    connected: Boolean(status?.available && status.connected && status.state === "active"),
    needsReauth: Boolean(status?.available && status.connected && status.state === "needs_reauth"),
    phase: store.phase,
    refresh,
  };
}
