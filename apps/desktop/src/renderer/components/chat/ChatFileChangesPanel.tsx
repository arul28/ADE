import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  FileCode,
  FilePlus,
  FileX,
  GitDiff,
} from "@phosphor-icons/react";
import type {
  AgentChatGetTurnFileDiffArgs,
  FileDiff,
  TurnDiffFile,
  TurnDiffSummary,
} from "../../../shared/types";
import { MonacoDiffView } from "../lanes/MonacoDiffView";
import { cn } from "../ui/cn";
import { BottomDrawerSection } from "./BottomDrawerSection";

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

const STATUS_BADGE_BY_STATUS: Record<string, { label: string; classes: string }> = {
  A: { label: "A", classes: "bg-emerald-500/15 text-emerald-400/70" },
  D: { label: "D", classes: "bg-red-500/15 text-red-400/70" },
  R: { label: "R", classes: "bg-amber-500/15 text-amber-400/70" },
  C: { label: "C", classes: "bg-purple-500/15 text-purple-400/70" },
};
const STATUS_BADGE_DEFAULT = { label: "M", classes: "bg-sky-500/15 text-sky-400/70" };

function statusBadge(status: TurnDiffFile["status"]) {
  const { label, classes } = STATUS_BADGE_BY_STATUS[status] ?? STATUS_BADGE_DEFAULT;
  return (
    <span className={cn("rounded px-1 py-px font-mono text-[10px] font-medium uppercase leading-none", classes)}>
      {label}
    </span>
  );
}

/* ── Aggregation ── */

type AggregatedFile = TurnDiffFile & {
  /** The turn whose SHA pair should be used to fetch the diff. */
  beforeSha: string;
  afterSha: string;
  turnIndex: number;
};

function aggregateFiles(summaries: TurnDiffSummary[]): AggregatedFile[] {
  // Summaries arrive in chronological order, so each subsequent turn is the
  // "latest" for any file it touches. We keep the first turn's beforeSha and
  // advance the afterSha/status/stats as later turns amend the same path.
  const byPath = new Map<string, AggregatedFile>();
  for (let i = 0; i < summaries.length; i++) {
    const turn = summaries[i];
    for (const file of turn.files) {
      const existing = byPath.get(file.path);
      if (existing) {
        existing.afterSha = turn.afterSha;
        existing.turnIndex = i;
        existing.status = file.status;
        existing.additions = file.additions;
        existing.deletions = file.deletions;
      } else {
        byPath.set(file.path, {
          ...file,
          beforeSha: turn.beforeSha,
          afterSha: turn.afterSha,
          turnIndex: i,
        });
      }
    }
  }
  return [...byPath.values()];
}

function getDiffCacheKey(args: AgentChatGetTurnFileDiffArgs) {
  return [args.sessionId, args.beforeSha, args.afterSha, args.filePath].join("\u0000");
}

/* ── Diff pane ── */

type DiffLoadState = "idle" | "loading" | "loaded" | "missing" | "error";

function renderDiffPane({
  selectedPath,
  loadingPath,
  activeDiff,
  loadState,
}: {
  selectedPath: string | null;
  loadingPath: string | null;
  activeDiff: FileDiff | null;
  loadState: DiffLoadState;
}) {
  const centered = "flex h-full min-h-[200px] items-center justify-center p-4";
  if (!selectedPath) {
    return (
      <div className={centered}>
        <span className="text-[12px] text-fg/25">Select a file to view its diff</span>
      </div>
    );
  }
  if (loadingPath === selectedPath) {
    return (
      <div className={centered}>
        <span className="animate-pulse text-[12px] text-fg/35">Loading diff...</span>
      </div>
    );
  }
  if (activeDiff) {
    return (
      <div className="h-full min-h-[200px]" style={{ maxHeight: 400 }}>
        <MonacoDiffView diff={activeDiff} editable={false} theme="dark" className="h-full rounded-none border-0" />
      </div>
    );
  }
  return (
    <div className={centered}>
      <span className="text-[12px] text-fg/35">
        {loadState === "missing" ? "No diff available" : "Failed to load diff"}
      </span>
    </div>
  );
}

/* ── Component ── */

export const ChatFileChangesPanel = React.memo(function ChatFileChangesPanel({
  summaries,
  sessionId,
}: {
  summaries: TurnDiffSummary[];
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const diffCache = useRef<Record<string, FileDiff>>({});
  const latestDiffRequestKey = useRef<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);
  const [activeDiffLoadState, setActiveDiffLoadState] = useState<DiffLoadState>("idle");

  const files = useMemo(() => aggregateFiles(summaries), [summaries]);
  const totalAdditions = useMemo(() => files.reduce((sum, file) => sum + file.additions, 0), [files]);
  const totalDeletions = useMemo(() => files.reduce((sum, file) => sum + file.deletions, 0), [files]);

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      setSelectedPath(filePath);

      const file = files.find((f) => f.path === filePath);
      if (!file) return;

      const args: AgentChatGetTurnFileDiffArgs = {
        sessionId,
        beforeSha: file.beforeSha,
        afterSha: file.afterSha,
        filePath,
      };
      const cacheKey = getDiffCacheKey(args);

      latestDiffRequestKey.current = cacheKey;

      const cachedDiff = diffCache.current[cacheKey];
      if (cachedDiff) {
        setActiveDiff(cachedDiff);
        setActiveDiffLoadState("loaded");
        setLoadingPath(null);
        return;
      }

      setLoadingPath(filePath);
      setActiveDiff(null);
      setActiveDiffLoadState("loading");

      try {
        const diff = await window.ade.agentChat.getTurnFileDiff(args);
        if (latestDiffRequestKey.current !== cacheKey) return;
        if (!diff) {
          setActiveDiff(null);
          setActiveDiffLoadState("missing");
          return;
        }
        diffCache.current[cacheKey] = diff;
        setActiveDiff(diff);
        setActiveDiffLoadState("loaded");
      } catch (err) {
        if (latestDiffRequestKey.current !== cacheKey) return;
        console.error("[ChatFileChangesPanel] Failed to fetch diff for", filePath, err);
        setActiveDiffLoadState("error");
      } finally {
        if (latestDiffRequestKey.current === cacheKey) {
          setLoadingPath(null);
        }
      }
    },
    [sessionId, files],
  );

  if (!files.length) return null;

  const summaryContent = (
    <span className="flex items-center gap-2 text-[12px]">
      <span className="text-fg/50">{files.length} file{files.length !== 1 ? "s" : ""}</span>
      {totalAdditions > 0 && <span className="text-emerald-400/70">+{totalAdditions}</span>}
      {totalDeletions > 0 && <span className="text-red-400/70">-{totalDeletions}</span>}
    </span>
  );

  return (
    <BottomDrawerSection
      label="File changes"
      icon={GitDiff}
      summary={summaryContent}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div className="flex" style={{ maxHeight: 400 }}>
        {/* File list (left pane) */}
        <div className="w-[220px] shrink-0 overflow-y-auto border-r border-white/[0.04]">
          {files.map((file) => {
            const isSelected = selectedPath === file.path;
            return (
              <button
                key={file.path}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                  isSelected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                )}
                onClick={() => void handleSelectFile(file.path)}
              >
                {statusIcon(file.status)}
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg/60" title={file.path}>
                  {basename(file.path)}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {file.additions > 0 && <span className="text-[11px] text-emerald-400/70">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-[11px] text-red-400/70">-{file.deletions}</span>}
                  {statusBadge(file.status)}
                </div>
              </button>
            );
          })}
        </div>

        {/* Diff viewer (right pane) */}
        <div className="min-w-0 flex-1">
          {renderDiffPane({ selectedPath, loadingPath, activeDiff, loadState: activeDiffLoadState })}
        </div>
      </div>
    </BottomDrawerSection>
  );
});
