import React, { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDown,
  CaretRight,
  FileCode,
  FilePlus,
  FileX,
} from "@phosphor-icons/react";
import type {
  AgentChatGetTurnFileDiffArgs,
  FileDiff,
  TurnDiffFile,
  TurnDiffSummary,
} from "../../../shared/types";
import { MonacoDiffView } from "../lanes/MonacoDiffView";
import { cn } from "../ui/cn";

/* ── Helpers ── */

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? normalized;
}

function statusIcon(status: TurnDiffFile["status"]) {
  switch (status) {
    case "A":
      return <FilePlus size={12} weight="regular" className="text-emerald-400/70" />;
    case "D":
      return <FileX size={12} weight="regular" className="text-red-400/70" />;
    default:
      return <FileCode size={12} weight="regular" className="text-sky-400/60" />;
  }
}

function statusBadge(status: TurnDiffFile["status"]) {
  switch (status) {
    case "A":
      return (
        <span className="rounded px-1 py-px font-mono text-[9px] font-medium uppercase leading-none bg-emerald-500/15 text-emerald-400/70">
          A
        </span>
      );
    case "D":
      return (
        <span className="rounded px-1 py-px font-mono text-[9px] font-medium uppercase leading-none bg-red-500/15 text-red-400/70">
          D
        </span>
      );
    case "R":
      return (
        <span className="rounded px-1 py-px font-mono text-[9px] font-medium uppercase leading-none bg-amber-500/15 text-amber-400/70">
          R
        </span>
      );
    case "C":
      return (
        <span className="rounded px-1 py-px font-mono text-[9px] font-medium uppercase leading-none bg-purple-500/15 text-purple-400/70">
          C
        </span>
      );
    default:
      return (
        <span className="rounded px-1 py-px font-mono text-[9px] font-medium uppercase leading-none bg-sky-500/15 text-sky-400/70">
          M
        </span>
      );
  }
}

/* ── Component ── */

export const ChatTurnDiffPanel = React.memo(function ChatTurnDiffPanel({
  summary,
  sessionId,
}: {
  summary: TurnDiffSummary;
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const diffCache = useRef<Record<string, FileDiff>>({});

  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      setSelectedPath(filePath);

      // Serve from cache if available.
      if (diffCache.current[filePath]) {
        setActiveDiff(diffCache.current[filePath]);
        return;
      }

      setLoadingPath(filePath);
      setActiveDiff(null);

      try {
        const args: AgentChatGetTurnFileDiffArgs = {
          sessionId,
          beforeSha: summary.beforeSha,
          afterSha: summary.afterSha,
          filePath,
        };
        const diff = await window.ade.agentChat.getTurnFileDiff(args);
        if (!diff) {
          setActiveDiff(null);
          return;
        }
        diffCache.current[filePath] = diff;
        setActiveDiff(diff);
      } catch (err) {
        console.error("[ChatTurnDiffPanel] Failed to fetch diff for", filePath, err);
      } finally {
        setLoadingPath(null);
      }
    },
    [sessionId, summary.beforeSha, summary.afterSha],
  );

  const fileCount = summary.files.length;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
      {/* ── Collapsed header ── */}
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <CaretDown size={10} weight="bold" className="shrink-0 text-fg/30" />
        ) : (
          <CaretRight size={10} weight="bold" className="shrink-0 text-fg/30" />
        )}

        <span className="font-mono text-[10px] text-fg/50">
          {fileCount} file{fileCount !== 1 ? "s" : ""} changed
        </span>

        {summary.totalAdditions > 0 && (
          <span className="font-mono text-[10px] text-emerald-400/70">
            +{summary.totalAdditions}
          </span>
        )}
        {summary.totalDeletions > 0 && (
          <span className="font-mono text-[10px] text-red-400/70">
            -{summary.totalDeletions}
          </span>
        )}

        <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/[0.06] px-1.5 font-mono text-[9px] tabular-nums text-fg/40">
          {fileCount}
        </span>
      </button>

      {/* ── Expanded body ── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.04]">
              <div
                className="flex"
                style={{ maxHeight: 400 }}
              >
                {/* ── File list (left pane) ── */}
                <div className="w-[220px] shrink-0 overflow-y-auto border-r border-white/[0.04]">
                  {summary.files.map((file) => {
                    const isSelected = selectedPath === file.path;
                    return (
                      <button
                        key={file.path}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                          isSelected
                            ? "bg-white/[0.05]"
                            : "hover:bg-white/[0.03]",
                        )}
                        onClick={() => void handleSelectFile(file.path)}
                      >
                        {statusIcon(file.status)}
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg/60"
                          title={file.path}
                        >
                          {basename(file.path)}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {file.additions > 0 && (
                            <span className="font-mono text-[9px] text-emerald-400/70">
                              +{file.additions}
                            </span>
                          )}
                          {file.deletions > 0 && (
                            <span className="font-mono text-[9px] text-red-400/70">
                              -{file.deletions}
                            </span>
                          )}
                          {statusBadge(file.status)}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* ── Diff viewer (right pane) ── */}
                <div className="min-w-0 flex-1">
                  {!selectedPath && (
                    <div className="flex h-full min-h-[200px] items-center justify-center p-4">
                      <span className="font-mono text-[10px] text-fg/25">
                        Select a file to view its diff
                      </span>
                    </div>
                  )}

                  {selectedPath && loadingPath === selectedPath && (
                    <div className="flex h-full min-h-[200px] items-center justify-center p-4">
                      <span className="font-mono text-[10px] text-fg/35 animate-pulse">
                        Loading diff...
                      </span>
                    </div>
                  )}

                  {selectedPath && loadingPath !== selectedPath && activeDiff && (
                    <div className="h-full min-h-[200px]" style={{ maxHeight: 400 }}>
                      <MonacoDiffView
                        diff={activeDiff}
                        editable={false}
                        theme="dark"
                        className="h-full rounded-none border-0"
                      />
                    </div>
                  )}

                  {selectedPath && loadingPath !== selectedPath && !activeDiff && (
                    <div className="flex h-full min-h-[200px] items-center justify-center p-4">
                      <span className="font-mono text-[10px] text-red-400/60">
                        Failed to load diff
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
