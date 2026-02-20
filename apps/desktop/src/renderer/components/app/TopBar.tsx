import React, { useCallback, useEffect, useState } from "react";
import { Folder, FolderSearch, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "../ui/Button";
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
    <header className="flex h-[38px] items-center gap-2.5 ade-panel-header px-3 bg-bg border-b border-border/40">
      {/* Branding */}
      <div className="font-mono text-[11px] font-semibold tracking-widest shrink-0 text-accent uppercase">ADE</div>

      <div className="h-3 w-px bg-border/20 shrink-0" />

      {/* Project tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {recentProjects.length === 0 && !project ? (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-mono text-muted-fg hover:bg-muted/30 hover:text-fg transition-colors"
            onClick={handleOpenNew}
          >
            <Folder className="h-3 w-3" />
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
                    "group inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-mono transition-colors",
                    isMissing
                      ? "opacity-40 text-muted-fg"
                      : isCurrent
                        ? "bg-accent/8 text-fg border-b border-accent"
                        : "text-muted-fg hover:bg-muted/30 hover:text-fg cursor-pointer"
                  )}
                  onClick={() => {
                    if (!isMissing) handleSwitchProject(rp.rootPath);
                  }}
                  title={isMissing ? `Missing: ${rp.rootPath}` : rp.rootPath}
                >
                  <Folder className={cn("h-2.5 w-2.5 shrink-0", isMissing && "text-red-400")} />
                  {isCurrent && terminalAttention.indicator !== "none" ? (
                    <span
                      title={
                        terminalAttention.indicator === "running-needs-attention"
                          ? `${terminalAttention.needsAttentionCount} running terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                          : `${terminalAttention.runningCount} running terminal${terminalAttention.runningCount === 1 ? "" : "s"}`
                      }
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        terminalAttention.indicator === "running-needs-attention" ? "bg-amber-400" : "bg-emerald-500"
                      )}
                    />
                  ) : null}
                  <span className={cn("truncate", isMissing && "line-through")}>{rp.displayName}</span>
                  {isMissing ? (
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span
                        className="inline-flex h-4 w-4 items-center justify-center rounded-md hover:bg-muted/70 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRelocate(rp.rootPath);
                        }}
                        title="Relocate project"
                      >
                        <FolderSearch className="h-2.5 w-2.5" />
                      </span>
                      <span
                        className="inline-flex h-4 w-4 items-center justify-center rounded-md hover:bg-red-500/20 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveTab(rp.rootPath);
                        }}
                        title="Remove from list"
                      >
                        <Trash2 className="h-2.5 w-2.5 text-red-400" />
                      </span>
                    </span>
                  ) : canClose ? (
                    <span
                      className="inline-flex h-4 w-4 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted/70 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTab(rp.rootPath);
                      }}
                      title="Remove from tabs"
                    >
                      <X className="h-2.5 w-2.5" />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </>
        )}

        {/* Add project tab */}
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-fg/40 hover:bg-muted/20 hover:text-fg transition-colors"
          onClick={handleOpenNew}
          title="Open another project"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Command palette */}
      <Button variant="ghost" size="sm" className="shrink-0 rounded gap-1" onClick={onOpenCommandPalette} title="Command palette">
        <Search className="h-3 w-3" />
        <span className="hidden sm:inline font-mono text-[10px]">Commands</span>
        <span className="hidden md:inline font-mono text-[9px] text-muted-fg/50">{commandHint}</span>
      </Button>
    </header>
  );
}
