import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, FloppyDisk } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { EmptyState } from "../ui/EmptyState";
import { ResizeGutter } from "../ui/ResizeGutter";
import { MonacoDiffView, type MonacoDiffHandle } from "./MonacoDiffView";
import type { FileDiff, GitCommitSummary } from "../../../shared/types";
import { SmartTooltip } from "../ui/SmartTooltip";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton } from "./laneDesignTokens";

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
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
  liveSync = false
}: {
  laneId: string | null;
  selectedPath: string | null;
  selectedFileMode: "staged" | "unstaged" | null;
  selectedCommit: GitCommitSummary | null;
  liveSync?: boolean;
}) {
  const navigate = useNavigate();
  const diffRef = useRef<MonacoDiffHandle | null>(null);

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  const [commitFiles, setCommitFiles] = useState<string[]>([]);
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<FileDiff | null>(null);
  const [commitDiffFailed, setCommitDiffFailed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refreshWorkingDiff = React.useCallback(() => {
    if (!laneId || !selectedPath || !selectedFileMode) {
      setDiff(null);
      setDiffFailed(false);
      return Promise.resolve();
    }

    setDiffFailed(false);
    return window.ade.diff
      .getFile({ laneId, path: selectedPath, mode: selectedFileMode })
      .then((value) => {
        setDiff(value);
      })
      .catch(() => {
        setDiff(null);
        setDiffFailed(true);
      });
  }, [laneId, selectedPath, selectedFileMode]);

  useEffect(() => {
    setDiff(null);
    setDiffFailed(false);
    if (!laneId || !selectedPath || !selectedFileMode) return;
    void refreshWorkingDiff();
  }, [laneId, selectedPath, selectedFileMode, refreshWorkingDiff]);

  useEffect(() => {
    if (!liveSync) return;
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
  }, [liveSync, laneId, selectedPath, selectedFileMode, selectedCommit, refreshWorkingDiff]);

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

  const refreshCommitDiff = React.useCallback(() => {
    setCommitDiff(null);
    setCommitDiffFailed(false);
    if (!laneId || !selectedCommit || !selectedCommitFilePath) return;
    window.ade.diff
      .getFile({
        laneId,
        path: selectedCommitFilePath,
        mode: "commit",
        compareRef: selectedCommit.sha,
        compareTo: "parent"
      })
      .then((value) => {
        setCommitDiff(value);
      })
      .catch(() => {
        setCommitDiff(null);
        setCommitDiffFailed(true);
      });
  }, [laneId, selectedCommit, selectedCommitFilePath]);

  useEffect(() => {
    refreshCommitDiff();
  }, [refreshCommitDiff]);

  // Commit diff view
  if (selectedCommit && laneId) {
    return (
      <div className="h-full flex flex-col" style={{ background: COLORS.pageBg }}>
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: "6px 12px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}`, gap: 6 }}
        >
          <div className="min-w-0 flex items-center" style={{ fontSize: 12, gap: 6 }}>
            <span style={{
              ...inlineBadge(COLORS.accent),
              fontSize: 9,
              fontWeight: 700,
              padding: "3px 8px",
              background: COLORS.outlineBorder,
              border: "none",
            }}>COMMIT</span>
            <span style={{ ...inlineBadge(COLORS.accent), fontFamily: MONO_FONT }}>{selectedCommit.shortSha}</span>
            <span className="truncate" style={{ color: COLORS.textMuted }}>{selectedCommit.subject}</span>
          </div>
          <span style={inlineBadge(COLORS.success, { fontSize: 9 })}>
            {commitFiles.length} FILE{commitFiles.length === 1 ? "" : "S"}
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <Group
            id={`diff-pane-commit:${selectedCommit.sha}`}
            orientation="horizontal"
            className="h-full min-h-0"
          >
            <Panel id="diff-pane-commit-files" minSize="15%" defaultSize="26%" className="min-w-0" style={{ background: COLORS.recessedBg }}>
              <div className="flex h-full min-h-0 flex-col">
                <div
                  className="flex items-center justify-between shrink-0"
                  style={{ padding: "6px 8px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}
                >
                  <div className="flex items-center gap-2">
                    <span style={LABEL_STYLE}>FILES</span>
                    <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{commitFiles.length}</span>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto" style={{ padding: 4 }}>
                  {commitFiles.length ? (
                    commitFiles.map((file) => {
                      const isFileSelected = selectedCommitFilePath === file;
                      return (
                        <button
                          key={file}
                          type="button"
                          className="flex w-full items-center gap-2 text-left transition-all duration-150"
                          style={{
                            padding: "6px 8px",
                            fontSize: 12,
                            borderLeft: isFileSelected ? `3px solid ${COLORS.accent}` : "3px solid transparent",
                            background: isFileSelected ? COLORS.accentSubtle : "transparent",
                            color: isFileSelected ? COLORS.textPrimary : COLORS.textMuted,
                          }}
                          onClick={() => setSelectedCommitFilePath(file)}
                          title={file}
                          onMouseEnter={(e) => { if (!isFileSelected) e.currentTarget.style.background = COLORS.hoverBg; }}
                          onMouseLeave={(e) => { if (!isFileSelected) e.currentTarget.style.background = "transparent"; }}
                        >
                          <span className="truncate">{file}</span>
                        </button>
                      );
                    })
                  ) : (
                    <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: COLORS.textDim, fontStyle: "italic" }}>
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
              ) : commitDiffFailed ? (
                <DiffFailedRetry onRetry={refreshCommitDiff} />
              ) : !commitDiff ? (
                <div className="flex h-full items-center justify-center" style={{ fontSize: 12, color: COLORS.textMuted }}>Loading diff...</div>
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
      <div className="h-full flex flex-col" style={{ background: COLORS.pageBg }}>
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: "6px 12px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}
        >
          <div className="flex items-center" style={{ fontSize: 12, gap: 6 }}>
            <span style={{
              ...inlineBadge(selectedFileMode === "unstaged" ? COLORS.warning : COLORS.info),
              fontSize: 9,
              fontWeight: 700,
              padding: "3px 8px",
              background: COLORS.outlineBorder,
              border: "none",
            }}>
              {selectedFileMode === "unstaged" ? "WORKING TREE" : "INDEX"}
            </span>
            <span style={{ color: COLORS.outlineBorder }}>/</span>
            {diff.path.split("/").map((segment, idx, arr) => (
              <React.Fragment key={idx}>
                <span style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  ...(idx === arr.length - 1
                    ? { fontWeight: 600, color: COLORS.textPrimary, background: `${COLORS.accent}15`, padding: "2px 4px" }
                    : { color: COLORS.textDim }),
                }}>{segment}</span>
                {idx < arr.length - 1 && <span style={{ color: COLORS.outlineBorder }}>/</span>}
              </React.Fragment>
            ))}
          </div>
          <div className="flex items-center" style={{ gap: 3 }}>
            {selectedFileMode === "unstaged" ? (
              <SmartTooltip content={{
                label: "Open in Files",
                description: "Open this file in the Files tab for full editing.",
                effect: `Open ${selectedPath}`,
              }}>
                <button
                  type="button"
                  className="focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                  style={outlineButton({ height: 24, gap: 4, padding: "4px 8px", fontSize: 10 })}
                  onClick={() => navigate("/files", { state: { openFilePath: selectedPath, laneId } })}
                  title="Open in Files tab"
                >
                  <FolderOpen size={12} />
                  FILES
                </button>
              </SmartTooltip>
            ) : null}
            {selectedFileMode === "unstaged" && !diff.isBinary ? (
              <SmartTooltip content={{
                label: "Save",
                description: "Write the edited content back to the working tree.",
                effect: `Save changes to ${selectedPath}`,
              }}>
                <button
                  type="button"
                  className="focus-visible:ring-2 focus-visible:ring-purple-400/50 focus-visible:ring-offset-0"
                  style={outlineButton({ height: 24, gap: 4, padding: "4px 8px", fontSize: 10 })}
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
                  <FloppyDisk size={12} />
                  SAVE
                </button>
              </SmartTooltip>
            ) : null}
          </div>
        </div>
        <MonacoDiffView ref={diffRef} diff={diff} editable={selectedFileMode === "unstaged"} className="flex-1" />
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
        Loading diff...
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
