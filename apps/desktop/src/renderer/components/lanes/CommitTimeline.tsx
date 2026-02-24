import React from "react";
import type { GitCommitSummary } from "../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge } from "./laneDesignTokens";

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
  onSelectCommit,
  refreshTrigger,
  hasUpstream
}: {
  laneId: string | null;
  selectedSha: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
  refreshTrigger?: number;
  hasUpstream?: boolean | null;
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
  }, [load, refreshTrigger]);

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
    if (el.scrollTop < 60 && !loading) {
      setLimit((prev) => Math.min(200, prev + 40));
    }
  };

  const hovered = hoveredSha ? commits.find((c) => c.sha === hoveredSha) ?? null : null;
  const hoveredMeta = hovered ? metaByShaRef.current.get(hovered.sha) ?? null : null;

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: "6px 12px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}
      >
        <div className="flex items-center gap-2">
          <span style={LABEL_STYLE}>COMMITS</span>
          <span style={{ ...inlineBadge(COLORS.accent), fontSize: 9 }}>
            {loading ? "..." : commits.length}
          </span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }} title="Blue node = merge commit">
            blue = merge
          </span>
        </div>
        <button
          type="button"
          style={{
            fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
            color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer",
            textTransform: "uppercase", letterSpacing: "1px",
          }}
          onClick={() => void load()}
          disabled={!laneId || loading}
          title="Refresh"
          onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textPrimary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textMuted; }}
        >
          REFRESH
        </button>
      </div>

      {error ? (
        <div style={{ padding: "8px 12px", fontSize: 12, color: COLORS.danger }}>{error}</div>
      ) : null}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" onScroll={onScroll}>
        <div className="relative" style={{ paddingLeft: 20, paddingRight: 4, paddingTop: 4, paddingBottom: 4 }}>
          {/* Continuous vertical line */}
          <div
            className="absolute"
            style={{ left: 11, top: 0, bottom: 0, width: 1, background: COLORS.border }}
          />

          {commits.map((commit, idx) => {
            const isNewest = idx === commits.length - 1;
            const isSelected = selectedSha === commit.sha;
            const isMerge = commit.parents.length > 1;
            const isLast = idx === commits.length - 1;

            const dotColor = isNewest ? COLORS.success : isMerge ? COLORS.info : COLORS.outlineBorder;
            const dotBg = isNewest ? COLORS.success : isMerge ? "transparent" : COLORS.pageBg;

            return (
              <React.Fragment key={commit.sha}>
                <button
                  type="button"
                  title={isMerge ? "Merge commit (multiple parents)." : "Commit"}
                  className="relative flex w-full items-start gap-2 text-left transition-all duration-150"
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    borderLeft: isSelected ? `3px solid ${COLORS.accent}` : "3px solid transparent",
                    background: isSelected ? COLORS.accentSubtle : "transparent",
                    color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                  }}
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
                    if (!isSelected) e.currentTarget.style.background = COLORS.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    setHoveredSha((prev) => (prev === commit.sha ? null : prev));
                    setTooltipPos(null);
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Node on the line */}
                  <div className="absolute" style={{ left: -8, top: 10 }}>
                    <div
                      style={{
                        width: 10, height: 10, borderRadius: "50%",
                        border: `2px solid ${dotColor}`,
                        background: dotBg,
                        boxShadow: isSelected ? `0 0 0 2px ${COLORS.accent}60` : "none",
                      }}
                    />
                    {isMerge ? (
                      <div className="absolute" style={{ inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ width: 4, height: 4, borderRadius: "50%", background: COLORS.info }} />
                      </div>
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: isNewest ? COLORS.success : COLORS.textMuted }}>
                        {commit.shortSha}
                      </span>
                      {isNewest ? <span style={inlineBadge(COLORS.success, { fontSize: 9 })}>HEAD</span> : null}
                      {isMerge ? <span style={inlineBadge(COLORS.info, { fontSize: 9 })}>MERGE</span> : null}
                      {hasUpstream === false ? (
                        <span style={inlineBadge(COLORS.textMuted, { fontSize: 9 })} title="No upstream branch yet.">UNPUBLISHED</span>
                      ) : commit.pushed ? (
                        <span style={inlineBadge(COLORS.info, { fontSize: 9 })} title="This commit exists on the remote branch.">REMOTE</span>
                      ) : (
                        <span style={inlineBadge(COLORS.warning, { fontSize: 9 })} title="This commit is local only.">NEEDS PUSH</span>
                      )}
                      <span className="ml-auto shrink-0" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
                        {formatRelative(commit.authoredAt)}
                      </span>
                    </div>
                    <div className="truncate" style={{ color: COLORS.textPrimary, lineHeight: 1.4, marginTop: 2 }}>
                      {commit.subject}
                    </div>
                  </div>
                </button>
                {/* Arrow connector */}
                {!isLast ? (
                  <div className="relative" style={{ height: 12, paddingLeft: 3 }}>
                    <div className="absolute" style={{ left: 10, top: 0, bottom: 0, width: 1, background: COLORS.border }} />
                    <svg className="absolute" style={{ left: 6, top: 1 }} width="10" height="10" viewBox="0 0 10 10">
                      <path d="M5 9 L5 2 M2 5 L5 1 L8 5" fill="none" stroke={COLORS.warning} strokeOpacity={0.5} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          {!commits.length && !loading ? (
            <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: COLORS.textDim, fontStyle: "italic" }}>
              No commits found
            </div>
          ) : null}
        </div>
      </div>

      {/* Tooltip */}
      {hovered && tooltipPos ? (
        <div
          className="pointer-events-none absolute z-50"
          style={{
            width: 260,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
            padding: 10,
            fontSize: 12,
            left: Math.min(tooltipPos.x, (containerRef.current?.clientWidth ?? 300) - 270),
            top: Math.max(0, tooltipPos.y - 8),
            transform: "translateY(-100%)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>{hovered.sha}</div>
            <div className="shrink-0" style={{ fontSize: 11, color: COLORS.textMuted }}>{formatTs(hovered.authoredAt)}</div>
          </div>
          <div className="truncate" style={{ marginTop: 4, color: COLORS.textPrimary }}>{hovered.subject}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted }}>
            {hovered.authorName}
            {hoveredMeta?.fileCount != null ? ` · ${hoveredMeta.fileCount} file${hoveredMeta.fileCount === 1 ? "" : "s"}` : ""}
          </div>
          {hoveredMeta?.message ? (
            <div style={{ marginTop: 4, maxHeight: 100, overflow: "hidden", whiteSpace: "pre-wrap", fontSize: 11, color: COLORS.textDim }}>
              {hoveredMeta.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
