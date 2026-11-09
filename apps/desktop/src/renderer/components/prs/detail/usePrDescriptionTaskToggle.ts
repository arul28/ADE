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
  const awaitingHostRef = useRef(false);

  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current = 0;
    awaitingHostRef.current = false;
    queueRef.current = Promise.resolve();
    pendingRef.current = null;
    setPendingBody(null);
  }, [prId]);

  // A failed re-read leaves the old text in place, and showing it would untick
  // a box that saved. The optimistic copy goes only when a new reading arrives.
  useEffect(() => {
    if (!awaitingHostRef.current || inFlightRef.current > 0) return;
    awaitingHostRef.current = false;
    pendingRef.current = null;
    setPendingBody(null);
  }, [body]);

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
    awaitingHostRef.current = false;
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
        // The clicks saved before this one did land.
        await refresh().catch(() => undefined);
        return;
      }
      inFlightRef.current -= 1;
      if (inFlightRef.current > 0 || generation !== generationRef.current) return;
      // Everything has landed: the host's next body replaces the optimistic
      // copy, so a later edit elsewhere can show through.
      awaitingHostRef.current = true;
      await refresh().catch(() => undefined);
    });
  }, [enabled, pin, prId, refresh]);

  return { body: pendingBody ?? body, toggleTask };
}
