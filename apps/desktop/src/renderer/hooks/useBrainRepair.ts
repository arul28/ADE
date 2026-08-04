import { useCallback, useState } from "react";
import { extractError } from "../lib/format";
import { useAsyncAction } from "./useAsyncAction";

export type BrainRepair = {
  /** Restarts the brain; ignores clicks while a restart is in flight. */
  run: () => void;
  pending: boolean;
  /** False when this surface cannot restart a brain (hosted web, browser mock). */
  available: boolean;
  /** Technical failure detail from the last attempt, or null. */
  error: string | null;
};

/**
 * Restarts this Mac's ADE brain — the background `com.ade.runtime` service —
 * and calls `onSettled` once the restart resolves, so the caller can re-read
 * whatever health source it renders.
 *
 * This is the remediation for a brain that cannot decrypt the stored account
 * session: the replacement process re-reads the keychain from scratch. The main
 * process waits for the replacement to answer a ping before resolving — only it
 * can observe brain readiness — so there is nothing to wait for here. A rejected
 * restart is reported through `error`; the caller's own banner stays put either
 * way, since `onSettled` runs on both paths.
 */
export function useBrainRepair(onSettled?: () => void): BrainRepair {
  const [error, setError] = useState<string | null>(null);

  const action = useCallback(async () => {
    const invoke = window.ade?.app?.restartBackgroundService;
    if (!invoke) throw new Error("Restarting the ADE background service is not available here.");
    await invoke();
  }, []);

  const { run, pending } = useAsyncAction({
    action,
    onSuccess: () => {
      setError(null);
      onSettled?.();
    },
    onError: (reason) => {
      setError(extractError(reason));
      onSettled?.();
    },
  });

  // Clear the previous failure as the retry starts, so the inline error never
  // sits next to a spinner that has not failed yet.
  const runRepair = useCallback(() => {
    setError(null);
    run();
  }, [run]);

  return {
    run: runRepair,
    pending,
    available: typeof window.ade?.app?.restartBackgroundService === "function",
    error,
  };
}
