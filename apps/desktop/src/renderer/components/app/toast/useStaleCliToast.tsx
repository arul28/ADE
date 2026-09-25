import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { TerminalWindow } from "@phosphor-icons/react";

import type { LaneSummary, TerminalSessionSummary } from "../../../../shared/types";
import { getStaleRunningCliSessionAgeHours } from "../../../lib/sessions";
import { listSessionsCached } from "../../../lib/sessionListCache";
import { isStaleCliNoticeSnoozed, snoozeStaleCliNotice } from "../../../lib/staleCliNoticeSnooze";
import { workViewStoreForProject } from "../../../state/appStore";
import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import { dismissToast, showToast, type ToastChip, type ToastInput } from "./toastStore";

/** One id, so a re-detection updates the visible notice in place. */
export const STALE_CLI_TOAST_ID = "stale-cli-sessions";

/** How many lanes get their own chip before the rest fold into "+N more". */
const MAX_LANE_CHIPS = 4;

export type StaleCliToastLane = {
  laneId: string;
  laneName: string;
  count: number;
  color: string | null;
};

/**
 * Pure: the idle CLI/shell sessions notice. Sticky — it leaves only when the
 * user acts on it, dismisses it (which snoozes it for an hour), or the idle
 * sessions go away.
 */
export function buildStaleCliToast({
  count,
  ageHours,
  lanes,
  onViewProcesses,
  onDismiss,
}: {
  count: number;
  ageHours: number;
  lanes: StaleCliToastLane[];
  onViewProcesses: () => void;
  onDismiss: () => void;
}): ToastInput & { id: string } {
  const chips: ToastChip[] = lanes.slice(0, MAX_LANE_CHIPS).map((lane) => ({
    label: lane.count > 1 ? `${lane.laneName} ×${lane.count}` : lane.laneName,
    icon: <LaneAccentDot color={lane.color ?? "currentColor"} size={6} ringed={false} />,
    title: `${lane.count} idle session${lane.count === 1 ? "" : "s"} in ${lane.laneName}`,
  }));
  if (lanes.length > MAX_LANE_CHIPS) {
    chips.push({ label: `+${lanes.length - MAX_LANE_CHIPS} more` });
  }
  return {
    id: STALE_CLI_TOAST_ID,
    tone: "warning",
    icon: <TerminalWindow size={15} weight="fill" />,
    badge: "Idle sessions",
    title: `${count} CLI or shell session${count === 1 ? "" : "s"} sitting idle`,
    message: `No activity for about ${ageHours} hours. Close anything you're done with to free up memory.`,
    chips: chips.length > 0 ? chips : undefined,
    actions: [{ label: "View processes", variant: "solid", onClick: onViewProcesses }],
    closeTitle: "Dismiss for an hour",
    onClose: onDismiss,
    durationMs: 0,
  };
}

type StaleCliNoticeLane = {
  laneId: string;
  laneName: string;
  count: number;
};

type StaleCliNotice = {
  count: number;
  /** Oldest last-activity (or startedAt fallback) among the stale sessions. */
  oldestActivityAt: string;
  /** Per-lane breakdown so the notice can show which lanes hold stale sessions. */
  lanes: StaleCliNoticeLane[];
};

function sessionActivityMs(session: TerminalSessionSummary): number {
  const activityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Number.NaN;
  return Number.isFinite(activityMs) ? activityMs : Date.parse(session.startedAt);
}

/**
 * Watches for CLI/shell sessions that have sat idle for hours and shows the
 * idle-sessions toast. Detection runs a few seconds after a project opens, then
 * every 10 minutes and on focus. The notice shows at most once an hour per
 * project (a durable snooze armed on first show and re-armed on dismiss); a
 * visible notice refreshes in place without re-tripping the snooze. Switching
 * projects, the welcome screen, or the idle sessions going away takes it down.
 */
export function useStaleCliToast({
  projectRoot,
  activeProjectRoot,
  showWelcome,
  isRemoteProject,
  isWorkAdjacentRoute,
  lanes,
  navigate,
}: {
  /** The opened project's root; detection runs against it. */
  projectRoot: string | null;
  /** The active project root (local or remote); dismiss and "View processes" act on it. */
  activeProjectRoot: string | null;
  showWelcome: boolean;
  isRemoteProject: boolean;
  /** Remote projects only check while a Work or Lanes route is open. */
  isWorkAdjacentRoute: boolean;
  lanes: readonly Pick<LaneSummary, "id" | "color">[];
  navigate: NavigateFunction;
}): void {
  const [staleCliNotice, setStaleCliNotice] = useState<StaleCliNotice | null>(null);
  // Whether a stale-CLI notice is currently displayed. Lets refreshes keep an
  // already-visible notice updated without re-tripping the once-per-hour snooze,
  // and prevents the snooze from hiding a notice the user is actively looking at.
  const staleCliNoticeActiveRef = useRef(false);

  useEffect(() => {
    const shouldCheckStaleCliNotice =
      Boolean(projectRoot) &&
      !showWelcome &&
      (!isRemoteProject || isWorkAdjacentRoute);
    if (!shouldCheckStaleCliNotice) {
      setStaleCliNotice(null);
      staleCliNoticeActiveRef.current = false;
      return;
    }

    if (!projectRoot) return;
    let cancelled = false;
    let refreshTimer: number | null = null;

    // Prevent cross-project stale notice carryover while the first refresh is
    // pending for the new project.
    setStaleCliNotice(null);
    staleCliNoticeActiveRef.current = false;

    const refreshStaleCliNotice = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const sessions = await listSessionsCached({ status: "running", limit: 500 });
        if (cancelled) return;
        const nowMs = Date.now();
        const stale = sessions
          .filter((session) => {
            return getStaleRunningCliSessionAgeHours(session, nowMs) != null;
          })
          .sort((left, right) => sessionActivityMs(left) - sessionActivityMs(right));

        if (!stale.length) {
          setStaleCliNotice(null);
          staleCliNoticeActiveRef.current = false;
          return;
        }

        const oldest = stale[0];
        const oldestActivityAt =
          oldest?.lastActivityAt ?? oldest?.startedAt ?? new Date(nowMs).toISOString();

        const laneMap = new Map<string, StaleCliNoticeLane>();
        for (const session of stale) {
          const existing = laneMap.get(session.laneId);
          if (existing) existing.count += 1;
          else
            laneMap.set(session.laneId, {
              laneId: session.laneId,
              laneName: session.laneName || session.laneId,
              count: 1,
            });
        }
        const lanesBreakdown = [...laneMap.values()].sort((a, b) => b.count - a.count);
        const notice: StaleCliNotice = { count: stale.length, oldestActivityAt, lanes: lanesBreakdown };

        // Already showing a notice for this project? Keep it fresh without
        // re-tripping the snooze. Otherwise gate on the per-project hourly
        // snooze, and arm the snooze the moment we first show it so the
        // once-per-hour cadence survives restarts / project re-opens.
        if (staleCliNoticeActiveRef.current) {
          setStaleCliNotice(notice);
          return;
        }
        if (isStaleCliNoticeSnoozed(projectRoot, nowMs)) {
          setStaleCliNotice(null);
          return;
        }
        snoozeStaleCliNotice(projectRoot, nowMs);
        staleCliNoticeActiveRef.current = true;
        setStaleCliNotice(notice);
      } catch {
        // best effort
      }
    };

    const scheduleRefresh = (delayMs = 0) => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshStaleCliNotice();
      }, delayMs);
    };

    scheduleRefresh(4_000);
    const interval = window.setInterval(() => scheduleRefresh(), 10 * 60_000);
    const onFocus = () => scheduleRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isRemoteProject, isWorkAdjacentRoute, projectRoot, showWelcome]);

  const staleCliNoticeAgeHours = staleCliNotice
    ? getStaleRunningCliSessionAgeHours({
        status: "running",
        startedAt: staleCliNotice.oldestActivityAt,
        toolType: "shell",
        lastActivityAt: staleCliNotice.oldestActivityAt,
      }) ?? 24
    : 0;

  const dismissStaleCliNotice = useCallback(() => {
    // Intentionally re-arms (resets) the snooze from the dismiss moment, not
    // just the first-show moment: "if dismissed, don't show again for an hour"
    // is measured from the dismissal. The show-time arming in
    // refreshStaleCliNotice is what keeps the once-per-hour cadence alive
    // across restarts when the user never dismisses; the two are complementary,
    // not a bug.
    if (activeProjectRoot) snoozeStaleCliNotice(activeProjectRoot);
    staleCliNoticeActiveRef.current = false;
    setStaleCliNotice(null);
  }, [activeProjectRoot]);

  const viewStaleCliProcesses = useCallback(() => {
    if (activeProjectRoot) {
      // AppShell renders above AppStoreProvider, so this
      // must go through the store that owns the project —
      // writing to the root store would leave the mounted
      // Work surface showing its own older view state.
      const workStore = workViewStoreForProject(activeProjectRoot);
      // Reset the lane filter too so stale sessions across
      // *all* lanes are visible, not just the active one.
      workStore.getState().setWorkViewState(activeProjectRoot, (current) => ({
        ...current,
        laneFilter: "all",
        sessionListOrganization: "all-lanes-by-status",
        workCollapsedSectionIds: current.workCollapsedSectionIds
          .filter((sectionId) => sectionId !== "status:running"),
      }));
    }
    navigate("/work");
    dismissStaleCliNotice();
  }, [activeProjectRoot, dismissStaleCliNotice, navigate]);

  // The idle-sessions notice is a store toast with a stable id: a refresh
  // updates it in place, and clearing the notice (project switch, sessions
  // gone, welcome screen) takes it down. × snoozes it via `onClose`.
  useEffect(() => {
    if (!staleCliNotice) {
      dismissToast(STALE_CLI_TOAST_ID);
      return;
    }
    showToast(
      buildStaleCliToast({
        count: staleCliNotice.count,
        ageHours: staleCliNoticeAgeHours,
        lanes: staleCliNotice.lanes.map((noticeLane) => ({
          ...noticeLane,
          color: lanes.find((lane) => lane.id === noticeLane.laneId)?.color ?? null,
        })),
        onViewProcesses: viewStaleCliProcesses,
        onDismiss: dismissStaleCliNotice,
      }),
    );
  }, [staleCliNotice, staleCliNoticeAgeHours, lanes, viewStaleCliProcesses, dismissStaleCliNotice]);
  useEffect(() => () => dismissToast(STALE_CLI_TOAST_ID), []);
}
