import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  chatPrSignature,
  detectChatPrDelta,
  type ChatPrDelta,
  type ChatPrSignature,
} from "./ChatPrPane";

export type UseChatPrAutoPop = {
  prPaneOpen: boolean;
  setPrPaneOpen: Dispatch<SetStateAction<boolean>>;
  /** The PR change that triggered the most recent auto-pop; handed to ChatPrPane. */
  prPaneDelta: ChatPrDelta | null;
};

/**
 * Drives the floating PR pane's auto-pop for a lane's linked PR, shared by the
 * ADE chat surface (AgentChatPane) and the CLI session surface (WorkViewArea).
 *
 * On each webhook-driven `prs-updated` it re-reads this lane's PR summary and
 * pops the pane for a pop-worthy change — a newly created/linked PR, a lifecycle
 * change (merged/closed/reopened/ready/draft), or a new commit push. Checks and
 * review changes update the pane but do not pop it (see detectChatPrDelta). The
 * baseline is seeded silently so an already-open PR never pops on chat open.
 * Re-pops on each qualifying event; rapid bursts collapse into one visible pop
 * because the pane only ever shows the latest delta.
 */
export function useChatPrAutoPop(laneId: string | null | undefined): UseChatPrAutoPop {
  const [prPaneOpen, setPrPaneOpen] = useState(false);
  const [prPaneDelta, setPrPaneDelta] = useState<ChatPrDelta | null>(null);
  const prevPrSigRef = useRef<ChatPrSignature | null>(null); // null = not yet seeded
  const nonceRef = useRef(0);

  useEffect(() => {
    setPrPaneDelta(null);
    prevPrSigRef.current = null;
    // The prs bridge can be absent in some surfaces / test harnesses / early
    // boot; degrade to "no auto-pop" instead of crashing the host surface.
    const prs = window.ade?.prs;
    if (!laneId || !prs?.getForLane || !prs?.onEvent) return;
    let cancelled = false;
    prs
      .getForLane(laneId)
      .then((pr) => {
        if (!cancelled && prevPrSigRef.current === null) prevPrSigRef.current = chatPrSignature(pr);
      })
      .catch(() => {});
    const unsubscribe = prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      const next = event.prs.find((pr) => pr.laneId === laneId) ?? null;
      const prev = prevPrSigRef.current;
      prevPrSigRef.current = chatPrSignature(next);
      if (prev === null) return; // just seeded from this event — no pop
      const change = detectChatPrDelta(prev, next);
      if (!change) return;
      setPrPaneDelta({ ...change, nonce: ++nonceRef.current });
      setPrPaneOpen(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [laneId]);

  return { prPaneOpen, setPrPaneOpen, prPaneDelta };
}
