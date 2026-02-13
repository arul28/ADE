import React from "react";
import type { GitCommitSummary } from "../../../shared/types";
import { cn } from "../ui/cn";

function formatTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function formatRelative(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

type CommitMeta = {
  fileCount: number | null;
  message: string | null;
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
  const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = React.useRef(false);

  const load = React.useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await window.ade.git.listRecentCommits({ laneId, limit });
      // Oldest first at top, newest at bottom (reversed from API which returns newest first)
      setCommits([...rows].reverse());
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
    setTooltipPos(null);
    setLimit(40);
    didInitialScrollRef.current = false;
  }, [laneId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Scroll to bottom on initial load so newest commits are visible
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!didInitialScrollRef.current && commits.length > 0) {
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
    }
  }, [commits]);

  const ensureMeta = React.useCallback(
    async (sha: string) => {
      if (!laneId) return;
      if (metaByShaRef.current.has(sha)) return;
      try {
        const [files, messageRaw] = await Promise.all([
          window.ade.git.listCommitFiles({ laneId, commitSha: sha }),
          window.ade.git.getCommitMessage({ laneId, commitSha: sha }).catch(() => "")
        ]);
        const message = messageRaw.trim().length ? messageRaw.trim() : null;
        metaByShaRef.current.set(sha, { fileCount: files.length, message, loadedAt: new Date().toISOString() });
        setHoveredSha((prev) => (prev === sha ? sha : prev));
      } catch {
        metaByShaRef.current.set(sha, { fileCount: null, message: null, loadedAt: new Date().toISOString() });
      }
    },
    [laneId]
  );

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    // Load older commits when user scrolls near the top (oldest commits are at top)
    if (el.scrollTop < 60 && !loading) {
      setLimit((prev) => Math.min(200, prev + 40));
    }
  };

  const hovered = hoveredSha ? commits.find((c) => c.sha === hoveredSha) ?? null : null;
  const hoveredMeta = hovered ? metaByShaRef.current.get(hovered.sha) ?? null : null;

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-fg">Commits</span>
          <span className="text-[10px] text-muted-fg">{loading ? "loading..." : `${commits.length}`}</span>
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

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" onScroll={onScroll}>
        <div className="relative pl-5 pr-1 py-1">
          {/* Continuous vertical line */}
          <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border" />

          {commits.map((commit, idx) => {
            const isNewest = idx === commits.length - 1;
            const isSelected = selectedSha === commit.sha;
            const isMerge = commit.parents.length > 1;
            const isLast = idx === commits.length - 1;
            return (
              <React.Fragment key={commit.sha}>
                <button
                  type="button"
                  className={cn(
                    "group relative flex w-full items-start gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors",
                    isSelected ? "bg-accent/10 text-fg" : "text-muted-fg hover:bg-muted/40 hover:text-fg"
                  )}
                  onClick={() => onSelectCommit(commit)}
                  onMouseEnter={(e) => {
                    setHoveredSha(commit.sha);
                    void ensureMeta(commit.sha);
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const containerRect = containerRef.current?.getBoundingClientRect();
                    if (containerRect) {
                      setTooltipPos({
                        x: rect.left - containerRect.left + rect.width / 2,
                        y: rect.top - containerRect.top
                      });
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredSha((prev) => (prev === commit.sha ? null : prev));
                    setTooltipPos(null);
                  }}
                >
                  {/* Node on the line */}
                  <div className="absolute left-[-8px] top-[6px]">
                    <div
                      className={cn(
                        "h-2.5 w-2.5 rounded-full border-2",
                        isNewest
                          ? "border-emerald-400 bg-emerald-500"
                          : isMerge
                            ? "border-sky-400 bg-transparent"
                            : "border-border bg-bg",
                        isSelected && "ring-2 ring-accent/60 ring-offset-1 ring-offset-bg"
                      )}
                    />
                    {isMerge ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="h-1 w-1 rounded-full bg-sky-400" />
                      </div>
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("font-mono text-[10px]", isNewest ? "text-emerald-300" : "text-muted-fg")}>
                        {commit.shortSha}
                      </span>
                      {isNewest ? <span className="rounded bg-emerald-900/30 border border-emerald-700/60 px-1 text-[9px] text-emerald-300 uppercase tracking-wider">HEAD</span> : null}
                      <span className="ml-auto text-[10px] text-muted-fg/60 shrink-0">{formatRelative(commit.authoredAt)}</span>
                    </div>
                    <div className="truncate text-fg leading-tight">{commit.subject}</div>
                  </div>
                </button>
                {/* Arrow connector pointing up between commits */}
                {!isLast ? (
                  <div className="relative flex items-center justify-start pl-[3px] h-3">
                    <div className="absolute left-[10px] top-0 bottom-0 w-px bg-border" />
                    {/* Small upward arrow */}
                    <svg className="absolute left-[6px] top-[1px]" width="10" height="10" viewBox="0 0 10 10">
                      <path d="M5 9 L5 2 M2 5 L5 1 L8 5" fill="none" stroke="currentColor" className="text-muted-fg/50" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          {!commits.length && !loading ? (
            <div className="p-3 text-center text-xs text-muted-fg opacity-60 italic">No commits found</div>
          ) : null}
        </div>
      </div>

      {/* Tooltip that follows hovered item */}
      {hovered && tooltipPos ? (
        <div
          className="pointer-events-none absolute z-50 w-[260px] rounded border border-border bg-bg p-2 text-[11px] shadow-2xl ring-1 ring-border/60 backdrop-blur-sm"
          style={{
            left: Math.min(tooltipPos.x, (containerRef.current?.clientWidth ?? 300) - 270),
            top: Math.max(0, tooltipPos.y - 8),
            transform: "translateY(-100%)"
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] text-muted-fg truncate">{hovered.sha}</div>
            <div className="text-[10px] text-muted-fg shrink-0">{formatTs(hovered.authoredAt)}</div>
          </div>
          <div className="mt-1 truncate text-fg">{hovered.subject}</div>
          <div className="mt-1 text-[10px] text-muted-fg">
            {hovered.authorName}
            {hoveredMeta?.fileCount != null ? ` · ${hoveredMeta.fileCount} file${hoveredMeta.fileCount === 1 ? "" : "s"}` : ""}
          </div>
          {hoveredMeta?.message ? (
            <div className="mt-1 max-h-[100px] overflow-hidden whitespace-pre-wrap text-[10px] text-muted-fg/80">
              {hoveredMeta.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
