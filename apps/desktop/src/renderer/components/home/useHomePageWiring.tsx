import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { NavigateFunction } from "react-router-dom";
import { SquaresFour } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { activityBoardColumn } from "../../../shared/attention/activityBoardColumn";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import type { RecentProjectGroup } from "../app/projectTabGrouping";
import { localDayKey } from "../usage/ActivityHeatmap";
import {
  ActivityUsageCard,
  LimitsMachinesCard,
  PullRequestsCard,
  RunningCard,
  prBucket,
  usePullRequests,
  useRecentStats,
} from "../projects/ProjectWelcomeHome";
import { openUsageDetails, useRunningChats, useUsageGroups, type MachineRow } from "../projects/ProjectWelcomeSidePanels";
import type { WidgetRenderContext } from "./HomeWidgetGrid";
import type { HomeData } from "./homeData";
import { buildHomeHeadline, type HomeHeadline } from "./homeHeadline";
import { HOME_LAYOUT_KEYBINDING, useHomeLayoutStore } from "./homeLayout";
import { LazyHomeWidget } from "./homeWidgetRegistry";
import { startOfLocalWeek, useLocalDayStart } from "./widgets/widgetHooks";

/**
 * The home page's widget wiring, apart from its recents list: the reads the
 * page shares with its widgets (`HomeData`), the headline under the greeting,
 * how each widget renders, and the saved-layouts chord.
 *
 * `renderProjects` is the page's Projects card; pass a memoized one, so
 * `renderWidget` (and the gallery's previews that read it) stays stable
 * between page renders.
 */
export function useHomePageWiring(args: {
  navigate: NavigateFunction;
  project: { rootPath: string; displayName: string } | null;
  webMode: boolean;
  machineRows: MachineRow[];
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  visibleProjectGroups: readonly RecentProjectGroup[];
  renderProjects: (preview: boolean) => ReactNode;
}): {
  homeData: HomeData;
  headline: HomeHeadline | null;
  openHeadlineTarget: (target: NonNullable<HomeHeadline["target"]>) => void;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
} {
  const { navigate, project, webMode, machineRows, remoteSnapshot, visibleProjectGroups, renderProjects } = args;
  const projectRoot = project?.rootPath ?? null;
  const projectName = project?.displayName ?? null;
  const running = useRunningChats();
  const recentStats = useRecentStats();
  const pullRequests = usePullRequests(projectRoot);
  const usageGroups = useUsageGroups();
  const needsYouCount = running.filter((item) => activityBoardColumn(item) === "needs_you").length;
  const dayStart = useLocalDayStart();

  useLayoutChord();

  // The line under the greeting, from what this page already loaded. It waits
  // for the usage stats (and the PR snapshot, when a project is open) so it
  // does not flash "All clear" before the real answer lands.
  const headline = useMemo((): HomeHeadline | null => {
    if (recentStats === null || (projectRoot && !pullRequests.loaded)) return null;
    const stats = recentStats === "unavailable" ? null : recentStats;
    const today = localDayKey(new Date(dayStart));
    let prCounts: Parameters<typeof buildHomeHeadline>[0]["prs"] = null;
    if (projectRoot) {
      // "This week" is since Monday, the same week the Shipped card counts.
      const weekStart = startOfLocalWeek(new Date(dayStart)).getTime();
      const counts = { failing: 0, changes: 0, ready: 0, mergedToday: 0, mergedThisWeek: 0 };
      const viewer = pullRequests.viewer;
      for (const pr of pullRequests.open) {
        // Only what is yours to act on: tracked by a lane, or authored by you.
        if (!(pr.tracked != null || (viewer != null && pr.author === viewer))) continue;
        const bucket = prBucket(pr);
        if (bucket === "failing") counts.failing += 1;
        else if (bucket === "changes") counts.changes += 1;
        else if (bucket === "ready") counts.ready += 1;
      }
      for (const pr of pullRequests.recent) {
        const merged = pr.mergedAt ? new Date(pr.mergedAt) : null;
        if (!merged || !Number.isFinite(merged.getTime())) continue;
        if (merged.getTime() >= weekStart) counts.mergedThisWeek += 1;
        if (localDayKey(merged) === today) counts.mergedToday += 1;
      }
      prCounts = counts;
    }
    const limits = usageGroups.groups.flatMap((group) => group.lines.map((line) => ({
      provider: group.provider,
      providerLabel: line.providerLabel,
      percentLeft: line.percentLeft,
      resetsInMs: line.resetsInMs,
    })));
    return buildHomeHeadline({
      needsYou: needsYouCount,
      working: running.length - needsYouCount,
      prs: prCounts,
      daily: stats?.daily ?? null,
      streakDays: stats?.summary.currentStreakDays ?? 0,
      longestStreakDays: stats?.summary.longestStreakDays ?? 0,
      limits,
      today,
    });
  }, [dayStart, needsYouCount, projectRoot, pullRequests, recentStats, running.length, usageGroups.groups]);

  const hasProject = project != null;
  const openHeadlineTarget = useCallback((target: NonNullable<HomeHeadline["target"]>) => {
    if (target === "prs" && hasProject) navigate("/prs");
    else if (target === "activity") navigate("/activity");
    else openUsageDetails();
  }, [hasProject, navigate]);

  // Pinned projects (the recents pin) for the feed's "pinned only" view: every
  // checkout of a pinned group, so an event from any of its machines matches.
  const pinnedProjects = useMemo(() => visibleProjectGroups
    .filter((group) => group.pinned)
    .map((group) => ({
      name: group.displayName,
      rootPaths: group.locations.map((location) => location.summary.rootPath).filter(Boolean),
    })), [visibleProjectGroups]);
  const machineOnlineSince = useMemo(() => {
    const map = new Map<string, number>();
    for (const connection of remoteSnapshot?.connections ?? []) {
      if (connection.state === "connected" && connection.connectedAt) map.set(connection.target.id, connection.connectedAt);
    }
    return map;
  }, [remoteSnapshot]);

  const homeData = useMemo((): HomeData => ({
    stats: recentStats,
    prs: pullRequests,
    projectName,
    projectRoot,
    webMode,
    openPrs: hasProject ? () => navigate("/prs") : undefined,
    openActivity: () => navigate("/activity"),
    pinnedProjects,
    machineRows,
    machineOnlineSince,
  }), [hasProject, machineOnlineSince, machineRows, navigate, pinnedProjects, projectName, projectRoot, pullRequests, recentStats, webMode]);

  const renderWidget = useCallback(({ item, stacked, editing, preview }: WidgetRenderContext): ReactNode => {
    switch (item.type) {
      case "projects":
        return renderProjects(Boolean(preview));
      case "running":
        return <RunningCard stacked={stacked && !editing} onOpenActivity={() => navigate("/activity")} />;
      case "activity":
        return <ActivityUsageCard stats={recentStats} />;
      case "limits":
        return <LimitsMachinesCard machineRows={machineRows} webMode={webMode} usage={usageGroups} />;
      case "prs":
        return (
          <PullRequestsCard
            projectName={projectName}
            projectRoot={projectRoot}
            prs={pullRequests}
            onOpenPrs={hasProject ? () => navigate("/prs") : undefined}
          />
        );
      default:
        return <LazyHomeWidget item={item} />;
    }
  }, [hasProject, machineRows, navigate, projectName, projectRoot, pullRequests, recentStats, renderProjects, usageGroups, webMode]);

  return { homeData, headline, openHeadlineTarget, renderWidget };
}

/** The saved-layouts chord (rebindable as home.layout.next) cycles layouts while the page shows. Typing in a field keeps the keystroke. */
function useLayoutChord(): void {
  const keybindings = useAppStore((s) => s.keybindings);
  const layoutBinding = useMemo(
    () => getEffectiveBinding(keybindings, HOME_LAYOUT_KEYBINDING.id, HOME_LAYOUT_KEYBINDING.fallback),
    [keybindings],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !eventMatchesBinding(event, layoutBinding)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (event.repeat) return;
      const store = useHomeLayoutStore.getState();
      if (store.presets.length < 2) {
        showToast({ id: "home-layout-switch", tone: "neutral", title: "Only one layout saved", message: "Customize the page, then Save as… to add another.", durationMs: 2600 });
        return;
      }
      const next = store.cyclePreset(1);
      if (next) showToast({ id: "home-layout-switch", tone: "neutral", icon: <SquaresFour size={15} weight="fill" />, title: `Layout: ${next.name}`, durationMs: 1600 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layoutBinding]);
}
