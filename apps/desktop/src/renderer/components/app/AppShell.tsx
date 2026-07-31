import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  GitBranch,
  GithubLogo,
  GitPullRequest,
  LinkSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { IntegrationBannerHost } from "./IntegrationBannerHost";
import { TabNav } from "./TabNav";
import { isWebClientMode } from "../../lib/webClientMode";
import { TopBar } from "./TopBar";
import { ProjectTransitionErrorAlert } from "./ProjectTransitionErrorAlert";
import {
  getPrToastHeadline,
  getPrToastMeta,
  getPrToastSummary,
  getPrToastTone,
  type PrToastTone,
} from "./prToastPresentation";
import { TabBackground } from "../ui/TabBackground";
import { LaneAccentDot } from "../lanes/LaneAccentDot";
import { selectActiveProjectRoot, useAppStore, workViewStoreForProject } from "../../state/appStore";
import { Button } from "../ui/Button";
import type {
  AiSettingsStatus,
  GitHubStatus,
  OnboardingStatus,
  PrEventPayload,
  ProjectInfo,
  OpenProjectBinding,
  SyncRoleSnapshot,
  SyncRouteHealth,
  TerminalSessionSummary,
} from "../../../shared/types";
import {
  eventMatchesBinding,
  getEffectiveBinding,
} from "../../lib/keybindings";
import { listSessionsCached } from "../../lib/sessionListCache";
import {
  AI_STATUS_CACHE_INVALIDATED_EVENT,
  getAiStatusCached,
  peekAiStatusCached,
  type AiStatusCacheInvalidatedEventDetail,
} from "../../lib/aiDiscoveryCache";
import {
  hasConfiguredAiProvider,
  shouldRefreshAiStatusForChatEvent,
} from "../../lib/aiProviderStatus";
import { getStaleRunningCliSessionAgeHours } from "../../lib/sessions";
import {
  isStaleCliNoticeSnoozed,
  snoozeStaleCliNotice,
} from "../../lib/staleCliNoticeSnooze";
import { hasRecentBannerDismissal } from "../../lib/bannerDismiss";
import {
  getStoredZoomLevel,
  displayZoomToLevel,
  applyShellHeaderInset,
} from "../../lib/zoom";
import { ONBOARDING_STATUS_UPDATED_EVENT } from "../../lib/onboardingStatusEvents";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { cn } from "../ui/cn";
import { disposeTerminalRuntimesForProjectChange } from "../terminals/TerminalView";
import { buildPrsRouteSearch, type PrDetailRouteTab } from "../prs/prsRouteState";
import { ToastStack } from "./toast/ToastStack";
import { AutoUpdateBanner } from "./AutoUpdateBanner";
import { BrainRecoveryNotice } from "./BrainRecoveryNotice";
import { WorktreeOpenDialog } from "../projects/WorktreeOpenDialog";
import { showToast, useToasts } from "./toast/toastStore";
import { useLaneEventToasts } from "./toast/useLaneEventToasts";
import {
  useProductAnalyticsLifecycle,
  WebAnalyticsConsentBanner,
} from "../analytics/ProductAnalyticsLifecycle";
import { useAppWideSessionAttention } from "../../hooks/useAppWideSessionAttention";
import { useAttentionSync } from "../attention/useAttentionSync";

type PrToast = {
  id: string;
  event: Extract<PrEventPayload, { type: "pr-notification" }>;
};

type AutoLinkToast = {
  id: string;
  event: Extract<PrEventPayload, { type: "pr-auto-linked" }>;
  undoing?: boolean;
  undoFailed?: boolean;
};

function primaryTabPath(pathname: string): string {
  const roots = ["/hub", "/attention", "/lanes", "/files", "/work", "/graph", "/prs", "/history", "/automations", "/cto", "/settings"];
  return roots.find((root) => pathname === root || pathname.startsWith(`${root}/`)) ?? pathname;
}

const PRODUCT_ANALYTICS_ROUTE_ROOTS = [
  "/hub",
  "/attention",
  "/lanes",
  "/files",
  "/work",
  "/graph",
  "/prs",
  "/review",
  "/history",
  "/automations",
  "/cto",
  "/settings",
  "/chats",
  "/onboarding",
] as const;

export function productAnalyticsScreenForPathname(pathname: string): string {
  if (pathname === "/project" || pathname.startsWith("/project/")) return "project";
  const root = PRODUCT_ANALYTICS_ROUTE_ROOTS.find(
    (candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`),
  );
  return root?.slice(1) ?? "other";
}

function shouldLoadShellGithubStatus(pathname: string, isRemoteProject: boolean): boolean {
  if (!isRemoteProject) return true;
  return pathname === "/prs"
    || pathname.startsWith("/prs/")
    || pathname === "/settings"
    || pathname.startsWith("/settings/");
}

function shouldLoadShellAiStatus(pathname: string, isRemoteProject: boolean): boolean {
  if (!isRemoteProject) return true;
  return pathname === "/work"
    || pathname.startsWith("/work/")
    || pathname === "/lanes"
    || pathname.startsWith("/lanes/")
    || pathname === "/settings"
    || pathname.startsWith("/settings/");
}

const PROJECT_ROUTE_STORAGE_PREFIX = "ade:project-route:";
const AI_STATUS_STARTUP_DELAY_MS = 1_000;
const AI_STATUS_CHAT_EVENT_REFRESH_MIN_GAP_MS = 30_000;
const GITHUB_STATUS_STARTUP_DELAY_MS = 12_000;
const GITHUB_STATUS_DISMISSED_BANNER_DELAY_MS = 30_000;
const GITHUB_STATUS_RECONNECT_DELAY_MS = 750;

function projectRouteStorageKey(projectRoot: string): string {
  return `${PROJECT_ROUTE_STORAGE_PREFIX}${projectRoot}`;
}

function serializeLocationRoute(location: ReturnType<typeof useLocation>): string | null {
  const pathname = location.pathname || "/work";
  const route = `${pathname}${location.search ?? ""}${location.hash ?? ""}`;
  const allowedRoots = [
    "/lanes",
    "/files",
    "/work",
    "/graph",
    "/prs",
    "/review",
    "/history",
    "/automations",
    "/cto",
    "/settings",
  ];
  if (!allowedRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`))) {
    return null;
  }
  return route;
}

function writeStoredProjectRoute(projectRoot: string, route: string): void {
  try {
    window.localStorage.setItem(projectRouteStorageKey(projectRoot), route);
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

type AiBannerState = {
  laneId: string | null;
  jobId: string | null;
  status: string | null;
  error: string;
  createdAt: string;
};

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

function shortId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

function getPrToastToneClasses(tone: PrToastTone): {
  panel: string;
  badge: string;
  iconWrap: string;
  iconClass: string;
} {
  if (tone === "danger") {
    return {
      panel: "border-red-500/25 bg-card/95",
      badge: "border border-red-500/30 bg-red-500/10 text-red-300",
      iconWrap: "border border-red-500/30 bg-red-500/12",
      iconClass: "text-red-300",
    };
  }
  if (tone === "warning") {
    return {
      panel: "border-amber-500/25 bg-card/95",
      badge: "border border-amber-500/30 bg-amber-500/10 text-amber-300",
      iconWrap: "border border-amber-500/30 bg-amber-500/12",
      iconClass: "text-amber-300",
    };
  }
  if (tone === "success") {
    return {
      panel: "border-emerald-500/25 bg-card/95",
      badge: "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      iconWrap: "border border-emerald-500/30 bg-emerald-500/12",
      iconClass: "text-emerald-300",
    };
  }
  return {
    panel: "border-sky-500/25 bg-card/95",
    badge: "border border-sky-500/30 bg-sky-500/10 text-sky-300",
    iconWrap: "border border-sky-500/30 bg-sky-500/12",
    iconClass: "text-sky-300",
  };
}

function getPrToastIcon(kind: PrToast["event"]["kind"]) {
  if (kind === "checks_failing") return XCircle;
  if (kind === "changes_requested") return WarningCircle;
  if (kind === "merge_ready") return CheckCircle;
  return GitPullRequest;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  useLaneEventToasts(navigate);
  const setProject = useAppStore((s) => s.setProject);
  const setProjectHydrated = useAppStore((s) => s.setProjectHydrated);
  const setProjectBinding = useAppStore((s) => s.setProjectBinding);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);
  const refreshKeybindings = useAppStore((s) => s.refreshKeybindings);
  const providerMode = useAppStore((s) => s.providerMode);
  const keybindings = useAppStore((s) => s.keybindings);
  const lanes = useAppStore((s) => s.lanes);
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectRevision = useAppStore((s) => s.projectRevision);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const setPersonalChatsTabOpen = useAppStore(
    (s) => s.setPersonalChatsTabOpen,
  );
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const closeProject = useAppStore((s) => s.closeProject);
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const [commandOpen, setCommandOpen] = useState(false);
  const visitedTabsRef = useRef(new Set<string>());
  const isFirstVisit = !visitedTabsRef.current.has(location.pathname);
  const storeToasts = useToasts();
  const [prToasts, setPrToasts] = useState<PrToast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const dismissPrToast = (id: string) => {
    setPrToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = toastTimersRef.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    toastTimersRef.current.delete(id);
  };
  const [autoLinkToasts, setAutoLinkToasts] = useState<AutoLinkToast[]>([]);
  const autoLinkToastTimersRef = useRef<Map<string, number>>(new Map());
  const dismissAutoLinkToast = (id: string) => {
    setAutoLinkToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = autoLinkToastTimersRef.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    autoLinkToastTimersRef.current.delete(id);
  };
  const [staleCliNotice, setStaleCliNotice] =
    useState<StaleCliNotice | null>(null);
  // Whether a stale-CLI notice is currently displayed. Lets refreshes keep an
  // already-visible notice updated without re-tripping the once-per-hour snooze,
  // and prevents the snooze from hiding a notice the user is actively looking at.
  const staleCliNoticeActiveRef = useRef(false);
  const [aiFailure, setAiFailure] = useState<AiBannerState | null>(null);
  const [aiMockProvider, setAiMockProvider] = useState<{
    createdAt: string;
  } | null>(null);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [aiStatusLoaded, setAiStatusLoaded] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubConnectionGeneration, setGithubConnectionGeneration] = useState(0);
  const [onboardingStatus, setOnboardingStatus] =
    useState<OnboardingStatus | null>(null);
  const [onboardingStatusLoading, setOnboardingStatusLoading] = useState(false);
  // Connection/health banner dismissals now live in a durable localStorage store
  // (see IntegrationBannerHost / bannerDismiss.ts) so they survive restart, rather
  // than the session-only Zustand maps this used to read.
  const currentProjectRoot = useAppStore(selectActiveProjectRoot);
  const isRemoteProject = projectBinding?.kind === "remote";
  const [projectMissing, setProjectMissing] = useState(false);
  const [feedbackGenerating, setFeedbackGenerating] = useState(false);
  const lastRouteSaveProjectRootRef = useRef<string | null | undefined>(undefined);
  const githubStatusProjectRootRef = useRef<string | null>(null);
  const githubConnectionStateRef = useRef<string | null>(null);
  const githubReconnectContextRef = useRef({
    currentProjectRoot,
    isRemoteProject,
    pathname: location.pathname,
  });
  githubReconnectContextRef.current = {
    currentProjectRoot,
    isRemoteProject,
    pathname: location.pathname,
  };
  const isOnboardingRoute = location.pathname === "/onboarding";
  const isPersonalChatsRoute =
    location.pathname === "/chats" || location.pathname.startsWith("/chats/");
  const isAttentionRoute =
    location.pathname === "/attention" || location.pathname.startsWith("/attention/");
  const isAccountRoute =
    location.pathname === "/account" || location.pathname.startsWith("/account/");
  const isWebHubRoute = isWebClientMode() && location.pathname === "/hub";
  const isLanesRoute = location.pathname.startsWith("/lanes");
  const isWorkRoute = location.pathname === "/work" || location.pathname.startsWith("/work/");
  const productAnalyticsScreen = productAnalyticsScreenForPathname(location.pathname);
  const productAnalytics = useProductAnalyticsLifecycle({
    projectRoot: currentProjectRoot,
    screen: productAnalyticsScreen,
  });
  const isWorkAdjacentRoute = isWorkRoute || isLanesRoute;
  const isLanesRouteRef = useRef(isLanesRoute);
  useAppWideSessionAttention();
  useAttentionSync(isAttentionRoute);

  useEffect(() => {
    isLanesRouteRef.current = isLanesRoute;
  }, [isLanesRoute]);

  useEffect(() => {
    // Any /chats visit opens the machine-level Chats tab — from the projectless
    // shell AND from a project's sidebar link — so the top bar always carries a
    // selectable affordance for the surface being shown.
    if (isPersonalChatsRoute) setPersonalChatsTabOpen(true);
  }, [isPersonalChatsRoute, setPersonalChatsTabOpen]);

  useEffect(() => {
    logRendererDebugEvent("renderer.route_change", {
      pathname: location.pathname,
      projectRoot: currentProjectRoot,
      showWelcome,
    });
    console.info(
      `renderer.route_change ${JSON.stringify({
        pathname: location.pathname,
        projectRoot: currentProjectRoot,
        showWelcome,
      })}`,
    );
  }, [currentProjectRoot, location.pathname, showWelcome]);

  useEffect(() => {
    disposeTerminalRuntimesForProjectChange(project?.rootPath ?? null, projectRevision);
  }, [project?.rootPath, projectRevision]);

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.onEvent) return;
    let cancelled = false;
    const observeConnection = (snapshot: { client?: { state?: string | null } } | null | undefined) => {
      const nextState = snapshot?.client?.state ?? null;
      const previousState = githubConnectionStateRef.current;
      githubConnectionStateRef.current = nextState;
      if (!cancelled && nextState === "connected" && previousState !== "connected") {
        setGithubConnectionGeneration((generation) => generation + 1);
      }
    };
    if (typeof syncApi.getStatus === "function") {
      void syncApi.getStatus().then(observeConnection).catch(() => {});
    }
    const dispose = syncApi.onEvent((event) => {
      if (event.type === "sync-status") observeConnection(event.snapshot);
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // Relay leg of THIS machine's sync route health, for the relay-offline banner.
  // Push-only: one seed read plus the existing `sync-status` broadcast, which the
  // sync host already emits whenever route health changes. No polling — the
  // banner host arms a single timer for the outage grace window instead.
  const [syncRelayHealth, setSyncRelayHealth] = useState<SyncRouteHealth["relay"] | null>(null);
  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi) return;
    let cancelled = false;
    const apply = (snapshot: SyncRoleSnapshot | null | undefined) => {
      if (cancelled) return;
      const next = snapshot?.routeHealth?.relay ?? null;
      // getStatus rebuilds routeHealth.relay as a fresh object every call, so
      // committing it unconditionally would re-render the whole shell on every
      // peer/status push. Only the fields the banner reads matter here.
      setSyncRelayHealth((prev) => (
        prev?.enabled === next?.enabled
        && prev?.relayControlConnected === next?.relayControlConnected
        && prev?.relayControlSuppressed === next?.relayControlSuppressed
        && prev?.relayControlFailingSinceMs === next?.relayControlFailingSinceMs
        && prev?.relayControlSuppressedReason === next?.relayControlSuppressedReason
        && prev?.skipReason === next?.skipReason
        && prev?.lastControlError === next?.lastControlError
          ? prev
          : next
      ));
    };
    // Always read the LOCAL snapshot: relay control belongs to the physical
    // machine this window runs on, not to whichever runtime a remote-bound
    // project routes to.
    const readLocal =
      typeof syncApi.getLocalStatus === "function"
        ? syncApi.getLocalStatus
        : syncApi.getStatus;
    const refresh = () => {
      if (typeof readLocal !== "function") return;
      void readLocal.call(syncApi).then(apply).catch(() => {});
    };
    refresh();
    // The event is an INVALIDATION, not the payload. On a remote-bound project
    // the preload subscription fans out the remote runtime's snapshot too, and
    // applying that directly would let a remote outage raise a warning about
    // this machine — or let remote health mask this machine's own outage.
    // Same pattern useSyncConnections already uses.
    const dispose = syncApi.onEvent?.((event) => {
      if (event.type === "sync-status") refresh();
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.onEvent || !project?.rootPath || !isLanesRoute) {
      return;
    }
    let cancelled = false;
    let refreshTimer: number | null = null;

    const scheduleLaneRefresh = () => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (cancelled) return;
        void refreshLanes({ includeStatus: false }).catch(() => {});
      }, 200);
    };

    const dispose = syncApi.onEvent((event) => {
      if (event.type !== "sync-status") return;
      scheduleLaneRefresh();
    });

    return () => {
      cancelled = true;
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      dispose();
    };
  }, [isLanesRoute, project?.rootPath, refreshLanes]);

  useEffect(() => {
    let cancelled = false;
    let laneRefreshTimer: number | null = null;
    let providerRefreshTimer: number | null = null;

    const clearScheduledRefreshes = () => {
      if (laneRefreshTimer != null) {
        window.clearTimeout(laneRefreshTimer);
        laneRefreshTimer = null;
      }
      if (providerRefreshTimer != null) {
        window.clearTimeout(providerRefreshTimer);
        providerRefreshTimer = null;
      }
    };

    const applyProjectState = (nextProject: ProjectInfo | null, nextBinding?: OpenProjectBinding | null) => {
      const remoteBinding = nextBinding?.kind === "remote" ? nextBinding : null;
      const nextProjectRoot = remoteBinding?.rootPath ?? nextProject?.rootPath ?? null;
      const currentProjectRoot =
        useAppStore.getState().project?.rootPath ?? null;
      const currentShowWelcome = useAppStore.getState().showWelcome;
      const currentIsNewTabOpen = useAppStore.getState().isNewTabOpen;
      const hasStoredProject = Boolean(nextProject || remoteBinding);
      const projectChanged = nextProjectRoot !== currentProjectRoot;
      const welcomeChanged = currentShowWelcome === hasStoredProject;

      if (remoteBinding) {
        setProjectBinding(remoteBinding);
        setProject({
          rootPath: remoteBinding.rootPath,
          displayName: remoteBinding.displayName,
          baseRef: "main",
        });
        setShowWelcome(false);
        clearScheduledRefreshes();
        void refreshLanes({ includeStatus: false });
        return;
      }

      if (currentIsNewTabOpen && nextProject && !projectChanged) {
        setProject(nextProject);
        setProjectBinding(nextBinding ?? null);
        // Leave showWelcome alone — the user explicitly opened the new-tab
        // UI; a stale project-changed event for the same root must not kick
        // them back to the project content.
        return;
      }

      if (nextProject) {
        setProject(nextProject);
        setProjectBinding(nextBinding ?? null);
        setShowWelcome(false);
      } else {
        setProject(null);
        setProjectBinding(null);
        setShowWelcome(true);
      }

      if (!projectChanged && !welcomeChanged) {
        return;
      }

      clearScheduledRefreshes();

      if (hasStoredProject) {
        void Promise.allSettled([
          refreshLanes({ includeStatus: false }),
          refreshKeybindings(),
        ]);
        laneRefreshTimer = window.setTimeout(() => {
          laneRefreshTimer = null;
          if (cancelled) return;
          const includeDecoratedLaneSnapshots = isLanesRouteRef.current;
          void refreshLanes({
            includeStatus: includeDecoratedLaneSnapshots,
            includeConflictStatus: includeDecoratedLaneSnapshots,
            includeRebaseSuggestions: includeDecoratedLaneSnapshots,
            includeAutoRebaseStatus: includeDecoratedLaneSnapshots,
          });
        }, 1_200);
        providerRefreshTimer = window.setTimeout(() => {
          providerRefreshTimer = null;
          if (cancelled) return;
          void refreshProviderMode();
        }, 1_800);
      }
    };

    const initializeProjectState = async () => {
      setProjectHydrated(false);
      try {
        const session = await window.ade.app.getWindowSession();
        if (cancelled) return;
        applyProjectState(session.project, session.binding);
      } catch {
        if (cancelled) return;
        setProject(null);
        setProjectMissing(false);
        setShowWelcome(true);
        clearScheduledRefreshes();
      } finally {
        if (!cancelled) setProjectHydrated(true);
      }
    };

    const disposeProjectChanged = window.ade.app.onProjectChanged((nextProject) => {
      const state = useAppStore.getState();
      const nextRoot = nextProject?.rootPath ?? null;
      const currentRoot = state.project?.rootPath ?? null;
      const expectedShowWelcome = !nextProject;
      const alreadyApplied =
        state.projectHydrated &&
        currentRoot === nextRoot &&
        state.showWelcome === expectedShowWelcome;

      if (state.projectTransition) return;

      if (alreadyApplied) {
        setProject(nextProject);
        setShowWelcome(expectedShowWelcome);
        return;
      }

      setProjectHydrated(false);
      applyProjectState(nextProject);
      setProjectHydrated(true);
    });
    const disposeProjectBindingChanged = window.ade.app.onProjectBindingChanged((binding) => {
      const state = useAppStore.getState();
      if (state.projectTransition) {
        setProjectBinding(binding);
        return;
      }
      setProjectHydrated(false);
      applyProjectState(binding?.kind === "local" ? state.project : null, binding);
      setProjectHydrated(true);
    });

    void initializeProjectState();
    return () => {
      cancelled = true;
      clearScheduledRefreshes();
      disposeProjectChanged();
      disposeProjectBindingChanged();
    };
  }, [
    setProject,
    setProjectBinding,
    setProjectHydrated,
    refreshLanes,
    refreshProviderMode,
    refreshKeybindings,
    setShowWelcome,
  ]);

  useEffect(() => {
    const projectRoot = project?.rootPath ?? null;
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

    const sessionActivityMs = (session: TerminalSessionSummary): number => {
      const activityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Number.NaN;
      return Number.isFinite(activityMs) ? activityMs : Date.parse(session.startedAt);
    };

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
  }, [isRemoteProject, isWorkAdjacentRoute, project?.rootPath, showWelcome]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.rootPath || showWelcome || isRemoteProject) {
      setOnboardingStatus(null);
      setOnboardingStatusLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setOnboardingStatusLoading(true);
    void window.ade.onboarding
      .getStatus()
      .then((status) => {
        if (cancelled) return;
        setOnboardingStatus(status);
      })
      .catch(() => {
        if (cancelled) return;
        setOnboardingStatus(null);
      })
      .finally(() => {
        if (cancelled) return;
        setOnboardingStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isRemoteProject, project?.rootPath, showWelcome]);

  useEffect(() => {
    const handler = (event: Event) => {
      if (isRemoteProject) return;
      const detail = (event as CustomEvent<OnboardingStatus>).detail;
      if (!detail) return;
      setOnboardingStatus(detail);
      setOnboardingStatusLoading(false);
    };
    window.addEventListener(ONBOARDING_STATUS_UPDATED_EVENT, handler);
    return () =>
      window.removeEventListener(ONBOARDING_STATUS_UPDATED_EVENT, handler);
  }, [isRemoteProject]);

  // Track visited tabs — mark after a short delay so stagger animation can play on first visit
  useEffect(() => {
    const timer = setTimeout(() => {
      visitedTabsRef.current.add(location.pathname);
    }, 500);
    return () => clearTimeout(timer);
  }, [location.pathname]);

  // Listen for projectMissing broadcast from main process.
  useEffect(() => {
    const unsub = window.ade.project.onMissing((payload) => {
      const missingPath =
        typeof payload?.rootPath === "string" ? payload.rootPath.trim() : "";
      if (missingPath && missingPath === project?.rootPath) {
        setProjectMissing(true);
      }
    });
    return unsub;
  }, [project?.rootPath]);

  // Reset projectMissing when the project changes (e.g. after relocate).
  useEffect(() => {
    setProjectMissing(false);
  }, [project?.rootPath]);

  useEffect(() => {
    const projectRoot = currentProjectRoot;
    if (!projectRoot || showWelcome) return;

    if (lastRouteSaveProjectRootRef.current !== projectRoot) {
      lastRouteSaveProjectRootRef.current = projectRoot;
      return;
    }

    const route = serializeLocationRoute(location);
    if (route) writeStoredProjectRoute(projectRoot, route);
  }, [location, currentProjectRoot, showWelcome]);

  useEffect(() => {
    let cancelled = false;
    if (!shouldLoadShellAiStatus(location.pathname, isRemoteProject)) {
      setAiStatus(null);
      setAiStatusLoaded(false);
      return;
    }
    const aiStatusProjectRoot = currentProjectRoot ?? null;
    const cachedStatus = peekAiStatusCached(aiStatusProjectRoot);
    setAiStatus(cachedStatus);
    setAiStatusLoaded(Boolean(cachedStatus));

    let refreshSerial = 0;
    let lastChatEventRefreshAt = 0;
    let lastKnownHasProvider = hasConfiguredAiProvider(cachedStatus);
    const chatEventSubscriptionStartedAt = Date.now();
    const refreshAiStatus = (options: { force?: boolean } = {}) => {
      if (document.visibilityState !== "visible") return;
      const serial = ++refreshSerial;
      void getAiStatusCached({ projectRoot: aiStatusProjectRoot, force: options.force === true }).then((status) => {
        if (cancelled) return;
        if (serial !== refreshSerial) return;
        lastKnownHasProvider = hasConfiguredAiProvider(status);
        setAiStatus(status);
      }).catch(() => {
        if (cancelled) return;
        if (serial !== refreshSerial) return;
        lastKnownHasProvider = false;
        setAiStatus(null);
      }).finally(() => {
        if (cancelled) return;
        if (serial !== refreshSerial) return;
        setAiStatusLoaded(true);
      });
    };

    const aiTimer = window.setTimeout(
      refreshAiStatus,
      cachedStatus ? 0 : AI_STATUS_STARTUP_DELAY_MS,
    );
    const onFocus = () => refreshAiStatus();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshAiStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeChatEvents = window.ade.agentChat.onEvent((envelope) => {
      if (isRemoteProject) {
        const eventTimestamp = Date.parse(envelope.timestamp);
        if (Number.isFinite(eventTimestamp) && eventTimestamp < chatEventSubscriptionStartedAt - 10_000) {
          return;
        }
      }
      if (lastKnownHasProvider && !shouldRefreshAiStatusForChatEvent(envelope)) return;
      const now = Date.now();
      if (now - lastChatEventRefreshAt < AI_STATUS_CHAT_EVENT_REFRESH_MIN_GAP_MS) return;
      lastChatEventRefreshAt = now;
      refreshAiStatus({ force: true });
    });
    const onAiStatusCacheInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<AiStatusCacheInvalidatedEventDetail>).detail;
      if (detail && !detail.allProjects && detail.projectRoot !== aiStatusProjectRoot) return;
      refreshAiStatus({ force: true });
    };
    window.addEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, onAiStatusCacheInvalidated);
    return () => {
      cancelled = true;
      window.clearTimeout(aiTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, onAiStatusCacheInvalidated);
      unsubscribeChatEvents();
    };
  }, [currentProjectRoot, isRemoteProject, location.pathname]);

  useEffect(() => {
    let cancelled = false;
    if (!currentProjectRoot || !shouldLoadShellGithubStatus(location.pathname, isRemoteProject)) {
      githubStatusProjectRootRef.current = null;
      setGithubStatus(null);
      return;
    }
    if (githubStatusProjectRootRef.current !== currentProjectRoot) {
      githubStatusProjectRootRef.current = currentProjectRoot;
      setGithubStatus(null);
    }
    const delayMs = currentProjectRoot && hasRecentBannerDismissal(`github-cli:${currentProjectRoot}`)
      ? GITHUB_STATUS_DISMISSED_BANNER_DELAY_MS
      : GITHUB_STATUS_STARTUP_DELAY_MS;
    const githubTimer = window.setTimeout(() => {
      void window.ade.github.getStatus({
        forceRefresh: false,
      }).then((status) => {
        if (cancelled) return;
        setGithubStatus(status);
      }).catch(() => {
        if (cancelled) return;
        setGithubStatus(null);
      });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(githubTimer);
    };
  }, [
    currentProjectRoot,
    isRemoteProject,
    location.pathname,
  ]);

  useEffect(() => {
    if (githubConnectionGeneration <= 0) return;
    let cancelled = false;
    const context = githubReconnectContextRef.current;
    if (
      !context.currentProjectRoot
      || !shouldLoadShellGithubStatus(context.pathname, context.isRemoteProject)
    ) {
      return;
    }
    const isCurrentContext = () => {
      const current = githubReconnectContextRef.current;
      return (
        !cancelled
        && current.currentProjectRoot === context.currentProjectRoot
        && current.pathname === context.pathname
        && current.isRemoteProject === context.isRemoteProject
      );
    };
    const githubTimer = window.setTimeout(() => {
      if (!isCurrentContext()) return;
      void window.ade.github.getStatus({ forceRefresh: true }).then((status) => {
        if (!isCurrentContext()) return;
        setGithubStatus(status);
      }).catch(() => {
        if (isCurrentContext()) setGithubStatus(null);
      });
    }, GITHUB_STATUS_RECONNECT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(githubTimer);
    };
  }, [githubConnectionGeneration]);

  // Refresh the GitHub banner the moment Settings saves/clears a token, so the
  // shell does not lag behind the Settings UI (the original "banner stays up
  // even though Settings says CONNECTED" bug).
  useEffect(() => {
    return (
      window.ade.github?.onStatusChanged?.((status) => {
        if (!currentProjectRoot || !shouldLoadShellGithubStatus(location.pathname, isRemoteProject)) {
          return;
        }
        setGithubStatus(status);
      }) ?? (() => {})
    );
  }, [currentProjectRoot, isRemoteProject, location.pathname]);

  useEffect(() => {
    if (!window.ade.feedback?.onUpdate) return;
    const dispose = window.ade.feedback.onUpdate((event) => {
      const s = event.submission?.status;
      setFeedbackGenerating(s === "generating" || s === "posting");
    });
    return dispose;
  }, []);

  useEffect(() => {
    if (!project?.rootPath || showWelcome) return;
    if (isRemoteProject) return;
    if (isOnboardingRoute) return;
    if (onboardingStatusLoading) return;
    if (
      !onboardingStatus?.freshProject ||
      onboardingStatus.completedAt ||
      onboardingStatus.dismissedAt
    )
      return;
    navigate("/onboarding", { replace: true });
  }, [
    isOnboardingRoute,
    navigate,
    onboardingStatus?.completedAt,
    onboardingStatus?.dismissedAt,
    onboardingStatus?.freshProject,
    onboardingStatusLoading,
    isRemoteProject,
    project?.rootPath,
    showWelcome,
  ]);

  useEffect(() => {
    setAiFailure(null);
    setAiMockProvider(null);
  }, [providerMode]);

  const hasAnyAiProvider = useMemo(() => {
    return hasConfiguredAiProvider(aiStatus);
  }, [aiStatus]);

  const commandPaletteBinding = useMemo(
    () => getEffectiveBinding(keybindings, "commandPalette.open", "Mod+K"),
    [keybindings],
  );

  // Initialize zoom from localStorage on mount (uses Electron webFrame)
  useEffect(() => {
    try {
      const clamped = getStoredZoomLevel();
      const zoomLevel = displayZoomToLevel(clamped);
      window.ade.zoom.setLevel(zoomLevel);
      applyShellHeaderInset(clamped);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!eventMatchesBinding(e, commandPaletteBinding)) return;
      e.preventDefault();
      setCommandOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteBinding]);

  useEffect(() => {
    const newId = (): string =>
      globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;

    const dismiss = (id: string) => {
      setPrToasts((prev) => prev.filter((toast) => toast.id !== id));
      const timer = toastTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    };

    const dismissAutoLink = (id: string) => {
      setAutoLinkToasts((prev) => prev.filter((toast) => toast.id !== id));
      const timer = autoLinkToastTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      autoLinkToastTimersRef.current.delete(id);
    };

    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type === "pr-sessions-auto-settled") {
        showToast({
          title: `PR #${event.prNumber} merged · ${event.settledCount} ${
            event.settledCount === 1 ? "session" : "sessions"
          } settled`,
          tone: "success",
        });
        return;
      }
      if (event.type === "pr-auto-linked") {
        const id = newId();
        setAutoLinkToasts((prev) => [{ id, event }, ...prev].slice(0, 4));
        const timer = window.setTimeout(() => dismissAutoLink(id), 18_000);
        autoLinkToastTimersRef.current.set(id, timer);
        return;
      }
      if (event.type !== "pr-notification") return;
      const id = newId();
      setPrToasts((prev) => [{ id, event }, ...prev].slice(0, 4));
      const timer = window.setTimeout(() => dismiss(id), 18_000);
      toastTimersRef.current.set(id, timer);
    });

    return () => {
      unsub();
      for (const timer of toastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      toastTimersRef.current.clear();
      for (const timer of autoLinkToastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      autoLinkToastTimersRef.current.clear();
    };
  }, []);

  const tintClass = useMemo(() => {
    const tintMap: Record<string, string> = {
      "/attention": "tab-tint-work",
      "/lanes": "tab-tint-lanes",
      "/files": "tab-tint-files",
      "/work": "tab-tint-work",
      "/graph": "tab-tint-graph",
      "/prs": "tab-tint-prs",
      "/review": "tab-tint-review",
      "/history": "tab-tint-history",
      "/automations": "tab-tint-automations",
      "/cto": "tab-tint-cto",
      "/settings": "tab-tint-settings",
      "/chats": "tab-tint-work",
    };
    return tintMap[primaryTabPath(location.pathname)] ?? "";
  }, [location.pathname]);

  const shouldHoldProjectRouteForOnboarding =
    Boolean(project?.rootPath) &&
    !showWelcome &&
    location.pathname === "/work" &&
    onboardingStatusLoading;
  const hideSidebar = isOnboardingRoute || isWebHubRoute || shouldHoldProjectRouteForOnboarding;
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
    if (currentProjectRoot) snoozeStaleCliNotice(currentProjectRoot);
    staleCliNoticeActiveRef.current = false;
    setStaleCliNotice(null);
  }, [currentProjectRoot]);
  return (
    <div
      className={cn(
        "text-fg overflow-hidden flex flex-col bg-bg",
        // In the browser web client the App is nested under the shell's top
        // strip, so fill that container (h-full) instead of the whole viewport
        // (h-screen), which would overflow beneath the strip.
        isWebClientMode() ? "h-full w-full" : "h-screen w-screen",
      )}
    >
      <div className="shrink-0 relative z-20">
        <TopBar
          personalChatsRouteActive={isPersonalChatsRoute}
          accountRouteActive={isAccountRoute}
          hubRouteActive={isWebHubRoute}
          onNavigate={(path, opts) => navigate(path, opts)}
        />
      </div>

      <ProjectTransitionErrorAlert />

      <AutoUpdateBanner />

      <BrainRecoveryNotice />

      {productAnalytics.consentRequired ? (
        <WebAnalyticsConsentBanner
          onAllow={productAnalytics.allow}
          onDecline={productAnalytics.decline}
        />
      ) : null}

      {!hideSidebar && projectMissing && project?.rootPath ? (
        <div className="shrink-0 mx-2 mt-1 rounded bg-red-500/8 px-3 py-1.5 text-[11px] font-mono text-red-800">
          <span className="font-semibold">Project directory not found</span> —
          it may have been moved or deleted.
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                void openRepo()
                  .then((nextProject) => {
                    if (nextProject) setProjectMissing(false);
                  })
                  .catch(() => {});
              }}
            >
              Relocate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                const rootPath = project?.rootPath;
                if (!rootPath) return;
                window.ade.project
                  .forgetRecent(rootPath)
                  .then(async (remaining) => {
                    const next = remaining.find((rp) => rp.exists);
                    if (next) {
                      await switchProjectToPath(next.rootPath);
                    } else {
                      await closeProject();
                    }
                    setProjectMissing(false);
                  })
                  .catch(() => {});
              }}
            >
              Remove
            </Button>
            <button
              type="button"
              className="text-red-900/70 hover:text-red-900"
              onClick={() => setProjectMissing(false)}
              title="Dismiss"
            >
              ×
            </button>
          </span>
        </div>
      ) : null}

      {!hideSidebar && !showWelcome && project?.rootPath ? (
        <IntegrationBannerHost
          currentProjectRoot={currentProjectRoot}
          githubStatus={githubStatus}
          hasAnyAiProvider={hasAnyAiProvider}
          aiStatusLoaded={aiStatusLoaded && aiStatus !== null}
          providerMode={providerMode}
          aiMockProvider={Boolean(aiMockProvider)}
          relayHealth={syncRelayHealth}
          navigate={navigate}
        />
      ) : null}

      {!hideSidebar && providerMode === "subscription" && aiFailure ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-red-500/6 px-3 py-1.5 text-[11px] font-mono text-red-800">
          <span className="font-semibold">Last AI job failed:</span>{" "}
          {aiFailure.jobId ? `job ${shortId(aiFailure.jobId)} · ` : ""}
          {aiFailure.error}
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={!aiFailure.laneId}
              onClick={() => {
                const laneId = aiFailure.laneId;
                if (!laneId) return;
                selectLane(laneId);
                setLaneInspectorTab(laneId, "context");
                window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single&inspectorTab=context`;
              }}
              title="Open lane context"
            >
              Details
            </Button>
            <button
              type="button"
              className="text-red-900/70 hover:text-red-900"
              onClick={() => setAiFailure(null)}
              title="Dismiss"
            >
              ×
            </button>
          </span>
        </div>
      ) : null}

      {!hideSidebar && feedbackGenerating ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-violet-500/6 px-3 py-1.5 text-[11px] font-mono text-violet-800 animate-pulse">
          Generating feedback report...
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        {hideSidebar ? null : (
          // Graph page uses `fixed` viewport layers up to z-[96]; keep the tab rail above them.
          <aside className="ade-sidebar-clip shrink-0 z-[100] border-r" data-tour="app.sidebar">
            <div className="ade-sidebar flex flex-col py-2 h-full">
              <TabNav githubStatus={githubStatus} />
            </div>
          </aside>
        )}

        <main className={cn("relative flex flex-col min-h-0 min-w-0 flex-1", tintClass)}>
          <TabBackground />
          <div
            className="relative z-[1] min-h-0 flex-1 w-full"
            data-tab-revisit={!isFirstVisit || undefined}
          >
            {shouldHoldProjectRouteForOnboarding ? (
              <div className="flex h-full w-full items-center justify-center">
                <div className="text-xs font-mono text-muted-fg/70">
                  Opening project setup...
                </div>
              </div>
            ) : (
              children
            )}
          </div>
          {staleCliNotice || prToasts.length > 0 || autoLinkToasts.length > 0 || storeToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-2 right-2 z-[95] flex w-[min(380px,calc(100vw-20px))] flex-col gap-1.5">
              {staleCliNotice ? (
                <div className="pointer-events-auto overflow-hidden rounded-xl border border-amber-500/25 bg-card/95 px-3 py-3 shadow-float backdrop-blur">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/12">
                      <WarningCircle size={16} weight="fill" className="text-amber-300" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-300">
                            Idle sessions
                          </span>
                          <div className="mt-2 text-[13px] font-semibold leading-tight text-fg">
                            {staleCliNotice.count} CLI or shell session{staleCliNotice.count === 1 ? "" : "s"} sitting idle
                          </div>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:bg-fg/[0.05] hover:text-fg"
                          onClick={dismissStaleCliNotice}
                          aria-label="Dismiss idle sessions notice"
                          title="Dismiss for an hour"
                        >
                          ×
                        </button>
                      </div>
                      <div className="mt-2 text-[12px] leading-relaxed text-muted-fg">
                        No activity for about {staleCliNoticeAgeHours} hours. Close anything you're done with to free up memory.
                      </div>
                      {staleCliNotice.lanes.length > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {staleCliNotice.lanes.slice(0, 4).map((noticeLane) => {
                            const laneColor =
                              lanes.find((lane) => lane.id === noticeLane.laneId)?.color ?? null;
                            return (
                              <span
                                key={noticeLane.laneId}
                                className="inline-flex max-w-full items-center gap-1 rounded-full border border-fg/10 bg-fg/[0.04] px-1.5 py-0.5 text-[10px] text-muted-fg"
                                title={`${noticeLane.count} idle session${noticeLane.count === 1 ? "" : "s"} in ${noticeLane.laneName}`}
                              >
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: laneColor ?? "currentColor" }}
                                />
                                <span className="max-w-[120px] truncate">{noticeLane.laneName}</span>
                                {noticeLane.count > 1 ? (
                                  <span className="shrink-0 tabular-nums text-muted-fg/70">×{noticeLane.count}</span>
                                ) : null}
                              </span>
                            );
                          })}
                          {staleCliNotice.lanes.length > 4 ? (
                            <span className="text-[10px] text-muted-fg/70">
                              +{staleCliNotice.lanes.length - 4} more
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-amber-300 px-3 text-[11px] font-medium text-[#0F0D14] transition-colors hover:brightness-110"
                          onClick={() => {
                            if (currentProjectRoot) {
                              // AppShell renders above AppStoreProvider, so this
                              // must go through the store that owns the project —
                              // writing to the root store would leave the mounted
                              // Work surface showing its own older view state.
                              const workStore = workViewStoreForProject(currentProjectRoot);
                              // Reset the lane filter too so stale sessions across
                              // *all* lanes are visible, not just the active one.
                              workStore.getState().setWorkViewState(currentProjectRoot, (current) => ({
                                ...current,
                                laneFilter: "all",
                                sessionListOrganization: "all-lanes-by-status",
                                workCollapsedSectionIds: current.workCollapsedSectionIds
                                  .filter((sectionId) => sectionId !== "status:running"),
                              }));
                            }
                            navigate("/work");
                            dismissStaleCliNotice();
                          }}
                        >
                          View processes
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              {prToasts.map((toast) => {
                const toastLane = lanes.find((lane) => lane.id === toast.event.laneId) ?? null;
                const laneName = toastLane?.name ?? toast.event.laneId;
                const laneColor = toastLane?.color ?? null;
                const tone = getPrToastTone(toast.event.kind);
                const toneClasses = getPrToastToneClasses(tone);
                const Icon = getPrToastIcon(toast.event.kind);
                const headline = getPrToastHeadline(toast.event);
                const summary = getPrToastSummary(toast.event);
                const meta = getPrToastMeta(toast.event, laneName);
                return (
                  <div
                    key={toast.id}
                    className={cn(
                      "pointer-events-auto overflow-hidden rounded-xl border px-3 py-3 shadow-float backdrop-blur",
                      toneClasses.panel,
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          toneClasses.iconWrap,
                        )}
                      >
                        <Icon
                          size={16}
                          weight="fill"
                          className={toneClasses.iconClass}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium",
                                  toneClasses.badge,
                                )}
                              >
                                {toast.event.title}
                              </span>
                              <span className="text-[11px] font-medium text-muted-fg">
                                #{toast.event.prNumber}
                              </span>
                            </div>
                            <div className="mt-2 line-clamp-2 text-[13px] font-semibold leading-tight text-fg">
                              {headline}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:bg-fg/[0.05] hover:text-fg"
                            onClick={() => dismissPrToast(toast.id)}
                            aria-label="Dismiss notification"
                            title="Dismiss"
                          >
                            ×
                          </button>
                        </div>
                        {meta.length > 0 ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {meta.map((item, index) => {
                              const isLane = laneName != null && item === laneName;
                              return (
                                <span
                                  key={`${toast.id}-meta-${index}`}
                                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/50 bg-black/10 px-2 py-1 text-[10px] text-muted-fg"
                                  style={isLane && laneColor ? { color: laneColor } : undefined}
                                >
                                  {isLane && laneColor ? (
                                    <LaneAccentDot lane={{ color: laneColor }} size={7} />
                                  ) : item.includes("/") ? (
                                    <GitBranch size={10} />
                                  ) : item.includes("#") ||
                                    (toast.event.repoOwner &&
                                      item.includes(toast.event.repoOwner)) ? (
                                    <GithubLogo size={10} />
                                  ) : (
                                    <GitPullRequest size={10} />
                                  )}
                                  <span className="truncate">{item}</span>
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                        <div className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-muted-fg">
                          {summary}
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                          <button
                            type="button"
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-transparent px-3 text-[11px] font-medium text-fg/85 transition-colors hover:border-fg/20 hover:bg-fg/[0.04] hover:text-fg"
                            onClick={() => {
                              let detailTab: PrDetailRouteTab | null = null;
                              if (toast.event.kind === "checks_failing") {
                                detailTab = "checks";
                              } else if (
                                toast.event.kind === "changes_requested" ||
                                toast.event.kind === "review_requested"
                              ) {
                                detailTab = "overview";
                              }
                              const search = buildPrsRouteSearch({
                                activeTab: "normal",
                                selectedPrId: toast.event.prId,
                                selectedRebaseItemId: null,
                                detailTab,
                              });
                              navigate(`/prs${search}`);
                              dismissPrToast(toast.id);
                            }}
                          >
                            <GitPullRequest size={12} />
                            Open in ADE
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11px] font-medium text-[#0F0D14] transition-colors hover:brightness-110",
                              tone === "danger"
                                ? "bg-red-300"
                                : tone === "warning"
                                  ? "bg-amber-300"
                                  : tone === "success"
                                    ? "bg-emerald-300"
                                    : "bg-[#A78BFA]",
                            )}
                            onClick={() => {
                              void window.ade.prs
                                .openInGitHub(toast.event.prId)
                                .then(
                                  () => dismissPrToast(toast.id),
                                  () => {
                                    /* keep toast visible on failure */
                                  },
                                );
                            }}
                          >
                            <ArrowSquareOut size={12} />
                            Open on GitHub
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {autoLinkToasts.map((toast) => {
                const toastLane =
                  lanes.find((lane) => lane.id === toast.event.laneId) ?? null;
                const laneName = toastLane?.name ?? toast.event.laneName;
                const laneColor = toastLane?.color ?? null;
                return (
                  <div
                    key={toast.id}
                    className="pointer-events-auto overflow-hidden rounded-xl border border-[#A78BFA]/25 bg-card/95 px-3 py-3 shadow-float backdrop-blur"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#A78BFA]/15">
                        <LinkSimple
                          size={16}
                          weight="bold"
                          className="text-[#A78BFA]"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold leading-tight text-fg">
                              Auto-linked PR #{toast.event.prNumber}
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-fg">
                              <span className="truncate">to</span>
                              {laneColor ? (
                                <LaneAccentDot lane={{ color: laneColor }} size={7} />
                              ) : null}
                              <span
                                className="truncate font-medium"
                                style={laneColor ? { color: laneColor } : undefined}
                              >
                                {laneName}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:bg-fg/[0.05] hover:text-fg"
                            onClick={() => dismissAutoLinkToast(toast.id)}
                            aria-label="Dismiss notification"
                            title="Dismiss"
                          >
                            ×
                          </button>
                        </div>
                        <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted-fg">
                          {toast.event.prTitle}
                        </div>
                        {toast.undoFailed ? (
                          <div className="mt-2 text-[11px] font-medium text-red-400">
                            Couldn't undo the link. Try again.
                          </div>
                        ) : null}
                        <div className="mt-3 flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={toast.undoing}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-transparent px-3 text-[11px] font-medium text-fg/85 transition-colors hover:border-fg/20 hover:bg-fg/[0.04] hover:text-fg disabled:opacity-60"
                            onClick={() => {
                              if (!toast.event.prId) {
                                dismissAutoLinkToast(toast.id);
                                return;
                              }
                              setAutoLinkToasts((prev) =>
                                prev.map((t) =>
                                  t.id === toast.id
                                    ? { ...t, undoing: true, undoFailed: false }
                                    : t,
                                ),
                              );
                              void window.ade.prs
                                .delete({
                                  prId: toast.event.prId,
                                  closeOnGitHub: false,
                                  archiveLane: false,
                                })
                                .then(
                                  () => dismissAutoLinkToast(toast.id),
                                  (error) => {
                                    console.error(
                                      `Failed to undo auto-link for PR #${toast.event.prNumber} (${toast.event.prId})`,
                                      error,
                                    );
                                    setAutoLinkToasts((prev) =>
                                      prev.map((t) =>
                                        t.id === toast.id
                                          ? { ...t, undoing: false, undoFailed: true }
                                          : t,
                                      ),
                                    );
                                  },
                                );
                            }}
                          >
                            {toast.undoing ? (
                              <CircleNotch size={12} className="animate-spin" />
                            ) : (
                              <ArrowCounterClockwise size={12} />
                            )}
                            {toast.undoFailed ? "Retry undo" : "Undo"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <ToastStack />
            </div>
          ) : null}
        </main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <WorktreeOpenDialog />
    </div>
  );
}
