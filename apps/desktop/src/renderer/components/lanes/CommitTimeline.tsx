import React from "react";
import type { GitCommitSummary } from "../../../shared/types";
import { cn } from "../ui/cn";

function formatTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

type CommitMeta = {
  fileCount: number | null;
  loadedAt: string;
};

export function CommitTimeline({
  laneId,
  selectedSha,
  onSelectCommit
}: {
  laneId: string | null;
  selectedSha: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
}) {
  const [commits, setCommits] = React.useState<GitCommitSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(40);
  const metaByShaRef = React.useRef<Map<string, CommitMeta>>(new Map());
  const [hoveredSha, setHoveredSha] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await window.ade.git.listRecentCommits({ laneId, limit });
      setCommits(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [laneId, limit]);

  React.useEffect(() => {
    metaByShaRef.current = new Map();
    setHoveredSha(null);
    setLimit(40);
  }, [laneId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const ensureMeta = React.useCallback(
    async (sha: string) => {
      if (!laneId) return;
      if (metaByShaRef.current.has(sha)) return;
      try {
        const files = await window.ade.git.listCommitFiles({ laneId, commitSha: sha });
        metaByShaRef.current.set(sha, { fileCount: files.length, loadedAt: new Date().toISOString() });
        // Force a repaint for tooltips.
        setHoveredSha((prev) => (prev === sha ? sha : prev));
      } catch {
        metaByShaRef.current.set(sha, { fileCount: null, loadedAt: new Date().toISOString() });
      }
    },
    [laneId]
  );

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 60 && !loading) {
      setLimit((prev) => Math.min(200, prev + 40));
    }
  };

  const hovered = hoveredSha ? commits.find((c) => c.sha === hoveredSha) ?? null : null;
  const hoveredMeta = hovered ? metaByShaRef.current.get(hovered.sha) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-fg">Commits</span>
          <span className="text-[10px] text-muted-fg">{loading ? "loading…" : `${commits.length}`}</span>
        </div>
        <button
          type="button"
          className="text-[10px] text-muted-fg hover:text-fg"
          onClick={() => void load()}
          disabled={!laneId || loading}
          title="Refresh"
        >
          Refresh
        </button>
      </div>

      {error ? <div className="px-2 py-2 text-[11px] text-red-300">{error}</div> : null}

      <div className="flex-1 min-h-0 overflow-auto p-1" onScroll={onScroll}>
        <div className="relative">
          <div className="absolute left-[13px] top-0 bottom-0 w-px bg-border/80" />
          <div className="space-y-0.5">
            {commits.map((commit, idx) => {
              const isHead = idx === 0;
              const isSelected = selectedSha === commit.sha;
              const isMerge = commit.parents.length > 1;
              return (
                <button
                  key={commit.sha}
                  type="button"
                  className={cn(
                    "group relative flex w-full items-start gap-2 rounded border px-2 py-1 text-left text-[11px] transition-colors",
                    isSelected ? "border-accent bg-accent/10" : "border-transparent hover:border-border hover:bg-muted/40"
                  )}
                  onClick={() => onSelectCommit(commit)}
                  onMouseEnter={() => {
                    setHoveredSha(commit.sha);
                    void ensureMeta(commit.sha);
                  }}
                  onMouseLeave={() => setHoveredSha((prev) => (prev === commit.sha ? null : prev))}
                >
                  <div className="relative mt-[2px] h-5 w-5 shrink-0">
                    <div
                      className={cn(
                        "absolute left-[7px] top-[6px] h-2.5 w-2.5 rounded-full border",
                        isHead ? "border-emerald-300 bg-emerald-500/70" : isMerge ? "border-sky-300 bg-sky-500/60" : "border-border bg-bg",
                        isSelected && "ring-2 ring-accent/70"
                      )}
                    />
                    {isMerge ? (
                      <>
                        <div className="absolute left-[7px] top-[2px] h-[6px] w-[6px] border-l border-t border-sky-400/70 rotate-45 origin-bottom-left" />
                        <div className="absolute left-[7px] top-[10px] h-[6px] w-[6px] border-l border-b border-sky-400/70 -rotate-45 origin-top-left" />
                      </>
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("font-mono text-[10px]", isHead ? "text-emerald-200" : "text-muted-fg")}>
                        {commit.shortSha}
                      </span>
                      {isHead ? <span className="rounded border border-emerald-700/60 bg-emerald-900/20 px-1 text-[10px] text-emerald-200">HEAD</span> : null}
                    </div>
                    <div className="truncate text-fg">{commit.subject}</div>
                  </div>
                </button>
              );
            })}
            {!commits.length && !loading ? (
              <div className="p-3 text-center text-xs text-muted-fg opacity-60 italic">No commits found</div>
            ) : null}
          </div>
        </div>
      </div>

      {hovered ? (
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded border border-border bg-card/95 p-2 text-[11px] shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] text-muted-fg">{hovered.sha}</div>
            <div className="text-[10px] text-muted-fg">{formatTs(hovered.authoredAt)}</div>
          </div>
          <div className="mt-1 truncate text-fg">{hovered.subject}</div>
          <div className="mt-1 text-[10px] text-muted-fg">
            {hovered.authorName}
            {hoveredMeta?.fileCount != null ? ` · ${hoveredMeta.fileCount} file${hoveredMeta.fileCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

