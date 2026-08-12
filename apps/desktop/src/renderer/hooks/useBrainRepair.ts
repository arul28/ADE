import { useCallback, useState } from "react";
import { extractError } from "../lib/format";
import { useAsyncAction } from "./useAsyncAction";

/** What a finished repair should tell the user, or null when there is nothing to say. */
export type BrainRepairNotice = { tone: "ok" | "warn"; text: string } | null;

export type BrainRepair = {
  /** Repairs the stored sign-in and restarts the brain; ignores repeat clicks. */
  run: () => void;
  pending: boolean;
  /** False when this surface cannot repair (hosted web, browser mock). */
  available: boolean;
  /** Technical failure detail from the last attempt, or null. */
  error: string | null;
  /** Outcome of the last successful attempt, in the user's words. */
  notice: BrainRepairNotice;
};

/**
 * Repairs this computer's stored sign-in, then restarts the brain — the background
 * `com.ade.runtime` service — and calls `onSettled` once it resolves, so the
 * caller can re-read whatever health source it renders.
 *
 * The order is the point. This control is offered for one condition: the stored
 * account session could not be read. Restarting the service was never a fix for
 * that — the replacement process reads the same unreadable file — so the main
 * process repairs the credential file first (converge its key binding, restore
 * anything a peer process had to set aside) and restarts after.
 *
 * `repairSession` is optional on the bridge because an older preload does not
 * have it; that case falls back to the bare restart rather than losing the
 * button. A rejected attempt is reported through `error`, and `onSettled` runs
 * on both paths so the caller's own banner refreshes either way.
 */
export function useBrainRepair(onSettled?: () => void): BrainRepair {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BrainRepairNotice>(null);

  const action = useCallback(async (): Promise<BrainRepairNotice> => {
    const repairSession = window.ade?.account?.repairSession;
    if (repairSession) {
      const result = await repairSession();
      if (result.outcome === "sign_in_required") {
        return {
          tone: "warn",
          text: "Your sign-in can't be read on this computer. Sign in again.",
        };
      }
      if (result.outcome === "repaired") {
        return { tone: "ok", text: "Fixed — your sign-in is back." };
      }
      return null;
    }
    const restart = window.ade?.app?.restartBackgroundService;
    if (!restart) throw new Error("Repairing the ADE background service is not available here.");
    await restart();
    return null;
  }, []);

  const { run, pending } = useAsyncAction({
    action,
    onSuccess: (result) => {
      setError(null);
      setNotice(result);
      onSettled?.();
    },
    onError: (reason) => {
      setError(extractError(reason));
      setNotice(null);
      onSettled?.();
    },
  });

  // Clear the previous outcome as the retry starts, so no stale line sits next
  // to a spinner that has not finished yet.
  const runRepair = useCallback(() => {
    setError(null);
    setNotice(null);
    run();
  }, [run]);

  return {
    run: runRepair,
    pending,
    available: typeof window.ade?.account?.repairSession === "function"
      || typeof window.ade?.app?.restartBackgroundService === "function",
    error,
    notice,
  };
}
