import { useEffect, useRef } from "react";
import type { TerminalSessionSummary } from "../../shared/types";
import { activityBadgeCount } from "../components/activity/activityPriority";
import { shouldRefreshSessionListForChatEvent } from "../lib/chatSessionEvents";
import {
  invalidateSessionListCache,
  listSessionsCached,
} from "../lib/sessionListCache";
import { summarizeTerminalAttention } from "../lib/terminalAttention";
import {
  activityStore,
  selectDockBadgeScope,
  useActivityStore,
} from "../state/activityStore";
import { selectActiveProjectRoot, useAppStore } from "../state/appStore";

const EMPTY_TERMINAL_ATTENTION = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none" as const,
  byLaneId: {},
};

/**
 * Account-scoped dock badge, or `null` when the account feed cannot answer.
 *
 * Null is not zero. A snapshot that has not landed, has gone degraded, or
 * belongs to a signed-out window knows nothing about the other machines, and a
 * badge of 0 in that state is a claim the data does not support — so the caller
 * falls back to the local count instead.
 */
function accountDockBadgeCount(): number | null {
  const state = activityStore.getState();
  if (state.availability?.state !== "ready") return null;
  return activityBadgeCount(state.itemsById);
}

export function useAppWideSessionAttention(): void {
  const currentProjectRoot = useAppStore(selectActiveProjectRoot);
  const showWelcome = useAppStore((state) => state.showWelcome);
  const setTerminalAttention = useAppStore((state) => state.setTerminalAttention);
  // The CTO thread is hidden from the session list this hook summarizes, so it
  // must be added to the dock badge explicitly or a CTO question would never
  // reach a minimized window. Kept in this hook so `setDockBadgeCount` keeps a
  // single writer.
  const ctoAwaitingInput = useAppStore((state) => state.ctoAttention.awaitingInput);
  // Account scope is a synced preference, so it can flip from another device
  // mid-session; the badge has to follow without a reload.
  const dockBadgeScope = useActivityStore(selectDockBadgeScope);
  const lastDockBadgeCountRef = useRef<number | null>(null);
  const trackedProjectRoot = showWelcome ? null : currentProjectRoot;

  useEffect(() => {
    if (!trackedProjectRoot) {
      setTerminalAttention(EMPTY_TERMINAL_ATTENTION);
      // The hook is app-wide, so route changes keep a project root and do not
      // enter this branch. Reaching it means the project was closed; clear the
      // application-wide badge instead of leaking the previous project's count
      // — unless the badge is account-scoped, in which case the open project is
      // irrelevant to what it counts.
      const accountOnly = dockBadgeScope === "account" ? accountDockBadgeCount() : null;
      const projectlessBadge = accountOnly == null
        ? 0
        : accountOnly + (ctoAwaitingInput ? 1 : 0);
      if (lastDockBadgeCountRef.current !== projectlessBadge) {
        lastDockBadgeCountRef.current = projectlessBadge;
        void window.ade?.app?.setDockBadgeCount?.(projectlessBadge)?.catch?.(() => {});
      }
      if (dockBadgeScope !== "account") return;
      // Keep following the account feed while no project is open.
      return activityStore.subscribe(() => {
        const count = accountDockBadgeCount();
        const next = count == null ? 0 : count + (ctoAwaitingInput ? 1 : 0);
        if (lastDockBadgeCountRef.current === next) return;
        lastDockBadgeCountRef.current = next;
        void window.ade?.app?.setDockBadgeCount?.(next)?.catch?.(() => {});
      });
    }

    let refreshTimer: number | null = null;
    let refreshDueAt = 0;
    let refreshInFlight = false;
    let refreshQueued = false;
    let cancelled = false;
    let localNeedsAttention = 0;

    /**
     * The single dock-badge write. Account scope counts the whole account's
     * needs-you tier; local scope counts this Mac's sessions. Either way the
     * CTO thread is added on top, because it is hidden from both feeds.
     */
    const pushDockBadge = () => {
      const account = dockBadgeScope === "account" ? accountDockBadgeCount() : null;
      const badgeCount = (account ?? localNeedsAttention) + (ctoAwaitingInput ? 1 : 0);
      // Push on change so a blocked agent reaches the user even with the
      // window minimized.
      if (lastDockBadgeCountRef.current === badgeCount) return;
      lastDockBadgeCountRef.current = badgeCount;
      void window.ade?.app?.setDockBadgeCount?.(badgeCount)?.catch?.(() => {});
    };

    const unsubscribeAttention = dockBadgeScope === "account"
      ? activityStore.subscribe(pushDockBadge)
      : () => {};

    const refreshTerminalAttention = async () => {
      if (cancelled) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      // No visibility gate: the dock badge must keep tracking the loud tier
      // while the window is hidden/minimized — that is its whole purpose. The
      // refresh stays event-driven + debounced, so hidden cost is bounded.
      refreshInFlight = true;
      try {
        const sessions: TerminalSessionSummary[] = (
          await listSessionsCached({ limit: 150 }, { force: true })
        );
        if (cancelled) return;
        const attention = summarizeTerminalAttention(sessions);
        setTerminalAttention(attention);
        // Dock badge mirrors the loud tier only.
        localNeedsAttention = attention.needsAttentionCount;
        pushDockBadge();
      } catch {
        // best effort
      } finally {
        refreshInFlight = false;
        if (!cancelled && refreshQueued) {
          refreshQueued = false;
          scheduleRefresh(250);
        }
      }
    };

    const scheduleRefresh = (delayMs = 2_500) => {
      if (cancelled) return;
      const dueAt = Date.now() + delayMs;
      if (refreshTimer != null && refreshDueAt <= dueAt) return;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshDueAt = dueAt;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshDueAt = 0;
        void refreshTerminalAttention();
      }, delayMs);
    };

    scheduleRefresh(2_500);

    const isCurrentProjectEvent = (event: { projectRoot?: string | null }) => {
      return !event.projectRoot || event.projectRoot === trackedProjectRoot;
    };

    const unsubscribeData = window.ade.pty.onData((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh();
    });
    const unsubscribeExit = window.ade.pty.onExit((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh();
    });
    const unsubscribeChat = window.ade.agentChat.onEvent((event) => {
      if (!shouldRefreshSessionListForChatEvent(event)) return;
      invalidateSessionListCache({ projectRoot: useAppStore.getState().project?.rootPath ?? null });
      scheduleRefresh(0);
    });
    const unsubscribeSession = window.ade.sessions.onChanged(() => {
      invalidateSessionListCache({ projectRoot: useAppStore.getState().project?.rootPath ?? null });
      scheduleRefresh(0);
    });
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleRefresh();
    }, 15_000);
    const onFocus = () => scheduleRefresh(0);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefresh(0);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribeAttention();
      try {
        unsubscribeData();
        unsubscribeExit();
        unsubscribeChat();
        unsubscribeSession();
      } catch {
        // ignore
      }
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [trackedProjectRoot, setTerminalAttention, ctoAwaitingInput, dockBadgeScope]);
}
