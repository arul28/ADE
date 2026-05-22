import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitBranch, Warning } from "@phosphor-icons/react";
import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { relativeWhen } from "../../lib/format";
import { HistoryGitContextMenu } from "./HistoryGitContextMenu";
import {
  buildCommitGraphLayout,
  columnCenterX,
  commitEdgePath,
  COMMIT_ROW_HEIGHT,
  rowCenterY,
} from "./commitGraphLayout";

function formatTimelineError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
  if (/^Lane worktree is missing\./i.test(message)) return message;
  if (/git working directory not found:/i.test(message)) {
    return "Lane worktree is missing. Restore or recreate the lane worktree before viewing commits.";
  }
  return message || "Unable to load commit history.";
}

type CommitHistoryViewProps = {
  laneId: string | null;
  laneName: string | null;
  selectedSha: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
  refreshToken?: number;
  active?: boolean;
};

export function CommitHistoryView({
  laneId,
  laneName,
  selectedSha,
  onSelectCommit,
  refreshToken = 0,
  active = true,
}: CommitHistoryViewProps) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limit, setLimit] = useState(120);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const [rows, branchRows] = await Promise.all([
        window.ade.git.listRecentCommits({ laneId, limit }),
        window.ade.git.listBranches({ laneId }).catch(() => [] as GitBranchSummary[]),
      ]);
      setCommits(rows);
      setBranches(branchRows);
    } catch (err) {
      setError(formatTimelineError(err));
      setCommits([]);
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, [laneId, limit]);

  useEffect(() => {
    if (!active || !laneId) return;
    void load();
  }, [active, laneId, load, refreshToken]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter((c) => {
      const hay = `${c.shortSha} ${c.sha} ${c.subject} ${c.authorName}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commits, search]);

  const layout = useMemo(() => buildCommitGraphLayout(filtered), [filtered]);

  const refsBySha = useMemo(() => {
    const map = new Map<string, GitBranchSummary[]>();
    for (const b of branches) {
      const sha = b.lastCommitSha?.trim();
      if (!sha) continue;
      const arr = map.get(sha) ?? [];
      arr.push(b);
      map.set(sha, arr);
    }
    return map;
  }, [branches]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    overscan: 12,
  });

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop < 80 && !loading && limit < 200) {
        setLimit((prev) => Math.min(200, prev + 40));
      }
    },
    [loading, limit],
  );

  if (!laneId) {
    return (
      <EmptyState
        icon={GitBranch}
        title="Select a lane"
        description="Pick a lane in the toolbar to view its commit graph"
      />
    );
  }

  if (loading && commits.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="Loading commits…"
        description={laneName ? `Fetching history for ${laneName}` : "Fetching commit history"}
      />
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          <Warning size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title={search ? "No matching commits" : "No commits"}
        description={search ? "Try a different search" : "This lane has no commit history yet"}
      />
    );
  }

  const graphHeight = virtualizer.getTotalSize();
  const svgHeight = layout.totalHeight;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SHA, message, author…"
          className="h-7 flex-1 rounded border border-white/10 bg-white/[0.03] px-2 font-mono text-[11px] text-fg placeholder:text-muted-fg/60 outline-none focus:border-accent/50"
        />
        <span className="shrink-0 font-mono text-[10px] text-muted-fg">
          {filtered.length} commit{filtered.length === 1 ? "" : "s"}
        </span>
        {notice ? (
          <span className="shrink-0 font-mono text-[10px] text-accent">{notice}</span>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        <div
          className="relative"
          style={{ height: graphHeight, minHeight: svgHeight }}
        >
          {/* SVG graph layer — fixed to content height */}
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={layout.graphWidth}
            height={svgHeight}
            aria-hidden
          >
            {layout.edges.map((edge) => {
              const x1 = columnCenterX(edge.fromCol);
              const y1 = rowCenterY(edge.fromRow) + 4;
              const x2 = columnCenterX(edge.toCol);
              const y2 = rowCenterY(edge.toRow) - 4;
              return (
                <path
                  key={edge.id}
                  d={commitEdgePath(x1, y1, x2, y2)}
                  fill="none"
                  stroke={edge.kind === "merge" ? "rgba(59,130,246,0.55)" : "rgba(255,255,255,0.14)"}
                  strokeWidth={edge.kind === "merge" ? 1.5 : 1}
                  strokeDasharray={edge.kind === "merge" ? "3 2" : undefined}
                />
              );
            })}
            {layout.nodes.map((node) => {
              const cx = columnCenterX(node.column);
              const cy = rowCenterY(node.rowIndex);
              const fill = node.isHead
                ? "#22C55E"
                : node.isMerge
                  ? "#3B82F6"
                  : "var(--color-card)";
              const stroke = node.isHead
                ? "#22C55E"
                : node.isMerge
                  ? "#3B82F6"
                  : "rgba(255,255,255,0.35)";
              return (
                <circle
                  key={node.sha}
                  cx={cx}
                  cy={cy}
                  r={node.isMerge ? 5 : 4}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={2}
                />
              );
            })}
          </svg>

          {virtualizer.getVirtualItems().map((vRow) => {
            const commit = filtered[vRow.index];
            if (!commit) return null;
            const node = layout.nodes.find((n) => n.sha === commit.sha);
            const isSelected = selectedSha === commit.sha;
            const isHead = vRow.index === 0;
            const refs = refsBySha.get(commit.sha) ?? [];

            return (
              <div
                key={commit.sha}
                className="absolute left-0 right-0 flex"
                style={{
                  height: COMMIT_ROW_HEIGHT,
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                <div
                  className="shrink-0"
                  style={{ width: layout.graphWidth }}
                />
                <HistoryGitContextMenu
                  laneId={laneId}
                  commit={commit}
                  isHead={isHead}
                  hasWorktree={!error}
                  onNotice={(m) => {
                    setNotice(m);
                    window.setTimeout(() => setNotice(null), 2500);
                  }}
                  onError={setError}
                  navigate={(path) => navigate(path)}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 border-l px-2 text-left transition-colors",
                      isSelected
                        ? "border-accent bg-accent/10"
                        : "border-transparent hover:bg-white/[0.04]",
                    )}
                    onClick={() => onSelectCommit(commit)}
                  >
                    <span className="shrink-0 font-mono text-[11px] text-muted-fg">
                      {commit.shortSha}
                    </span>
                    {isHead ? (
                      <span className="shrink-0 rounded bg-emerald-500/20 px-1 font-mono text-[9px] font-bold uppercase text-emerald-400">
                        HEAD
                      </span>
                    ) : null}
                    {node?.isMerge ? (
                      <span className="shrink-0 rounded bg-blue-500/20 px-1 font-mono text-[9px] font-bold uppercase text-blue-300">
                        merge
                      </span>
                    ) : null}
                    {refs.slice(0, 2).map((ref) => (
                      <span
                        key={ref.name}
                        className="max-w-[120px] truncate rounded bg-violet-500/15 px-1 font-mono text-[9px] text-violet-300"
                        title={ref.name}
                      >
                        {ref.isCurrent ? "● " : ""}
                        {ref.name}
                      </span>
                    ))}
                    <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-fg">
                      {commit.subject}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-fg">
                      {relativeWhen(commit.authoredAt)}
                    </span>
                  </button>
                </HistoryGitContextMenu>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
