/**
 * Live run progress: the host frame, or the child's poll.
 *
 * The compiled Review had `window.ade.review.onEvent` — a direct listener on the
 * daemon's own review events, which is how a queued run turned into a running
 * one on screen without anybody pressing Refresh. A guest has no such listener.
 * Two things replace it, and the page needs both:
 *
 * 1. **`host.subscribe({ kinds: ["review"] })`.** The `review` kind is new in
 *    this wave. A host that has it delivers a coalesced `host` frame naming the
 *    run ids that moved, and the page refetches on each.
 *
 * 2. **The child's poll.** `index.js` already reschedules `refreshRuns` every
 *    `LIVE_POLL_MS` (2,500 ms) for as long as any run is queued or running, and
 *    that is unchanged by the page tier — it is what keeps the phone's panels
 *    live. What the PAGE adds is asking for the same answer on the same cadence
 *    when the subscription was refused, so a host that predates the `review`
 *    kind draws a moving run rather than a frozen one.
 *
 * The two never both run. `mode` says which is on, and the seam test asserts
 * both paths: a host that accepts the kind must not be polled, and a host that
 * refuses it must be.
 */

import { useEffect, useRef, useState } from "react";

import { bridge } from "../bridge";

/**
 * The page's poll cadence when the host refuses the `review` kind.
 *
 * The same 2,500 ms as `LIVE_POLL_MS` in `index.js`, deliberately: the child is
 * the thing actually re-reading the engine, and a page asking faster than the
 * child re-reads would only be asking the child for its cache twice.
 */
export const REVIEW_POLL_MS = 2_500;

export type ReviewLiveMode = "starting" | "subscribed" | "polling";

/**
 * Follow review progress while `active` is true.
 *
 * `active` is the caller's own "is anything still running" — polling a workspace
 * whose every run finished is pure cost, and the compiled page's event listener
 * was equally silent in that state. The subscription is opened regardless of
 * `active` (it is free, and it is how a run STARTED elsewhere arrives), and only
 * the poll respects it.
 */
export function useReviewLive(
  onChange: () => void,
  active: boolean,
): { mode: ReviewLiveMode } {
  const [mode, setMode] = useState<ReviewLiveMode>("starting");
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    const api = bridge();
    if (!api?.host) {
      setMode("polling");
      return;
    }
    let stopped = false;
    let unsubscribeEvent: (() => void) | null = null;
    let unsubscribeHost: (() => void) | null = null;

    try {
      unsubscribeEvent = api.events.on("host", (frame) => {
        if (frame.kind === "review") handler.current();
      });
    } catch {
      unsubscribeEvent = null;
    }

    void api.host
      .subscribe({ kinds: ["review"] })
      .then((stop) => {
        if (stopped) {
          stop();
          return;
        }
        unsubscribeHost = typeof stop === "function" ? stop : null;
        setMode("subscribed");
      })
      .catch(() => {
        // A host that does not know the `review` kind. The child's poll is the
        // fallback, and it is a fallback rather than a failure: the reader sees
        // the same progress a second and a half later.
        if (!stopped) setMode("polling");
      });

    return () => {
      stopped = true;
      unsubscribeEvent?.();
      unsubscribeHost?.();
    };
  }, []);

  useEffect(() => {
    if (mode !== "polling" || !active) return;
    const timer = setInterval(() => handler.current(), REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [mode, active]);

  return { mode };
}
