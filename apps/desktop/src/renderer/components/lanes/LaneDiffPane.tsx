import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, FloppyDisk } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { ResizeGutter } from "../ui/ResizeGutter";
import { MonacoDiffView, type MonacoDiffHandle } from "./MonacoDiffView";
import type { FileDiff, GitCommitSummary } from "../../../shared/types";

export function LaneDiffPane({
  laneId,
  selectedPath,
  selectedFileMode,
  selectedCommit
}: {
  laneId: string | null;
  selectedPath: string | null;
  selectedFileMode: "staged" | "unstaged" | null;
  selectedCommit: GitCommitSummary | null;
}) {
  const navigate = useNavigate();
  const diffRef = useRef<MonacoDiffHandle | null>(null);

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [commitFiles, setCommitFiles] = useState<string[]>([]);
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<FileDiff | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Load diff for selected working tree file
  useEffect(() => {
    setDiff(null);
    if (!laneId || !selectedPath || !selectedFileMode) return;
    window.ade.diff
      .getFile({ laneId, path: selectedPath, mode: selectedFileMode })
      .then((value) => setDiff(value))
      .catch(() => setDiff(null));
  }, [laneId, selectedPath, selectedFileMode]);

  // Load commit file list
  useEffect(() => {
    setCommitFiles([]);
    setSelectedCommitFilePath(null);
    setCommitDiff(null);
    if (!laneId || !selectedCommit) return;

    let cancelled = false;
    window.ade.git
      .listCommitFiles({ laneId, commitSha: selectedCommit.sha })
      .then((files) => {
        if (cancelled) return;
        setCommitFiles(files);
        setSelectedCommitFilePath(files[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setCommitFiles([]);
        setSelectedCommitFilePath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, selectedCommit]);

  // Load commit file diff
  useEffect(() => {
    setCommitDiff(null);
    if (!laneId || !selectedCommit || !selectedCommitFilePath) return;
    let cancelled = false;
    window.ade.diff
      .getFile({
        laneId,
        path: selectedCommitFilePath,
        mode: "commit",
        compareRef: selectedCommit.sha,
        compareTo: "parent"
      })
      .then((value) => {
        if (!cancelled) setCommitDiff(value);
      })
      .catch(() => {
        if (!cancelled) setCommitDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, selectedCommit, selectedCommitFilePath]);

  // Commit diff view
  if (selectedCommit && laneId) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-card/40 backdrop-blur-sm shrink-0">
          <div className="min-w-0 flex items-center gap-2 text-xs">
            <span className="text-muted-fg/70">Commit</span>
            <span className="font-mono text-fg rounded bg-accent/8 px-1.5 py-0.5">{selectedCommit.shortSha}</span>
            <span className="truncate text-muted-fg">{selectedCommit.subject}</span>
          </div>
          <Chip className="text-[11px] shadow-[0_0_6px_-1px_rgba(6,214,160,0.15)]">{commitFiles.length} file{commitFiles.length === 1 ? "" : "s"}</Chip>
        </div>
        <div className="flex-1 min-h-0">
          <Group
            id={`diff-pane-commit:${selectedCommit.sha}`}
            orientation="horizontal"
            className="h-full min-h-0"
          >
            <Panel id="diff-pane-commit-files" minSize="15%" defaultSize="26%" className="min-w-0 bg-[--color-surface-recessed] shadow-inset ade-surface-recessed">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-center justify-between bg-card/40 backdrop-blur-sm px-2 py-1 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-fg/70">Files</span>
                    <Chip className="h-4 px-1 text-[11px] shadow-[0_0_4px_-1px_rgba(6,214,160,0.1)]">{commitFiles.length}</Chip>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto p-1.5 space-y-1">
                  {commitFiles.length ? (
                    commitFiles.map((file) => (
                      <button
                        key={file}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-all duration-150",
                          selectedCommitFilePath === file
                            ? "bg-accent/10 text-fg shadow-[0_0_8px_-2px_rgba(6,214,160,0.15)] border border-accent/10"
                            : "text-muted-fg hover:bg-card/40 hover:text-fg hover:shadow-[0_1px_4px_-1px_rgba(0,0,0,0.2)] border border-transparent"
                        )}
                        onClick={() => setSelectedCommitFilePath(file)}
                        title={file}
                      >
                        <span className="truncate">{file}</span>
                      </button>
                    ))
                  ) : (
                    <div className="p-3 text-center text-xs text-muted-fg opacity-60 italic">
                      Loading files...
                    </div>
                  )}
                </div>
              </div>
            </Panel>
            <ResizeGutter orientation="vertical" />
            <Panel id="diff-pane-commit-content" minSize="30%" defaultSize="74%" className="min-w-0">
              {!selectedCommitFilePath ? (
                <div className="flex h-full items-center justify-center p-3">
                  <EmptyState title="No files found" description="This commit may be empty." />
                </div>
              ) : !commitDiff ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-fg">Loading diff...</div>
              ) : (
                <MonacoDiffView diff={commitDiff} editable={false} className="h-full" />
              )}
            </Panel>
          </Group>
        </div>
      </div>
    );
  }

  // Working tree file diff
  if (selectedPath && diff && laneId) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-3 py-1.5 bg-card/40 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted-fg/70 rounded bg-muted/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">{selectedFileMode === "unstaged" ? "Working Tree" : "Index"}</span>
            <span className="text-muted-fg/30 mx-1">/</span>
            {diff.path.split("/").map((segment, idx, arr) => (
              <React.Fragment key={idx}>
                <span className={cn(
                  idx === arr.length - 1
                    ? "font-semibold text-fg rounded bg-accent/8 px-1 py-0.5"
                    : "text-muted-fg/60 hover:text-muted-fg transition-colors"
                )}>{segment}</span>
                {idx < arr.length - 1 && <span className="text-accent/30 mx-0.5">/</span>}
              </React.Fragment>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {selectedFileMode === "unstaged" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-[11px]"
                onClick={() => navigate("/files", { state: { openFilePath: selectedPath, laneId } })}
                title="Open in Files tab"
              >
                <FolderOpen size={12} className="mr-0.5" />
                Files
              </Button>
            ) : null}
            {selectedFileMode === "unstaged" && !diff.isBinary ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-[11px]"
                disabled={busyAction != null}
                onClick={() => {
                  const text = diffRef.current?.getModifiedValue();
                  if (text == null) return;
                  setBusyAction("save");
                  window.ade.files
                    .writeTextAtomic({ laneId, path: selectedPath, text })
                    .then(() => {
                      // Reload diff
                      return window.ade.diff.getFile({ laneId, path: selectedPath, mode: "unstaged" });
                    })
                    .then((value) => setDiff(value))
                    .catch(() => {})
                    .finally(() => setBusyAction(null));
                }}
              >
                <FloppyDisk size={12} className="mr-0.5" />
                Save
              </Button>
            ) : null}
          </div>
        </div>
        <MonacoDiffView ref={diffRef} diff={diff} editable={selectedFileMode === "unstaged"} className="flex-1" />
      </div>
    );
  }

  // Loading state
  if (selectedPath && !diff) {
    return <div className="flex items-center justify-center h-full text-muted-fg text-xs">Loading diff...</div>;
  }

  // Empty state
  return (
    <div className="flex h-full items-center justify-center p-3">
      <EmptyState title="Select a file or commit" description="Choose a changed file or pick a commit from the timeline." />
    </div>
  );
}
