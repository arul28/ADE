import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  CaretDown,
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
import { AdeDiffViewer } from "../shared/AdeDiffViewer";
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
const MAX_DIFF_CACHE_ENTRIES = 24;

function statusBadge(status: TurnDiffFile["status"]) {
  const { label, classes } = STATUS_BADGE_BY_STATUS[status] ?? STATUS_BADGE_DEFAULT;
  return (
    <span className={cn("rounded px-1 py-px font-mono text-[10px] font-medium uppercase leading-none", classes)}>
      {label}
    </span>
  );
}

/* ── Aggregation ── */

export type AggregatedFile = TurnDiffFile & {
  /** The turn whose SHA pair should be used to fetch the diff. */
  beforeSha: string;
  afterSha: string;
  turnIndex: number;
};

export function aggregateFiles(summaries: TurnDiffSummary[]): AggregatedFile[] {
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

function rememberCachedDiff(cache: Map<string, FileDiff>, cacheKey: string, diff: FileDiff): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, diff);
  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
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
        <AdeDiffViewer diff={activeDiff} editable={false} theme="dark" compact showToolbar={false} className="h-full rounded-none border-0" />
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

/* ── Components ── */

function FileChangesSummary({
  files,
  muted = false,
}: {
  files: TurnDiffFile[];
  muted?: boolean;
}) {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <span className={cn("flex flex-wrap items-center gap-2 text-[12px]", muted ? "text-fg/45" : "text-fg/60")}>
      <span>{files.length} file{files.length !== 1 ? "s" : ""}</span>
      {totalAdditions > 0 && <span className="text-emerald-400/70">+{totalAdditions}</span>}
      {totalDeletions > 0 && <span className="text-red-400/70">-{totalDeletions}</span>}
    </span>
  );
}

type FileChangesBrowserProps = {
  summaries: TurnDiffSummary[];
  sessionId: string;
  className?: string;
  maxHeight?: number;
};

const FileChangesBrowser = React.memo(function FileChangesBrowser({
  summaries,
  sessionId,
  className,
  maxHeight = 400,
}: FileChangesBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const diffCache = useRef<Map<string, FileDiff>>(new Map());
  const latestDiffRequestKey = useRef<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);
  const [activeDiffLoadState, setActiveDiffLoadState] = useState<DiffLoadState>("idle");

  const files = useMemo(() => aggregateFiles(summaries), [summaries]);
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

      const cachedDiff = diffCache.current.get(cacheKey);
      if (cachedDiff) {
        rememberCachedDiff(diffCache.current, cacheKey, cachedDiff);
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
        rememberCachedDiff(diffCache.current, cacheKey, diff);
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

  return (
    <div className={cn("flex min-h-[220px] overflow-hidden", className)} style={{ maxHeight }}>
      {/* File list (left pane) */}
      <div className="w-[220px] shrink-0 overflow-y-auto border-r border-white/[0.04] max-sm:w-[150px]">
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
              <div className="flex shrink-0 items-center gap-1.5 max-sm:hidden">
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
  );
});

export const ChatFileChangesPanel = React.memo(function ChatFileChangesPanel({
  summaries,
  sessionId,
}: {
  summaries: TurnDiffSummary[];
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(() => aggregateFiles(summaries), [summaries]);

  if (!files.length) return null;

  const summaryContent = (
    <FileChangesSummary files={files} />
  );

  return (
    <BottomDrawerSection
      label="File changes"
      icon={GitDiff}
      summary={summaryContent}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <FileChangesBrowser summaries={summaries} sessionId={sessionId} />
    </BottomDrawerSection>
  );
});

function NestedFileChangesSection({
  label,
  summaries,
  sessionId,
}: {
  label: string;
  summaries: TurnDiffSummary[];
  sessionId: string;
}) {
  const files = useMemo(() => aggregateFiles(summaries), [summaries]);
  if (!files.length) return null;
  return (
    <details className="group/changes overflow-hidden rounded-lg border border-white/[0.06] bg-black/[0.16]">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none transition-colors hover:bg-white/[0.03]">
        <CaretDown
          size={12}
          weight="bold"
          className="shrink-0 text-fg/38 transition-transform group-open/changes:rotate-180"
        />
        <span className="font-sans text-[12px] font-medium text-fg/72">{label}</span>
        <span className="ml-auto">
          <FileChangesSummary files={files} muted />
        </span>
      </summary>
      <div className="border-t border-white/[0.05]">
        <FileChangesBrowser
          summaries={summaries}
          sessionId={sessionId}
          maxHeight={360}
        />
      </div>
    </details>
  );
}

export const ChatTurnFileChangesPanel = React.memo(function ChatTurnFileChangesPanel({
  turnSummary,
  threadSummaries,
  sessionId,
}: {
  turnSummary: TurnDiffSummary;
  threadSummaries: TurnDiffSummary[];
  sessionId: string;
}) {
  const thread = threadSummaries.length ? threadSummaries : [turnSummary];
  const turnFiles = useMemo(() => aggregateFiles([turnSummary]), [turnSummary]);
  if (!turnFiles.length) return null;

  return (
    <details className="group rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-left outline-none">
        <GitDiff size={12} className="text-fg/42" />
        <span className="font-sans text-[12px] font-semibold text-fg/74">Files changed</span>
        <FileChangesSummary files={turnFiles} muted />
        <span className="ml-auto rounded-md border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/45 transition-colors group-open:text-fg/68">
          View diffs
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        <NestedFileChangesSection label="This turn" summaries={[turnSummary]} sessionId={sessionId} />
        <NestedFileChangesSection label="Full thread" summaries={thread} sessionId={sessionId} />
      </div>
    </details>
  );
});
