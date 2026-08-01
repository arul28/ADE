import React from "react";
import { ArrowSquareOut, ChatText, CheckCircle, CircleDashed, GitBranch, XCircle } from "@phosphor-icons/react";

import type { GitHubPrListItem, PrSummary } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import { useAppStore } from "../../../state/appStore";
import { isTerminalPrState } from "../../../lib/prState";
import { formatTimeAgoCompact } from "./prFormatters";
import { PrCiRunningIndicator } from "./prVisuals";
import { GitHubStackBadge } from "./GitHubStackBadge";
import { formatPrListGroupDiff, type PrListGroupHeader as PrListGroupHeaderModel } from "./prListGrouping";
import { branchNameFromRef } from "../tabs/githubPrBranch";

/**
 * Presentation for one row of the GitHub PR list, and the period header that groups
 * them. Split out of `GitHubTab.tsx` because none of it depends on that component's
 * state — `useLaneColorById` reads the store directly — so the tab is left as a
 * coordinator rather than a coordinator plus 450 lines of row markup.
 */

/* -- Color-coded state badge with distinct colors per state -- */
function stateColor(state: string): { bg: string; border: string; text: string } {
  switch (state) {
    case "open":
      return { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.20)", text: "#60A5FA" };
    case "draft":
      return { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.20)", text: "#FBBF24" };
    case "merged":
      return { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.20)", text: "#4ADE80" };
    default:
      return { bg: "rgba(161,161,170,0.08)", border: "rgba(161,161,170,0.15)", text: "#A1A1AA" };
  }
}

function stateBadgeStyle(item: GitHubPrListItem): React.CSSProperties {
  const c = stateColor(item.state);
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: c.text,
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: 5,
    textTransform: "capitalize",
  };
}

/** Copy used when the producer had no more specific reason to offer. */
const NO_CI_REASON = "No CI has run on this commit.";

function PrRowCiStatus({
  status,
  reason,
}: {
  status: PrSummary["checksStatus"] | null;
  reason?: string | null;
}) {
  switch (status) {
    case "passing":
      return (
        <span title="CI passing" style={{ display: "inline-flex", flexShrink: 0 }}>
          <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />
        </span>
      );
    case "failing":
      return (
        <span title="CI failing" style={{ display: "inline-flex", flexShrink: 0 }}>
          <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} />
        </span>
      );
    case "pending":
      return (
        <span title="CI pending" style={{ display: "inline-flex", flexShrink: 0 }}>
          <PrCiRunningIndicator color={COLORS.warning} size={14} />
        </span>
      );
    // ADE-135: nothing verified this commit. The glyph is a hollow dashed ring
    // in the muted tone — an empty slot where a result should be, deliberately
    // not the danger colour: this is absence, not failure.
    case "not_run":
      return (
        <span
          aria-label="No CI has run"
          title={reason || NO_CI_REASON}
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <CircleDashed size={14} weight="bold" style={{ color: COLORS.textMuted }} />
        </span>
      );
    default:
      return null;
  }
}

/* -- Review status indicator -- */
function reviewIndicator(linkedPr: PrSummary | null): { color: string; label: string } | null {
  if (!linkedPr) return null;
  switch (linkedPr.reviewStatus) {
    case "approved":
      return { color: COLORS.success, label: "Approved" };
    case "changes_requested":
      return { color: COLORS.danger, label: "Changes" };
    case "requested":
      return { color: COLORS.warning, label: "Review required" };
    default:
      return null;
  }
}

/* -- adeKind badge with distinctive styling -- */
const ADE_KIND_STYLES: Record<string, { color: string; background: string; border: string }> = {
  integration: {
    color: "#FBBF24",
    background: "linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(217,119,6,0.06) 100%)",
    border: "1px solid rgba(245,158,11,0.22)",
  },
};

function AdeKindBadge({ kind }: { kind: GitHubPrListItem["adeKind"] }): React.ReactElement | null {
  if (!kind || kind === "single") return null;
  const style = ADE_KIND_STYLES[kind];
  if (!style) return null;
  return <span style={adeKindBadgeStyle(style)}>{kind}</span>;
}

function adeKindBadgeStyle(style: { color: string; background: string; border: string }): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: style.color,
    background: style.background,
    border: style.border,
    borderRadius: 5,
  };
}

/* -- Label text color from hex background (luminance-aware) -- */
function labelTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a2e" : "#f0f0f0";
}


/**
 * Whether the "unmapped" badge would actually lead somewhere. Selecting the row offers
 * one of two actions depending on whether a lane already tracks the head branch — map
 * to it, or create one — so the presence of a usable local branch is the real gate.
 * Fork PRs have no local branch to work with, and a terminal PR cannot be mapped at all.
 *
 * Drives the amber-vs-neutral choice, so the warning colour is only ever spent on rows
 * the user can do something about.
 */
function isPrRowMappable(item: GitHubPrListItem): boolean {
  if (item.linkedPrId || item.scope !== "repo") return false;
  if (item.state !== "open" && item.state !== "draft") return false;
  return Boolean(branchNameFromRef(item.headBranch));
}

/**
 * The lane column of a PR row.
 *
 * Three states, deliberately distinct:
 * - **mapped** — the lane chip, in the lane's colour.
 * - **detached** — `was: <lane>` plus the activity frozen when the lane was deleted.
 *   This is history, so it is dim and carries no call to action.
 * - **no lane** — nothing at all in terminal buckets (absence already reads as "no
 *   lane"), and a neutral chip in Open. It only turns amber when there is genuinely
 *   something to do, so amber keeps meaning "act on this".
 */
function PrRowLaneChip({
  item,
  linkedLaneColor,
  mappable,
}: {
  item: GitHubPrListItem;
  linkedLaneColor: string | null;
  mappable: boolean;
}) {
  if (item.linkedLaneName) {
    return (
      <span
        style={{
          ...inlineBadge(COLORS.textSecondary),
          fontSize: 10,
          padding: "2px 7px",
          borderRadius: 5,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          ...(linkedLaneColor ? { color: linkedLaneColor } : {}),
        }}
      >
        {linkedLaneColor ? <LaneAccentDot lane={{ color: linkedLaneColor }} size={6} /> : null}
        {item.linkedLaneName}
      </span>
    );
  }

  if (item.detached) return <PrRowGhostLaneChip detached={item.detached} />;

  // A linked id is internal identity, not user-facing copy. If the lane metadata is
  // temporarily unavailable, omit the chip instead of leaking a UUID or claiming the
  // PR is unmapped.
  if (item.linkedLaneId) return null;

  // Terminal PRs have no mapping story worth telling — the lane is gone and mapping one
  // now would do nothing. Showing a badge here is what made Merged a wall of warnings.
  if (isTerminalPrState(item.state)) return null;

  const actionable = mappable;
  return (
    <span
      title={actionable ? "Not mapped to a lane — you can map or create one" : "Not mapped to an ADE lane"}
      style={{
        ...inlineBadge(actionable ? COLORS.warning : COLORS.textMuted),
        fontSize: 10,
        padding: "2px 7px",
        borderRadius: 5,
        fontWeight: 600,
        fontFamily: SANS_FONT,
      }}
    >
      unmapped
    </span>
  );
}

/**
 * `arul · squash → main` — how a terminal PR shipped, folded onto the meta line in
 * place of the branch row. Every part is optional: PRs merged before ADE recorded
 * merge metadata simply show less, rather than showing placeholders.
 */
function PrRowMergeFacts({ item }: { item: GitHubPrListItem }) {
  const parts = [
    item.mergedBy?.login ?? null,
    item.mergeMethod,
    item.baseBranch ? `→ ${item.baseBranch}` : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return (
    <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim, whiteSpace: "nowrap" }}>
      {parts.join(" · ")}
    </span>
  );
}

function PrRowDiffStat({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions == null && deletions == null) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT }}>
      <span style={{ color: COLORS.success }}>+{additions ?? 0}</span>
      <span style={{ color: COLORS.danger }}>-{deletions ?? 0}</span>
    </span>
  );
}

/** `was: <lane> · 3 chats · 2 proof` — what ADE knows that GitHub cannot show. */
function PrRowGhostLaneChip({ detached }: { detached: NonNullable<GitHubPrListItem["detached"]> }) {
  const counts = [
    detached.chats > 0 ? `${detached.chats} chat${detached.chats === 1 ? "" : "s"}` : null,
    detached.artifacts > 0 ? `${detached.artifacts} proof` : null,
  ].filter(Boolean) as string[];
  const name = detached.laneName?.trim();
  const detachedAgo = formatTimeAgoCompact(detached.at);
  if (!name && counts.length === 0) return null;
  return (
    <span
      title={`Built in lane "${name ?? "unknown"}", deleted ${detachedAgo ? `${detachedAgo} ago` : "earlier"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        fontSize: 10,
        fontFamily: SANS_FONT,
        color: COLORS.textDim,
        borderRadius: 5,
      }}
    >
      {detached.laneColor ? <LaneAccentDot lane={{ color: detached.laneColor }} size={6} /> : null}
      {name ? <span>was: {name}</span> : null}
      {counts.length > 0 ? <span style={{ opacity: 0.85 }}>· {counts.join(" · ")}</span> : null}
    </span>
  );
}

/* ---- PR row (shared between list and virtualizer) ---- */
function useLaneColorById(laneId: string | null | undefined): string | null {
  return useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.color ?? null;
  });
}

export function GitHubTabPrRow({
  item,
  selected,
  linkedPr,
  onSelect,
}: {
  item: GitHubPrListItem;
  selected: boolean;
  linkedPr: PrSummary | null;
  onSelect: (item: GitHubPrListItem) => void;
}) {
  const sc = stateColor(item.state);
  // A merged PR is a record, not a queue item: CI outcome, "review required" and the
  // state badge are all answered by the fact that it merged. Dropping them is what lets
  // the row collapse to two lines and stops the list reading as a wall of signals.
  const terminal = isTerminalPrState(item.state);
  const review = terminal ? null : reviewIndicator(linkedPr);
  // Open rows are about how long something has been waiting; merged rows are about
  // when it shipped.
  const ago = formatTimeAgoCompact(terminal ? (item.mergedAt ?? item.updatedAt) : item.createdAt);
  const labels = item.labels ?? [];
  const visibleLabels = labels.slice(0, 4);
  const overflowCount = labels.length - 4;
  const rowLinkedLaneColor = useLaneColorById(item.linkedLaneId ?? null);
  const mappable = isPrRowMappable(item);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        data-tour="prs.listRow"
        onClick={() => onSelect(item)}
        style={{
          display: "flex",
          width: "100%",
          flexDirection: "column",
          gap: 6,
          padding: "11px 42px 11px 14px",
          textAlign: "left",
          border: "none",
          borderLeft: selected ? `3px solid ${sc.text}` : "3px solid transparent",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          background: selected
            ? `linear-gradient(90deg, ${sc.bg} 0%, rgba(255,255,255,0.02) 100%)`
            : "transparent",
          cursor: "pointer",
          transition: "background 150ms ease",
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
      >
      {/* Row 1: avatar, bot badge, PR number, title, CI icon, time, comments */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {item.author ? (
          <img
            src={`https://avatars.githubusercontent.com/${item.author}?size=32`}
            alt=""
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              flexShrink: 0,
              border: `1.5px solid ${sc.bg}`,
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            flexShrink: 0,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
          }} />
        )}
        {item.isBot ? (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            fontFamily: SANS_FONT,
            textTransform: "uppercase",
            padding: "1px 5px",
            borderRadius: 3,
            background: "rgba(255,255,255,0.06)",
            color: COLORS.textDim,
            flexShrink: 0,
            letterSpacing: "0.3px",
          }}>
            bot
          </span>
        ) : null}
        <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: sc.text, flexShrink: 0 }}>
          #{item.githubPrNumber}
        </span>
        <GitHubStackBadge stack={item.stack} compact />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: SANS_FONT,
          flex: 1,
          minWidth: 0,
        }}>
          {item.title}
        </span>
        {terminal ? null : (
          <PrRowCiStatus status={linkedPr?.checksStatus ?? null} reason={linkedPr?.checksReason ?? null} />
        )}
        {ago ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0 }}>
            {ago}
          </span>
        ) : null}
        {item.commentCount > 0 ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: COLORS.textDim }}>
            <ChatText size={12} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 10 }}>{item.commentCount}</span>
          </span>
        ) : null}
      </div>
      {/* Row 1.5: labels */}
      {visibleLabels.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, flexWrap: "wrap" }}>
          {visibleLabels.map((label) => {
            const bg = `#${label.color}`;
            const textColor = labelTextColor(label.color);
            return (
              <span
                key={label.name}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: SANS_FONT,
                  color: textColor,
                  background: bg,
                  borderRadius: 10,
                  lineHeight: "16px",
                }}
              >
                {label.name}
              </span>
            );
          })}
          {overflowCount > 0 ? (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              +{overflowCount}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Row 2: branch info. Merged rows fold the base into the meta line below. */}
      {!terminal && item.baseBranch && item.headBranch ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.headBranch}</span>
          <span style={{ color: COLORS.textMuted }}>→</span>
          <span>{item.baseBranch}</span>
        </div>
      ) : null}
      {/* Row 3: inline stats */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, paddingLeft: 30 }}>
        {/* The state badge is redundant on a merged row — the bucket, the glyph colour
            and the merge facts all already say it. Closed keeps it: "closed" is a
            genuinely different outcome from "merged" and worth calling out. */}
        {item.state === "closed" ? (
          <span style={stateBadgeStyle(item)}>{item.state}</span>
        ) : null}
        {terminal ? <PrRowMergeFacts item={item} /> : null}
        <AdeKindBadge kind={item.adeKind} />
        {item.scope === "external" ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
            {item.repoOwner}/{item.repoName}
          </span>
        ) : null}
        <PrRowLaneChip item={item} linkedLaneColor={rowLinkedLaneColor} mappable={mappable} />
        {review ? (
          <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", fontSize: 10, fontWeight: 500, fontFamily: SANS_FONT, color: review.color, background: `${review.color}10`, borderRadius: 4 }}>
            {review.label}
          </span>
        ) : null}
        {/* Prefer the live linked row, but fall back to the values carried on the list
            item so a detached PR keeps its diff stats after its lane is gone. */}
        <PrRowDiffStat
          additions={linkedPr?.additions ?? item.additions ?? null}
          deletions={linkedPr?.deletions ?? item.deletions ?? null}
        />
        {/* The one honest amber left in the merged list: the remote branch still
            exists. Selecting the row surfaces the real Delete branch action. */}
        {item.cleanupState === "required" ? (
          <span
            title="The remote branch still exists — open this PR to delete it"
            style={{ ...inlineBadge(COLORS.warning), fontSize: 10, padding: "2px 7px", borderRadius: 5, display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <GitBranch size={10} weight="bold" />
            branch
          </span>
        ) : null}
      </div>
      </button>
      <button
        type="button"
        aria-label="View on GitHub"
        onClick={() => { void window.ade.app.openExternal(item.githubUrl); }}
        style={{
          position: "absolute",
          right: 14,
          bottom: 11,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          padding: 0,
          border: "none",
          borderRadius: 4,
          background: "transparent",
          cursor: "pointer",
          color: COLORS.textDim,
          transition: "color 100ms ease",
        }}
        title="Open on GitHub"
        onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textSecondary; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
      >
        <ArrowSquareOut size={13} />
      </button>
    </div>
  );
}

/**
 * Period header for the merged/closed log. Announced as a heading so screen readers get
 * the same structure sighted users do, instead of an undifferentiated pile of buttons.
 */
export function PrListGroupHeaderRow({ header }: { header: PrListGroupHeaderModel }) {
  const diff = formatPrListGroupDiff(header.additions, header.deletions);
  return (
    <div
      role="heading"
      aria-level={3}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px",
        background: COLORS.prSurface,
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.4px",
        textTransform: "uppercase",
        color: COLORS.textMuted,
      }}
    >
      <span>{header.label}</span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 500, opacity: 0.75, textTransform: "none", letterSpacing: 0 }}>
        {header.count} {header.outcome}{diff ? ` · ${diff}` : ""}
      </span>
    </div>
  );
}
