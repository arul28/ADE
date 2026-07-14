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
import {
  InboundDeeplinkModal,
  type InboundDeeplinkDispatchOptions,
  type InboundDeeplinkTarget,
} from "./InboundDeeplinkModal";
import { ClipboardDeeplinkBanner } from "./ClipboardDeeplinkBanner";
import { CrossRepoPrBanner } from "./CrossRepoPrBanner";
import { ProjectRecoveryScreen } from "./ProjectRecoveryScreen";
import { RunPage } from "../run/RunPage";
import { ProjectSetupPage } from "../onboarding/ProjectSetupPage";
import { OnboardingBootstrap } from "../onboarding/OnboardingBootstrap";
import { GlossaryPage } from "../onboarding/GlossaryPage";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { readStoredProjectRoute, writeStoredProjectRoute } from "./projectRouteStorage";
import { requestLinearIssueQuickView } from "../../lib/linearIssueQuickViewNavigation";

function createPreloadableRoute<TProps extends object>(
  loadModule: () => Promise<{ default: React.ComponentType<TProps> }>,
) {
  let resolved: React.ComponentType<TProps> | null = null;
  let loadPromise: Promise<{ default: React.ComponentType<TProps> }> | null = null;
  const load = () => {
    if (!loadPromise) {
      loadPromise = loadModule().then((module) => {
        resolved = module.default;
        return module;
      });
    }
    return loadPromise;
  };
  const LazyComponent = React.lazy(load);
  const Component = (props: TProps) => {
    const Resolved = resolved;
    const routeProps = props as object;
    return Resolved
      ? React.createElement(Resolved as React.ComponentType<object>, routeProps)
      : React.createElement(LazyComponent as unknown as React.ComponentType<object>, routeProps);
  };
  return { Component, preload: load };
}

const lanesRoute = createPreloadableRoute<{ active?: boolean }>(() =>
  import("../lanes/LanesPage").then((m) => ({ default: m.LanesPage }))
);
const LanesPage = lanesRoute.Component;
const preloadLanesPage = lanesRoute.preload;
const filesRoute = createPreloadableRoute<{ active?: boolean }>(() =>
  import("../files/FilesTab").then((m) => ({ default: m.FilesTab }))
);
const FilesTab = filesRoute.Component;
const preloadFilesTab = filesRoute.preload;
const workRoute = createPreloadableRoute<{ active?: boolean }>(() =>
  import("../terminals/TerminalsPage").then((m) => ({ default: m.TerminalsPage }))
);
const TerminalsPage = workRoute.Component;
const preloadTerminalsPage = workRoute.preload;
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
const PersonalChatsPage = React.lazy(() =>
  import("../personalChats/PersonalChatsPage").then((m) => ({ default: m.PersonalChatsPage }))
);
const ctoRoute = createPreloadableRoute<{ active?: boolean }>(() =>
  import("../cto/CtoPage").then((m) => ({ default: m.CtoPage }))
);
const CtoPage = ctoRoute.Component;
const preloadCtoPage = ctoRoute.preload;
import {
  AppStoreProvider,
  createProjectAppStore,
  hydrateProjectAppStore,
  selectActiveProjectRoot,
  useAppStore,
  type AppStoreApi,
} from "../../state/appStore";
import { getDirtyFileTextForWindow } from "../../lib/dirtyWorkspaceBuffers";
import { filesProjectCacheKey, releaseFilesProjectCaches } from "../files/v2/filesTreeCache";
import { getAiStatusCached } from "../../lib/aiDiscoveryCache";
import { dispatchWorkSurfaceRevealed } from "../terminals/workSurfaceVisibility";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT } from "../../lib/openExternal";
import {
  githubRepoSlugsEqual,
  parseGithubRemoteUrl,
  type GithubRepoSlug,
} from "../../../shared/githubRemote";
import { isValidRepoRelativePath } from "../../../shared/deeplinks";
import type {
  AppNavigationRequest,
  AppNavigationTarget,
  OpenProjectBinding,
  ProjectInfo,
} from "../../../shared/types";

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

const RouteLoadingFallback = (
  <div
    className="flex h-full min-h-0 w-full flex-col"
    style={{ background: "var(--color-bg)" }}
    aria-label="Loading tab"
  >
    <div
      className="flex h-14 shrink-0 items-center gap-3 px-5"
      style={{ borderBottom: "1px solid var(--color-border)", background: "color-mix(in srgb, var(--color-fg) 3%, transparent)" }}
    >
      <div className="h-4 w-28 animate-pulse rounded bg-muted/40" />
      <div className="h-4 w-16 animate-pulse rounded bg-muted/30" />
      <div className="ml-auto h-7 w-24 animate-pulse rounded-md bg-muted/30" />
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,260px)_minmax(0,1fr)]">
      <div className="min-h-0 space-y-2 border-r border-border p-3">
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={`route-fallback-list-${index}`}
            className="h-10 animate-pulse rounded-md"
            style={{ background: "color-mix(in srgb, var(--color-fg) 5%, transparent)" }}
          />
        ))}
      </div>
      <div className="grid min-h-0 grid-cols-2 gap-3 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={`route-fallback-panel-${index}`}
            className="animate-pulse rounded-lg border border-border"
            style={{ background: "color-mix(in srgb, var(--color-fg) 4%, transparent)" }}
          />
        ))}
      </div>
    </div>
  </div>
);

const LazyFallback = RouteLoadingFallback;

function isWorkRoutePath(pathname: string): boolean {
  return pathname === "/work" || pathname.startsWith("/work/");
}

function isLanesRoutePath(pathname: string): boolean {
  return pathname === "/lanes" || pathname.startsWith("/lanes/");
}

const WARM_PROJECT_SURFACE_LIMIT = 8;
const EMPTY_PROJECT_TAB_ROOTS: string[] = [];
const EMPTY_PROJECT_INFO_BY_ROOT: Record<string, ProjectInfo> = {};

function localProjectBindingForProject(project: ProjectInfo): OpenProjectBinding {
  return {
    kind: "local",
    key: `local:${project.rootPath}`,
    rootPath: project.rootPath,
    displayName: project.displayName,
  };
}

function bindingForProject(
  project: ProjectInfo,
  activeProjectBinding: OpenProjectBinding | null,
): OpenProjectBinding {
  if (activeProjectBinding?.rootPath === project.rootPath) {
    return activeProjectBinding;
  }
  return localProjectBindingForProject(project);
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
    "/cto",
    "/settings",
    "/onboarding",
  ];
  if (!allowedRoots.some((root) => pathname === root || pathname.startsWith(`${root}/`))) {
    return null;
  }
  return `${pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

function serializeStoredProjectRoute(location: ReturnType<typeof useLocation>): string | null {
  const route = serializeProjectRoute(location);
  if (!route || location.pathname !== "/files") return route;
  const params = new URLSearchParams(location.search ?? "");
  if (!params.has("externalPath") && !params.has("externalOpen")) return route;
  params.delete("externalPath");
  params.delete("externalOpen");
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash ?? ""}`;
}

type ProjectSurfaceEntry = {
  surfaceKey: string;
  project: ProjectInfo;
  binding: OpenProjectBinding;
};

function browserEventProjectRoot(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ("collectionProjectRoot" in record) {
    const root = record.collectionProjectRoot;
    return typeof root === "string" && root.trim().length > 0 ? root : null;
  }
  return browserEventProjectRoot(record.status);
}

function browserEventMatchesProject(event: unknown, projectRoot: string | null): boolean {
  const root = browserEventProjectRoot(event);
  if (root === undefined) return projectRoot == null;
  if (!projectRoot) return root === null;
  return root === projectRoot;
}

function hideBuiltInBrowserView(projectRoot: string | null): void {
  const browser = window.ade?.builtInBrowser;
  if (!browser) return;
  const scope = projectRoot ? { projectRoot } : {};
  void browser.stopInspect(scope).catch(() => {});
  void browser.setBounds({
    ...scope,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    visible: false,
  }).catch(() => {});
}

function projectNameFromRoot(rootPath: string | null | undefined): string | null {
  if (!rootPath) return null;
  const segments = rootPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? rootPath;
}

function ProjectTransitionVeil({ label }: { label: string }) {
  return (
    <div
      data-testid="project-transition-veil"
      className="absolute inset-0 z-30 flex items-center justify-center bg-bg/95 text-fg backdrop-blur-sm"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-card/95 px-3 py-2 text-[12px] font-medium shadow-2xl">
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/40 border-t-accent"
        />
        <span className="max-w-[320px] truncate">{label}</span>
      </div>
    </div>
  );
}

function ProjectRouteContent({ active, route }: { active: boolean; route: string }) {
  const navigate = useNavigate();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const workSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const lanesSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const isWorkRoute = isWorkRoutePath(route.split(/[?#]/, 1)[0] || "/work");
  const isLanesRoute = isLanesRoutePath(route.split(/[?#]/, 1)[0] || "/work");
  const [workRoute, setWorkRoute] = React.useState(() => isWorkRoute ? route : "/work");
  const [workMounted, setWorkMounted] = React.useState(isWorkRoute);
  const [lanesRoute, setLanesRoute] = React.useState(() => isLanesRoute ? route : "/lanes");
  const routeProps = { active } as { active?: boolean };
  const shouldRenderWork = workMounted || isWorkRoute;
  const shouldRenderLanes = active && isLanesRoute;
  const visibleWorkRoute = isWorkRoute ? route : workRoute;
  const visibleLanesRoute = isLanesRoute ? route : lanesRoute;

  React.useEffect(() => {
    if (!isWorkRoute) return;
    setWorkRoute(route);
    setWorkMounted(true);
  }, [isWorkRoute, route]);

  React.useEffect(() => {
    if (!isLanesRoute) return;
    setLanesRoute(route);
  }, [isLanesRoute, route]);

  React.useEffect(() => {
    if (active && isWorkRoute) return;
    hideBuiltInBrowserView(projectRoot);
  }, [active, isWorkRoute, projectRoot]);

  React.useEffect(() => {
    if (!active || !projectRoot) return;
    const revealWorkBrowser = () => {
      // The work-tab `viewMode` (tabs/grid) was the old grid this lane's overhaul
      // replaces; just open the browser sidebar.
      setWorkViewState(projectRoot, {
        workSidebarOpen: true,
        workSidebarTab: "browser",
      });
      if (!isWorkRoute) navigate("/work");
    };
    const handleBrowserEvent = (event: unknown) => {
      if (
        event
        && typeof event === "object"
        && (event as { type?: unknown }).type === "open-request"
        && browserEventMatchesProject(event, projectRoot)
      ) {
        revealWorkBrowser();
      }
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, revealWorkBrowser);
    const unsubscribeBrowserEvents = window.ade?.builtInBrowser?.onEvent?.(handleBrowserEvent) ?? null;
    return () => {
      window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, revealWorkBrowser);
      unsubscribeBrowserEvents?.();
    };
  }, [active, isWorkRoute, navigate, projectRoot, setWorkViewState]);

  React.useEffect(() => {
    const node = workSurfaceRef.current;
    if (!node) return;
    if (isWorkRoute) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, [isWorkRoute, shouldRenderWork]);

  React.useEffect(() => {
    const node = lanesSurfaceRef.current;
    if (!node) return;
    if (isLanesRoute) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, [isLanesRoute, shouldRenderLanes]);

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

  const lanesSurface = shouldRenderLanes ? (
    <Routes location={visibleLanesRoute}>
      <Route path="/lanes/*" element={
        <div
          ref={lanesSurfaceRef}
          className="h-full min-h-0 w-full"
          aria-hidden={!isLanesRoute}
          style={!isLanesRoute
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
              <LanesPage active={active && isLanesRoute} />
            </React.Suspense>
          </PageErrorBoundary>
        </div>
      } />
    </Routes>
  ) : null;

  return (
    <div className="relative h-full min-h-0 w-full">
      {workSurface}
      {lanesSurface}
      {active && !isWorkRoute && !isLanesRoute ? (
        <Routes location={route}>
          <Route path="/" element={<Navigate to="/work" replace />} />
          <Route path="/project" element={<PageErrorBoundary><RunPage /></PageErrorBoundary>} />
          <Route path="/onboarding" element={<PageErrorBoundary><ProjectSetupPage /></PageErrorBoundary>} />
          <Route path="/glossary" element={<PageErrorBoundary><GlossaryPage /></PageErrorBoundary>} />
          <Route path="/files" element={
            <PageErrorBoundary>
              <React.Suspense fallback={LazyFallback}>{React.createElement(FilesTab as React.ComponentType<{ active?: boolean }>, routeProps)}</React.Suspense>
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
  projectBinding,
  route,
  store,
}: {
  active: boolean;
  project: ProjectInfo;
  projectBinding: OpenProjectBinding;
  route: string;
  store: AppStoreApi;
}) {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    hydrateProjectAppStore(store, {
      project,
      projectBinding,
      projectHydrated: true,
      showWelcome: false,
    });
  }, [project, projectBinding, store]);

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
  const activeProjectBinding = useAppStore((s) => s.projectBinding);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const projectTransition = useAppStore((s) => s.projectTransition);
  const projectTransitionError = useAppStore((s) => s.projectTransitionError);
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
    launchPromptClipboardEnabled: s.launchPromptClipboardEnabled,
    launchPromptClipboardNoticeEnabled: s.launchPromptClipboardNoticeEnabled,
    voiceInputEnabled: s.voiceInputEnabled,
  })));
  const storesRef = React.useRef(new Map<string, AppStoreApi>());
  const filesCacheKeysRef = React.useRef(new Map<string, string>());
  const lruRef = React.useRef<string[]>([]);
  const [routesBySurfaceKey, setRoutesBySurfaceKey] = React.useState<Record<string, string>>({});
  const isPersonalChatsRoute = location.pathname === "/chats" || location.pathname.startsWith("/chats/");
  const isExternalFilesRoute = location.pathname === "/files" && new URLSearchParams(location.search).has("externalPath");
  const activeBinding = !showWelcome && activeProject?.rootPath
    ? bindingForProject(activeProject, activeProjectBinding)
    : null;
  const activeSurfaceKey = activeBinding?.key ?? null;
  const previousActiveSurfaceKeyRef = React.useRef<string | null>(null);
  const pendingNavigationRef = React.useRef<{ surfaceKey: string; route: string } | null>(null);

  React.useEffect(() => {
    for (const store of storesRef.current.values()) {
      hydrateProjectAppStore(store, rootPrefs);
    }
  }, [rootPrefs]);

  React.useEffect(() => {
    if (!activeSurfaceKey) return;
    lruRef.current = [
      activeSurfaceKey,
      ...lruRef.current.filter((key) => key !== activeSurfaceKey),
    ];
  }, [activeSurfaceKey]);

  React.useEffect(() => {
    if (!activeSurfaceKey) return;
    const preload = () => {
      void preloadTerminalsPage().catch(() => undefined);
      void preloadLanesPage().catch(() => undefined);
      void preloadFilesTab().catch(() => undefined);
      void preloadCtoPage().catch(() => undefined);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(preload, { timeout: 900 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(preload, 150);
    return () => window.clearTimeout(handle);
  }, [activeSurfaceKey]);

  React.useEffect(() => {
    if (isPersonalChatsRoute) return;
    const previousSurfaceKey = previousActiveSurfaceKeyRef.current;
    if (previousSurfaceKey === activeSurfaceKey) return;
    const currentRoute = serializeStoredProjectRoute(location);
    if (previousSurfaceKey && currentRoute) {
      writeStoredProjectRoute(previousSurfaceKey, currentRoute);
      setRoutesBySurfaceKey((prev) => ({ ...prev, [previousSurfaceKey]: currentRoute }));
    }
    previousActiveSurfaceKeyRef.current = activeSurfaceKey;
    if (!activeSurfaceKey) return;
    const shouldKeepInitialRoute =
      currentRoute &&
      currentRoute !== "/project" &&
      currentRoute !== "/onboarding";
    if (!previousSurfaceKey && shouldKeepInitialRoute) {
      writeStoredProjectRoute(activeSurfaceKey, currentRoute);
      setRoutesBySurfaceKey((prev) => (prev[activeSurfaceKey] === currentRoute ? prev : { ...prev, [activeSurfaceKey]: currentRoute }));
      return;
    }
    const nextRoute = routesBySurfaceKey[activeSurfaceKey] ?? readStoredProjectRoute(activeSurfaceKey) ?? "/work";
    pendingNavigationRef.current = { surfaceKey: activeSurfaceKey, route: nextRoute };
    if (currentRoute !== nextRoute) {
      navigate(nextRoute, { replace: true });
    }
  }, [activeSurfaceKey, isPersonalChatsRoute, location, navigate, routesBySurfaceKey]);

  React.useEffect(() => {
    if (!activeSurfaceKey) return;
    const route = serializeStoredProjectRoute(location);
    if (!route) return;
    const pending = pendingNavigationRef.current;
    if (pending?.surfaceKey === activeSurfaceKey && pending.route !== route) return;
    if (pending?.surfaceKey === activeSurfaceKey && pending.route === route) {
      pendingNavigationRef.current = null;
    }
    writeStoredProjectRoute(activeSurfaceKey, route);
    setRoutesBySurfaceKey((prev) => (prev[activeSurfaceKey] === route ? prev : { ...prev, [activeSurfaceKey]: route }));
  }, [activeSurfaceKey, location]);

  const projectEntries = React.useMemo<ProjectSurfaceEntry[]>(() => {
    const entries: ProjectSurfaceEntry[] = [];
    const activeRemoteRoot =
      activeProjectBinding?.kind === "remote" ? activeProjectBinding.rootPath : null;
    const rootsFromTabs = openProjectTabRoots.length > 0
      ? openProjectTabRoots
      : activeProject?.rootPath && !activeRemoteRoot
        ? [activeProject.rootPath]
        : [];
    for (const root of rootsFromTabs) {
      const project = projectInfoByRoot[root] ?? (
        activeProject?.rootPath === root && !activeRemoteRoot ? activeProject : null
      );
      if (!project) continue;
      const binding = localProjectBindingForProject(project);
      entries.push({ surfaceKey: binding.key, project, binding });
    }
    if (activeProject && activeBinding && !entries.some((entry) => entry.surfaceKey === activeBinding.key)) {
      entries.unshift({
        surfaceKey: activeBinding.key,
        project: activeProject,
        binding: activeBinding,
      });
    }
    return entries;
  }, [activeBinding, activeProject, activeProjectBinding, openProjectTabRoots, projectInfoByRoot]);

  const mountedProjects = React.useMemo(() => {
    const lru = lruRef.current;
    const openSet = new Set(projectEntries.map((entry) => entry.surfaceKey));
    const ordered = [...projectEntries].sort((left, right) => {
      const leftIndex = lru.indexOf(left.surfaceKey);
      const rightIndex = lru.indexOf(right.surfaceKey);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
    const warm = ordered.slice(0, WARM_PROJECT_SURFACE_LIMIT);
    if (activeSurfaceKey && openSet.has(activeSurfaceKey) && !warm.some((entry) => entry.surfaceKey === activeSurfaceKey)) {
      warm.pop();
      const activeEntry = projectEntries.find((entry) => entry.surfaceKey === activeSurfaceKey);
      if (activeEntry) warm.unshift(activeEntry);
    }
    return warm;
  }, [activeSurfaceKey, projectEntries]);

  for (const entry of mountedProjects) {
    if (!storesRef.current.has(entry.surfaceKey)) {
      storesRef.current.set(entry.surfaceKey, createProjectAppStore(
        entry.project,
        entry.binding,
      ));
    }
    filesCacheKeysRef.current.set(
      entry.surfaceKey,
      filesProjectCacheKey(entry.binding, entry.project.rootPath),
    );
  }

  React.useEffect(() => {
    const mountedKeys = new Set(mountedProjects.map((entry) => entry.surfaceKey));
    for (const key of storesRef.current.keys()) {
      if (!mountedKeys.has(key)) {
        storesRef.current.delete(key);
        // Release the evicted surface's Files roster/tree caches with it —
        // module-level caches must not outlive the warm project surface.
        const filesCacheKey = filesCacheKeysRef.current.get(key);
        filesCacheKeysRef.current.delete(key);
        if (filesCacheKey) releaseFilesProjectCaches(filesCacheKey);
      }
    }
  }, [mountedProjects]);

  // A project open/switch that failed with a typed code takes over the whole
  // surface with the recovery flow. Un-coded string errors still fall through
  // to the dismissible banner in AppShell. Unmounts once the error is cleared
  // or a new transition begins.
  if (!projectTransition && projectTransitionError?.code && projectTransitionError.rootPath) {
    return (
      <div className="relative h-full min-h-0 w-full">
        <ProjectRecoveryScreen />
      </div>
    );
  }

  if (isExternalFilesRoute && (!activeProject || showWelcome || mountedProjects.length === 0)) {
    return (
      <PageErrorBoundary>
        <React.Suspense fallback={LazyFallback}>
          {React.createElement(FilesTab as React.ComponentType<{ active?: boolean }>, { active: true })}
        </React.Suspense>
      </PageErrorBoundary>
    );
  }

  if (!projectHydrated && !activeProject) {
    return GuardLoadingFallback;
  }

  if (!isPersonalChatsRoute && (!activeProject || showWelcome || mountedProjects.length === 0)) {
    return (
      <PageErrorBoundary>
        <RunPage />
      </PageErrorBoundary>
    );
  }

  const transitionTargetName = projectTransition?.rootPath
    ? projectInfoByRoot[projectTransition.rootPath]?.displayName
      ?? projectNameFromRoot(projectTransition.rootPath)
    : null;
  let transitionLabel: string | null = null;
  switch (projectTransition?.kind) {
    case "switching":
      transitionLabel = `Switching${transitionTargetName ? ` to ${transitionTargetName}` : " projects"}...`;
      break;
    case "opening":
      transitionLabel = "Opening project...";
      break;
    case "closing":
      transitionLabel = "Closing project...";
      break;
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      {mountedProjects.map((entry) => {
        const { binding: projectBinding, project, surfaceKey } = entry;
        const store = storesRef.current.get(surfaceKey);
        if (!store) return null;
        const liveRoute = surfaceKey === activeSurfaceKey ? serializeProjectRoute(location) : null;
        const route = liveRoute ?? routesBySurfaceKey[surfaceKey] ?? readStoredProjectRoute(surfaceKey) ?? "/work";
        return (
          <ProjectSurface
            key={surfaceKey}
            active={!isPersonalChatsRoute && surfaceKey === activeSurfaceKey}
            project={project}
            projectBinding={projectBinding}
            route={route}
            store={store}
          />
        );
      })}
      {isPersonalChatsRoute ? (
        <PageErrorBoundary>
          <React.Suspense fallback={LazyFallback}>
            <PersonalChatsPage standalone={showWelcome || !activeProject} />
          </React.Suspense>
        </PageErrorBoundary>
      ) : null}
      {transitionLabel ? <ProjectTransitionVeil label={transitionLabel} /> : null}
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
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [inboundTarget, setInboundTarget] = React.useState<InboundDeeplinkTarget | null>(null);
  // Refs keep async dispatch paths reading FRESH state: the switch-project
  // modal re-dispatches after `switchToPath`, and a callback captured before
  // the switch would otherwise close over the previous project's lanes/root.
  const lanesRef = React.useRef(lanes);
  lanesRef.current = lanes;
  const projectRootRef = React.useRef<string | null>(project?.rootPath ?? null);
  projectRootRef.current = project?.rootPath ?? null;

  const resolveActiveProjectRepo = React.useCallback(async (): Promise<GithubRepoSlug | null> => {
    const lane = lanesRef.current[0];
    if (!lane) return null;
    try {
      const remote = await window.ade?.git?.getOriginRemote?.({ laneId: lane.id });
      return parseGithubRemoteUrl(remote?.remoteUrl ?? null);
    } catch {
      return null;
    }
  }, []);

  const resolvePortableFallback = React.useCallback(async (
    entity: "chat" | "lane" | "commit",
    original: AppNavigationTarget,
    options: InboundDeeplinkDispatchOptions,
  ): Promise<boolean> => {
    if (options.forceLocal || options.suppressUnresolved) return false;
    const envelope = original.kind === "work"
      || original.kind === "chat"
      || original.kind === "lane"
      || original.kind === "commit"
      || original.kind === "artifact"
      ? original.envelope ?? null
      : null;
    if (!envelope?.repoOwner || !envelope.repoName) {
      setInboundTarget({ kind: "foreign", entity, envelope, original });
      return true;
    }
    const targetRepo: GithubRepoSlug = { owner: envelope.repoOwner, repo: envelope.repoName };
    const activeRepo = await resolveActiveProjectRepo();
    if (githubRepoSlugsEqual(activeRepo, targetRepo)) {
      setInboundTarget({ kind: "foreign", entity, envelope, original });
      return true;
    }

    const projectApi = window.ade?.project as typeof window.ade.project & {
      findForRepo?: (args: { repoOwner: string; repoName: string }) => Promise<{
        rootPath: string;
        displayName: string;
      } | null>;
    };
    const match = await projectApi?.findForRepo?.({
      repoOwner: envelope.repoOwner,
      repoName: envelope.repoName,
    }).catch(() => null);
    if (match?.rootPath && match.rootPath !== projectRootRef.current) {
      setInboundTarget({ kind: "switch-project", entity, project: match, original });
      return true;
    }
    setInboundTarget({ kind: "foreign", entity, envelope, original });
    return true;
  }, [resolveActiveProjectRepo]);

  const dispatchTarget = React.useCallback(async (
    target: AppNavigationTarget,
    options: InboundDeeplinkDispatchOptions = {},
  ): Promise<boolean> => {
    const laneById = (laneId: string | null | undefined) =>
      laneId ? lanesRef.current.find((lane) => lane.id === laneId) ?? null : null;

    if (target.kind === "chat" || target.kind === "work") {
      if (target.sessionId && !options.forceLocal) {
        const localSession = await window.ade?.sessions?.get?.(target.sessionId).catch(() => null);
        if (!localSession) {
          const handled = await resolvePortableFallback("chat", target, options);
          if (handled) return true;
        }
      }
      const params = new URLSearchParams();
      if (target.sessionId) params.set("sessionId", target.sessionId);
      if (target.laneId) params.set("laneId", target.laneId);
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      navigate(`/work${params.toString() ? `?${params.toString()}` : ""}`);
      return true;
    }

    if (target.kind === "file") {
      // Defense in depth: targets normally arrive parser-validated, but the
      // app/navigate RPC path bypasses URL parsing — never compose a path
      // that could escape the resolved root.
      if (!isValidRepoRelativePath(target.path)) return true;
      let lane = laneById(target.laneId);
      if (target.laneId && !lane) {
        // An explicit lane must never silently degrade to the project root —
        // the same relative path exists in every worktree. Lanes may still be
        // loading (cold start, just-switched project): refresh and wait
        // briefly before giving up.
        void refreshLanes({ includeStatus: false }).catch(() => undefined);
        for (let attempt = 0; attempt < 6 && !lane; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          lane = laneById(target.laneId);
        }
        if (!lane) {
          if (options.suppressUnresolved) return false;
          navigate("/files");
          return true;
        }
      }
      const root = lane?.worktreePath || projectRootRef.current || "";
      const localPath = root
        ? `${root.replace(/\/+$/, "")}/${target.path.replace(/^\/+/, "")}`
        : target.path;
      const params = new URLSearchParams();
      params.set("externalPath", localPath);
      params.set("externalOpen", String(Date.now()));
      if (target.line != null) params.set("line", String(target.line));
      navigate(`/files?${params.toString()}`);
      return true;
    }

    if (target.kind === "commit") {
      const lane = laneById(target.laneId);
      if (lane) {
        const params = new URLSearchParams();
        params.set("laneId", lane.id);
        params.set("focus", "single");
        // LanesPage consumes commitSha and opens the Git detail for that commit.
        params.set("commitSha", target.sha);
        navigate(`/lanes?${params.toString()}`);
        return true;
      }
      if (!options.forceLocal) {
        const handled = await resolvePortableFallback("commit", target, options);
        if (handled) return true;
        // During switch-project retries the lane list may still be loading —
        // report unhandled so the caller retries instead of dropping the sha.
        if (options.suppressUnresolved) return false;
      }
      // Last resort: keep the lane hint + sha in the route so LanesPage can
      // apply them once lanes load, instead of landing on a bare list.
      const params = new URLSearchParams();
      if (target.laneId) {
        params.set("laneId", target.laneId);
        params.set("focus", "single");
        params.set("commitSha", target.sha);
      }
      navigate(params.toString() ? `/lanes?${params.toString()}` : "/lanes");
      return true;
    }

    if (target.kind === "artifact") {
      // History does not expose a stable focused-artifact URL yet; route to the
      // local proof/history surface optimistically.
      navigate("/history");
      return true;
    }

    if (target.kind === "lane") {
      const lane = laneById(target.laneId);
      if (!lane && !options.forceLocal) {
        const handled = await resolvePortableFallback("lane", target, options);
        if (handled) return true;
      }
      const params = new URLSearchParams();
      params.set("laneId", target.laneId);
      if (target.sessionId) params.set("sessionId", target.sessionId);
      navigate(`/lanes?${params.toString()}`);
      return true;
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
      return true;
    }

    if (target.kind === "branch") {
      setInboundTarget({
        kind: "branch",
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        branch: target.branch,
        prNumber: target.prNumber ?? null,
      });
      return true;
    }

    if (target.kind === "linear-issue") {
      requestLinearIssueQuickView({
        issueIdentifier: target.issueIdentifier,
        branch: target.branch ?? null,
        source: "deeplink",
      });
      return true;
    }

    if (target.kind === "files-external") {
      const params = new URLSearchParams();
      params.set("externalPath", target.path);
      params.set("externalOpen", String(Date.now()));
      navigate(`/files?${params.toString()}`);
      return true;
    }

    if (target.kind === "route") {
      navigate(target.route.startsWith("/") ? target.route : `/${target.route}`);
      return true;
    }

    return false;
  }, [navigate, refreshLanes, resolvePortableFallback]);

  // The modal's post-switch retry loop must always call the LATEST dispatcher
  // (fresh lanes/project), not the instance captured when the card rendered.
  const dispatchTargetRef = React.useRef(dispatchTarget);
  dispatchTargetRef.current = dispatchTarget;
  const dispatchLatest = React.useCallback(
    (target: AppNavigationTarget, options?: InboundDeeplinkDispatchOptions) =>
      dispatchTargetRef.current(target, options),
    [],
  );

  React.useEffect(() => {
    const onNavigate = window.ade?.app?.onNavigate;
    if (!onNavigate) return;
    return onNavigate((request: AppNavigationRequest) => {
      void dispatchLatest(request.target);
    });
  }, [dispatchLatest]);

  if (!inboundTarget) return null;
  return (
    <InboundDeeplinkModal
      target={inboundTarget}
      lanes={lanes}
      onClose={() => setInboundTarget(null)}
      onDispatchTarget={dispatchLatest}
      projectOpen={Boolean(project?.rootPath)}
      onLaneOpened={(laneId) => {
        const params = new URLSearchParams({ laneId });
        void refreshLanes({ includeStatus: false })
          .catch(() => undefined)
          .finally(() => navigate(`/lanes?${params.toString()}`));
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
  const projectRoot = useAppStore(selectActiveProjectRoot);

  React.useEffect(() => {
    const w = window as Window & { __ADE_GET_DIRTY_FILE_TEXT__?: (p: string) => string | undefined };
    w.__ADE_GET_DIRTY_FILE_TEXT__ = (absPath: string) => getDirtyFileTextForWindow(absPath);
    return () => {
      delete w.__ADE_GET_DIRTY_FILE_TEXT__;
    };
  }, []);

  React.useEffect(() => {
    void getAiStatusCached({ projectRoot: projectRoot ?? null }).catch(() => undefined);
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
