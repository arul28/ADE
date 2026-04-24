import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitCommit } from "@phosphor-icons/react";

import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";

export type PrCommitRailCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  threadCount: number;
  resolvedCount: number;
};

type CommitFilter = "all" | "mine" | "bots";

export type PrCommitRailProps = {
  commits: PrCommitRailCommit[];
  activeSha: string | null;
  viewerLogin?: string | null;
  onSelectCommit: (sha: string) => void;
};

const BOT_SUFFIXES = ["[bot]", "-bot"];

function looksLikeBot(author: string): boolean {
  const lower = author.toLowerCase();
  return BOT_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || lower === "github-actions";
}

function commitMatchesFilter(
  commit: PrCommitRailCommit,
  filter: CommitFilter,
  viewerLogin: string | null | undefined,
): boolean {
  if (filter === "all") return true;
  if (filter === "mine") {
    if (!viewerLogin) return false;
    return commit.author.toLowerCase() === viewerLogin.toLowerCase();
  }
  return looksLikeBot(commit.author);
}

const VIRTUALIZE_AT = 50;

export const PrCommitRail = memo(function PrCommitRail({
  commits,
  activeSha,
  viewerLogin,
  onSelectCommit,
}: PrCommitRailProps) {
  const [filter, setFilter] = useState<CommitFilter>("all");

  const filtered = useMemo(
    () => commits.filter((c) => commitMatchesFilter(c, filter, viewerLogin)),
    [commits, filter, viewerLogin],
  );

  const shouldVirtualize = filtered.length > VIRTUALIZE_AT;

  return (
    <div
      data-testid="pr-commit-rail"
      className="flex h-full w-full flex-col"
      style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}` }}
    >
      <div
        className="flex items-center gap-1 px-2.5"
        style={{ borderBottom: `1px solid ${COLORS.border}`, height: 36 }}
      >
        <GitCommit size={12} weight="bold" style={{ color: COLORS.textMuted }} />
        <span
          className="text-[10px] font-bold uppercase tracking-[1px]"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
        >
          Commits
        </span>
        <span
          className="ml-auto text-[10px]"
          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
        >
          {filtered.length}
        </span>
      </div>

      <div
        className="flex items-center gap-0.5 p-1.5"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <FilterPill label="All" value="all" current={filter} onChange={setFilter} />
        <FilterPill label="Mine" value="mine" current={filter} onChange={setFilter} />
        <FilterPill label="Bots" value="bots" current={filter} onChange={setFilter} />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {filtered.length === 0 ? (
          <div
            className="px-3 py-4 text-[11px]"
            style={{ color: COLORS.textDim }}
          >
            No commits match this filter.
          </div>
        ) : shouldVirtualize ? (
          <VirtualizedCommitList
            commits={filtered}
            activeSha={activeSha}
            onSelectCommit={onSelectCommit}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            {filtered.map((commit) => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                isActive={commit.sha === activeSha}
                onSelect={onSelectCommit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function FilterPill({
  label,
  value,
  current,
  onChange,
}: {
  label: string;
  value: CommitFilter;
  current: CommitFilter;
  onChange: (next: CommitFilter) => void;
}) {
  const active = current === value;
  const style: CSSProperties = active
    ? {
        background: COLORS.accentSubtle,
        border: `1px solid ${COLORS.accentBorder}`,
        color: COLORS.accent,
      }
    : {
        background: "transparent",
        border: `1px solid transparent`,
        color: COLORS.textMuted,
      };
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className="h-6 px-2 text-[11px] font-medium transition-colors"
      style={style}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function VirtualizedCommitList({
  commits,
  activeSha,
  onSelectCommit,
}: {
  commits: PrCommitRailCommit[];
  activeSha: string | null;
  onSelectCommit: (sha: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 58,
    overscan: 6,
  });
  return (
    <div
      ref={parentRef}
      data-testid="pr-commit-rail-virtual"
      className="h-full overflow-y-auto"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const commit = commits[virtualRow.index]!;
          return (
            <div
              key={commit.sha}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <CommitRow
                commit={commit}
                isActive={commit.sha === activeSha}
                onSelect={onSelectCommit}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommitRow({
  commit,
  isActive,
  onSelect,
}: {
  commit: PrCommitRailCommit;
  isActive: boolean;
  onSelect: (sha: string) => void;
}) {
  const unresolved = Math.max(0, commit.threadCount - commit.resolvedCount);
  const style: CSSProperties = isActive
    ? {
        background: COLORS.accentSubtle,
        borderLeft: `3px solid ${COLORS.accent}`,
        paddingLeft: 7,
      }
    : {
        borderLeft: "3px solid transparent",
        paddingLeft: 7,
      };
  return (
    <button
      type="button"
      onClick={() => onSelect(commit.sha)}
      className="block w-full text-left transition-colors"
      style={{ ...style, padding: "8px 10px", borderBottom: `1px solid ${COLORS.borderMuted}` }}
      aria-current={isActive ? "true" : undefined}
      data-sha={commit.sha}
      data-testid="pr-commit-rail-row"
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-semibold"
          style={{
            color: isActive ? COLORS.accent : COLORS.textMuted,
            fontFamily: MONO_FONT,
          }}
        >
          {commit.shortSha}
        </span>
        <span
          className="ml-auto text-[10px]"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
        >
          {relativeWhen(commit.authoredAt)}
        </span>
      </div>
      <div
        className="mt-1 line-clamp-2 text-[11px] leading-[1.35]"
        style={{ color: COLORS.textPrimary }}
      >
        {commit.subject}
      </div>
      {commit.threadCount > 0 ? (
        <div
          className="mt-1 text-[10px]"
          style={{
            color: unresolved > 0 ? COLORS.warning : COLORS.textMuted,
            fontFamily: MONO_FONT,
          }}
        >
          {commit.threadCount} thread{commit.threadCount === 1 ? "" : "s"}
          {" · "}
          {commit.resolvedCount}/{commit.threadCount} resolved
        </div>
      ) : null}
    </button>
  );
}

export default PrCommitRail;
