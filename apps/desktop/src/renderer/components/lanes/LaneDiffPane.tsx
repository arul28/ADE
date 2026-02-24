import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, FloppyDisk } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { EmptyState } from "../ui/EmptyState";
import { ResizeGutter } from "../ui/ResizeGutter";
import { MonacoDiffView, type MonacoDiffHandle } from "./MonacoDiffView";
import type { FileDiff, GitCommitSummary } from "../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton } from "./laneDesignTokens";

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

  useEffect(() => {
    setDiff(null);
    if (!laneId || !selectedPath || !selectedFileMode) return;
    window.ade.diff
      .getFile({ laneId, path: selectedPath, mode: selectedFileMode })
      .then((value) => setDiff(value))
      .catch(() => setDiff(null));
  }, [laneId, selectedPath, selectedFileMode]);

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
              <button
                type="button"
                style={outlineButton({ height: 24, gap: 4, padding: "4px 8px", fontSize: 10 })}
                onClick={() => navigate("/files", { state: { openFilePath: selectedPath, laneId } })}
                title="Open in Files tab"
              >
                <FolderOpen size={12} />
                FILES
              </button>
            ) : null}
            {selectedFileMode === "unstaged" && !diff.isBinary ? (
              <button
                type="button"
                style={outlineButton({ height: 24, gap: 4, padding: "4px 8px", fontSize: 10 })}
                disabled={busyAction != null}
                onClick={() => {
                  const text = diffRef.current?.getModifiedValue();
                  if (text == null) return;
                  setBusyAction("save");
                  window.ade.files
                    .writeTextAtomic({ laneId, path: selectedPath, text })
                    .then(() => {
                      return window.ade.diff.getFile({ laneId, path: selectedPath, mode: "unstaged" });
                    })
                    .then((value) => setDiff(value))
                    .catch(() => {})
                    .finally(() => setBusyAction(null));
                }}
              >
                <FloppyDisk size={12} />
                SAVE
              </button>
            ) : null}
          </div>
        </div>
        <MonacoDiffView ref={diffRef} diff={diff} editable={selectedFileMode === "unstaged"} className="flex-1" />
      </div>
    );
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
