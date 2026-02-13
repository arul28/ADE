import React, { useCallback, useEffect, useState } from "react";
import { Folder, Plus, Search, X } from "lucide-react";
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
  const openRepo = useAppStore((s) => s.openRepo);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.ade.project
      .listRecent()
      .then((rows) => {
        if (!cancelled) setRecentProjects(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath]);

  const handleOpenNew = useCallback(() => {
    openRepo().catch(() => {});
  }, [openRepo]);

  const handleSwitchProject = useCallback((rootPath: string) => {
    // If it's already the current project, do nothing
    if (project?.rootPath === rootPath) return;
    switchProjectToPath(rootPath).catch(() => {});
  }, [project?.rootPath, switchProjectToPath]);

  const handleRemoveTab = useCallback((rootPath: string) => {
    // Don't allow removing the current project
    if (project?.rootPath === rootPath) return;
    window.ade.project
      .forgetRecent(rootPath)
      .then((rows) => setRecentProjects(rows))
      .catch(() => {});
  }, [project?.rootPath]);

  return (
    <header className="flex h-[44px] items-center gap-3 border-b border-border bg-bg px-3">
      {/* Branding */}
      <div className="text-sm font-bold tracking-tight shrink-0">ADE</div>

      <div className="h-5 w-px bg-border shrink-0" />

      {/* Project tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {recentProjects.length === 0 && !project ? (
          <button
            type="button"
            className="flex items-center gap-1.5 rounded border border-dashed border-border px-2 py-1 text-xs text-muted-fg hover:border-accent hover:text-fg transition-colors"
            onClick={handleOpenNew}
          >
            <Folder className="h-3 w-3" />
            Open a project
          </button>
        ) : (
          <>
            {recentProjects.map((rp) => {
              const isCurrent = project?.rootPath === rp.rootPath;
              const canClose = !isCurrent;
              return (
                <div
                  key={rp.rootPath}
                  className={cn(
                    "group inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                    isCurrent
                      ? "border-accent bg-accent/15 text-fg"
                      : "border-border bg-card/70 text-muted-fg hover:border-muted-fg hover:text-fg cursor-pointer"
                  )}
                  onClick={() => handleSwitchProject(rp.rootPath)}
                  title={rp.rootPath}
                >
                  <Folder className="h-3 w-3 shrink-0" />
                  <span className="truncate">{rp.displayName}</span>
                  {canClose ? (
                    <span
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted/70"
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
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-dashed border-border text-muted-fg hover:border-accent hover:text-fg transition-colors"
          onClick={handleOpenNew}
          title="Open another project"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Command palette */}
      <Button variant="ghost" size="sm" className="shrink-0" onClick={onOpenCommandPalette} title="Command palette">
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline text-xs">Commands</span>
        <span className="hidden md:inline text-[10px] text-muted-fg">{commandHint}</span>
      </Button>
    </header>
  );
}
