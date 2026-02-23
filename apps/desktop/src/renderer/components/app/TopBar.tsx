import React, { useCallback, useEffect, useState } from "react";
import { Folder, FolderOpen, Plus, MagnifyingGlass, Trash, X } from "@phosphor-icons/react";

import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import type { RecentProjectSummary } from "../../../shared/types";

export function TopBar({
  onOpenCommandPalette,
  commandHint
}: {
  onOpenCommandPalette: () => void;
  commandHint: React.ReactNode;
}) {
  const project = useAppStore((s) => s.project);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null);

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
    <header className="flex h-[40px] items-center gap-3 px-3.5 bg-surface-raised border-b border-border/30">
      {/* Branding */}
      <div className="shrink-0 select-none text-[14px] font-bold tracking-[0.05em] text-accent">
        ADE
      </div>

      {/* Divider */}
      <div className="h-4 w-px shrink-0 bg-border/30" />

      {/* Project tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
        {recentProjects.length === 0 && !project ? (
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1",
              "text-[11px] font-mono text-muted-fg",
              "hover:bg-accent/10 hover:text-fg",
              "transition-all duration-150"
            )}
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
              const canClose = !isCurrent;
              return (
                <div
                  key={rp.rootPath}
                  className={cn(
                    "group inline-flex max-w-[160px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono transition-all duration-150",
                    isMissing
                      ? "bg-red-500/8 text-red-400/60 hover:bg-red-500/12"
                      : isCurrent
                        ? "bg-accent text-accent-fg shadow-sm"
                        : "text-muted-fg hover:bg-muted/40 hover:text-fg cursor-pointer"
                  )}
                  onClick={() => {
                    if (!isMissing) handleSwitchProject(rp.rootPath);
                  }}
                  title={isMissing ? `Missing: ${rp.rootPath}` : rp.rootPath}
                >
                  <Folder
                    size={12}
                    weight="regular"
                    className={cn(
                      "shrink-0",
                      isMissing
                        ? "text-red-400/70"
                        : isCurrent
                          ? "text-accent-fg/80"
                          : "text-muted-fg/60"
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
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        terminalAttention.indicator === "running-needs-attention"
                          ? "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.6)]"
                          : "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]"
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "truncate",
                      isMissing && "line-through decoration-red-400/50"
                    )}
                  >
                    {rp.displayName}
                  </span>
                  {isMissing ? (
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <span
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-red-500/15 cursor-pointer transition-colors duration-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRelocate(rp.rootPath);
                        }}
                        title="Relocate project"
                      >
                        <FolderOpen size={12} weight="regular" />
                      </span>
                      <span
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-red-500/20 cursor-pointer transition-colors duration-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveTab(rp.rootPath);
                        }}
                        title="Remove from list"
                      >
                        <Trash size={12} weight="regular" className="text-red-400" />
                      </span>
                    </span>
                  ) : canClose ? (
                    <span
                      className={cn(
                        "inline-flex h-4 w-4 items-center justify-center rounded-full",
                        "opacity-0 group-hover:opacity-100 transition-all duration-150",
                        isCurrent
                          ? "hover:bg-accent-fg/20"
                          : "hover:bg-muted/60"
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTab(rp.rootPath);
                      }}
                      title="Remove from tabs"
                    >
                      <X size={12} weight="regular" />
                    </span>
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
            "inline-flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full",
            "text-muted-fg/40 hover:bg-accent/10 hover:text-accent",
            "transition-all duration-150"
          )}
          onClick={handleOpenNew}
          title="Open another project"
        >
          <Plus size={12} weight="regular" />
        </button>
      </div>

      {/* Command palette */}
      <button
        type="button"
        className={cn(
          "shrink-0 inline-flex items-center gap-1.5 rounded",
          "h-[26px] px-2.5",
          "border border-border/40 bg-transparent",
          "text-muted-fg hover:text-fg hover:border-accent/30 hover:bg-muted/20",
          "transition-all duration-150"
        )}
        onClick={onOpenCommandPalette}
        title="Command palette"
      >
        <MagnifyingGlass size={13} weight="regular" className="shrink-0 opacity-50" />
        <span className="hidden sm:inline text-xs">Commands</span>
        <span
          className={cn(
            "hidden md:inline font-mono text-[10px]",
            "rounded px-1 py-px",
            "bg-muted/40 text-muted-fg/60",
            "border border-border/30"
          )}
        >
          {commandHint}
        </span>
      </button>
    </header>
  );
}
