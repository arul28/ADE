import { Clock, File as FileIcon, GitCommit, Path, Timer, type Icon } from "@phosphor-icons/react";

import type { PrWithConflicts } from "../../../../shared/types/prs";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { formatTimestampShort } from "./prFormatters";
import { PrUserAvatar } from "./PrUserAvatar";

/** One shipped figure: a glyph, the number, then the noun it counts. */
function ShippedStat({ icon: Glyph, value, label }: { icon: Icon; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: COLORS.textMuted }}>
      <Glyph size={11} style={{ color: COLORS.textDim, flexShrink: 0 }} />
      <span>
        <span style={{ color: COLORS.textSecondary, fontWeight: 600 }}>{value}</span> {label}
      </span>
    </span>
  );
}

/**
 * The record of how a PR shipped, shown in the Merge card once it merged.
 *
 * Three groups, in descending importance: who merged it and when (attribution),
 * how big it was (figures), and which ADE lane produced it (provenance). Every
 * group is independently omitted — PRs merged before ADE recorded merge metadata
 * show less rather than showing blanks or invented values.
 *
 * The lane group is the part GitHub cannot give you; it survives the lane's
 * deletion because the counts are frozen at detach time. It is marked as ADE's
 * own — accent label, lane colour, the word "ADE lane" — so it is never mistaken
 * for another line of GitHub metadata.
 */
export function PrShippedSummary({ pr }: { pr: PrWithConflicts }) {
  const mergedBy = pr.mergedBy ?? null;
  const mergedOn = pr.mergedAt ? formatTimestampShort(pr.mergedAt) : null;
  const hasAttribution = Boolean(mergedBy?.login || mergedOn);

  const openFor = formatOpenDuration(pr.createdAt, pr.mergedAt);
  const stats: { key: string; icon: Icon; value: string; label: string }[] = [];
  if (pr.commitCount != null) {
    stats.push({ key: "commits", icon: GitCommit, value: String(pr.commitCount), label: pr.commitCount === 1 ? "commit" : "commits" });
  }
  if (pr.changedFiles != null) {
    stats.push({ key: "files", icon: FileIcon, value: String(pr.changedFiles), label: pr.changedFiles === 1 ? "file" : "files" });
  }
  if (openFor) stats.push({ key: "open", icon: Timer, value: openFor, label: "open" });

  const detached = pr.detached;
  const laneName = detached?.laneName ?? null;
  const laneCounts = detached
    ? ([
      detached.chats > 0 ? `${detached.chats} chat${detached.chats === 1 ? "" : "s"}` : null,
      detached.artifacts > 0 ? `${detached.artifacts} proof` : null,
    ].filter(Boolean) as string[])
    : [];

  if (!hasAttribution && stats.length === 0 && !laneName) return null;

  return (
    <div
      data-testid="pr-shipped-summary"
      className="mt-2 text-[10px] leading-snug"
      style={{ fontFamily: SANS_FONT }}
    >
      {hasAttribution ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" style={{ color: COLORS.textMuted }}>
          {mergedBy?.login ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <PrUserAvatar user={{ login: mergedBy.login, avatarUrl: mergedBy.avatarUrl }} size={13} />
              <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary }} title={mergedBy.login}>
                {mergedBy.login}
              </span>
            </span>
          ) : null}
          {mergedOn ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock size={11} style={{ color: COLORS.textDim, flexShrink: 0 }} />
              {mergedOn}
            </span>
          ) : null}
        </div>
      ) : null}

      {stats.length > 0 ? (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1${hasAttribution ? " mt-1.5" : ""}`}>
          {stats.map((stat) => (
            <ShippedStat key={stat.key} icon={stat.icon} value={stat.value} label={stat.label} />
          ))}
        </div>
      ) : null}

      {laneName ? (
        <div
          data-testid="pr-shipped-lane"
          className="mt-2 min-w-0"
          style={{
            paddingLeft: 7,
            borderLeft: `2px solid color-mix(in srgb, ${detached?.laneColor || COLORS.accent} 55%, transparent)`,
          }}
        >
          <div className="flex items-center gap-1.5" style={{ color: COLORS.accent }}>
            <Path size={10} weight="bold" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600 }}>ADE lane</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary }} title={laneName}>
              {laneName}
            </span>
            {laneCounts.length > 0 ? (
              <span className="shrink-0" style={{ color: COLORS.textMuted }}>
                · {laneCounts.join(" · ")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "2d 4h" / "5h" / "12m" — how long the PR was open before it merged. */
function formatOpenDuration(createdAt: string | null | undefined, mergedAt: string | null | undefined): string | null {
  if (!createdAt || !mergedAt) return null;
  const start = new Date(createdAt).getTime();
  const end = new Date(mergedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}
