import React, { useCallback, useEffect, useState } from "react";
import { Folder, FolderOpen, Plus, Minus, MagnifyingGlass, Trash, X } from "@phosphor-icons/react";

import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import type { RecentProjectSummary } from "../../../shared/types";

const ZOOM_KEY = "ade:zoom-level";

/** Convert between display percentage (70–150) and Electron zoom level.
 *  Electron zoom level is log-based: level 0 = 100%, each ±1 ≈ ±20%.
 *  Formula: factor = 1.2^level, so level = log(factor) / log(1.2). */
function pctToZoomLevel(pct: number): number {
  return Math.log(pct / 100) / Math.log(1.2);
}

function getStoredZoom(): number {
  try {
    return parseInt(localStorage.getItem(ZOOM_KEY) || "100", 10);
  } catch {
    return 100;
  }
}

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
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null);
  const [zoom, setZoom] = useState(getStoredZoom);

  const applyZoom = useCallback((pct: number) => {
    const clamped = Math.max(70, Math.min(150, pct));
    window.ade.zoom.setLevel(pctToZoomLevel(clamped));
    localStorage.setItem(ZOOM_KEY, String(clamped));
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

  const handleOpenNew = useCallback(() => {
    openRepo().catch(() => { });
  }, [openRepo]);

  const handleSwitchProject = useCallback((rootPath: string) => {
    if (project?.rootPath === rootPath) return;
    switchProjectToPath(rootPath).catch(() => { });
  }, [project?.rootPath, switchProjectToPath]);

  const handleRemoveTab = useCallback((rootPath: string) => {
    if (project?.rootPath === rootPath) return;
    window.ade.project
      .forgetRecent(rootPath)
      .then((rows) => setRecentProjects(rows))
      .catch(() => { });
  }, [project?.rootPath]);

  const handleRelocate = useCallback((oldPath: string) => {
    setRelocatingPath(oldPath);
    window.ade.project
      .openRepo()
      .then((newProject) => {
        // After relocating, remove the stale entry and refresh
        window.ade.project
          .forgetRecent(oldPath)
          .then((rows) => setRecentProjects(rows))
          .catch(() => { });
        switchProjectToPath(newProject.rootPath).catch(() => { });
      })
      .catch(() => { })
      .finally(() => setRelocatingPath(null));
  }, [switchProjectToPath]);

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
              const canClose = !isCurrent;
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
                        "ade-status-dot h-1.5 w-1.5 shrink-0",
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
                  ) : canClose ? (
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
                      title="Remove from tabs"
                    >
                      <X size={12} weight="regular" />
                    </button>
                  ) : null}
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
