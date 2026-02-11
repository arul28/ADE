import React, { useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderTree, RefreshCw, Save } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { useAppStore } from "../../state/appStore";
import { PaneHeader } from "../ui/PaneHeader";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import type { DiffChanges, DiffMode, FileDiff, FileChange } from "../../../shared/types";
import { MonacoDiffView, type MonacoDiffHandle } from "./MonacoDiffView";

export function LaneDetail() {
  const laneId = useAppStore((s) => s.selectedLaneId);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const laneName = useMemo(() => lanes.find((l) => l.id === laneId)?.name ?? null, [lanes, laneId]);

  const [mode, setMode] = useState<DiffMode>("unstaged");
  const [showFiles, setShowFiles] = useState(true);
  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>({ unstaged: [], staged: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const diffRef = useRef<MonacoDiffHandle | null>(null);

  const files: FileChange[] = mode === "unstaged" ? changes.unstaged : changes.staged;

  const refreshChanges = async () => {
    if (!laneId) return;
    setLoading(true);
    try {
      const next = await window.ade.diff.getChanges({ laneId });
      setChanges(next);
      // If selected file disappears, clear selection.
      if (selectedPath && ![...next.staged, ...next.unstaged].some((f) => f.path === selectedPath)) {
        setSelectedPath(null);
        setDiff(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedPath(null);
    setDiff(null);
    setChanges({ staged: [], unstaged: [] });
    if (!laneId) return;
    refreshChanges().catch(() => {
      // ignore
    });
  }, [laneId]);

  useEffect(() => {
    setDiff(null);
    if (!laneId || !selectedPath) return;
    window.ade.diff
      .getFile({ laneId, path: selectedPath, mode })
      .then((d) => setDiff(d))
      .catch(() => {
        setDiff(null);
      });
  }, [laneId, selectedPath, mode]);

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title="Changes"
        meta={laneName ?? (laneId ?? "no lane selected")}
        right={
          <div className="flex items-center gap-2">
            <Button
              variant={mode === "unstaged" ? "primary" : "outline"}
              size="sm"
              onClick={() => setMode("unstaged")}
              title="Working tree (unstaged)"
            >
              <FileText className="h-4 w-4" />
              Unstaged
            </Button>
            <Button
              variant={mode === "staged" ? "primary" : "outline"}
              size="sm"
              onClick={() => setMode("staged")}
              title="Index (staged)"
            >
              <FileText className="h-4 w-4" />
              Staged
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={showFiles ? "Hide file list" : "Show file list"}
              onClick={() => setShowFiles((v) => !v)}
            >
              <FolderTree className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Refresh changes"
              onClick={() => {
                refreshChanges().catch(() => {});
                refreshLanes().catch(() => {});
              }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!laneId || !selectedPath || mode !== "unstaged" || !diff || diff.isBinary}
              title={mode !== "unstaged" ? "Quick edit applies to the working tree (unstaged)" : "Save changes"}
              onClick={() => {
                if (!laneId || !selectedPath) return;
                const text = diffRef.current?.getModifiedValue();
                if (text == null) return;
                window.ade.files
                  .writeTextAtomic({ laneId, path: selectedPath, text })
                  .then(async () => {
                    await refreshChanges();
                    const d = await window.ade.diff.getFile({ laneId, path: selectedPath, mode: "unstaged" });
                    setDiff(d);
                  })
                  .catch(() => {});
              }}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        {showFiles ? (
          <aside className="w-[260px] shrink-0 border-r border-border p-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold text-muted-fg">Files</div>
              <Chip className="text-[11px]">{loading ? "…" : `${files.length}`}</Chip>
            </div>
            <div className="space-y-1 overflow-auto pr-1">
              {files.length === 0 ? (
                <div className="rounded-lg border border-border bg-card/60 p-3 text-xs text-muted-fg">
                  No {mode} changes.
                </div>
              ) : (
                files.map((f) => (
                  <button
                    key={`${mode}:${f.path}`}
                    className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-2 text-left text-xs transition-colors ${
                      f.path === selectedPath
                        ? "border-accent/40 bg-muted/70 text-fg"
                        : "border-border bg-card/50 text-muted-fg hover:bg-muted/50 hover:text-fg"
                    }`}
                    onClick={() => setSelectedPath(f.path)}
                    title={f.path}
                  >
                    <span className="truncate">{f.path}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-fg">{f.kind}</span>
                  </button>
                ))
              )}
            </div>
          </aside>
        ) : null}

        <section className="min-w-0 flex-1 p-3">
          {!laneId ? (
            <EmptyState title="Select a lane" description="Create and select a lane to view diffs." />
          ) : !selectedPath ? (
            <EmptyState title="Select a file" description="Pick a changed file to view a Monaco diff and quick edit." />
          ) : !diff ? (
            <div className="h-full rounded-lg border border-border bg-card/60 p-4 text-sm text-muted-fg">Loading diff…</div>
          ) : diff.isBinary ? (
            <EmptyState title="Binary file" description="MVP diff viewer only supports text files." />
          ) : (
            <div className="h-full min-h-0">
              <div className="mb-2 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">{diff.path}</div>
                  <div className="truncate text-[11px] text-muted-fg">{mode === "unstaged" ? "index → working tree" : "HEAD → index"}</div>
                </div>
                {mode === "unstaged" ? (
                  <Chip className="text-[11px]">quick edit enabled</Chip>
                ) : (
                  <Chip className="text-[11px]">read-only</Chip>
                )}
              </div>
              <MonacoDiffView ref={diffRef} diff={diff} editable={mode === "unstaged"} className="h-[calc(100%-28px)]" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
