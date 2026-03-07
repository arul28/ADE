import React, { useCallback, useEffect, useState } from "react";
import { Folder, FolderOpen, Plus, Minus, MagnifyingGlass, Trash, X } from "@phosphor-icons/react";

import { useAppStore } from "../../state/appStore";
import {
  ZOOM_LEVEL_KEY,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  displayZoomToLevel,
  getStoredZoomLevel,
} from "../../lib/zoom";
import { cn } from "../ui/cn";
import type { ProcessRuntime, RecentProjectSummary } from "../../../shared/types";

const RUNNING_LANE_PROCESS_STATES: ProcessRuntime["status"][] = ["starting", "running", "degraded"];

export function TopBar({
  onOpenCommandPalette,
  commandHint,
  commandPaletteOpen
}: {
  onOpenCommandPalette: () => void;
  commandHint: React.ReactNode;
  commandPaletteOpen: boolean;
}) {
  const project = useAppStore((s) => s.project);
  const closeProject = useAppStore((s) => s.closeProject);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null);
  const [zoom, setZoom] = useState(getStoredZoomLevel);

  const applyZoom = useCallback((pct: number) => {
    const clamped = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, pct));
    window.ade.zoom.setLevel(displayZoomToLevel(clamped));
    localStorage.setItem(ZOOM_LEVEL_KEY, String(clamped));
    setZoom(clamped);
  }, []);

  const zoomIn = useCallback(() => applyZoom(zoom + 10), [applyZoom, zoom]);
  const zoomOut = useCallback(() => applyZoom(zoom - 10), [applyZoom, zoom]);

  const fetchRecent = useCallback(() => {
    window.ade.project
      .listRecent()
      .then((rows) => setRecentProjects(rows))
      .catch(() => { });
  }, []);

  useEffect(() => {
    fetchRecent();
  }, [project?.rootPath, fetchRecent]);

  // Re-fetch when app regains focus (catches external deletions).
  useEffect(() => {
    const onFocus = () => fetchRecent();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchRecent]);

  // Re-fetch when the main process reports a missing project.
  useEffect(() => {
    const unsub = window.ade.project.onMissing(() => fetchRecent());
    return unsub;
  }, [fetchRecent]);

  const checkForActiveWorkloads = useCallback(async (projectRootPath: string): Promise<boolean> => {
    if (project?.rootPath !== projectRootPath) return true;

    try {
      const [lanes, runningSessions, agentChats, activeMissions] = await Promise.all([
        window.ade.lanes.list({ includeArchived: false }),
        window.ade.sessions.list({ status: "running" }),
        window.ade.agentChat.list(),
        window.ade.missions.list({ status: "active" })
      ]);

      const laneRuntimes = await Promise.all(
        lanes.map((lane) => window.ade.processes.listRuntime(lane.id).catch(() => [] as ProcessRuntime[]))
      );

      const activeProcesses = laneRuntimes
        .flat()
        .filter((runtime) => RUNNING_LANE_PROCESS_STATES.includes(runtime.status));
      const activeSessionCount = runningSessions.filter((session) => session.status === "running").length;
      const activeChatCount = agentChats.filter((chat) => chat.status === "active").length;

      const warnings: string[] = [];
      if (activeProcesses.length > 0) {
        warnings.push(`${activeProcesses.length} running lane process${activeProcesses.length === 1 ? "" : "es"}`);
      }
      if (activeSessionCount > 0) {
        warnings.push(`${activeSessionCount} running terminal session${activeSessionCount === 1 ? "" : "s"}`);
      }
      if (activeChatCount > 0) {
        warnings.push(`${activeChatCount} active chat${activeChatCount === 1 ? "" : "s"}`);
      }
      if (activeMissions.length > 0) {
        warnings.push(`${activeMissions.length} active mission${activeMissions.length === 1 ? "" : "s"}`);
      }

      if (warnings.length === 0) return true;

      const message = [
        "You are about to close this project.",
        "The following active work items will be terminated:",
        ...warnings.map((line) => `- ${line}`),
        "",
        "Do you want to continue?"
      ].join("\n");

      return window.confirm(message);
    } catch {
      return true;
    }
  }, [project?.rootPath]);

  const handleOpenNew = useCallback(() => {
    openRepo().catch(() => { });
  }, [openRepo]);

  const handleSwitchProject = useCallback((rootPath: string) => {
    if (project?.rootPath === rootPath) return;
    switchProjectToPath(rootPath).catch(() => { });
  }, [project?.rootPath, switchProjectToPath]);

  const handleRemoveTab = useCallback((rootPath: string) => {
    void (async () => {
      const shouldClose = await checkForActiveWorkloads(rootPath);
      if (!shouldClose) return;

      const rows = await window.ade.project.forgetRecent(rootPath).catch(() => null);
      if (!rows) return;

      setRecentProjects(rows);
      // If we just removed the active project, switch to the next available or show welcome.
      if (project?.rootPath === rootPath) {
        const next = rows.find((r) => r.exists && r.rootPath !== rootPath);
        if (next) {
          switchProjectToPath(next.rootPath).catch(() => { });
        } else {
          closeProject().catch(() => { });
        }
      }
    })().catch(() => { });
  }, [checkForActiveWorkloads, project?.rootPath, closeProject, switchProjectToPath]);

  const handleRelocate = useCallback((oldPath: string) => {
    setRelocatingPath(oldPath);
    void (async () => {
      const newProject = await openRepo().catch(() => null);
      if (!newProject) return;
      const nextRows = await window.ade.project.forgetRecent(oldPath).catch(() => null);
      if (nextRows) setRecentProjects(nextRows);
    })().catch(() => { }).finally(() => setRelocatingPath(null));
  }, [openRepo]);

  return (
    <header
      className="ade-shell-header flex items-center gap-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Branding */}
      <img
        src="./logo.png"
        alt="ADE"
        className="shrink-0 select-none"
        style={{ height: 20 }}
        draggable={false}
      />

      {/* Divider */}
      <div className="ade-shell-header-divider h-4 w-px shrink-0" />

      {/* Project tabs — the container stays draggable, only interactive elements opt out */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {recentProjects.length === 0 && !project ? (
          <button
            type="button"
            className={cn(
              "ade-shell-project-tab inline-flex items-center gap-1.5 px-3 py-1",
              "transition-[background-color,color,border-color,box-shadow] duration-150"
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onClick={handleOpenNew}
          >
            <Folder size={12} weight="regular" />
            Open a project
          </button>
        ) : (
          <>
              {recentProjects.map((rp) => {
              const isCurrent = project?.rootPath === rp.rootPath;
              const isMissing = !rp.exists;
              const isRelocating = relocatingPath === rp.rootPath;
              const projectTabState = isRelocating ? "open" : isMissing ? "missing" : isCurrent ? "active" : undefined;
              return (
                <div
                  key={rp.rootPath}
                  role={isMissing ? undefined : "button"}
                  tabIndex={isMissing ? -1 : 0}
                  data-state={projectTabState}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-disabled={isRelocating ? true : undefined}
                  className={cn(
                    "ade-shell-project-tab group inline-flex max-w-[180px] shrink-0 items-center gap-1.5 px-2.5 py-1",
                    "transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                    !isMissing && "cursor-pointer",
                    isCurrent && "font-semibold",
                    isRelocating && "pointer-events-none opacity-80"
                  )}
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  onClick={() => {
                    if (!isMissing) handleSwitchProject(rp.rootPath);
                  }}
                  onKeyDown={(event) => {
                    if (isMissing) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleSwitchProject(rp.rootPath);
                    }
                  }}
                  title={isMissing ? `Missing: ${rp.rootPath}` : rp.rootPath}
                >
                  <Folder
                    size={12}
                    weight="regular"
                    className={cn(
                      "shrink-0 transition-opacity duration-150",
                      isCurrent ? "opacity-90" : "opacity-70"
                    )}
                  />
                  {isCurrent && terminalAttention.indicator !== "none" ? (
                    <span
                      title={
                        terminalAttention.indicator === "running-needs-attention"
                          ? `${terminalAttention.needsAttentionCount} running terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                          : `${terminalAttention.runningCount} running terminal${terminalAttention.runningCount === 1 ? "" : "s"}`
                      }
                      className={cn(
                        "ade-status-dot h-1.5 w-1.5 shrink-0 animate-spin",
                        terminalAttention.indicator === "running-needs-attention"
                          ? "ade-status-dot-warning"
                          : "ade-status-dot-active"
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "truncate",
                      isMissing && "line-through"
                    )}
                  >
                    {rp.displayName}
                  </span>
                  {isMissing ? (
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
                      <button
                        type="button"
                        className="ade-shell-control inline-flex h-4 w-4 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
                        data-variant="ghost"
                        data-state={isRelocating ? "open" : undefined}
                        disabled={isRelocating}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRelocating) return;
                          handleRelocate(rp.rootPath);
                        }}
                        title="Relocate project"
                      >
                        <FolderOpen size={12} weight="regular" className={cn(isRelocating && "animate-pulse")} />
                      </button>
                      <button
                        type="button"
                        className="ade-shell-control inline-flex h-4 w-4 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
                        data-variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveTab(rp.rootPath);
                        }}
                        title="Remove from list"
                      >
                        <Trash size={12} weight="regular" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        "ade-shell-control inline-flex h-4 w-4 items-center justify-center text-current",
                        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150"
                      )}
                      data-variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTab(rp.rootPath);
                      }}
                      title="Remove project"
                    >
                      <X size={12} weight="regular" />
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Add project button */}
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-5.5 w-5.5 shrink-0 items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150"
          )}
          data-variant="ghost"
          onClick={handleOpenNew}
          title="Open another project"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <Plus size={12} weight="regular" />
        </button>
      </div>

      {/* Zoom controls */}
      <div
        className="shrink-0 inline-flex items-center gap-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150"
          )}
          onClick={zoomOut}
          title="Zoom out"
        >
          <Minus size={12} weight="bold" />
        </button>
        <span
          className={cn(
            "ade-shell-control-kbd inline-flex h-[20px] items-center justify-center border-x-0 px-1.5",
            "text-[10px] font-mono select-none",
            "min-w-[36px] text-center"
          )}
        >
          {zoom}%
        </span>
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150"
          )}
          onClick={zoomIn}
          title="Zoom in"
        >
          <Plus size={12} weight="bold" />
        </button>
      </div>

      {/* Command palette / search */}
      <button
        type="button"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        data-state={commandPaletteOpen ? "open" : undefined}
        aria-pressed={commandPaletteOpen}
        className={cn(
          "ade-shell-control shrink-0 inline-flex items-center gap-2",
          "h-[26px] px-2.5",
          "outline-none transition-[background-color,color,border-color,box-shadow] duration-150"
        )}
        onClick={onOpenCommandPalette}
        title="Command palette"
      >
        <MagnifyingGlass size={13} weight="regular" className="shrink-0 opacity-50" />
        <span className="hidden sm:inline text-[11px] font-mono opacity-75">Search...</span>
        <span
          className={cn(
            "ade-shell-control-kbd hidden md:inline font-mono text-[10px]",
            "px-1.5 py-px"
          )}
        >
          {commandHint}
        </span>
      </button>
    </header>
  );
}
