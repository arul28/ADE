import { useEffect, useRef } from "react";
import type { TerminalSessionSummary } from "../../shared/types";
import { shouldRefreshSessionListForChatEvent } from "../lib/chatSessionEvents";
import {
  invalidateSessionListCache,
  listSessionsCached,
} from "../lib/sessionListCache";
import { summarizeTerminalAttention } from "../lib/terminalAttention";
import { selectActiveProjectRoot, useAppStore } from "../state/appStore";

const EMPTY_TERMINAL_ATTENTION = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none" as const,
  byLaneId: {},
};

export function useAppWideSessionAttention(): void {
  const currentProjectRoot = useAppStore(selectActiveProjectRoot);
  const showWelcome = useAppStore((state) => state.showWelcome);
  const setTerminalAttention = useAppStore((state) => state.setTerminalAttention);
  // The CTO thread is hidden from the session list this hook summarizes, so it
  // must be added to the dock badge explicitly or a CTO question would never
  // reach a minimized window. Kept in this hook so `setDockBadgeCount` keeps a
  // single writer.
  const ctoAwaitingInput = useAppStore((state) => state.ctoAttention.awaitingInput);
  const lastDockBadgeCountRef = useRef<number | null>(null);
  const trackedProjectRoot = showWelcome ? null : currentProjectRoot;

  useEffect(() => {
    if (!trackedProjectRoot) {
      setTerminalAttention(EMPTY_TERMINAL_ATTENTION);
      // The hook is app-wide, so route changes keep a project root and do not
      // enter this branch. Reaching it means the project was closed; clear the
      // application-wide badge instead of leaking the previous project's count.
      if (lastDockBadgeCountRef.current !== 0) {
        lastDockBadgeCountRef.current = 0;
        void window.ade?.app?.setDockBadgeCount?.(0)?.catch?.(() => {});
      }
      return;
    }

    let refreshTimer: number | null = null;
    let refreshDueAt = 0;
    let refreshInFlight = false;
    let refreshQueued = false;
    let cancelled = false;

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
        const badgeCount = attention.needsAttentionCount + (ctoAwaitingInput ? 1 : 0);
        // Dock badge mirrors the loud tier only; push on change so a blocked
        // agent reaches the user even with the window minimized.
        if (lastDockBadgeCountRef.current !== badgeCount) {
          lastDockBadgeCountRef.current = badgeCount;
          void window.ade?.app?.setDockBadgeCount?.(badgeCount)?.catch?.(() => {});
        }
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
  }, [trackedProjectRoot, setTerminalAttention, ctoAwaitingInput]);
}
