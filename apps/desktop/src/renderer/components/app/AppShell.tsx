import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import type { PrEventPayload } from "../../../shared/types";

type PrToast = {
  id: string;
  event: Extract<PrEventPayload, { type: "pr-notification" }>;
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const setProject = useAppStore((s) => s.setProject);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);
  const providerMode = useAppStore((s) => s.providerMode);
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const [commandOpen, setCommandOpen] = useState(false);
  const [prToasts, setPrToasts] = useState<PrToast[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    window.ade.app
      .getProject()
      .then(setProject)
      .then(() => Promise.all([refreshLanes(), refreshProviderMode()]))
      .catch(() => {
        // Leave project unset; UI will show placeholders.
      });
  }, [setProject, refreshLanes, refreshProviderMode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  const cmdK = useMemo(() => (navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"), []);

  return (
    <div className="h-screen w-screen text-fg overflow-hidden flex flex-col bg-bg">
      {/* TopBar is now part of the 'paper' flow - less like a floating header */
      /* CONSOLE LAYOUT: Integrated Header */}
      <div className="shrink-0 bg-bg relative z-20">
        <TopBar
          onOpenCommandPalette={() => setCommandOpen(true)}
          commandHint={
            <>
              {cmdK}+<span className="font-mono">K</span>
            </>
          }
        />
      </div>

      {providerMode === "guest" ? (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          Running in Guest Mode - context tracking disabled. <Link to="/settings" className="underline">Set up provider</Link>
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        {/* Sidebar Navigation - High contrast, distinct pane */}
        <aside className="w-[50px] shrink-0 border-r border-border bg-bg flex flex-col items-center py-2 z-10">
          <TabNav />
        </aside>

        {/* Main Workspace - Canvas for Lanes/Content */}
        <main className="relative flex min-h-0 min-w-0 flex-1 bg-bg">
          <div className="h-full min-h-0 w-full">
            {children}
          </div>

          {prToasts.length > 0 ? (
            <div className="pointer-events-none absolute bottom-3 right-3 z-[95] flex w-[min(420px,calc(100vw-24px))] flex-col gap-2">
              {prToasts.map((toast) => {
                const laneName = lanes.find((lane) => lane.id === toast.event.laneId)?.name ?? toast.event.laneId;
                return (
                  <div key={toast.id} className="pointer-events-auto rounded border border-border bg-card/95 px-3 py-2 text-xs shadow-xl">
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
                          setLaneInspectorTab(toast.event.laneId, "pr");
                          window.location.hash = `#/lanes?laneId=${encodeURIComponent(toast.event.laneId)}&focus=single&inspectorTab=pr`;
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
