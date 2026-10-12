import { useCallback, useEffect, useRef, useState } from "react";
import type { AdeAccountStatus } from "../../shared/types";
import { runAccountDeviceLogin, type AccountDeviceLoginPrompt } from "./accountLogin";
import { isWebClientMode } from "./webClientMode";

/**
 * True when this build can sign in from another device: the desktop app with
 * a brain that has the device-authorization actions. The hosted web client is
 * a browser already, so it has nothing to hand to another device.
 */
export function accountDeviceLoginAvailable(): boolean {
  if (isWebClientMode()) return false;
  const api = (window.ade as (typeof window.ade & {
    account?: { startDeviceLogin?: unknown; pollDeviceLogin?: unknown };
  }) | undefined)?.account;
  return typeof api?.startDeviceLogin === "function" && typeof api.pollDeviceLogin === "function";
}

/**
 * "Sign in with another device": the device-authorization sign-in, but shown
 * instead of opened. No browser opens on this computer; the card draws the
 * link as a QR code and the code as text, and a phone or another computer
 * completes the sign-in. The password is never typed here, which is the point
 * on a VM or a shared machine.
 */
export function useAccountDeviceLogin(options?: {
  onSignedIn?: (status: AdeAccountStatus) => void;
}): {
  phase: "idle" | "starting" | "awaiting" | "error";
  prompt: AccountDeviceLoginPrompt | null;
  error: string | null;
  begin: () => Promise<void>;
  cancel: () => void;
} {
  const [phase, setPhase] = useState<"idle" | "starting" | "awaiting" | "error">("idle");
  const [prompt, setPrompt] = useState<AccountDeviceLoginPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const onSignedInRef = useRef(options?.onSignedIn);
  onSignedInRef.current = options?.onSignedIn;

  // Leaving the card abandons the attempt, so the brain drops its secret.
  useEffect(() => {
    return () => {
      attemptRef.current += 1;
    };
  }, []);

  const cancel = useCallback(() => {
    attemptRef.current += 1;
    setPhase("idle");
    setPrompt(null);
    setError(null);
  }, []);

  const begin = useCallback(async () => {
    const attemptId = ++attemptRef.current;
    const stale = () => attemptRef.current !== attemptId;
    setError(null);
    setPrompt(null);
    setPhase("starting");
    const outcome = await runAccountDeviceLogin({
      isCancelled: stale,
      // Never open this computer's browser: the sign-in belongs elsewhere.
      openUrl: () => false,
      onPrompt: (next) => {
        if (stale()) return;
        setPrompt(next);
        setPhase("awaiting");
      },
    });
    if (stale()) return;
    setPrompt(null);
    if (outcome.status === "signed_in") {
      setPhase("idle");
      onSignedInRef.current?.(outcome.authStatus);
      return;
    }
    if (outcome.status === "cancelled") {
      setPhase("idle");
      return;
    }
    setPhase("error");
    setError(outcome.message);
  }, []);

  return { phase, prompt, error, begin, cancel };
}
