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
import { NO_CI_REASON } from "../../../../shared/prChecksRollup";
import "./prListRow.css";

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

/**
 * The glyph sits at the end of the headline row, so it carries its own optical
 * nudge onto the title's first line rather than being wrapped by the caller —
 * a wrapper would leave a flex gap behind on the statuses that render nothing.
 */
const CI_GLYPH_STYLE: React.CSSProperties = { display: "inline-flex", flexShrink: 0, marginTop: 2 };

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
        <span title="CI passing" style={CI_GLYPH_STYLE}>
          <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />
        </span>
      );
    case "failing":
      return (
        <span title="CI failing" style={CI_GLYPH_STYLE}>
          <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} />
        </span>
      );
    case "pending":
      return (
        <span title="CI pending" style={CI_GLYPH_STYLE}>
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
          style={CI_GLYPH_STYLE}
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
 * The lane column of a PR row.
 *
 * Two states, deliberately distinct:
 * - **has a lane** — the lane chip, in the lane's colour.
 * - **detached** — `was: <lane>` plus the activity frozen when the lane was deleted.
 *   This is history, so it is dim and carries no call to action.
 *
 * Anything else renders nothing. The absence of a chip already says there is no lane,
 * and starting local work on a PR is an offer, not a warning.
 */
function PrRowLaneChip({
  item,
  linkedLaneColor,
}: {
  item: GitHubPrListItem;
  linkedLaneColor: string | null;
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

  return null;
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

/**
 * `was: <lane>` plus `3 chats · 2 proof` — what ADE knows that GitHub cannot show.
 *
 * The two halves are separate elements on purpose: as the list column narrows the
 * lane name drops first and the counts hold on for another 40px (see
 * `.ade-pr-row-provenance` in `index.css`). The full sentence stays in the tooltip
 * either way, so nothing is actually lost when the chip shrinks.
 */
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
      className="ade-pr-row-provenance"
      data-counts={counts.length > 0 ? "1" : "0"}
      title={`Built in lane "${name ?? "unknown"}", deleted ${detachedAgo ? `${detachedAgo} ago` : "earlier"}`}
      style={{
        fontSize: 10,
        fontFamily: SANS_FONT,
        color: COLORS.textDim,
      }}
    >
      {name ? (
        // No inline `display` here: an inline style outranks the container
        // query in `index.css` that has to hide this at <=340px.
        <span className="ade-pr-row-provenance-lane">
          {detached.laneColor ? <LaneAccentDot lane={{ color: detached.laneColor }} size={6} /> : null}
          was: {name}
        </span>
      ) : null}
      {counts.length > 0 ? (
        <span className="ade-pr-row-provenance-counts" style={{ opacity: 0.85 }}>{counts.join(" · ")}</span>
      ) : null}
    </span>
  );
}

/**
 * The author, parked in the card's top-right corner.
 *
 * The card already reserves a 42px right gutter for the GitHub link that sits at the
 * bottom-right, and the top of that gutter was empty. Taking the avatar out of the
 * headline's flex flow and pinning it there costs the title nothing — an 18px glyph
 * inset 14px from the edge stops 10px short of the text column, so the title keeps the
 * full-width wrap it has today and never re-flows around the avatar. Out of flow also
 * means the row's measured height is unchanged, which matters for a virtualiser that
 * re-measures every row.
 *
 * Absolutely positioned *inside* the row button, not beside it, so the corner is still
 * part of the row's click target.
 */
function PrRowAuthorAvatar({ item, accentBg }: { item: GitHubPrListItem; accentBg: string }) {
  const base: React.CSSProperties = {
    position: "absolute",
    top: 11,
    right: 14,
    width: 18,
    height: 18,
    borderRadius: "50%",
    flexShrink: 0,
  };
  if (item.author) {
    return (
      <img
        className="ade-pr-row-avatar"
        src={`https://avatars.githubusercontent.com/${item.author}?size=32`}
        alt=""
        style={{ ...base, border: `1.5px solid ${accentBg}` }}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div
      className="ade-pr-row-avatar"
      style={{
        ...base,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    />
  );
}

/* ---- PR row (shared between list and virtualizer) ---- */
function useLaneColorById(laneId: string | null | undefined): string | null {
  return useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.color ?? null;
  });
}

/**
 * One PR in the list column.
 *
 * The column is drag-resizable down to 260px, and the row used to spend that width
 * badly: the title shared its line with a timestamp and a comment count, so it was
 * the first thing to truncate while decoration kept its space. Now the title owns a
 * full-width line of its own and wraps to as many lines as it needs, the author sits
 * in the top-right corner and the timestamp at the bottom-right beside the GitHub
 * link, and the row sheds decoration in a fixed order as it narrows — the frozen lane
 * name, then that lane's chat and proof counts, and only at the very floor of the
 * drag range the avatar. The PR number and title never drop.
 *
 * The narrowing is driven by `.ade-pr-row`'s container query in `index.css`, keyed on
 * the row's own width. That is deliberately not a React density prop: the width that
 * matters is the row's, the tab does not otherwise measure it, and threading a tier
 * down would put a resize observer and a re-render in the path of every drag frame.
 */
export const GitHubTabPrRow = React.memo(function GitHubTabPrRow({
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
  // state badge are all answered by the fact that it merged. Dropping them is what keeps
  // a merged row down to a headline and a meta line, and stops the list reading as a
  // wall of signals.
  const terminal = isTerminalPrState(item.state);
  const review = terminal ? null : reviewIndicator(linkedPr);
  // Open rows are about how long something has been waiting; merged rows are about
  // when it shipped.
  const ago = formatTimeAgoCompact(terminal ? (item.mergedAt ?? item.updatedAt) : item.createdAt);
  const labels = item.labels ?? [];
  const visibleLabels = labels.slice(0, 4);
  const overflowCount = labels.length - 4;
  const rowLinkedLaneColor = useLaneColorById(item.linkedLaneId ?? null);
  return (
    <div className="ade-pr-row" style={{ position: "relative" }}>
      <button
        type="button"
        data-tour="prs.listRow"
        onClick={() => onSelect(item)}
        style={{
          position: "relative",
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
      {/* The author, pinned to the card's top-right gutter and out of the headline's
          flow. See `PrRowAuthorAvatar`. */}
      <PrRowAuthorAvatar item={item} accentBg={sc.bg} />
      {/* Row 1: the headline — number and title, which are the row's reason to exist
          and the two things that never drop. They share one wrapping text flow, so
          the title takes the whole card and runs to as many lines as it needs
          instead of ellipsing after a few characters. Only the CI glyph flanks it. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <div style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.35,
          color: COLORS.textPrimary,
          fontFamily: SANS_FONT,
          // A single unbroken token (a branch name, a URL) can be wider than the
          // whole column; break it rather than let it overflow the card.
          overflowWrap: "anywhere",
        }}>
          {item.isBot ? (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              fontFamily: SANS_FONT,
              textTransform: "uppercase",
              padding: "1px 5px",
              marginRight: 5,
              borderRadius: 3,
              background: "rgba(255,255,255,0.06)",
              color: COLORS.textDim,
              letterSpacing: "0.3px",
              whiteSpace: "nowrap",
            }}>
              bot
            </span>
          ) : null}
          <span style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 400, color: sc.text }}>
            #{item.githubPrNumber}
          </span>{" "}
          {item.title}
        </div>
        {terminal ? null : (
          <PrRowCiStatus status={linkedPr?.checksStatus ?? null} reason={linkedPr?.checksReason ?? null} />
        )}
      </div>
      {/* Row 2: labels */}
      {visibleLabels.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
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
      {/* Row 3: branch info. Merged rows fold the base into the meta line below.
          Kept at every width: it is one line, it truncates from the head branch
          inwards, and with the title on its own line it no longer costs the title
          anything. */}
      {!terminal && item.baseBranch && item.headBranch ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.headBranch}</span>
          <span style={{ color: COLORS.textMuted }}>→</span>
          <span>{item.baseBranch}</span>
        </div>
      ) : null}
      {/* Row 4: inline stats, and the timestamp pinned to the right so it lands
          beside the GitHub link below. `minHeight` keeps that row's optical centre
          on the link button's even when it holds nothing but the timestamp. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, minHeight: 20 }}>
        <GitHubStackBadge stack={item.stack} compact />
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
        <PrRowLaneChip item={item} linkedLaneColor={rowLinkedLaneColor} />
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
        {/* Activity, pushed to the right so it ends up beside the GitHub link at the
            bottom-right of the card. Open rows count how long this has been waiting;
            terminal rows say when it shipped. */}
        {item.commentCount > 0 ? (
          <span style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            flexShrink: 0,
            color: COLORS.textDim,
          }}>
            <ChatText size={12} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 10 }}>{item.commentCount}</span>
          </span>
        ) : null}
        {ago ? (
          <span style={{
            ...(item.commentCount > 0 ? {} : { marginLeft: "auto" }),
            flexShrink: 0,
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textDim,
          }}>
            {ago}
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
});

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
