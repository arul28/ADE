import React, { useEffect, useMemo, useRef, useState } from "react";
import { FloppyDisk, FolderOpen, GitCommit } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { EmptyState } from "../ui/EmptyState";
import { ResizeGutter } from "../ui/ResizeGutter";
import { AdeDiffViewer, type AdeDiffViewerHandle } from "../shared/AdeDiffViewer";
import type { FileDiff, FilePatch, GitCommitSummary, OpenProjectBinding } from "../../../shared/types";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { getFileIcon } from "../files/filePresentation";
import { COLORS, MONO_FONT, outlineButton } from "./laneDesignTokens";

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function filePatchHasRenderableChanges(patch: FilePatch | null | undefined): patch is FilePatch {
  if (!patch) return false;
  if (patch.isBinary) return true;
  return patch.patch.trim().length > 0;
}

function fileDiffHasRenderableChanges(diff: FileDiff | null | undefined): diff is FileDiff {
  if (!diff) return false;
  if (diff.original.exists !== diff.modified.exists) return true;
  if (diff.isBinary) return true;
  return diff.original.text !== diff.modified.text;
}

const MAX_COMMIT_FILE_ROWS = 500;

/** The diff's header strip: one quiet row over a hairline, like the pane chrome. */
const HEADER_ROW = "flex h-10 shrink-0 items-center justify-between gap-2 px-3";
const HEADER_ROW_STYLE: React.CSSProperties = { borderBottom: `1px solid ${COLORS.borderMuted}` };

/** A small ghost button for the diff header ("Open in Files", "Save"). */
const headerButton = outlineButton({ height: 26, gap: 5, padding: "0 9px", fontSize: 12 });

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

function DiffFailedRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <span className="text-sm text-red-400">Failed to load diff</span>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs text-white/60 hover:text-white/80 underline focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
      >
        Retry
      </button>
    </div>
  );
}

export function LaneDiffPane({
  laneId,
  selectedPath,
  selectedFileMode,
  selectedCommit,
  liveSync = false,
  runtimePin = null
}: {
  laneId: string | null;
  selectedPath: string | null;
  selectedFileMode: "staged" | "unstaged" | null;
  selectedCommit: GitCommitSummary | null;
  liveSync?: boolean;
  /**
   * Machine this lane actually lives on. `null` means the tab's bound machine
   * (the historical behavior). When set, every diff/git read is routed there.
   */
  runtimePin?: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  const pin = runtimePin ?? null;
  // File-workspace IPC (watch/save) has no pin parameter yet, so a foreign
  // lane's diff is read-only and does not live-sync.
  const isForeign = pin != null;
  const diffRef = useRef<AdeDiffViewerHandle | null>(null);
  const workingDiffRequestSeq = useRef(0);
  const commitFilesRequestSeq = useRef(0);
  const commitDiffRequestSeq = useRef(0);

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  const [commitFiles, setCommitFiles] = useState<string[]>([]);
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<FileDiff | null>(null);
  const [commitPatch, setCommitPatch] = useState<FilePatch | null>(null);
  const [commitDiffFailed, setCommitDiffFailed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showAllCommitFiles, setShowAllCommitFiles] = useState(false);
  useEffect(() => {
    setShowAllCommitFiles(false);
  }, [selectedCommit?.sha]);
  const visibleCommitFiles = useMemo(
    () => (showAllCommitFiles ? commitFiles : commitFiles.slice(0, MAX_COMMIT_FILE_ROWS)),
    [commitFiles, showAllCommitFiles],
  );
  const hiddenCommitFileCount = Math.max(0, commitFiles.length - visibleCommitFiles.length);

  const refreshWorkingDiff = React.useCallback(() => {
    const requestId = ++workingDiffRequestSeq.current;
    if (!laneId || !selectedPath || !selectedFileMode) {
      setDiff(null);
      setPatch(null);
      setDiffFailed(false);
      return Promise.resolve();
    }

    return Promise.allSettled([
      window.ade.diff.getFile({ laneId, path: selectedPath, mode: selectedFileMode }, pin),
      window.ade.diff.getFilePatch({ laneId, path: selectedPath, mode: selectedFileMode }, pin),
    ])
      .then(([diffResult, patchResult]) => {
        if (workingDiffRequestSeq.current !== requestId) return;
        const nextDiff = diffResult.status === "fulfilled" ? diffResult.value : null;
        const nextPatch = patchResult.status === "fulfilled" && filePatchHasRenderableChanges(patchResult.value) ? patchResult.value : null;
        if (!nextPatch && (!nextDiff || !fileDiffHasRenderableChanges(nextDiff))) {
          if (diffResult.status === "rejected" || patchResult.status === "rejected") {
            setDiff(null);
            setPatch(null);
            setDiffFailed(true);
            return;
          }
        }
        if (!nextDiff && !nextPatch) {
          setDiff(null);
          setPatch(null);
          setDiffFailed(true);
          return;
        }
        setDiff(nextDiff);
        setPatch(nextPatch);
        setDiffFailed(false);
      })
      .catch(() => {
        if (workingDiffRequestSeq.current !== requestId) return;
        setDiff(null);
        setPatch(null);
        setDiffFailed(true);
      });
  }, [laneId, pin, selectedPath, selectedFileMode]);

  useEffect(() => {
    void refreshWorkingDiff();
  }, [refreshWorkingDiff]);

  useEffect(() => {
    if (!liveSync || isForeign) return;
    if (!laneId || !selectedPath || !selectedFileMode || selectedCommit) return;

    let cancelled = false;
    let watchedWorkspaceId: string | null = null;
    let refreshTimer: number | null = null;
    let unsubscribe = () => {};

    const selectedPathNormalized = normalizePath(selectedPath);

    const scheduleRefresh = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (document.visibilityState !== "visible") return;
        void refreshWorkingDiff();
      }, 120);
    };

    void window.ade.files
      .listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const workspace = workspaces.find((candidate) => candidate.laneId === laneId);
        if (!workspace) return;
        watchedWorkspaceId = workspace.id;
        void window.ade.files.watchChanges({ workspaceId: workspace.id }).catch(() => {
          // best effort
        });
        unsubscribe = window.ade.files.onChange((event) => {
          if (event.workspaceId !== workspace.id) return;
          const nextPath = normalizePath(event.path);
          const oldPath = normalizePath(event.oldPath ?? "");
          if (
            nextPath !== selectedPathNormalized &&
            oldPath !== selectedPathNormalized &&
            !selectedPathNormalized.startsWith(`${oldPath}/`)
          ) {
            return;
          }
          scheduleRefresh();
        });
      })
      .catch(() => {
        // no-op: live sync is best effort
      });

    return () => {
      cancelled = true;
      unsubscribe();
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      if (watchedWorkspaceId) {
        void window.ade.files.stopWatching({ workspaceId: watchedWorkspaceId }).catch(() => {
          // best effort
        });
      }
    };
  }, [liveSync, isForeign, laneId, selectedPath, selectedFileMode, selectedCommit, refreshWorkingDiff]);

  useEffect(() => {
    const requestId = ++commitFilesRequestSeq.current;
    commitDiffRequestSeq.current += 1;
    setCommitFiles([]);
    setSelectedCommitFilePath(null);
    setCommitDiff(null);
    setCommitPatch(null);
    setCommitDiffFailed(false);
    if (!laneId || !selectedCommit) return;

    let cancelled = false;
    window.ade.git
      .listCommitFiles({ laneId, commitSha: selectedCommit.sha }, pin)
      .then((files) => {
        if (cancelled || commitFilesRequestSeq.current !== requestId) return;
        setCommitFiles(files);
        setSelectedCommitFilePath(files[0] ?? null);
      })
      .catch(() => {
        if (cancelled || commitFilesRequestSeq.current !== requestId) return;
        setCommitFiles([]);
        setSelectedCommitFilePath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, pin, selectedCommit]);

  const refreshCommitDiff = React.useCallback(() => {
    const requestId = ++commitDiffRequestSeq.current;
    setCommitDiff(null);
    setCommitPatch(null);
    setCommitDiffFailed(false);
    if (!laneId || !selectedCommit || !selectedCommitFilePath) return;
    const args = {
        laneId,
        path: selectedCommitFilePath,
        mode: "commit",
        compareRef: selectedCommit.sha,
        compareTo: "parent"
      } as const;
    Promise.allSettled([
      window.ade.diff.getFile(args, pin),
      window.ade.diff.getFilePatch(args, pin),
    ])
      .then(([diffResult, patchResult]) => {
        if (commitDiffRequestSeq.current !== requestId) return;
        const nextDiff = diffResult.status === "fulfilled" ? diffResult.value : null;
        const nextPatch = patchResult.status === "fulfilled" && filePatchHasRenderableChanges(patchResult.value) ? patchResult.value : null;
        if (!nextPatch && !fileDiffHasRenderableChanges(nextDiff)) {
          if (diffResult.status === "rejected" || patchResult.status === "rejected") {
            setCommitDiff(null);
            setCommitPatch(null);
            setCommitDiffFailed(true);
            return;
          }
        }
        if (diffResult.status !== "fulfilled" && patchResult.status !== "fulfilled") {
          setCommitDiff(null);
          setCommitPatch(null);
          setCommitDiffFailed(true);
          return;
        }
        setCommitDiff(nextDiff);
        setCommitPatch(nextPatch);
        setCommitDiffFailed(false);
      })
      .catch(() => {
        if (commitDiffRequestSeq.current !== requestId) return;
        setCommitDiff(null);
        setCommitDiffFailed(true);
      });
  }, [laneId, pin, selectedCommit, selectedCommitFilePath]);

  useEffect(() => {
    refreshCommitDiff();
  }, [refreshCommitDiff]);

  // Commit diff view
  if (selectedCommit && laneId) {
    return (
      <div className="h-full flex flex-col" style={{ background: COLORS.pageBg }}>
        <div className={HEADER_ROW} style={HEADER_ROW_STYLE}>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <GitCommit size={14} weight="bold" className="shrink-0" style={{ color: COLORS.textMuted }} aria-hidden />
            <span className="shrink-0 text-[11.5px]" style={{ fontFamily: MONO_FONT, color: COLORS.textMuted }}>{selectedCommit.shortSha}</span>
            <span className="truncate" style={{ color: COLORS.textPrimary }}>{selectedCommit.subject}</span>
          </div>
          <span className="shrink-0 text-[12px] tabular-nums" style={{ color: COLORS.textMuted }}>
            {commitFiles.length} file{commitFiles.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <Group
            id={`diff-pane-commit:${selectedCommit.sha}`}
            orientation="horizontal"
            className="h-full min-h-0"
          >
            <Panel id="diff-pane-commit-files" minSize="15%" defaultSize="32%" className="min-w-0">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
                  <span className="font-medium" style={{ color: COLORS.textMuted }}>Files</span>
                  <span className="tabular-nums" style={{ color: COLORS.textDim }}>{commitFiles.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-auto" style={{ padding: "0 6px 6px" }}>
                  {commitFiles.length ? (
                    visibleCommitFiles.map((file) => {
                      const isFileSelected = selectedCommitFilePath === file;
                      const { dir, name } = splitPath(file);
                      const { icon: FileIcon, color: iconColor } = getFileIcon(name);
                      return (
                        <button
                          key={file}
                          type="button"
                          className={cn(
                            "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors duration-100",
                            !isFileSelected && "hover:bg-fg/[0.05]",
                          )}
                          style={{
                            background: isFileSelected ? COLORS.accentSubtle : undefined,
                            color: isFileSelected ? COLORS.textPrimary : COLORS.textSecondary,
                          }}
                          onClick={() => setSelectedCommitFilePath(file)}
                          title={file}
                        >
                          <FileIcon size={13} className="shrink-0" style={{ color: iconColor }} aria-hidden />
                          {/* The folder gives way before the file name does. */}
                          <span className="max-w-[calc(100%-21px)] shrink-0 truncate">{name}</span>
                          {dir ? <span className="min-w-0 truncate" style={{ color: COLORS.textDim }}>{dir.replace(/\/$/, "")}</span> : null}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-2 py-3 text-[12px]" style={{ color: COLORS.textDim }}>
                      Loading files…
                    </div>
                  )}
                  {hiddenCommitFileCount > 0 ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-[11.5px]" style={{ color: COLORS.textDim }}>
                      <span>Showing first {MAX_COMMIT_FILE_ROWS} of {commitFiles.length} files.</span>
                      <button
                        type="button"
                        onClick={() => setShowAllCommitFiles(true)}
                        className="font-medium hover:underline"
                        style={{ color: COLORS.accent, cursor: "pointer" }}
                      >
                        Show all
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </Panel>
            <ResizeGutter orientation="vertical" />
            <Panel id="diff-pane-commit-content" minSize="30%" defaultSize="68%" className="min-w-0">
              {!selectedCommitFilePath ? (
                <div className="flex h-full items-center justify-center p-3">
                  <EmptyState title="No files found" description="This commit may be empty." />
                </div>
              ) : commitDiffFailed ? (
                <DiffFailedRetry onRetry={refreshCommitDiff} />
              ) : !commitDiff && !commitPatch ? (
                <div className="flex h-full items-center justify-center" style={{ fontSize: 12, color: COLORS.textMuted }}>Loading diff…</div>
              ) : (
                <AdeDiffViewer diff={commitDiff} patch={commitPatch} editable={false} className="h-full" />
              )}
            </Panel>
          </Group>
        </div>
      </div>
    );
  }

  // Working tree file diff
  if (selectedPath && laneId && (diff || patch)) {
    const displayPath = diff?.path ?? patch?.path ?? selectedPath;
    return (
      <div className="h-full flex flex-col" style={{ background: COLORS.pageBg }}>
        <div className={HEADER_ROW} style={HEADER_ROW_STYLE}>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <span
              className="inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-medium"
              style={{
                color: selectedFileMode === "unstaged" ? COLORS.warning : COLORS.success,
                background: `color-mix(in srgb, ${selectedFileMode === "unstaged" ? COLORS.warning : COLORS.success} 13%, transparent)`,
              }}
            >
              {selectedFileMode === "unstaged" ? "Unstaged" : "Staged"}
            </span>
            <span className="min-w-0 truncate" title={displayPath}>
              <span style={{ color: COLORS.textDim }}>{splitPath(displayPath).dir}</span>
              <span className="font-medium" style={{ color: COLORS.textPrimary }}>{splitPath(displayPath).name}</span>
            </span>
          </div>
          <div className="flex items-center" style={{ gap: 3 }}>
            {selectedFileMode === "unstaged" && !isForeign ? (
              <SmartTooltip content={{
                label: "Open in Files",
                description: "Open this file in the Files tab for full editing.",
                effect: `Open ${selectedPath}`,
              }}>
                <button
                  type="button"
                  className="focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                  style={headerButton}
                  onClick={() => navigate("/files", { state: { openFilePath: selectedPath, laneId } })}
                  title="Open in Files tab"
                >
                  <FolderOpen size={13} />
                  Files
                </button>
              </SmartTooltip>
            ) : null}
            {selectedFileMode === "unstaged" && !isForeign && diff && !diff.isBinary ? (
              <SmartTooltip content={{
                label: "Save",
                description: "Write the edited content back to the working tree.",
                effect: `Save changes to ${selectedPath}`,
              }}>
                <button
                  type="button"
                  className="focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                  style={headerButton}
                  disabled={busyAction != null}
                  onClick={() => {
                    const text = diffRef.current?.getModifiedValue();
                    if (text == null) return;
                    setBusyAction("save");
                    window.ade.files
                      .writeTextAtomic({ laneId, path: selectedPath, text })
                      .then(() => {
                        return refreshWorkingDiff();
                      })
                      .catch(() => {})
                      .finally(() => setBusyAction(null));
                  }}
                >
                  <FloppyDisk size={13} />
                  Save
                </button>
              </SmartTooltip>
            ) : null}
          </div>
        </div>
        <AdeDiffViewer ref={diffRef} diff={diff} patch={patch} editable={selectedFileMode === "unstaged" && !isForeign} className="flex-1" />
      </div>
    );
  }

  // Failure state with retry
  if (selectedPath && diffFailed) {
    return <DiffFailedRetry onRetry={() => void refreshWorkingDiff()} />;
  }

  // Loading state
  if (selectedPath && !diff) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: COLORS.textMuted, fontSize: 12 }}>
        Loading diff…
      </div>
    );
  }

  // Empty state
  return (
    <div className="flex h-full items-center justify-center p-3">
      <EmptyState title="Select a file or commit" description="Choose a changed file or pick a commit from the timeline." />
    </div>
  );
}
