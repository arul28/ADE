import { memo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowsClockwise, GitCommit } from "@phosphor-icons/react";

import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";

export type PrCommitRailCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  threadCount: number;
  resolvedCount: number;
  /** True for the force-push entry (a branch action, not a real commit). */
  forcePushed?: boolean;
};

export type PrCommitRailProps = {
  commits: PrCommitRailCommit[];
  activeSha: string | null;
  onSelectCommit: (sha: string) => void;
  layout?: "full" | "pane";
};

const VIRTUALIZE_AT = 50;

export const PrCommitRail = memo(function PrCommitRail({
  commits,
  activeSha,
  onSelectCommit,
  layout = "full",
}: PrCommitRailProps) {
  const shouldVirtualize = commits.length > VIRTUALIZE_AT;
  const isPane = layout === "pane";

  return (
    <div
      data-testid="pr-commit-rail"
      className={`flex w-full flex-col ${isPane ? "min-h-0 flex-1" : "h-full"}`}
      style={{
        background: isPane ? "transparent" : COLORS.cardBg,
        borderRight: isPane ? undefined : `1px solid ${COLORS.border}`,
      }}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 px-3"
        style={{
          borderBottom: `1px solid ${COLORS.border}`,
          height: 34,
        }}
      >
        <GitCommit size={13} weight="bold" style={{ color: COLORS.textMuted }} />
        <span
          className="text-[11px] font-medium"
          style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
        >
          Commits
        </span>
        <span
          className="ml-auto text-[11px]"
          style={{ color: COLORS.textDim, fontFamily: SANS_FONT, fontVariantNumeric: "tabular-nums" }}
        >
          {commits.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {commits.length === 0 ? (
          <div
            className="px-3 py-4 text-[11px]"
            style={{ color: COLORS.textDim }}
          >
            No commits.
          </div>
        ) : shouldVirtualize ? (
          <VirtualizedCommitList
            commits={commits}
            activeSha={activeSha}
            onSelectCommit={onSelectCommit}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            {commits.map((commit) => (
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
  const style: CSSProperties = {
    paddingLeft: 7,
    borderLeft: isActive ? `3px solid ${COLORS.accent}` : "3px solid transparent",
    background: isActive ? COLORS.accentSubtle : undefined,
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
        {commit.forcePushed ? (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: isActive ? COLORS.accent : COLORS.textMuted, fontFamily: SANS_FONT }}
          >
            <ArrowsClockwise size={11} weight="bold" />
            Force-push
          </span>
        ) : (
          <span
            className="text-[10px] font-semibold"
            style={{
              color: isActive ? COLORS.accent : COLORS.textMuted,
              fontFamily: MONO_FONT,
            }}
          >
            {commit.shortSha}
          </span>
        )}
        <span
          className="ml-auto text-[10px]"
          style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
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
