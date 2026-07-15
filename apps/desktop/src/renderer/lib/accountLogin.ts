import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "./openExternal";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "./account";
import type { AdeAccountStatus } from "../../shared/types";

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
