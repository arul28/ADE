import React, { startTransition } from "react";
import type { GitCommitSummary, OpenProjectBinding } from "../../../shared/types";
import { CloudArrowUp, CloudCheck, CloudSlash, CloudX } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "./laneDesignTokens";
import { Banner } from "../ui/notice";
import { isSameListResult, laneGitListEpoch, readLaneGitListCache, writeLaneGitListCache } from "./laneGitListCache";
import { AnchoredTooltip } from "../ui/AnchoredTooltip";
import { extractError } from "../../lib/format";

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

function formatTimelineError(err: unknown): string {
  const raw = extractError(err);
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
  if (/^Lane worktree is missing\./i.test(message)) return message;
  if (/git working directory not found:/i.test(message)) {
    return "Lane worktree is missing. Restore or recreate the lane worktree before viewing history.";
  }
  return message || "Unable to load commit history.";
}

/**
 * A commit's push state as a 12px glyph with a tooltip, so the subject keeps
 * the row's width: a muted cloud on pushed commits (the run of clouds ends at
 * the remote branch), a warning cloud on local-only ones.
 */
function PushStateGlyph({ icon: Glyph, color, title }: { icon: typeof CloudCheck; color: string; title: string }) {
  return (
    <span title={title} aria-label={title} role="img" className="inline-flex shrink-0" style={{ color }}>
      <Glyph size={12} weight="regular" />
    </span>
  );
}

type CommitMeta = {
  fileCount: number | null;
  message: string | null;
  loadedAt: string;
};

export function CommitTimeline({
  laneId,
  active = true,
  selectedSha,
  onSelectCommit,
  refreshTrigger,
  hasUpstream,
  remoteMissing,
  runtimePin = null,
  cacheScope = null,
  cacheBranchRef = null,
}: {
  laneId: string | null;
  active?: boolean;
  selectedSha: string | null;
  onSelectCommit: (commit: GitCommitSummary) => void;
  refreshTrigger?: number;
  hasUpstream?: boolean | null;
  remoteMissing?: boolean;
  /** Machine this lane lives on; `null` means the tab's bound machine. */
  runtimePin?: OpenProjectBinding | null;
  /**
   * The lane's cache scope and branch (`laneGitListCache.ts`). The last
   * successful history is painted from it on mount; `null` keeps this list uncached.
   */
  cacheScope?: string | null;
  cacheBranchRef?: string | null;
}) {
  const pin = runtimePin ?? null;
  const [commits, setCommits] = React.useState<GitCommitSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(40);
  const metaByShaRef = React.useRef<Map<string, CommitMeta>>(new Map());
  const inFlightMetaRef = React.useRef<Set<string>>(new Set());
  const [hoveredSha, setHoveredSha] = React.useState<string | null>(null);
  // The hovered row; the card is placed against it.
  const hoveredRowRef = React.useRef<HTMLElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = React.useRef(false);

  const load = React.useCallback(async () => {
    if (!active || !laneId) return;
    setLoading(true);
    setError(null);
    const epochAtStart = laneGitListEpoch();
    try {
      const rows = await window.ade.git.listRecentCommits({ laneId, limit }, pin);
      const next = [...rows].reverse();
      writeLaneGitListCache(cacheScope, epochAtStart, cacheBranchRef, { commits: next });
      setCommits((prev) => (isSameListResult(prev, next) ? prev : next));
    } catch (err) {
      setError(formatTimelineError(err));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [active, cacheBranchRef, cacheScope, laneId, limit, pin]);

  React.useEffect(() => {
    metaByShaRef.current = new Map();
    inFlightMetaRef.current = new Set();
    setHoveredSha(null);
    setLimit(40);
    didInitialScrollRef.current = false;
  }, [laneId, pin]);

  // Declared before the read's effect, so the cached rows are queued before its
  // result. A transition keeps them out of the mount's first commit.
  React.useEffect(() => {
    const cached = readLaneGitListCache(cacheScope, cacheBranchRef)?.commits;
    if (cached) startTransition(() => setCommits(cached));
  }, [cacheBranchRef, cacheScope]);

  React.useEffect(() => {
    void load();
  }, [load, refreshTrigger]);

  // `commits` stays oldest-first (the shared list cache's shape); the pane
  // shows newest first so it opens on the head instead of a clipped old row.
  const newestFirst = React.useMemo(() => [...commits].reverse(), [commits]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!didInitialScrollRef.current && commits.length > 0) {
      // Scroll to the selected commit if present, otherwise show most recent
      // Newest first: the list opens at the top on a whole row (the head).
      const selectedIdx = selectedSha ? newestFirst.findIndex((c) => c.sha === selectedSha) : -1;
      if (selectedIdx > 0) {
        el.querySelectorAll<HTMLElement>("[data-commit-row]")[selectedIdx]?.scrollIntoView({ block: "nearest" });
      } else {
        el.scrollTop = 0;
      }
      didInitialScrollRef.current = true;
    }
  }, [commits, newestFirst, selectedSha]);

  const ensureMeta = React.useCallback(
    async (sha: string) => {
      if (!laneId) return;
      if (metaByShaRef.current.has(sha) || inFlightMetaRef.current.has(sha)) return;
      inFlightMetaRef.current.add(sha);
      try {
        const messageRaw = await window.ade.git.getCommitMessage({ laneId, commitSha: sha }, pin).catch(() => "");
        const message = messageRaw.trim().length ? messageRaw.trim() : null;
        metaByShaRef.current.set(sha, { fileCount: null, message, loadedAt: new Date().toISOString() });
        setHoveredSha((prev) => (prev === sha ? sha : prev));
      } catch {
        metaByShaRef.current.set(sha, { fileCount: null, message: null, loadedAt: new Date().toISOString() });
      } finally {
        inFlightMetaRef.current.delete(sha);
      }
    },
    [laneId, pin]
  );

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    // Older commits are below now: load more near the bottom.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60 && !loading) {
      setLimit((prev) => Math.min(200, prev + 40));
    }
  };

  const hovered = hoveredSha ? commits.find((c) => c.sha === hoveredSha) ?? null : null;
  const hoveredMeta = hovered ? metaByShaRef.current.get(hovered.sha) ?? null : null;


  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: COLORS.pageBg }}>
      {error ? (
        <Banner
          layout="inline"
          style={{ margin: "8px 12px" }}
          model={{
            id: "commit-timeline-error",
            tone: "error",
            title: error,
            report: { surface: "commit_timeline" },
          }}
        />
      ) : null}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" onScroll={onScroll}>
        <div className="relative" style={{ paddingLeft: 22, paddingRight: 4, paddingTop: 4, paddingBottom: 4 }}>
          {/* Continuous vertical line (none under an empty state) */}
          {newestFirst.length > 0 ? <div
            className="absolute"
            style={{ left: 12, top: 0, bottom: 0, width: 1, background: COLORS.borderMuted }}
          /> : null}

          {newestFirst.map((commit, idx) => {
            const isNewest = idx === 0;
            const isSelected = selectedSha === commit.sha;
            const isMerge = commit.parents.length > 1;

            const dotColor = isNewest ? COLORS.success : isMerge ? COLORS.info : COLORS.outlineBorder;
            const dotBg = isNewest ? COLORS.success : isMerge ? "transparent" : COLORS.pageBg;

            return (
              <React.Fragment key={commit.sha}>
                <button
                  type="button"
                  data-commit-row=""
                  title={isNewest ? "Head: the lane's latest commit." : isMerge ? "Merge commit (multiple parents)." : "Commit"}
                  className="relative flex w-full items-start gap-2 rounded-lg text-left transition-colors duration-100"
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    background: isSelected ? COLORS.accentSubtle : "transparent",
                    boxShadow: isSelected ? `inset 0 0 0 1px ${COLORS.accentBorder}` : "none",
                    color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                  }}
                  onClick={() => onSelectCommit(commit)}
                  onMouseEnter={(e) => {
                    setHoveredSha(commit.sha);
                    void ensureMeta(commit.sha);
                    hoveredRowRef.current = e.currentTarget as HTMLElement;
                    if (!isSelected) e.currentTarget.style.background = COLORS.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    setHoveredSha((prev) => (prev === commit.sha ? null : prev));
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Node on the line */}
                  <div className="absolute" style={{ left: -14, top: 9 }}>
                    <div
                      style={{
                        width: 10, height: 10, borderRadius: "50%",
                        border: `2px solid ${dotColor}`,
                        background: dotBg,
                        boxShadow: isSelected ? `0 0 0 2px color-mix(in srgb, var(--color-accent) 60%, transparent)` : "none",
                      }}
                    />
                    {isMerge ? (
                      <div className="absolute" style={{ inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ width: 4, height: 4, borderRadius: "50%", background: COLORS.info }} />
                      </div>
                    ) : null}
                  </div>

                  {/* One line: subject, then the exception tags, the hash and the
                      time in a muted right-hand cluster. */}
                  <div className="flex min-w-0 flex-1 items-center gap-1.5" style={{ lineHeight: 1.4 }}>
                    <span className="min-w-0 flex-1 truncate" style={{ color: COLORS.textPrimary, fontSize: 12.5 }}>
                      {commit.subject}
                    </span>
                    {remoteMissing ? (
                      <PushStateGlyph icon={CloudX} color={COLORS.warning} title="Remote gone: the configured remote branch no longer exists." />
                    ) : hasUpstream === false ? (
                      <PushStateGlyph icon={CloudSlash} color={COLORS.textDim} title="Unpublished: no upstream branch yet." />
                    ) : commit.pushed ? (
                      <PushStateGlyph icon={CloudCheck} color={COLORS.textDim} title="Pushed: on the remote branch." />
                    ) : (
                      <PushStateGlyph icon={CloudArrowUp} color={COLORS.warning} title="Needs push: this commit is local only." />
                    )}
                    <span className="shrink-0" style={{ fontFamily: MONO_FONT, fontSize: 11, color: isNewest ? COLORS.success : COLORS.textDim }}>
                      {commit.shortSha}
                    </span>
                    <span className="w-[52px] shrink-0 text-right tabular-nums" style={{ fontSize: 11, color: COLORS.textDim }}>
                      {formatRelative(commit.authoredAt)}
                    </span>
                  </div>
                </button>
                {/* Arrow connector */}
                {idx < newestFirst.length - 1 ? (
                  <div style={{ height: 2 }} />
                ) : null}
              </React.Fragment>
            );
          })}
          {!commits.length && !loading ? (
            <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>
              No commits yet
            </div>
          ) : null}
        </div>
      </div>

      {/* Above the row when it fits, below it near the top of the window, never
          past an edge. The card used to sit in this panel and grow upward from the
          row, so on the first rows it ran out of the panel and was clipped under
          the toolbar. */}
      {hovered ? (
        <AnchoredTooltip
          open
          triggerRef={hoveredRowRef}
          side="top"
          remeasureKey={`${hovered.sha}:${hoveredMeta?.fileCount ?? ""}:${hoveredMeta?.message ?? ""}`}
          onDismiss={() => setHoveredSha(null)}
          className="pointer-events-none"
          style={{
            width: 280,
            background: COLORS.cardBgSolid,
            boxShadow: `0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px ${COLORS.border}`,
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
          }}
        >
          {/* SHA + timestamp */}
          <div className="flex items-center justify-between gap-2">
            <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>{hovered.sha}</div>
            <div className="shrink-0" style={{ fontSize: 11, color: COLORS.textMuted }}>{formatTs(hovered.authoredAt)}</div>
          </div>

          {/* Subject */}
          <div className="truncate" style={{ marginTop: 4, color: COLORS.textPrimary }}>{hovered.subject}</div>

          {/* Author + file count */}
          <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted }}>
            {hovered.authorName}
            {hoveredMeta?.fileCount != null ? ` · ${hoveredMeta.fileCount} file${hoveredMeta.fileCount === 1 ? "" : "s"}` : ""}
          </div>

          {/* Parent SHAs (merge info) */}
          {hovered.parents.length > 1 ? (
            <div style={{ marginTop: 6, fontSize: 11, color: COLORS.textDim }}>
              <span style={{ color: COLORS.textMuted }}>Merge: </span>
              {hovered.parents.map((p) => p.slice(0, 7)).join(" + ")}
            </div>
          ) : null}

          {/* Separator */}
          <div style={{ marginTop: 8, marginBottom: 8, height: 1, background: COLORS.border }} />

          {/* Pushed / local status */}
          <div className="flex items-center gap-2" style={{ fontSize: 11 }}>
            <span style={{ color: COLORS.textMuted }}>Status:</span>
            {hovered.pushed ? (
              <span style={{ color: COLORS.success }}>Pushed to remote</span>
            ) : (
              <span style={{ color: COLORS.warning }}>Local only</span>
            )}
          </div>

          {/* PR placeholder */}
          <div className="flex items-center gap-2" style={{ marginTop: 4, fontSize: 11 }}>
            <span style={{ color: COLORS.textMuted }}>PR:</span>
            <span style={{ color: COLORS.textDim }}>&mdash;</span>
          </div>

          {/* Extended commit message */}
          {hoveredMeta?.message ? (
            <>
              <div style={{ marginTop: 8, marginBottom: 8, height: 1, background: COLORS.border }} />
              <div style={{ maxHeight: 100, overflow: "hidden", whiteSpace: "pre-wrap", fontSize: 11, color: COLORS.textDim }}>
                {hoveredMeta.message}
              </div>
            </>
          ) : null}
        </AnchoredTooltip>
      ) : null}
    </div>
  );
}
