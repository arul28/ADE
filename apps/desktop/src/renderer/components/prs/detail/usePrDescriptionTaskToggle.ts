import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../../shared/types/core";
import { showToast } from "../../app/toast/toastStore";
import { togglePrTaskInBody } from "../shared/prTaskList";

/**
 * Checkbox clicks in a PR description: the box changes at once, saves go to
 * GitHub in click order, and a failed save goes back to GitHub's text.
 *
 * Each save sends the whole body computed for that click, so the last one to
 * land leaves every earlier click in it.
 */
export function usePrDescriptionTaskToggle(args: {
  prId: string;
  body: string | null | undefined;
  enabled: boolean;
  pin: OpenProjectBinding | null;
  /** Re-read the PR so the host's copy of the body catches up. */
  refresh: () => Promise<unknown>;
}): { body: string | null | undefined; toggleTask: (slice: string, index: number, nextChecked: boolean) => void } {
  const { prId, body, enabled, pin, refresh } = args;
  const [pendingBody, setPendingBody] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const inFlightRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current = 0;
    queueRef.current = Promise.resolve();
    pendingRef.current = null;
    setPendingBody(null);
  }, [prId]);

  const toggleTask = useCallback((slice: string, index: number, nextChecked: boolean) => {
    if (!enabled) return;
    const base = pendingRef.current ?? bodyRef.current ?? "";
    const next = togglePrTaskInBody(base, slice, index, nextChecked);
    if (next === null) {
      showToast({
        title: "Couldn't update that checkbox",
        message: "The description changed or that box could not be found. Refresh the pull request and try again.",
        tone: "error",
      });
      return;
    }
    pendingRef.current = next;
    setPendingBody(next);
    const generation = generationRef.current;
    inFlightRef.current += 1;
    queueRef.current = queueRef.current.then(async () => {
      if (generation !== generationRef.current) return;
      try {
        await window.ade.prs.updateDescription({ prId, body: next }, pin);
      } catch (error) {
        // Cancels the saves queued behind this one and returns to the host's text.
        generationRef.current += 1;
        inFlightRef.current = 0;
        pendingRef.current = null;
        setPendingBody(null);
        showToast({
          title: "Couldn't save the checkbox",
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
        return;
      }
      inFlightRef.current -= 1;
      if (inFlightRef.current > 0 || generation !== generationRef.current) return;
      // Everything has landed: wait for the host's fresh body, then let go of
      // the optimistic copy so a later edit elsewhere can show through.
      await refresh().catch(() => undefined);
      if (generation !== generationRef.current || inFlightRef.current > 0) return;
      pendingRef.current = null;
      setPendingBody(null);
    });
  }, [enabled, pin, prId, refresh]);

  return { body: pendingBody ?? body, toggleTask };
}
