import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { RightEdgeFloatingPane } from "./RightEdgeFloatingPane";
import { TabBackground } from "../ui/TabBackground";
import { GenerateDocsModal } from "../context/GenerateDocsModal";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import type { ContextStatus, PrEventPayload, TerminalSessionSummary } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { summarizeTerminalAttention } from "../../lib/terminalAttention";
import { cn } from "../ui/cn";

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

const EMPTY_TERMINAL_ATTENTION = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none" as const,
  byLaneId: {}
};

const ONBOARDING_DISMISSED_KEY = "ade:onboarding:dismissed:v1";
const ZOOM_LEVEL_KEY = "ade:zoom-level";
const MIN_ZOOM_LEVEL = 70;
const MAX_ZOOM_LEVEL = 150;
const ZOOM_OFFSET = 10;
const LEGACY_DEFAULT_ZOOM = 110;
const DEFAULT_ZOOM = 100;

function normalizeZoomLevel(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_ZOOM;
  if (raw === LEGACY_DEFAULT_ZOOM) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.trunc(raw)));
}

function getStoredZoomLevel(): number {
  try {
    const raw = parseInt(localStorage.getItem(ZOOM_LEVEL_KEY) || `${DEFAULT_ZOOM}`, 10);
    const normalized = normalizeZoomLevel(raw);
    const rawValue = Number.isFinite(raw) ? raw : DEFAULT_ZOOM;
    if (rawValue !== normalized) {
      localStorage.setItem(ZOOM_LEVEL_KEY, String(normalized));
    }
    return normalized;
  } catch {
    return DEFAULT_ZOOM;
  }
}

function mapDisplayZoomToLevel(displayZoom: number): number {
  return Math.log((Math.trunc(displayZoom) + ZOOM_OFFSET) / 100) / Math.log(1.2);
}

function shortId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const setProject = useAppStore((s) => s.setProject);
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
  const [aiFailure, setAiFailure] = useState<AiBannerState | null>(null);
  const [aiMockProvider, setAiMockProvider] = useState<{ createdAt: string } | null>(null);
  const [onboardingIncomplete, setOnboardingIncomplete] = useState(false);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [contextGenerateOpen, setContextGenerateOpen] = useState(false);
  const [projectMissing, setProjectMissing] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    const initializeProjectState = async () => {
      try {
        const nextProject = await window.ade.app.getProject();
        if (cancelled) return;
        const status = await window.ade.onboarding.getStatus().catch(() => null);
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
          await Promise.all([
            refreshLanes(),
            refreshProviderMode(),
            refreshKeybindings().catch(() => { })
          ]);
        }
        setOnboardingIncomplete(Boolean(status && !status.completedAt));
      } catch {
        if (cancelled) return;
        setProject(null);
        setProjectMissing(false);
        setShowWelcome(true);
      }
    };

    void initializeProjectState();
    return () => {
      cancelled = true;
    };
  }, [setProject, refreshLanes, refreshProviderMode, refreshKeybindings, setShowWelcome]);

  useEffect(() => {
    if (!project?.rootPath || showWelcome) {
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
        const sessions: TerminalSessionSummary[] = await window.ade.sessions.list({ limit: 500 });
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

    const scheduleRefresh = (delayMs = 1_200) => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshTerminalAttention();
      }, delayMs);
    };

    scheduleRefresh(0);

    const unsubData = window.ade.pty.onData(() => scheduleRefresh());
    const unsubExit = window.ade.pty.onExit(() => scheduleRefresh());
    const unsubChat = window.ade.agentChat.onEvent(() => scheduleRefresh(220));
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleRefresh();
    }, 5_000);
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
        unsubChat();
      } catch {
        // ignore
      }
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [project?.rootPath, showWelcome, setTerminalAttention]);

  useEffect(() => {
    let cancelled = false;
    void window.ade.onboarding
      .getStatus()
      .then((status) => {
        if (cancelled) return;
        setOnboardingIncomplete(Boolean(status && !status.completedAt));
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

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
      return;
    }
    void window.ade.context
      .getStatus()
      .then((next) => {
        if (cancelled) return;
        setContextStatus(next);
      })
      .catch(() => {
        if (cancelled) return;
        setContextStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, location.pathname]);

  useEffect(() => {
    setAiFailure(null);
    setAiMockProvider(null);
  }, [providerMode]);

  const commandPaletteBinding = useMemo(
    () => getEffectiveBinding(keybindings, "commandPalette.open", "Mod+K"),
    [keybindings]
  );

  // Initialize zoom from localStorage on mount (uses Electron webFrame)
  useEffect(() => {
    try {
      const clamped = getStoredZoomLevel();
      const zoomLevel = mapDisplayZoomToLevel(clamped);
      window.ade.zoom.setLevel(zoomLevel);
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

  const commandHint = useMemo(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const primary = commandPaletteBinding.split(",")[0]?.trim() ?? "Mod+K";
    const normalized = primary.replace(/\bMod\b/g, isMac ? "Cmd" : "Ctrl");
    return normalized;
  }, [commandPaletteBinding]);

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
      "/test": "",
      "/settings": "tab-tint-settings",
    };
    return tintMap[location.pathname] ?? "";
  }, [location.pathname]);

  return (
    <div className="h-screen w-screen text-fg overflow-hidden flex flex-col bg-bg">
      <div className="shrink-0 relative z-20">
        <TopBar
          onOpenCommandPalette={() => setCommandOpen(true)}
          commandPaletteOpen={commandOpen}
          commandHint={
            <span className="font-mono">{commandHint}</span>
          }
        />
      </div>

      {projectMissing && project?.rootPath ? (
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

      {project?.rootPath && !showWelcome && providerMode === "guest" ? (
        <div className="shrink-0 mx-2 mt-1 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          Running in Guest Mode - AI details disabled. <Link to="/settings?tab=providers" className="underline">Set up provider</Link>
        </div>
      ) : null}

      {project?.rootPath && !showWelcome && contextStatus?.docs?.some((doc) => !doc.exists) ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          Missing ADE context docs:
          {contextStatus.docs.filter((doc) => !doc.exists).map((doc) => ` ${doc.label}`).join(", ")}.
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setContextGenerateOpen(true)}
            >
              Generate Docs
            </Button>
            <Link to="/settings?tab=context" className="underline">Open Settings</Link>
          </span>
        </div>
      ) : null}

      {providerMode === "subscription" && aiMockProvider ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-amber-500/6 px-3 py-1.5 text-[11px] font-mono text-amber-800">
          LLM provider is "mock" — AI will return placeholder content. <Link to="/settings?tab=providers" className="underline">Open Settings</Link>
        </div>
      ) : null}

      {providerMode === "subscription" && aiFailure ? (
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

      {onboardingIncomplete && !onboardingDismissed && location.pathname !== "/onboarding" ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded bg-card/50 px-3 py-1.5 text-[11px] font-mono text-fg">
          <span className="font-semibold">Onboarding is incomplete.</span>{" "}
          Set it up in{" "}
          <Link to="/settings?tab=context" className="underline">Settings &gt; Context &amp; Docs</Link>.
          <button
            type="button"
            className="ml-2 text-muted-fg hover:text-fg"
            onClick={() => {
              setOnboardingDismissed(true);
              try {
                window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
              } catch {
                // ignore
              }
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        <aside
          className="ade-sidebar-clip shrink-0 z-10 border-r"
        >
          <div className="ade-sidebar flex flex-col py-2 h-full">
            <TabNav />
          </div>
        </aside>

        <main className={cn("relative flex min-h-0 min-w-0 flex-1", tintClass)}>
          <TabBackground />
          <div className="relative z-[1] h-full min-h-0 w-full" data-tab-revisit={!isFirstVisit || undefined}>
            {children}
          </div>
          <RightEdgeFloatingPane />

          {prToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-2 right-2 z-[95] flex w-[min(380px,calc(100vw-20px))] flex-col gap-1.5">
              {prToasts.map((toast) => {
                const laneName = lanes.find((lane) => lane.id === toast.event.laneId)?.name ?? toast.event.laneId;
                return (
                  <div key={toast.id} className="pointer-events-auto rounded border border-border/50 bg-card px-3 py-2 text-[11px] font-mono shadow-float">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-fg truncate">{toast.event.title}</div>
                        <div className="mt-0.5 truncate text-muted-fg">{laneName}</div>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 text-muted-fg hover:text-fg"
                        onClick={() => {
                          setPrToasts((prev) => prev.filter((t) => t.id !== toast.id));
                          const timer = toastTimersRef.current.get(toast.id);
                          if (timer != null) window.clearTimeout(timer);
                          toastTimersRef.current.delete(toast.id);
                        }}
                        title="Dismiss"
                      >
                        ×
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-fg line-clamp-2">{toast.event.message}</div>
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          selectLane(toast.event.laneId);
                          setLaneInspectorTab(toast.event.laneId, "merge");
                          window.location.hash = `#/lanes?laneId=${encodeURIComponent(toast.event.laneId)}&focus=single&inspectorTab=merge`;
                          setPrToasts((prev) => prev.filter((t) => t.id !== toast.id));
                        }}
                      >
                        View PR
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          void window.ade.prs.openInGitHub(toast.event.prId).catch(() => { });
                          setPrToasts((prev) => prev.filter((t) => t.id !== toast.id));
                        }}
                      >
                        Open in GitHub
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <GenerateDocsModal
        open={contextGenerateOpen}
        onOpenChange={setContextGenerateOpen}
        onCompleted={() => {
          void window.ade.context.getStatus().then(setContextStatus).catch(() => {});
        }}
      />
    </div>
  );
}
