import React, { useMemo } from "react";
import { ArrowsDownUp, GitBranch, GitPullRequest, Robot, User } from "@phosphor-icons/react";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { PrAgentAvatar } from "../../prs/shared/PrAgentAvatar";
import { cn } from "../../ui/cn";
import { COLORS } from "../laneDesignTokens";
import {
  formatEntryTime,
  groupLaneHistoryByDay,
  type LaneHistoryEntry,
  type LaneHistoryFilter,
} from "./laneHistoryModel";
import { OVERVIEW_ROW, OVERVIEW_ROW_HOVER, OVERVIEW_TIME, OverviewSection, TextButton } from "./sectionUi";

const FILTERS: Array<{ id: LaneHistoryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "commits", label: "Commits" },
  { id: "prs", label: "PRs" },
  { id: "agents", label: "Agents" },
];

function githubAvatarUrl(login: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=40`;
}

function ActorMark({ entry }: { entry: LaneHistoryEntry }) {
  const { actor } = entry;
  if (actor.kind === "agent") return <ProviderLogo family={actor.provider} size={13} />;
  if (actor.kind === "human") {
    if (actor.login) {
      return <PrAgentAvatar login={actor.login} avatarUrl={actor.avatarUrl ?? githubAvatarUrl(actor.login)} size={14} />;
    }
    return <User size={13} weight="bold" className="text-muted-fg/70" />;
  }
  const className = "text-muted-fg/60";
  if (entry.category === "pr") return <GitPullRequest size={13} weight="bold" className={className} />;
  if (entry.category === "git") return <ArrowsDownUp size={13} weight="bold" className={className} />;
  if (entry.category === "lane") return <GitBranch size={13} weight="bold" className={className} />;
  return <Robot size={13} className={className} />;
}

function toneColor(entry: LaneHistoryEntry): string | undefined {
  if (entry.tone === "danger") return COLORS.danger;
  if (entry.tone === "success") return COLORS.success;
  if (entry.tone === "warning") return COLORS.warning;
  return undefined;
}

const HistoryRow = React.memo(function HistoryRow({
  entry,
  onOpen,
}: {
  entry: LaneHistoryEntry;
  onOpen: (entry: LaneHistoryEntry) => void;
}) {
  const clickable = entry.target != null;
  const color = toneColor(entry);
  const content = (
    <>
      <span className="flex w-4 shrink-0 items-center justify-center">
        <ActorMark entry={entry} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={color ? undefined : "text-muted-fg"} style={color ? { color } : undefined}>{entry.text}</span>
        {entry.emphasis ? (
          <>
            <span className="text-muted-fg/40">{" · "}</span>
            <span className="text-fg/90">{entry.emphasis}</span>
          </>
        ) : null}
      </span>
      <span className={cn(OVERVIEW_TIME, "w-16")}>{formatEntryTime(entry.ts)}</span>
    </>
  );
  const className = cn(OVERVIEW_ROW, clickable && OVERVIEW_ROW_HOVER, "h-8 text-[12.5px]");
  if (!clickable) {
    return (
      <div className={className} title={entry.hint ?? undefined} data-testid="lane-history-row" data-entry-id={entry.id}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={entry.hint ?? undefined}
      onClick={() => onOpen(entry)}
      data-testid="lane-history-row"
      data-entry-id={entry.id}
    >
      {content}
    </button>
  );
});

/** The lane's commits, PRs, chats and git operations, newest first, grouped by day. */
export function LaneHistoryFeed({
  entries,
  totalCount,
  filter,
  onFilterChange,
  moreLabel,
  onShowMore,
  onOpen,
  loaded,
}: {
  /** Already filtered, sorted newest first, and cut to the visible count. */
  entries: LaneHistoryEntry[];
  /** How many entries the current filter has in all. */
  totalCount: number;
  filter: LaneHistoryFilter;
  onFilterChange: (filter: LaneHistoryFilter) => void;
  /** Label of the button under the list, or null when everything is shown. */
  moreLabel: string | null;
  onShowMore: () => void;
  onOpen: (entry: LaneHistoryEntry) => void;
  loaded: boolean;
}) {
  const days = useMemo(() => groupLaneHistoryByDay(entries, Date.now()), [entries]);

  const filters = (
    <div className="flex items-center gap-0.5" role="tablist" aria-label="Filter activity">
      {FILTERS.map((option) => {
        const active = option.id === filter;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onFilterChange(option.id)}
            className={cn(
              "h-6 rounded-md px-2 text-[12px] transition-colors duration-100",
              active ? "bg-fg/[0.07] text-fg" : "text-muted-fg/70 hover:bg-fg/[0.04] hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <OverviewSection
      title="Recent activity"
      count={totalCount}
      action={filters}
      testId="lane-history"
      collapseKey="activity"
    >
      {entries.length === 0 ? (
        <p className="m-0 py-1 text-[12.5px] text-muted-fg/70">
          {loaded ? "Nothing here yet." : "Loading…"}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col">
          {days.map((day, index) => (
            <div key={day.key} className="flex min-w-0 flex-col">
              <div className={cn("flex h-7 items-center gap-2 text-[11.5px] text-muted-fg/60", index > 0 && "mt-2")}>
                {day.label}
                <span aria-hidden className="h-px min-w-0 flex-1" style={{ background: "color-mix(in srgb, var(--color-border) 55%, transparent)" }} />
              </div>
              {day.entries.map((entry) => <HistoryRow key={entry.id} entry={entry} onOpen={onOpen} />)}
            </div>
          ))}
          {moreLabel ? (
            <div className="-ml-1.5 pt-1">
              <TextButton onClick={onShowMore} testId="lane-history-more">{moreLabel}</TextButton>
            </div>
          ) : null}
        </div>
      )}
    </OverviewSection>
  );
}
