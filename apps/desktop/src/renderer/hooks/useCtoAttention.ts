import { useEffect } from "react";
import type { CtoAttentionState } from "../../shared/types";
import { shouldRefreshSessionListForChatEvent } from "../lib/chatSessionEvents";
import { selectActiveProjectRoot, useAppStore } from "../state/appStore";

const IDLE: CtoAttentionState = { status: "idle", awaitingInput: false, since: null };
// Each probe is a full identity-session scan on the host, so the safety read
// backs off while the state stays the same: 15s, 30s, 60s, then 120s. Events
// and focus still bring it back to the base cadence.
const SAFETY_READ_BASE_MS = 15_000;
const SAFETY_READ_MAX_MS = 120_000;

function attentionKey(state: CtoAttentionState): string {
  return `${state.status}|${state.awaitingInput}|${state.since ?? ""}`;
}

/**
 * Keeps the CTO tab's "needs you" dot fresh.
 *
 * The CTO chat is deliberately excluded from every lane/session roster, which
 * also excludes it from `terminalAttention` and the dock badge. Without this
 * hook a hidden thread could ask a question and show nothing anywhere — the
 * exact failure mode hiding the row introduces. It is a pure read: the probe
 * never creates a CTO session or a primary lane.
 */
export function useCtoAttention(): void {
  const currentProjectRoot = useAppStore(selectActiveProjectRoot);
  const showWelcome = useAppStore((state) => state.showWelcome);
  const setCtoAttention = useAppStore((state) => state.setCtoAttention);
  const trackedProjectRoot = showWelcome ? null : currentProjectRoot;

  useEffect(() => {
    if (!trackedProjectRoot) {
      setCtoAttention(IDLE);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let queued = false;
    let timer: number | null = null;
    let dueAt = 0;
    let lastKey: string | null = null;
    let unchangedReads = 0;

    // Clear immediately on project switch so the previous project's CTO state
    // cannot linger on the tab while the first probe is in flight.
    setCtoAttention(IDLE);

    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const next = await window.ade?.cto?.getAttention?.();
        if (cancelled || !next) return;
        if (next.status === "unknown") return;
        const key = attentionKey(next);
        unchangedReads = key === lastKey ? unchangedReads + 1 : 0;
        lastKey = key;
        setCtoAttention(next);
      } catch {
        // Best effort: a failed probe leaves the last known state rather than
        // falsely clearing a pending question.
      } finally {
        inFlight = false;
        if (!cancelled && queued) {
          queued = false;
          schedule(250);
        } else if (!cancelled) {
          scheduleSafetyRead();
        }
      }
    };

    // An already-pending timer must not swallow a sooner request: window focus
    // asks for an immediate refresh, and dropping it leaves the dot stale for
    // the remainder of the debounce.
    const schedule = (delayMs = 1_500) => {
      if (cancelled) return;
      const nextDueAt = Date.now() + delayMs;
      if (timer != null) {
        if (dueAt <= nextDueAt) return;
        window.clearTimeout(timer);
      }
      dueAt = nextDueAt;
      timer = window.setTimeout(() => {
        timer = null;
        dueAt = 0;
        void refresh();
      }, delayMs);
    };

    // The safety read is the one timer that keeps itself going, so it is
    // scheduled after each probe at the current backoff. It pauses while the
    // page is hidden; becoming visible reads again at once.
    const scheduleSafetyRead = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      schedule(Math.min(SAFETY_READ_MAX_MS, SAFETY_READ_BASE_MS * 2 ** unchangedReads));
    };

    schedule(0);

    // A CTO question arrives as a chat event on its own session, so we cannot
    // filter by lane here. We can filter by *kind*: the probe runs a full
    // identity-session scan in main, so arming it on every streaming delta
    // would burn main-process CPU for a whole turn. This is the same predicate
    // the Work-tab attention hook uses, and it admits exactly the event types
    // that can change `awaitingInput`.
    const unsubscribeChat = window.ade?.agentChat?.onEvent?.((event) => {
      if (!shouldRefreshSessionListForChatEvent(event)) return;
      unchangedReads = 0;
      schedule();
    });
    const onFocus = () => {
      unchangedReads = 0;
      schedule(0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      unchangedReads = 0;
      schedule(0);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      try {
        unsubscribeChat?.();
      } catch {
        // ignore
      }
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [trackedProjectRoot, setCtoAttention]);
}
