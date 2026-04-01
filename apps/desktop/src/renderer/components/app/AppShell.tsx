import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  GitBranch,
  GithubLogo,
  GitPullRequest,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { RightEdgeFloatingPane } from "./RightEdgeFloatingPane";
import { getPrToastHeadline, getPrToastMeta, getPrToastSummary, getPrToastTone, type PrToastTone } from "./prToastPresentation";
import { TabBackground } from "../ui/TabBackground";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import type {
  AiSettingsStatus,
  ContextStatus,
  GitHubStatus,
  LinearWorkflowEventPayload,
  OnboardingStatus,
  PrEventPayload,
  TerminalSessionSummary,
} from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { listSessionsCached } from "../../lib/sessionListCache";
import { isRunOwnedSession } from "../../lib/sessions";
import { summarizeTerminalAttention } from "../../lib/terminalAttention";
import { getStoredZoomLevel, displayZoomToLevel } from "../../lib/zoom";
import { ONBOARDING_STATUS_UPDATED_EVENT } from "../../lib/onboardingStatusEvents";
import { cn } from "../ui/cn";
import { describeContextDocHealth, listActionableContextDocs, listContextDocsByHealth } from "../context/contextShared";

type PrToast = {
  id: string;
  event: Extract<PrEventPayload, { type: "pr-notification" }>;
};

type AiBannerState = {
  laneId: string | null;
  jobId: string | null;
  status: string | null;
  error: string;
  createdAt: string;
};

type LinearWorkflowToast = {
  id: string;
  event: Extract<LinearWorkflowEventPayload, { type: "linear-workflow-notification" }>;
};

const EMPTY_TERMINAL_ATTENTION = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none" as const,
  byLaneId: {}
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
  const setProject = useAppStore((s) => s.setProject);
  const setProjectHydrated = useAppStore((s) => s.setProjectHydrated);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);
  const refreshKeybindings = useAppStore((s) => s.refreshKeybindings);
  const setTerminalAttention = useAppStore((s) => s.setTerminalAttention);
  const providerMode = useAppStore((s) => s.providerMode);
  const keybindings = useAppStore((s) => s.keybindings);
  const lanes = useAppStore((s) => s.lanes);
  const project = useAppStore((s) => s.project);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const closeProject = useAppStore((s) => s.closeProject);
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const [commandOpen, setCommandOpen] = useState(false);
  const visitedTabsRef = useRef(new Set<string>());
  const isFirstVisit = !visitedTabsRef.current.has(location.pathname);
  const [prToasts, setPrToasts] = useState<PrToast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const dismissPrToast = (id: string) => {
    setPrToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = toastTimersRef.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    toastTimersRef.current.delete(id);
  };
  const [linearWorkflowToasts, setLinearWorkflowToasts] = useState<LinearWorkflowToast[]>([]);
  const linearToastTimersRef = useRef<Map<string, number>>(new Map());
  const [aiFailure, setAiFailure] = useState<AiBannerState | null>(null);
  const [aiMockProvider, setAiMockProvider] = useState<{ createdAt: string } | null>(null);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [onboardingStatusLoading, setOnboardingStatusLoading] = useState(false);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [dismissedContextBannerRoots, setDismissedContextBannerRoots] = useState<Record<string, true>>({});
  const [projectMissing, setProjectMissing] = useState(false);
  const isOnboardingRoute = location.pathname === "/onboarding";
  const shouldTrackTerminalAttention =
    Boolean(project?.rootPath)
    && !showWelcome
    && (location.pathname === "/work" || location.pathname === "/lanes");

  useEffect(() => {
    console.info(`renderer.route_change ${JSON.stringify({
      pathname: location.pathname,
      projectRoot: project?.rootPath ?? null,
      showWelcome,
    })}`);
  }, [location.pathname, project?.rootPath, showWelcome]);

  useEffect(() => {
    let cancelled = false;
    setProjectHydrated(false);
    const initializeProjectState = async () => {
      try {
        const nextProject = await window.ade.app.getProject();
        if (cancelled) return;

        const hasStoredProject = Boolean(nextProject);
        if (nextProject) {
          setProject(nextProject);
          setShowWelcome(false);
        } else {
          setProject(null);
          setShowWelcome(true);
        }

        if (hasStoredProject) {
          void Promise.allSettled([
            refreshLanes({ includeStatus: false }),
            refreshKeybindings()
          ]);
          window.setTimeout(() => {
            if (cancelled) return;
            void refreshLanes({ includeStatus: true });
          }, 1_200);
          window.setTimeout(() => {
            if (cancelled) return;
            void refreshProviderMode();
          }, 1_800);
        }
      } catch {
        if (cancelled) return;
        setProject(null);
        setProjectMissing(false);
        setShowWelcome(true);
      } finally {
        if (!cancelled) setProjectHydrated(true);
      }
    };

    void initializeProjectState();
    return () => {
      cancelled = true;
    };
  }, [setProject, setProjectHydrated, refreshLanes, refreshProviderMode, refreshKeybindings, setShowWelcome]);

  useEffect(() => {
    if (!shouldTrackTerminalAttention) {
      setTerminalAttention(EMPTY_TERMINAL_ATTENTION);
      return;
    }

    let refreshTimer: number | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;

    const refreshTerminalAttention = async () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      if (document.visibilityState !== "visible") return;
      refreshInFlight = true;
      try {
        const sessions: TerminalSessionSummary[] = (await listSessionsCached({ limit: 150 }))
          .filter((session) => !isRunOwnedSession(session));
        setTerminalAttention(summarizeTerminalAttention(sessions));
      } catch {
        // best effort
      } finally {
        refreshInFlight = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh(250);
        }
      }
    };

    const scheduleRefresh = (delayMs = 2_500) => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshTerminalAttention();
      }, delayMs);
    };

    scheduleRefresh(2_500);

    const unsubData = window.ade.pty.onData(() => scheduleRefresh());
    const unsubExit = window.ade.pty.onExit(() => scheduleRefresh());
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
      try {
        unsubData();
        unsubExit();
      } catch {
        // ignore
      }
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [setTerminalAttention, shouldTrackTerminalAttention]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.rootPath || showWelcome) {
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
  }, [location.pathname, project?.rootPath, showWelcome]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OnboardingStatus>).detail;
      if (!detail) return;
      setOnboardingStatus(detail);
      setOnboardingStatusLoading(false);
    };
    window.addEventListener(ONBOARDING_STATUS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ONBOARDING_STATUS_UPDATED_EVENT, handler);
  }, []);

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
      const missingPath = typeof payload?.rootPath === "string" ? payload.rootPath.trim() : "";
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
    let cancelled = false;
    if (!project?.rootPath) {
      setContextStatus(null);
      setAiStatus(null);
      setGithubStatus(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        window.ade.context.getStatus(),
        window.ade.ai.getStatus(),
        window.ade.github.getStatus(),
      ]).then((results) => {
        if (cancelled) return;
        const [contextResult, aiResult, githubResult] = results;
        setContextStatus(contextResult.status === "fulfilled" ? contextResult.value : null);
        setAiStatus(aiResult.status === "fulfilled" ? aiResult.value : null);
        setGithubStatus(githubResult.status === "fulfilled" ? githubResult.value : null);
      });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project?.rootPath]);

  useEffect(() => {
    if (!project?.rootPath) return;
    return window.ade.context?.onStatusChanged?.((status) => {
      setContextStatus(status);
    }) ?? (() => {});
  }, [project?.rootPath]);

  useEffect(() => {
    if (!project?.rootPath || showWelcome) return;
    if (isOnboardingRoute) return;
    if (onboardingStatusLoading) return;
    if (!onboardingStatus?.freshProject || onboardingStatus.completedAt || onboardingStatus.dismissedAt) return;
    navigate("/onboarding", { replace: true });
  }, [
    isOnboardingRoute,
    navigate,
    onboardingStatus?.completedAt,
    onboardingStatus?.dismissedAt,
    onboardingStatus?.freshProject,
    onboardingStatusLoading,
    project?.rootPath,
    showWelcome,
  ]);

  useEffect(() => {
    setAiFailure(null);
    setAiMockProvider(null);
  }, [providerMode]);

  const hasAnyAiProvider = useMemo(() => {
    if (!aiStatus) return false;
    const runtimeOrLocal =
      aiStatus.providerConnections?.claude.authAvailable
      || aiStatus.providerConnections?.codex.authAvailable
      || aiStatus.providerConnections?.cursor?.authAvailable;
    return Boolean(runtimeOrLocal || (aiStatus.detectedAuth?.length ?? 0) > 0);
  }, [aiStatus]);

  const missingContextDocs = useMemo(
    () => listContextDocsByHealth(contextStatus, "missing"),
    [contextStatus],
  );

  const actionableContextDocs = useMemo(
    () => listActionableContextDocs(contextStatus),
    [contextStatus],
  );

  const actionableContextSummary = useMemo(
    () => actionableContextDocs.map((doc) => `${doc.label} (${describeContextDocHealth(doc)})`).join(", "),
    [actionableContextDocs],
  );

  const missingContextSummary = useMemo(
    () => missingContextDocs.map((doc) => doc.label).join(", "),
    [missingContextDocs],
  );
  const currentProjectRoot = project?.rootPath ?? null;
  const contextBannerDismissed = Boolean(currentProjectRoot && dismissedContextBannerRoots[currentProjectRoot]);
  const generationState = contextStatus?.generation.state;

  const commandPaletteBinding = useMemo(
    () => getEffectiveBinding(keybindings, "commandPalette.open", "Mod+K"),
    [keybindings]
  );

  // Initialize zoom from localStorage on mount (uses Electron webFrame)
  useEffect(() => {
    try {
      const clamped = getStoredZoomLevel();
      const zoomLevel = displayZoomToLevel(clamped);
      window.ade.zoom.setLevel(zoomLevel);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const dismiss = (id: string) => {
      setLinearWorkflowToasts((prev) => prev.filter((toast) => toast.id !== id));
      const timer = linearToastTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      linearToastTimersRef.current.delete(id);
    };

    const unsub =
      window.ade.cto?.onLinearWorkflowEvent?.((event: LinearWorkflowEventPayload) => {
        if (event.type !== "linear-workflow-notification") return;
        const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        setLinearWorkflowToasts((prev) => [{ id, event }, ...prev].slice(0, 4));
        const timer = window.setTimeout(() => dismiss(id), 18_000);
        linearToastTimersRef.current.set(id, timer);
      }) ?? (() => {});

    return () => {
      unsub();
      for (const timer of linearToastTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      linearToastTimersRef.current.clear();
    };
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
    const dismiss = (id: string) => {
      setPrToasts((prev) => prev.filter((toast) => toast.id !== id));
      const timer = toastTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    };

    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-notification") return;
      const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
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
    };
  }, []);

  const tintClass = useMemo(() => {
    const tintMap: Record<string, string> = {
      "/project": "tab-tint-project",
      "/lanes": "tab-tint-lanes",
      "/files": "tab-tint-files",
      "/work": "tab-tint-work",
      "/graph": "tab-tint-graph",
      "/prs": "tab-tint-prs",
      "/history": "tab-tint-history",
      "/automations": "tab-tint-automations",
      "/missions": "tab-tint-missions",
      "/settings": "tab-tint-settings",
    };
    return tintMap[location.pathname] ?? "";
  }, [location.pathname]);

  const shouldHoldProjectRouteForOnboarding =
    Boolean(project?.rootPath)
    && !showWelcome
    && location.pathname === "/project"
    && onboardingStatusLoading;
  const hideSidebar = isOnboardingRoute || shouldHoldProjectRouteForOnboarding;
  const showContextBanner =
    !hideSidebar &&
    Boolean(project?.rootPath) &&
    !showWelcome &&
    generationState !== "pending" &&
    generationState !== "running" &&
    actionableContextDocs.length > 0 &&
    !contextBannerDismissed;

  return (
    <div className="h-screen w-screen text-fg overflow-hidden flex flex-col bg-bg">
      <div className="shrink-0 relative z-20">
        <TopBar />
      </div>

      {!hideSidebar && projectMissing && project?.rootPath ? (
        <div className="shrink-0 mx-2 mt-1 rounded bg-red-500/8 px-3 py-1.5 text-[11px] font-mono text-red-800">
          <span className="font-semibold">Project directory not found</span> — it may have been moved or deleted.
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
                  .catch(() => { });
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
                  .catch(() => { });
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

      {!hideSidebar && project?.rootPath && !showWelcome && !hasAnyAiProvider ? (
        <div className="shrink-0 mx-2 mt-1 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          No AI provider is configured yet. <Link to="/settings?tab=ai" className="underline">Set up AI</Link>
        </div>
      ) : null}

      {!hideSidebar && project?.rootPath && !showWelcome && !isOnboardingRoute && githubStatus !== null && !githubStatus.tokenStored ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          GitHub is not connected for this ADE app yet. <Link to="/settings?tab=integrations" className="underline">Connect GitHub</Link>
        </div>
      ) : null}

      {!hideSidebar && providerMode === "subscription" && aiMockProvider ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          LLM provider is "mock" — AI will return placeholder content. <Link to="/settings?tab=ai" className="underline">Open AI settings</Link>
        </div>
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
              title="Open lane memory"
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

      {!hideSidebar && project?.rootPath && !showWelcome && (contextStatus?.generation.state === "pending" || contextStatus?.generation.state === "running") ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-sky-500/6 px-3 py-1.5 text-[11px] font-mono text-sky-800 animate-pulse">
          Generating context docs... <Link to="/settings?tab=workspace" className="underline">Open context settings</Link>
        </div>
      ) : null}

      {!hideSidebar && project?.rootPath && !showWelcome && contextStatus?.generation.state === "failed" ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-red-500/6 px-3 py-1.5 text-[11px] font-mono text-red-800">
          Context doc generation failed{contextStatus.generation.error ? `: ${contextStatus.generation.error}` : "."} <Link to="/settings?tab=workspace" className="underline">Retry generation</Link>
        </div>
      ) : null}

      {showContextBanner ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          <span>
            {missingContextDocs.length > 0
              ? `Missing ADE context docs: ${missingContextSummary}.`
              : `ADE context docs need regeneration: ${actionableContextSummary}.`}
            <Link to="/settings?tab=workspace" className="ml-2 underline">Generate docs</Link>
          </span>
          <button
            type="button"
            className="ml-2 text-amber-900/70 hover:text-amber-900"
            onClick={() => {
              if (!currentProjectRoot) return;
              setDismissedContextBannerRoots((prev) => ({ ...prev, [currentProjectRoot]: true }));
            }}
            title="Dismiss for this session"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        {hideSidebar ? null : (
          <aside
            className="ade-sidebar-clip shrink-0 z-10 border-r"
          >
            <div className="ade-sidebar flex flex-col py-2 h-full">
              <TabNav />
            </div>
          </aside>
        )}

        <main className={cn("relative flex min-h-0 min-w-0 flex-1", tintClass)}>
          <TabBackground />
          <div className="relative z-[1] h-full min-h-0 w-full" data-tab-revisit={!isFirstVisit || undefined}>
            {shouldHoldProjectRouteForOnboarding ? (
              <div className="flex h-full w-full items-center justify-center">
                <div className="text-xs font-mono text-muted-fg/70">Opening project setup...</div>
              </div>
            ) : (
              children
            )}
          </div>
          <RightEdgeFloatingPane />

          {prToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-2 right-2 z-[95] flex w-[min(380px,calc(100vw-20px))] flex-col gap-1.5">
              {prToasts.map((toast) => {
                const laneName = lanes.find((lane) => lane.id === toast.event.laneId)?.name ?? toast.event.laneId;
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
                      <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", toneClasses.iconWrap)}>
                        <Icon size={16} weight="fill" className={toneClasses.iconClass} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={cn("inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium", toneClasses.badge)}>
                                {toast.event.title}
                              </span>
                              <span className="text-[11px] font-medium text-muted-fg">#{toast.event.prNumber}</span>
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
                            {meta.map((item, index) => (
                              <span
                                key={`${toast.id}-meta-${index}`}
                                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/50 bg-black/10 px-2 py-1 text-[10px] text-muted-fg"
                              >
                                {item.includes("/") ? <GitBranch size={10} /> : item.includes("#") || (toast.event.repoOwner && item.includes(toast.event.repoOwner)) ? <GithubLogo size={10} /> : <GitPullRequest size={10} />}
                                <span className="truncate">{item}</span>
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-muted-fg">{summary}</div>
                        <div className="mt-3 flex justify-end gap-2">
                          <button
                            type="button"
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-transparent px-3 text-[11px] font-medium text-fg/85 transition-colors hover:border-fg/20 hover:bg-fg/[0.04] hover:text-fg"
                            onClick={() => {
                              selectLane(toast.event.laneId);
                              setLaneInspectorTab(toast.event.laneId, "merge");
                              window.location.hash = `#/lanes?laneId=${encodeURIComponent(toast.event.laneId)}&focus=single&inspectorTab=merge`;
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
                              tone === "danger" ? "bg-red-300" : tone === "warning" ? "bg-amber-300" : tone === "success" ? "bg-emerald-300" : "bg-[#A78BFA]",
                            )}
                            onClick={() => {
                              void window.ade.prs.openInGitHub(toast.event.prId).then(
                                () => dismissPrToast(toast.id),
                                () => { /* keep toast visible on failure */ },
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
            </div>
          ) : null}

          {linearWorkflowToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-2 left-2 z-[95] flex w-[min(360px,calc(100vw-20px))] flex-col gap-1.5">
              {linearWorkflowToasts.map((toast) => (
                <div key={toast.id} className="pointer-events-auto rounded border border-border/50 bg-card px-3 py-2 text-[11px] font-mono shadow-float">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-fg truncate">{toast.event.title}</div>
                      <div className="mt-0.5 truncate text-muted-fg">{toast.event.issueIdentifier}</div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-muted-fg hover:text-fg"
                      onClick={() => {
                        setLinearWorkflowToasts((prev) => prev.filter((t) => t.id !== toast.id));
                        const timer = linearToastTimersRef.current.get(toast.id);
                        if (timer != null) window.clearTimeout(timer);
                        linearToastTimersRef.current.delete(toast.id);
                      }}
                      title="Dismiss"
                    >
                      ×
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-fg line-clamp-3">{toast.event.message}</div>
                </div>
              ))}
            </div>
          ) : null}
        </main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
