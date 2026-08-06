import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "./openExternal";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "./account";
import type {
  AdeAccountDeviceLoginPoll,
  AdeAccountDeviceLoginStart,
  AdeAccountStatus,
} from "../../shared/types";

// Drives the machine-owned account OAuth PKCE login from the renderer: start the
// flow in main, open the browser to the authorize URL, then poll until the
// loopback callback completes. The raw token never crosses into the renderer —
// only the resulting token-free status does.

export type AccountLoginPhase = "idle" | "starting" | "awaiting" | "signed_in" | "error";

const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 200; // ~5 minutes at 1.5s, matching the login session TTL.

function accountApi() {
  return (window.ade as typeof window.ade & {
    account?: {
      startLogin: () => Promise<{ sessionId: string; authorizeUrl: string; expiresAt: string }>;
      pollLogin: (args: { sessionId: string }) => Promise<{
        status: "pending" | "signed_in" | "expired" | "error";
        message: string | null;
        authStatus: AdeAccountStatus;
      }>;
      cancelLogin: (args: { sessionId: string }) => Promise<AdeAccountStatus>;
      startDeviceLogin?: () => Promise<AdeAccountDeviceLoginStart>;
      pollDeviceLogin?: (args: { sessionId: string }) => Promise<AdeAccountDeviceLoginPoll>;
      cancelDeviceLogin?: (args: { sessionId: string }) => Promise<AdeAccountStatus>;
    };
  })?.account;
}

export function useAccountLogin(options?: {
  onSignedIn?: (status: AdeAccountStatus) => void;
}): {
  phase: AccountLoginPhase;
  error: string | null;
  beginLogin: () => Promise<void>;
  cancel: () => void;
} {
  const [phase, setPhase] = useState<AccountLoginPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const onSignedInRef = useRef(options?.onSignedIn);
  onSignedInRef.current = options?.onSignedIn;

  useEffect(() => {
    return () => {
      attemptRef.current += 1;
    };
  }, []);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    attemptRef.current += 1;
    if (sessionId) {
      void accountApi()?.cancelLogin({ sessionId }).catch(() => {});
    }
    sessionIdRef.current = null;
    setPhase("idle");
    setError(null);
  }, []);

  const beginLogin = useCallback(async () => {
    const api = accountApi();
    if (!api?.startLogin) {
      setPhase("error");
      setError("Account sign-in isn't available on this build.");
      return;
    }
    const attemptId = ++attemptRef.current;
    setError(null);
    setPhase("starting");
    let sessionId: string;
    try {
      const start = await api.startLogin();
      if (attemptRef.current !== attemptId) {
        void accountApi()?.cancelLogin({ sessionId: start.sessionId }).catch(() => {});
        return;
      }
      sessionId = start.sessionId;
      sessionIdRef.current = sessionId;
      openExternalUrl(start.authorizeUrl);
    } catch (err) {
      if (attemptRef.current !== attemptId) return;
      setPhase("error");
      setError(
        err instanceof Error ? err.message : "Couldn't start ADE account sign-in.",
      );
      return;
    }

    setPhase("awaiting");
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      if (attemptRef.current !== attemptId) return;
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
      if (attemptRef.current !== attemptId) return;
      let result: Awaited<ReturnType<NonNullable<typeof api>["pollLogin"]>>;
      try {
        result = await api.pollLogin({ sessionId });
      } catch {
        continue; // Transient IPC hiccup — keep polling until the TTL.
      }
      if (attemptRef.current !== attemptId) return;
      if (result.status === "signed_in") {
        sessionIdRef.current = null;
        publishAccountStatus(result.authStatus);
        setPhase("signed_in");
        onSignedInRef.current?.(result.authStatus);
        return;
      }
      if (result.status === "expired" || result.status === "error") {
        sessionIdRef.current = null;
        publishAccountStatus(result.authStatus ?? SIGNED_OUT_ACCOUNT);
        setPhase("error");
        setError(
          result.message ??
            (result.status === "expired"
              ? "Sign-in timed out. Try again."
              : "Sign-in didn't complete. Try again."),
        );
        return;
      }
    }
    if (attemptRef.current !== attemptId) return;
    setPhase("error");
    setError("Sign-in timed out. Try again.");
  }, []);

  return { phase, error, beginLogin, cancel };
}

// ---------------------------------------------------------------------------
// Device-authorization sign-in — the flow the account directory can observe.
// ---------------------------------------------------------------------------

/** What the user has to act on while a device sign-in is in flight. */
export type AccountDeviceLoginPrompt = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
};

export type AccountDeviceLoginOutcome =
  | { status: "signed_in"; authStatus: AdeAccountStatus }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

const DEVICE_POLL_FLOOR_MS = 1_000;
const DEVICE_POLL_CEILING_MS = 15_000;

/**
 * Run one device-authorization sign-in to completion.
 *
 * Deliberately a plain async function rather than a hook: its only caller
 * chains it between two other awaited steps ("try the re-pair" → "sign in" →
 * "re-read the directory"), and a hook that owned this state would force that
 * sequence to be reassembled out of effects.
 *
 * `verification_uri_complete` is preferred over the bare verification URI: it
 * carries the user code, so the whole sign-in costs one Continue click. The
 * code is still surfaced through `onPrompt` for the case where the page opens
 * without it (a different browser profile, a signed-out session).
 */
export async function runAccountDeviceLogin(options: {
  onPrompt?: (prompt: AccountDeviceLoginPrompt) => void;
  /** Polled between attempts so the caller can abandon the flow. */
  isCancelled?: () => boolean;
} = {}): Promise<AccountDeviceLoginOutcome> {
  const api = accountApi();
  if (!api?.startDeviceLogin || !api.pollDeviceLogin) {
    return {
      status: "failed",
      message: "Signing in again on this computer isn't available on this build.",
    };
  }

  let start: AdeAccountDeviceLoginStart;
  try {
    start = await api.startDeviceLogin();
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error && err.message
        ? err.message
        : "ADE couldn't start a sign-in on this computer. Try again in a moment.",
    };
  }

  const abandon = () => {
    void api.cancelDeviceLogin?.({ sessionId: start.sessionId }).catch(() => {});
  };
  if (options.isCancelled?.()) {
    abandon();
    return { status: "cancelled" };
  }

  options.onPrompt?.({
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
  });
  openExternalUrl(start.verificationUriComplete ?? start.verificationUri);

  const expiresAtMs = Date.parse(start.expiresAt);
  const deadlineMs = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 15 * 60_000;
  let intervalMs = Math.min(
    DEVICE_POLL_CEILING_MS,
    Math.max(DEVICE_POLL_FLOOR_MS, start.intervalSec * 1_000),
  );

  while (true) {
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    if (options.isCancelled?.()) {
      abandon();
      return { status: "cancelled" };
    }
    let poll: AdeAccountDeviceLoginPoll;
    try {
      poll = await api.pollDeviceLogin({ sessionId: start.sessionId });
    } catch {
      // A transient IPC hiccup is not a failed sign-in; keep waiting out the
      // directory's own expiry rather than telling the user it broke.
      if (Date.now() >= deadlineMs) {
        abandon();
        return { status: "failed", message: "Sign-in timed out. Try again." };
      }
      continue;
    }
    if (options.isCancelled?.()) {
      abandon();
      return { status: "cancelled" };
    }
    if (poll.status === "signed_in") {
      publishAccountStatus(poll.authStatus);
      return { status: "signed_in", authStatus: poll.authStatus };
    }
    if (poll.status === "pending" || poll.status === "slow_down") {
      if (poll.intervalSec) {
        intervalMs = Math.min(
          DEVICE_POLL_CEILING_MS,
          Math.max(DEVICE_POLL_FLOOR_MS, poll.intervalSec * 1_000),
        );
      }
      if (Date.now() >= deadlineMs) {
        abandon();
        return { status: "failed", message: "Sign-in timed out. Try again." };
      }
      continue;
    }
    return {
      status: "failed",
      message: poll.message
        ?? (poll.status === "expired"
          ? "Sign-in timed out. Try again."
          : "Sign-in didn't complete. Try again."),
    };
  }
}
