import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import type { ContextStatus, HostedStatus, PackEvent, PrEventPayload } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";

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

const ONBOARDING_DISMISSED_KEY = "ade:onboarding:dismissed:v1";

function shortId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const setProject = useAppStore((s) => s.setProject);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);
  const refreshKeybindings = useAppStore((s) => s.refreshKeybindings);
  const providerMode = useAppStore((s) => s.providerMode);
  const keybindings = useAppStore((s) => s.keybindings);
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const [commandOpen, setCommandOpen] = useState(false);
  const [prToasts, setPrToasts] = useState<PrToast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const [hostedStatus, setHostedStatus] = useState<HostedStatus | null>(null);
  const [hostedStatusError, setHostedStatusError] = useState<string | null>(null);
  const [aiFailure, setAiFailure] = useState<AiBannerState | null>(null);
  const [aiMockProvider, setAiMockProvider] = useState<{ createdAt: string } | null>(null);
  const [aiRetrying, setAiRetrying] = useState(false);
  const [onboardingIncomplete, setOnboardingIncomplete] = useState(false);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [contextGenerateBusy, setContextGenerateBusy] = useState<"codex" | "claude" | null>(null);
  const [projectMissing, setProjectMissing] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    window.ade.app
      .getProject()
      .then(setProject)
      .then(() => Promise.all([refreshLanes(), refreshProviderMode(), refreshKeybindings().catch(() => {})]))
      .then(async () => {
        const status = await window.ade.onboarding.getStatus().catch(() => null);
        setOnboardingIncomplete(Boolean(status && !status.completedAt));
      })
      .catch(() => {
        // Leave project unset; UI will show placeholders.
      });
  }, [setProject, refreshLanes, refreshProviderMode, refreshKeybindings, navigate]);

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

  // Listen for projectMissing broadcast from main process.
  useEffect(() => {
    const unsub = window.ade.project.onMissing(() => setProjectMissing(true));
    return unsub;
  }, []);

  // Reset projectMissing when the project changes (e.g. after relocate).
  const project = useAppStore((s) => s.project);
  useEffect(() => {
    setProjectMissing(false);
  }, [project?.rootPath]);

  useEffect(() => {
    let cancelled = false;
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
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    setHostedStatus(null);
    setHostedStatusError(null);
    if (providerMode !== "hosted") return;
    window.ade.hosted
      .getStatus()
      .then((status) => {
        if (cancelled) return;
        setHostedStatus(status);
      })
      .catch((err) => {
        if (cancelled) return;
        setHostedStatusError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [providerMode]);

  useEffect(() => {
    setAiFailure(null);
    setAiMockProvider(null);
    if (providerMode !== "hosted") return;

    const unsub = window.ade.packs.onEvent((ev: PackEvent) => {
      if (ev.eventType === "narrative_failed") {
        const payload = ev.payload ?? {};
        const laneIdRaw = typeof payload.laneId === "string" ? (payload.laneId as string) : ev.packKey.startsWith("lane:") ? ev.packKey.slice("lane:".length) : null;
        const jobId = typeof payload.jobId === "string" ? (payload.jobId as string) : null;
        const status = typeof payload.status === "string" ? (payload.status as string) : null;
        const error = typeof payload.error === "string" ? (payload.error as string) : "AI update failed.";
        setAiFailure({
          laneId: laneIdRaw,
          jobId,
          status,
          error,
          createdAt: ev.createdAt
        });
      }

      if (ev.eventType === "narrative_update") {
        const payload = ev.payload ?? {};
        const provider = typeof payload.provider === "string" ? (payload.provider as string) : null;
        if (provider === "mock") {
          setAiMockProvider({ createdAt: ev.createdAt });
        } else if (provider) {
          setAiMockProvider(null);
        }

        const jobId = typeof payload.jobId === "string" ? (payload.jobId as string) : null;
        setAiFailure((prev) => {
          if (!prev) return prev;
          if (jobId && prev.jobId && prev.jobId === jobId) return null;
          return prev;
        });
      }
    });

    return () => {
      try {
        unsub();
      } catch {
        // ignore
      }
    };
  }, [providerMode]);

  const commandPaletteBinding = useMemo(
    () => getEffectiveBinding(keybindings, "commandPalette.open", "Mod+K"),
    [keybindings]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!eventMatchesBinding(e, commandPaletteBinding)) return;
      e.preventDefault();
      setCommandOpen(true);
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

  return (
    <div className="h-screen w-screen text-fg overflow-hidden flex flex-col bg-bg">
      <div className="shrink-0 relative z-20">
        <TopBar
          onOpenCommandPalette={() => setCommandOpen(true)}
          commandHint={
            <>
              <span className="font-mono">{commandHint}</span>
            </>
          }
        />
      </div>

      {projectMissing ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-red-500/10 px-4 py-2.5 text-xs text-red-800 shadow-card">
          <span className="font-semibold">Project directory not found</span> — it may have been moved or deleted.
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                window.ade.project
                  .openRepo()
                  .then(() => setProjectMissing(false))
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
                    setProjectMissing(false);
                    // Switch to the next available project, or open a new one.
                    const next = remaining.find((rp) => rp.exists);
                    if (next) {
                      await window.ade.project.switchToPath(next.rootPath);
                    }
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

      {providerMode === "guest" ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-amber-500/8 px-4 py-2.5 text-xs text-amber-800 shadow-card">
          Running in Guest Mode - AI details disabled. <Link to="/settings" className="underline">Set up provider</Link>
        </div>
      ) : null}
      {providerMode === "hosted" ? (
        hostedStatusError ? (
          <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-red-500/8 px-4 py-2.5 text-xs text-red-800 shadow-card">
            Hosted AI error: {hostedStatusError} <Link to="/settings" className="underline">Open Settings</Link>
          </div>
        ) : hostedStatus && (!hostedStatus.consentGiven || !hostedStatus.apiConfigured || !hostedStatus.auth.signedIn) ? (
          <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-amber-500/8 px-4 py-2.5 text-xs text-amber-800 shadow-card">
            Hosted AI not ready:
            {!hostedStatus.consentGiven ? " consent not granted;" : ""}
            {!hostedStatus.apiConfigured ? " missing API config;" : ""}
            {!hostedStatus.auth.signedIn ? " not signed in;" : ""}
            {" "}
            <Link to="/settings" className="underline">Fix in Settings</Link>
          </div>
        ) : null
      ) : null}

      {contextStatus?.docs?.some((doc) => !doc.exists) ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-amber-500/8 px-4 py-2.5 text-xs text-amber-800 shadow-card">
          Missing ADE context docs:
          {contextStatus.docs.filter((doc) => !doc.exists).map((doc) => ` ${doc.label}`).join(", ")}.
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={contextGenerateBusy != null}
              onClick={() => {
                setContextGenerateBusy("codex");
                void window.ade.context
                  .generateDocs({ provider: "codex" })
                  .then(() => window.ade.context.getStatus())
                  .then((next) => setContextStatus(next))
                  .finally(() => setContextGenerateBusy(null));
              }}
            >
              {contextGenerateBusy === "codex" ? "Generating…" : "Generate (Codex)"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={contextGenerateBusy != null}
              onClick={() => {
                setContextGenerateBusy("claude");
                void window.ade.context
                  .generateDocs({ provider: "claude" })
                  .then(() => window.ade.context.getStatus())
                  .then((next) => setContextStatus(next))
                  .finally(() => setContextGenerateBusy(null));
              }}
            >
              {contextGenerateBusy === "claude" ? "Generating…" : "Generate (Claude)"}
            </Button>
            <Link to="/context" className="underline">Open Context tab</Link>
          </span>
        </div>
      ) : null}

      {providerMode === "hosted" && aiMockProvider ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-amber-500/8 px-4 py-2.5 text-xs text-amber-800 shadow-card">
          LLM provider is "mock" — AI will return placeholder content. <Link to="/settings" className="underline">Open Settings</Link>
        </div>
      ) : null}

      {providerMode === "hosted" && aiFailure ? (
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-red-500/8 px-4 py-2.5 text-xs text-red-800 shadow-card">
          <span className="font-semibold">Last AI job failed:</span>{" "}
          {aiFailure.jobId ? `job ${shortId(aiFailure.jobId)} · ` : ""}
          {aiFailure.error}
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={aiRetrying || !aiFailure.laneId}
              onClick={() => {
                const laneId = aiFailure.laneId;
                if (!laneId) return;
                setAiRetrying(true);
                void window.ade.packs
                  .generateNarrative(laneId)
                  .catch((err) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    setAiFailure((prev) => (prev ? { ...prev, error: msg } : prev));
                  })
                  .finally(() => setAiRetrying(false));
              }}
              title="Retry AI narrative generation"
            >
              {aiRetrying ? "Retrying…" : "Retry"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={!aiFailure.laneId}
              onClick={() => {
                const laneId = aiFailure.laneId;
                if (!laneId) return;
                selectLane(laneId);
                setLaneInspectorTab(laneId, "packs");
                window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single&inspectorTab=packs`;
              }}
              title="Open lane packs"
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
        <div className="shrink-0 mx-3 mt-1.5 rounded-xl bg-card/60 px-4 py-2.5 text-xs text-fg shadow-card">
          <span className="font-semibold">Onboarding is incomplete.</span>{" "}
          You can keep working and set it up later, or run the wizard to detect defaults, lanes, and initial packs.
          <span className="ml-2 inline-flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => navigate("/onboarding")}
              title="Open onboarding wizard"
            >
              Open wizard
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={onboardingBusy}
              onClick={() => {
                setOnboardingBusy(true);
                void window.ade.onboarding
                  .complete()
                  .then(() => setOnboardingIncomplete(false))
                  .finally(() => setOnboardingBusy(false));
              }}
              title="Skip onboarding for now"
            >
              {onboardingBusy ? "Skipping…" : "Skip for now"}
            </Button>
            <button
              type="button"
              className="text-muted-fg hover:text-fg"
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
          </span>
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        <aside className="w-[52px] shrink-0 bg-[--color-surface-raised] shadow-panel flex flex-col items-center py-2 z-10">
          <TabNav />
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-1">
          <div className="h-full min-h-0 w-full">
            {children}
          </div>

          {prToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-3 right-3 z-[95] flex w-[min(420px,calc(100vw-24px))] flex-col gap-2">
              {prToasts.map((toast) => {
                const laneName = lanes.find((lane) => lane.id === toast.event.laneId)?.name ?? toast.event.laneId;
                return (
                  <div key={toast.id} className="pointer-events-auto rounded-2xl bg-card/90 backdrop-blur-lg px-4 py-3 text-xs shadow-float">
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
                          void window.ade.prs.openInGitHub(toast.event.prId).catch(() => {});
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
    </div>
  );
}
