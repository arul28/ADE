import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AccountSignedOutBanner } from "../account/AccountSignedOutBanner";
import { CommandPalette } from "./CommandPalette";
import { IntegrationBanners } from "./IntegrationBanners";
import { isCssZoomedBrowserSurface } from "../../lib/webClientMode";
import { TopBar } from "./TopBar";
import { useProjectSidebarShortcuts } from "./projectSidebar/useProjectSidebarShortcuts";
import { ProjectTransitionErrorAlert } from "./ProjectTransitionErrorAlert";
import { TabBackground } from "../ui/TabBackground";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { APP_BANNER_PRIORITY, AppBannerHost, useAppBanner } from "../ui/notice";
import type {
  AiSettingsStatus,
  GitHubStatus,
  ProjectInfo,
  OpenProjectBinding,
  SyncRoleSnapshot,
  SyncRouteHealth,
} from "../../../shared/types";
import {
  eventMatchesBinding,
  getEffectiveBinding,
} from "../../lib/keybindings";
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
import { hasRecentBannerDismissal } from "../../lib/bannerDismiss";
import {
  getStoredZoomLevel,
  displayZoomToLevel,
  applyShellHeaderInset,
} from "../../lib/zoom";
import { syncWindowsTitleBarOverlay } from "../../lib/windowControlsOverlay";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { readLocalSyncStatus } from "../../lib/localSyncStatusReader";
import { cn } from "../ui/cn";
import { disposeTerminalRuntimesForProjectChange } from "../terminals/TerminalView";
import { ToastViewport } from "./toast/ToastViewport";
import { ChatLaunchesSlideOut, useChatLaunchSlideOutVisible } from "./ChatLaunchesSlideOut";
import { useChatLaunchSync } from "../../state/useChatLaunchSync";
import { AutoUpdateBanner } from "./AutoUpdateBanner";
import { BrainRecoveryNotice } from "./BrainRecoveryNotice";
import { FolderSimpleDashed } from "@phosphor-icons/react";
import { WorktreeOpenDialog } from "../projects/WorktreeOpenDialog";
import { dismissToast, showToast } from "./toast/toastStore";
import { usePrEventToasts } from "./toast/usePrEventToasts";
import { useStaleCliToast } from "./toast/useStaleCliToast";
import { useLaneEventToasts } from "./toast/useLaneEventToasts";
import { useAutoDiagnosticsToast } from "./toast/useAutoDiagnosticsToast";
import { useProductAnalyticsLifecycle } from "../analytics/ProductAnalyticsLifecycle";
import { useAppWideSessionAttention } from "../../hooks/useAppWideSessionAttention";
import { useCtoAttention } from "../../hooks/useCtoAttention";
import { ActivityPane } from "../activity/ActivityPane";
import { CtoVoiceHudHost } from "../cto/CtoVoiceHudHost";
import { GlobalCaptureGestureHost } from "../capture/GlobalCaptureGestureHost";
import { useActivitySync } from "../activity/useActivitySync";
import { isActivityRoute } from "../../lib/legacyRoutes";

function primaryTabPath(pathname: string): string {
  const roots = ["/hub", "/activity", "/attention", "/lanes", "/files", "/work", "/prs", "/history", "/automations", "/cto", "/settings"];
  return roots.find((root) => pathname === root || pathname.startsWith(`${root}/`)) ?? pathname;
}

const PRODUCT_ANALYTICS_ROUTE_ROOTS = [
  "/hub",
  "/activity",
  "/attention",
  "/lanes",
  "/files",
  "/work",
  "/prs",
  "/history",
  "/automations",
  "/cto",
  "/settings",
  "/chats",
] as const;

/**
 * What the deferred second-tier lane refresh asks for, per route.
 *
 * Boot runs two lane reads: an immediate `includeStatus: false` one so the lane
 * list paints without spawning git, then this one 1.2s later. Git STATUS is not
 * a Lanes-tab luxury — the Work tab's Git and Files cards read `lane.status`
 * and `lane.trackedFileCount`, and this is the ONLY refresh the restore path
 * ever schedules. Gating it on the route meant a session that booted straight
 * into Work never fetched status at all, so both cards sat on their no-data
 * fallbacks ("Unpublished", "Browse") for a clean, committed repository until
 * the user happened to visit the Lanes tab.
 *
 * Only the conflict / rebase-suggestion DECORATIONS are genuinely Lanes-route
 * work, so those (and the decorated snapshot read that carries them) stay
 * gated.
 */
export function deferredLaneRefreshOptions(isLanesRoute: boolean): {
  includeStatus: boolean;
  includeSnapshots: boolean;
  includeConflictStatus: boolean;
  includeRebaseSuggestions: boolean;
  includeAutoRebaseStatus: boolean;
} {
  return {
    includeStatus: true,
    includeSnapshots: isLanesRoute,
    includeConflictStatus: isLanesRoute,
    includeRebaseSuggestions: isLanesRoute,
    includeAutoRebaseStatus: isLanesRoute,
  };
}

export function productAnalyticsScreenForPathname(pathname: string): string {
  if (pathname === "/project" || pathname.startsWith("/project/")) return "project";
  // Activity used to be the "/attention" route, and the screen name is derived
  // from the path root. Mapping it explicitly keeps one PostHog series across
  // the rename instead of forking it into "attention" and "activity".
  if (isActivityRoute(pathname)) return "attention";
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
    "/prs",
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

const FEEDBACK_PROGRESS_TOAST_ID = "ade-feedback-report-progress";

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  useLaneEventToasts(navigate);
  usePrEventToasts(navigate);
  useAutoDiagnosticsToast();
  const setProject = useAppStore((s) => s.setProject);
  const setProjectHydrated = useAppStore((s) => s.setProjectHydrated);
  const setProjectBinding = useAppStore((s) => s.setProjectBinding);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);
  const refreshKeybindings = useAppStore((s) => s.refreshKeybindings);
  const keybindings = useAppStore((s) => s.keybindings);
  const lanes = useAppStore((s) => s.lanes);
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectRevision = useAppStore((s) => s.projectRevision);
  // One launch feed for the whole window; the slide-out renders only when it
  // has a background chat or CLI launch of ours to show.
  useChatLaunchSync();
  const chatLaunchesVisible = useChatLaunchSlideOutVisible();
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const setPersonalChatsTabOpen = useAppStore(
    (s) => s.setPersonalChatsTabOpen,
  );
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const closeProject = useAppStore((s) => s.closeProject);
  const [commandOpen, setCommandOpen] = useState(false);
  const visitedTabsRef = useRef(new Set<string>());
  const isFirstVisit = !visitedTabsRef.current.has(location.pathname);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [aiStatusLoaded, setAiStatusLoaded] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubConnectionGeneration, setGithubConnectionGeneration] = useState(0);
  // Connection/health banner dismissals live in a durable localStorage store
  // (AppBannerHost records them in bannerDismiss.ts) so they survive restart.
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
  const isPersonalChatsRoute =
    location.pathname === "/chats" || location.pathname.startsWith("/chats/");
  const activityDeepLink = isActivityRoute(location.pathname);
  const isAccountRoute =
    location.pathname === "/account" || location.pathname.startsWith("/account/");
  const isLanesRoute = location.pathname.startsWith("/lanes");
  const isWorkRoute = location.pathname === "/work" || location.pathname.startsWith("/work/");
  const productAnalyticsScreen = productAnalyticsScreenForPathname(location.pathname);
  useProductAnalyticsLifecycle({
    projectRoot: currentProjectRoot,
    screen: productAnalyticsScreen,
  });
  const isWorkAdjacentRoute = isWorkRoute || isLanesRoute;
  useStaleCliToast({
    projectRoot: project?.rootPath ?? null,
    activeProjectRoot: currentProjectRoot,
    showWelcome,
    isRemoteProject,
    isWorkAdjacentRoute,
    lanes,
    navigate,
  });
  const isLanesRouteRef = useRef(isLanesRoute);

  // Activity is a modal over whatever tab is in front, not a tab of its own, so
  // the shell owns whether it is up. `/activity` (and its `/attention`
  // predecessor) stay valid deep links: they open the pane and immediately hand
  // the URL back, so the surface underneath is a real tab rather than a blank
  // route that exists only to host an overlay.
  const [activityPaneOpen, setActivityPaneOpen] = useState(false);
  const lastNonActivityRouteRef = useRef("/work");
  if (!activityDeepLink) {
    lastNonActivityRouteRef.current = `${location.pathname}${location.search}`;
  }
  useEffect(() => {
    if (!activityDeepLink) return;
    setActivityPaneOpen(true);
    navigate(lastNonActivityRouteRef.current, { replace: true });
  }, [activityDeepLink, navigate]);

  useAppWideSessionAttention();
  useCtoAttention();
  useActivitySync(activityPaneOpen);

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
    // The shared reader coalesces this with Connections' read of the same
    // broadcast and backs off while the runtime is unhealthy; an unhealthy
    // read used to take seconds and the broadcast kept stacking new ones.
    // The `getLocalStatus` check is a capability probe for old preloads that
    // predate it; the call itself always goes through the shared reader.
    let readLocal: (() => Promise<SyncRoleSnapshot>) | null = null;
    if (typeof syncApi.getLocalStatus === "function") {
      readLocal = () => readLocalSyncStatus();
    } else if (typeof syncApi.getStatus === "function") {
      readLocal = () => syncApi.getStatus();
    }
    const refresh = () => {
      if (!readLocal) return;
      void readLocal().then(apply).catch(() => {});
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
        // Binding a remote project fills the pending New Tab, exactly as
        // opening a local one does. Every local open path clears this in the
        // store; this branch bypasses them all, which left a blank "New Tab"
        // pill sitting next to the tab it had just become.
        if (currentIsNewTabOpen) cancelNewTab();
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
          void refreshLanes(deferredLaneRefreshOptions(isLanesRouteRef.current));
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
    cancelNewTab,
    setProject,
    setProjectBinding,
    setProjectHydrated,
    refreshLanes,
    refreshProviderMode,
    refreshKeybindings,
    setShowWelcome,
  ]);

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

  // A report in flight is a progress toast, not a strip: it is short-lived and
  // about something the user just asked for.
  useEffect(() => {
    if (!feedbackGenerating) {
      dismissToast(FEEDBACK_PROGRESS_TOAST_ID);
      return;
    }
    showToast({
      id: FEEDBACK_PROGRESS_TOAST_ID,
      title: "Generating feedback report...",
      tone: "accent",
      busy: true,
      durationMs: 0,
      dismissible: false,
    });
  }, [feedbackGenerating]);
  useEffect(() => () => dismissToast(FEEDBACK_PROGRESS_TOAST_ID), []);

  const relocateMissingProject = useCallback(() => {
    void openRepo()
      .then((nextProject) => {
        if (nextProject) setProjectMissing(false);
      })
      .catch(() => {});
  }, [openRepo]);

  const removeMissingProject = useCallback(() => {
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
  }, [closeProject, project?.rootPath, switchProjectToPath]);

  useAppBanner(
    projectMissing && project?.rootPath
      ? {
          id: "project-directory-missing",
          tone: "error",
          icon: <FolderSimpleDashed size={13} weight="bold" />,
          title: "Project directory not found — it may have been moved or deleted.",
          actions: [
            { label: "Relocate", variant: "primary", onClick: relocateMissingProject },
            { label: "Remove", variant: "secondary", onClick: removeMissingProject },
          ],
          dismiss: { onDismiss: () => setProjectMissing(false) },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.project },
  );

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
      syncWindowsTitleBarOverlay({ displayZoom: clamped });
    } catch {
      // ignore
    }
  }, []);

  // Mod+1..5 and Mod+B act on the project surface, so they are off while the
  // welcome page, Chats, or the account page is in front.
  useProjectSidebarShortcuts({
    enabled: Boolean(project?.rootPath) && !showWelcome && !isPersonalChatsRoute && !isAccountRoute,
    projectRoot: currentProjectRoot,
    keybindings,
    navigate,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!eventMatchesBinding(e, commandPaletteBinding)) return;
      e.preventDefault();
      setCommandOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteBinding]);

  const tintClass = useMemo(() => {
    const tintMap: Record<string, string> = {
      "/activity": "tab-tint-work",
      "/attention": "tab-tint-work",
      "/lanes": "tab-tint-lanes",
      "/files": "tab-tint-files",
      "/work": "tab-tint-work",
      "/prs": "tab-tint-prs",
      "/history": "tab-tint-history",
      "/automations": "tab-tint-automations",
      "/cto": "tab-tint-cto",
      "/settings": "tab-tint-settings",
      "/chats": "tab-tint-work",
    };
    return tintMap[primaryTabPath(location.pathname)] ?? "";
  }, [location.pathname]);

  return (
    <div
      className={cn(
        "text-fg overflow-hidden flex flex-col bg-bg",
        // Hosted web and the Vite mock zoom <body> and inverse-size it.
        // `h-screen` is 100vh in unzoomed viewport pixels, so CSS zoom would
        // paint the shell larger than the window and clip the launch shelf
        // and chat column. Electron keeps h-screen: webFrame shrinks 100vh.
        isCssZoomedBrowserSurface() ? "h-full w-full" : "h-screen w-screen",
      )}
    >
      <div className="shrink-0 relative z-20">
        <TopBar
          personalChatsRouteActive={isPersonalChatsRoute}
          accountRouteActive={isAccountRoute}
          onNavigate={(path, opts) => navigate(path, opts)}
          onOpenActivityPane={() => setActivityPaneOpen(true)}
        />
      </div>

      {/*
        The one banner host, outside every project condition so account and
        app-level banners reach the welcome screen too. The components below
        render nothing: each registers its banners with the host, which owns
        order (account, project, app, outage, integration), the two-banner cap
        and dismissal.
      */}
      <AppBannerHost />
      <ProjectTransitionErrorAlert />
      <AccountSignedOutBanner navigate={navigate} />
      <AutoUpdateBanner />
      <BrainRecoveryNotice />
      {!showWelcome && project?.rootPath ? (
        <IntegrationBanners
          currentProjectRoot={currentProjectRoot}
          githubStatus={githubStatus}
          hasAnyAiProvider={hasAnyAiProvider}
          aiStatusLoaded={aiStatusLoaded && aiStatus !== null}
          relayHealth={syncRelayHealth}
          navigate={navigate}
        />
      ) : null}

      <div className="flex-1 flex min-h-0">
        <main className={cn("relative flex flex-col min-h-0 min-w-0 flex-1", tintClass)}>
          <TabBackground />
          <div
            className="relative z-[1] min-h-0 flex-1 w-full"
            data-tab-revisit={!isFirstVisit || undefined}
          >
            {children}
          </div>
          <ToastViewport
            slot={chatLaunchesVisible ? <ChatLaunchesSlideOut /> : null}
            slotKey="chat-launches"
          />
        </main>
      </div>

      <ActivityPane open={activityPaneOpen} onClose={() => setActivityPaneOpen(false)} />

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      {/* Shell level, beside the other overlays: a call must outlive tab and
          project switches, because the whole point is talking while you work. */}
      <CtoVoiceHudHost />
      {/* Also shell level, and for a stronger version of the same reason: the
          capture arrives from the main process while ADE is in the BACKGROUND,
          so nothing mounted by a tab could be listening when it lands. */}
      <GlobalCaptureGestureHost />
      <WorktreeOpenDialog />
    </div>
  );
}
