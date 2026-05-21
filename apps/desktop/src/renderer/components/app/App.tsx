import React from "react";
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { AppShell } from "./AppShell";
import { InboundDeeplinkModal } from "./InboundDeeplinkModal";
import { ClipboardDeeplinkBanner } from "./ClipboardDeeplinkBanner";
import { CrossRepoPrBanner } from "./CrossRepoPrBanner";
import { RunPage } from "../run/RunPage";
import { ProjectSetupPage } from "../onboarding/ProjectSetupPage";
import { OnboardingBootstrap } from "../onboarding/OnboardingBootstrap";
import { GlossaryPage } from "../onboarding/GlossaryPage";
import { logRendererDebugEvent } from "../../lib/debugLog";

const LanesPage = React.lazy(() =>
  import("../lanes/LanesPage").then((m) => ({ default: m.LanesPage }))
);
const FilesPage = React.lazy(() =>
  import("../files/FilesPage").then((m) => ({ default: m.FilesPage }))
);
const TerminalsPage = React.lazy(() =>
  import("../terminals/TerminalsPage").then((m) => ({ default: m.TerminalsPage }))
);
const PRsPage = React.lazy(() =>
  import("../prs/PRsPage").then((m) => ({ default: m.PRsPage }))
);
const ReviewPage = React.lazy(() =>
  import("../review/ReviewPage").then((m) => ({ default: m.ReviewPage }))
);
const HistoryPage = React.lazy(() =>
  import("../history/HistoryPage").then((m) => ({ default: m.HistoryPage }))
);
const AutomationsPage = React.lazy(() =>
  import("../automations/AutomationsPage").then((m) => ({ default: m.AutomationsPage }))
);
const AutomationsTemplatesPage = React.lazy(() =>
  import("../automations/AutomationsTemplatesPage").then((m) => ({ default: m.AutomationsTemplatesPage }))
);
const SettingsPage = React.lazy(() =>
  import("./SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkspaceGraphPage = React.lazy(() =>
  import("../graph/WorkspaceGraphPage").then((m) => ({ default: m.WorkspaceGraphPage }))
);
const MissionsPage = React.lazy(() =>
  import("../missions/MissionsPage").then((m) => ({ default: m.MissionsPage }))
);
const CtoPage = React.lazy(() =>
  import("../cto/CtoPage").then((m) => ({ default: m.CtoPage }))
);

import {
  AppStoreProvider,
  createProjectAppStore,
  hydrateProjectAppStore,
  useAppStore,
  type AppStoreApi,
} from "../../state/appStore";
import { getDirtyFileTextForWindow } from "../../lib/dirtyWorkspaceBuffers";
import { getAiStatusCached } from "../../lib/aiDiscoveryCache";
import { dispatchWorkSurfaceRevealed } from "../terminals/workSurfaceVisibility";
import type { AppNavigationRequest, ProjectInfo } from "../../../shared/types";

// Use path-based routes on http(s) (Vite in Chrome, Cursor Simple Browser, etc.).
// Use hash routes for non-http(s) surfaces (e.g. packaged Electron `file://`) where
// the history API is not tied to a normal origin.
// Relying only on `__adeBrowserMock` breaks when the flag is not set at module-eval
// time, which can strand Cursor's embedded browser on a single path.
const usesBrowserRouter =
  typeof window !== "undefined" &&
  (window.location.protocol === "http:" || window.location.protocol === "https:");
const Router = usesBrowserRouter ? BrowserRouter : HashRouter;

const StartupSplashScreen = (
  <div className="flex h-full w-full flex-col items-center justify-center relative overflow-hidden" style={{ background: "var(--color-bg)" }}>
    {/* Background glow */}
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[60vw] h-[60vw] max-w-[600px] max-h-[600px] rounded-full opacity-20 blur-[100px] pointer-events-none" style={{ background: "var(--color-accent)" }} />
    <div className="relative z-10 flex flex-col items-center animate-fade-in-up">
      <div className="flex items-center justify-center mb-6" style={{ filter: "drop-shadow(0 0 22px color-mix(in srgb, var(--color-accent) 45%, transparent))" }}>
        <img src="./logo.png" alt="ADE Logo" className="h-[240px] w-[420px] max-w-[72vw] object-contain" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="text-xl font-bold tracking-tight text-fg">Starting ADE</div>
        <div className="text-[12px] font-mono text-muted-fg/70 animate-pulse">Initializing local workspace...</div>
      </div>
    </div>
  </div>
);

/** Used by React.lazy Suspense boundaries while route chunks load. */
const GuardLoadingFallback = StartupSplashScreen;

/* ---------- Per-route error boundary ---------- */

type PageErrorBoundaryState = { hasError: boolean; message: string };

class PageErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; onGoHome: () => void },
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("page.crash", error, errorInfo, error?.stack);
    logRendererDebugEvent("renderer.page_boundary_crash", {
      message: error?.message ?? String(error),
      route: window.location.hash || window.location.pathname,
      componentStack: errorInfo.componentStack ?? null,
      causeStack: error?.stack ?? null,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-fg">
          <div className="max-w-[560px] rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
            <div className="font-semibold text-red-300">This page crashed</div>
            <div className="mt-1 text-xs text-muted-fg">{this.state.message || "Unknown error"}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors"
              onClick={() => this.setState({ hasError: false, message: "" })}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors"
              onClick={() => {
                this.setState({ hasError: false, message: "" });
                this.props.onGoHome();
              }}
            >
              Go Home
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PageErrorBoundary({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <PageErrorBoundaryInner onGoHome={() => navigate("/work")}>
      {children}
    </PageErrorBoundaryInner>
  );
}

const LazyFallback = GuardLoadingFallback;

function isWorkRoutePath(pathname: string): boolean {
  return pathname === "/work" || pathname.startsWith("/work/");
}

const PROJECT_ROUTE_STORAGE_PREFIX = "ade:project-route:";
const WARM_PROJECT_SURFACE_LIMIT = 8;
const EMPTY_PROJECT_TAB_ROOTS: string[] = [];
const EMPTY_PROJECT_INFO_BY_ROOT: Record<string, ProjectInfo> = {};

function projectRouteStorageKey(projectRoot: string): string {
  return `${PROJECT_ROUTE_STORAGE_PREFIX}${projectRoot}`;
}

function serializeProjectRoute(location: ReturnType<typeof useLocation>): string | null {
  const pathname = location.pathname || "/work";
  const allowedRoots = [
    "/project",
    "/lanes",
    "/files",
    "/work",
    "/graph",
    "/prs",
    "/review",
    "/history",
    "/automations",
    "/missions",
    "/cto",
    "/settings",
    "/onboarding",
  ];
  if (!allowedRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`))) {
    return null;
  }
  return `${pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

function readStoredProjectRoute(projectRoot: string): string | null {
  try {
    const value = window.localStorage.getItem(projectRouteStorageKey(projectRoot));
    return value?.startsWith("/") ? value : null;
  } catch {
    return null;
  }
}

function writeStoredProjectRoute(projectRoot: string, route: string): void {
  try {
    window.localStorage.setItem(projectRouteStorageKey(projectRoot), route);
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

function ProjectRouteContent({ active, route }: { active: boolean; route: string }) {
  const workSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const isWorkRoute = isWorkRoutePath(route.split(/[?#]/, 1)[0] || "/work");
  const [workRoute, setWorkRoute] = React.useState(() => isWorkRoute ? route : "/work");
  const [workMounted, setWorkMounted] = React.useState(isWorkRoute);
  const routeProps = { active } as { active?: boolean };
  const shouldRenderWork = workMounted || isWorkRoute;
  const visibleWorkRoute = isWorkRoute ? route : workRoute;

  React.useEffect(() => {
    if (!isWorkRoute) return;
    setWorkRoute(route);
    setWorkMounted(true);
  }, [isWorkRoute, route]);

  React.useEffect(() => {
    const node = workSurfaceRef.current;
    if (!node) return;
    if (isWorkRoute) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, [isWorkRoute, shouldRenderWork]);

  const workSurface = shouldRenderWork ? (
    <Routes location={visibleWorkRoute}>
      <Route path="/work/*" element={
        <div
          ref={workSurfaceRef}
          className="h-full min-h-0 w-full"
          aria-hidden={!isWorkRoute}
          style={!isWorkRoute
            ? {
              position: "absolute",
              inset: 0,
              zIndex: -1,
              opacity: 0,
              pointerEvents: "none",
            }
            : undefined}
        >
          <PageErrorBoundary>
            <React.Suspense fallback={LazyFallback}>
              <TerminalsPage active={active && isWorkRoute} />
            </React.Suspense>
          </PageErrorBoundary>
        </div>
      } />
    </Routes>
  ) : null;

  return (
    <div className="relative h-full min-h-0 w-full">
      {workSurface}
      {!isWorkRoute ? (
        <Routes location={route}>
          <Route path="/" element={<Navigate to="/work" replace />} />
          <Route path="/project" element={<PageErrorBoundary><RunPage /></PageErrorBoundary>} />
          <Route path="/onboarding" element={<PageErrorBoundary><ProjectSetupPage /></PageErrorBoundary>} />
          <Route path="/glossary" element={<PageErrorBoundary><GlossaryPage /></PageErrorBoundary>} />
          <Route path="/lanes" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(LanesPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/files" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(FilesPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/graph" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(WorkspaceGraphPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/prs" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(PRsPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/review" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(ReviewPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/history" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(HistoryPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/automations" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(AutomationsPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/automations/templates" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(AutomationsTemplatesPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/missions" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(MissionsPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/cto" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(CtoPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="/settings" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(SettingsPage as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
            </PageErrorBoundary>
          } />
          <Route path="*" element={<Navigate to="/work" replace />} />
        </Routes>
      ) : null}
    </div>
  );
}

function ProjectSurface({
  active,
  project,
  route,
  store,
}: {
  active: boolean;
  project: ProjectInfo;
  route: string;
  store: AppStoreApi;
}) {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    hydrateProjectAppStore(store, {
      project,
      projectBinding: {
        kind: "local",
        key: `local:${project.rootPath}`,
        rootPath: project.rootPath,
        displayName: project.displayName,
      },
      projectHydrated: true,
      showWelcome: false,
    });
  }, [project, store]);

  React.useEffect(() => {
    if (!active || !isWorkRoutePath(route.split(/[?#]/, 1)[0] || "/work")) return;
    const raf = window.requestAnimationFrame(() => {
      dispatchWorkSurfaceRevealed();
    });
    const settleTimer = window.setTimeout(() => {
      dispatchWorkSurfaceRevealed();
    }, 120);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
    };
  }, [active, route]);

  React.useEffect(() => {
    if (!active) return;
    const state = store.getState();
    if (state.lanes.length === 0 && !state.lanesLoading) {
      void state.refreshLanes({ includeStatus: false }).catch(() => {});
    }
    if (!state.keybindings) {
      void state.refreshKeybindings().catch(() => {});
    }
    void state.refreshProviderMode().catch(() => {});
  }, [active, store]);

  React.useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    if (active) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, [active]);

  return (
    <AppStoreProvider store={store}>
      <div
        ref={surfaceRef}
        className="h-full min-h-0 w-full"
        aria-hidden={!active}
        data-project-root={project.rootPath}
        style={!active
          ? {
            position: "absolute",
            inset: 0,
            zIndex: -1,
            opacity: 0,
            pointerEvents: "none",
          }
          : undefined}
      >
        <ProjectRouteContent active={active} route={route} />
      </div>
    </AppStoreProvider>
  );
}

function ProjectTabHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeProject = useAppStore((s) => s.project);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots ?? EMPTY_PROJECT_TAB_ROOTS);
  const projectInfoByRoot = useAppStore((s) => s.projectInfoByRoot ?? EMPTY_PROJECT_INFO_BY_ROOT);
  const rootPrefs = useAppStore(useShallow((s) => ({
    theme: s.theme,
    terminalPreferences: s.terminalPreferences,
    codeBlockCopyButtonPosition: s.codeBlockCopyButtonPosition,
    agentTurnCompletionSound: s.agentTurnCompletionSound,
    agentTurnCompletionSoundVolume: s.agentTurnCompletionSoundVolume,
    agentTurnCompletionSoundQuietWhenFocused: s.agentTurnCompletionSoundQuietWhenFocused,
    chatFontSizePx: s.chatFontSizePx,
    chatUserMinimapEnabled: s.chatUserMinimapEnabled,
    chatTranscriptDensity: s.chatTranscriptDensity,
    chatChromeTint: s.chatChromeTint,
    chatShellGeometry: s.chatShellGeometry,
    smartTooltipsEnabled: s.smartTooltipsEnabled,
    onboardingEnabled: s.onboardingEnabled,
    didYouKnowEnabled: s.didYouKnowEnabled,
  })));
  const storesRef = React.useRef(new Map<string, AppStoreApi>());
  const lruRef = React.useRef<string[]>([]);
  const [routesByRoot, setRoutesByRoot] = React.useState<Record<string, string>>({});
  const activeRoot = !showWelcome && activeProject?.rootPath ? activeProject.rootPath : null;
  const previousActiveRootRef = React.useRef<string | null>(null);
  const pendingNavigationRef = React.useRef<{ root: string; route: string } | null>(null);

  React.useEffect(() => {
    for (const store of storesRef.current.values()) {
      hydrateProjectAppStore(store, rootPrefs);
    }
  }, [rootPrefs]);

  React.useEffect(() => {
    if (!activeRoot) return;
    lruRef.current = [activeRoot, ...lruRef.current.filter((root) => root !== activeRoot)];
  }, [activeRoot]);

  React.useEffect(() => {
    const previousRoot = previousActiveRootRef.current;
    if (previousRoot === activeRoot) return;
    const currentRoute = serializeProjectRoute(location);
    if (previousRoot && currentRoute) {
      writeStoredProjectRoute(previousRoot, currentRoute);
      setRoutesByRoot((prev) => ({ ...prev, [previousRoot]: currentRoute }));
    }
    previousActiveRootRef.current = activeRoot;
    if (!activeRoot) return;
    const shouldKeepInitialRoute =
      currentRoute &&
      currentRoute !== "/project" &&
      currentRoute !== "/onboarding";
    if (!previousRoot && shouldKeepInitialRoute) {
      writeStoredProjectRoute(activeRoot, currentRoute);
      setRoutesByRoot((prev) => (prev[activeRoot] === currentRoute ? prev : { ...prev, [activeRoot]: currentRoute }));
      return;
    }
    const nextRoute = routesByRoot[activeRoot] ?? readStoredProjectRoute(activeRoot) ?? "/work";
    pendingNavigationRef.current = { root: activeRoot, route: nextRoute };
    if (currentRoute !== nextRoute) {
      navigate(nextRoute, { replace: true });
    }
  }, [activeRoot, location, navigate, routesByRoot]);

  React.useEffect(() => {
    if (!activeRoot) return;
    const route = serializeProjectRoute(location);
    if (!route) return;
    const pending = pendingNavigationRef.current;
    if (pending?.root === activeRoot && pending.route !== route) return;
    if (pending?.root === activeRoot && pending.route === route) {
      pendingNavigationRef.current = null;
    }
    writeStoredProjectRoute(activeRoot, route);
    setRoutesByRoot((prev) => (prev[activeRoot] === route ? prev : { ...prev, [activeRoot]: route }));
  }, [activeRoot, location]);

  const projects = React.useMemo(() => {
    const roots = openProjectTabRoots.length > 0
      ? openProjectTabRoots
      : activeProject?.rootPath
        ? [activeProject.rootPath]
        : [];
    return roots
      .map((root) => projectInfoByRoot[root] ?? (activeProject?.rootPath === root ? activeProject : null))
      .filter((project): project is ProjectInfo => project != null);
  }, [activeProject, openProjectTabRoots, projectInfoByRoot]);

  const mountedProjects = React.useMemo(() => {
    const lru = lruRef.current;
    const openSet = new Set(projects.map((project) => project.rootPath));
    const ordered = [...projects].sort((left, right) => {
      const leftIndex = lru.indexOf(left.rootPath);
      const rightIndex = lru.indexOf(right.rootPath);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
    const warm = ordered.slice(0, WARM_PROJECT_SURFACE_LIMIT);
    if (activeProject && openSet.has(activeProject.rootPath) && !warm.some((project) => project.rootPath === activeProject.rootPath)) {
      warm.pop();
      warm.unshift(activeProject);
    }
    return warm;
  }, [activeProject, projects]);

  for (const project of mountedProjects) {
    if (!storesRef.current.has(project.rootPath)) {
      storesRef.current.set(project.rootPath, createProjectAppStore(project));
    }
  }

  React.useEffect(() => {
    const mountedRoots = new Set(mountedProjects.map((project) => project.rootPath));
    for (const root of storesRef.current.keys()) {
      if (!mountedRoots.has(root)) storesRef.current.delete(root);
    }
  }, [mountedProjects]);

  if (!projectHydrated && !activeProject) {
    return GuardLoadingFallback;
  }

  if (!activeProject || showWelcome || mountedProjects.length === 0) {
    return (
      <PageErrorBoundary>
        <RunPage />
      </PageErrorBoundary>
    );
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      {mountedProjects.map((project) => {
        const store = storesRef.current.get(project.rootPath);
        if (!store) return null;
        const route = routesByRoot[project.rootPath] ?? readStoredProjectRoute(project.rootPath) ?? "/work";
        return (
          <ProjectSurface
            key={project.rootPath}
            active={project.rootPath === activeRoot}
            project={project}
            route={route}
            store={store}
          />
        );
      })}
    </div>
  );
}

function ShellLayout() {
  return (
    <AppShell>
      <ProjectTabHost />
    </AppShell>
  );
}

function AppNavigationBridge() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const [inboundBranch, setInboundBranch] = React.useState<{
    repoOwner: string;
    repoName: string;
    branch: string;
    prNumber?: number | null;
  } | null>(null);

  // Capture lanes in a ref so the navigation callback always sees the latest
  // list without re-subscribing every time the lanes array updates (which
  // happens often — status polls, etc.).
  const lanesRef = React.useRef(lanes);
  React.useEffect(() => {
    lanesRef.current = lanes;
  }, [lanes]);

  React.useEffect(() => {
    const onNavigate = window.ade?.app?.onNavigate;
    if (!onNavigate) return;
    return onNavigate((request: AppNavigationRequest) => {
      const target = request.target;
      if (target.kind === "chat" || target.kind === "work") {
        const params = new URLSearchParams();
        if (target.sessionId) params.set("sessionId", target.sessionId);
        if (target.laneId) params.set("laneId", target.laneId);
        navigate(`/work${params.toString() ? `?${params.toString()}` : ""}`);
        return;
      }
      if (target.kind === "lane") {
        const params = new URLSearchParams();
        params.set("laneId", target.laneId);
        if (target.sessionId) params.set("sessionId", target.sessionId);
        navigate(`/lanes?${params.toString()}`);
        return;
      }
      if (target.kind === "pr") {
        const params = new URLSearchParams();
        if (target.prId) params.set("prId", target.prId);
        if (target.prNumber != null) params.set("pr", String(target.prNumber));
        if (target.laneId) params.set("laneId", target.laneId);
        // Forward repo identity so the PRs tab can detect cross-project
        // deeplinks (and offer to switch projects) instead of silently
        // showing an empty filter.
        if (target.repoOwner) params.set("repoOwner", target.repoOwner);
        if (target.repoName) params.set("repoName", target.repoName);
        navigate(`/prs${params.toString() ? `?${params.toString()}` : ""}`);
        return;
      }
      if (target.kind === "branch") {
        setInboundBranch({
          repoOwner: target.repoOwner,
          repoName: target.repoName,
          branch: target.branch,
          prNumber: target.prNumber ?? null,
        });
        return;
      }
      if (target.kind === "linear-issue") {
        // Look up a lane whose linkedIssue matches this identifier. If found,
        // navigate. If not, fall back: route to /lanes with the issue + branch
        // hints so the lanes page can pre-filter and offer "create lane" CTA.
        const matchingLane = lanesRef.current.find(
          (lane) => lane.linearIssue?.identifier === target.issueIdentifier,
        );
        if (matchingLane) {
          const params = new URLSearchParams({ laneId: matchingLane.id });
          navigate(`/lanes?${params.toString()}`);
          return;
        }
        const params = new URLSearchParams();
        params.set("linearIssue", target.issueIdentifier);
        if (target.branch) params.set("branch", target.branch);
        navigate(`/lanes?${params.toString()}`);
        return;
      }
      if (target.kind === "route") {
        navigate(target.route.startsWith("/") ? target.route : `/${target.route}`);
      }
    });
  }, [navigate]);

  if (!inboundBranch) return null;
  return (
    <InboundDeeplinkModal
      target={inboundBranch}
      lanes={lanes}
      onClose={() => setInboundBranch(null)}
      onLaneOpened={(laneId) => {
        const params = new URLSearchParams({ laneId });
        navigate(`/lanes?${params.toString()}`);
      }}
    />
  );
}

function BrowserHashRouteBridge() {
  const navigate = useNavigate();

  React.useEffect(() => {
    const normalizeHashRoute = (hash: string): string | null => {
      if (!hash.startsWith("#/")) return null;
      try {
        const raw = hash.slice(1);
        if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\0")) return null;
        const queryIndex = raw.indexOf("?");
        const fragmentIndex = raw.indexOf("#");
        const suffixIndex = [queryIndex, fragmentIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? raw.length;
        const pathname = raw.slice(0, suffixIndex);
        const suffix = raw.slice(suffixIndex);
        const segments = pathname.split("/").filter(Boolean);
        if (segments.some((segment) => {
          const decoded = decodeURIComponent(segment);
          return decoded === "." || decoded === "..";
        })) {
          return null;
        }
        return `/${segments.join("/")}${suffix}`;
      } catch {
        return null;
      }
    };

    const syncHashRoute = () => {
      const route = normalizeHashRoute(window.location.hash);
      if (!route) return;
      navigate(route, { replace: true });
    };
    syncHashRoute();
    window.addEventListener("hashchange", syncHashRoute);
    return () => window.removeEventListener("hashchange", syncHashRoute);
  }, [navigate]);

  return null;
}

export function App() {
  const theme = useAppStore((s) => s.theme);
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);

  React.useEffect(() => {
    const w = window as Window & { __ADE_GET_DIRTY_FILE_TEXT__?: (p: string) => string | undefined };
    w.__ADE_GET_DIRTY_FILE_TEXT__ = (absPath: string) => getDirtyFileTextForWindow(absPath);
    return () => {
      delete w.__ADE_GET_DIRTY_FILE_TEXT__;
    };
  }, []);

  React.useEffect(() => {
    if (!projectRoot) return;
    void getAiStatusCached({ projectRoot }).catch(() => undefined);
  }, [projectRoot]);

  React.useEffect(() => {
    // Keep theme consistent for portals mounted outside the app root.
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <Router>
      <div data-theme={theme} className="h-full bg-bg text-fg font-sans antialiased selection:bg-accent/30">
        <OnboardingBootstrap />
        <AppNavigationBridge />
        <CrossRepoPrBanner />
        <ClipboardDeeplinkBanner />
        {usesBrowserRouter ? <BrowserHashRouteBridge /> : null}
        <Routes>
          <Route path="/startup" element={<Navigate to="/work" replace />} />
          <Route path="*" element={<ShellLayout />} />
        </Routes>
      </div>
    </Router>
  );
}
