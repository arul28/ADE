/**
 * Shared visual primitives for the Lane story: actor avatars, live status
 * dots, PR chips and the node glyphs drawn on the spine.
 *
 * Every colour here comes from `laneDesignTokens` or the provider brand table
 * in `laneStoryModel` — nothing hardcodes a grey.
 */

import React, { memo, useMemo } from "react";
import {
  ChatCircleDots,
  Check,
  GitBranch,
  GitCommit,
  GitPullRequest,
  X as XIcon,
} from "@phosphor-icons/react";
import type { LaneEvent, LaneEventActor } from "../../../../shared/types/laneEvents";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge } from "../laneDesignTokens";
import { ProviderLogo } from "../../shared/ProviderLogos";
import type { LaneTabPrTag } from "../lanePageModel";
import { LANE_COLOR, PR_COLOR, REVIEW_COLOR, actorLabel, storyProviderColor } from "./laneStoryModel";

/* ------------------------------------------------------------------ *
 * Actor avatar
 * ------------------------------------------------------------------ */

export type StoryAvatarProps = {
  actor: Pick<LaneEventActor, "kind" | "provider" | "login">;
  size?: number;
  /** GitHub/account avatar for human actors; falls back to initials. */
  humanAvatarUrl?: string | null;
  ring?: boolean;
  title?: string;
};

/**
 * One 18px-ish disc that says who acted. Agents get their provider mark, humans
 * get their GitHub avatar (initials when signed out), bots get a monogram.
 */
export const StoryAvatar = memo(function StoryAvatar({
  actor,
  size = 18,
  humanAvatarUrl,
  ring = true,
  title,
}: StoryAvatarProps) {
  const color = storyProviderColor(actor.provider) ?? (actor.kind === "human" ? COLORS.textSecondary : COLORS.textMuted);
  const initials = (actor.login ?? (actor.kind === "human" ? "you" : "?")).slice(0, 2).toUpperCase();
  const showLogo = Boolean(actor.provider) && actor.kind !== "human";
  return (
    <span
      title={title ?? actorLabel(actor as LaneEventActor)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        overflow: "hidden",
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        boxShadow: ring ? `0 0 0 1px color-mix(in srgb, ${color} 42%, transparent)` : undefined,
      }}
    >
      {actor.kind === "human" && humanAvatarUrl ? (
        <img src={humanAvatarUrl} alt="" width={size} height={size} style={{ display: "block", borderRadius: "50%" }} />
      ) : showLogo ? (
        <ProviderLogo family={String(actor.provider)} size={Math.round(size * 0.72)} />
      ) : (
        <span style={{ fontFamily: MONO_FONT, fontSize: Math.max(7, Math.round(size * 0.4)), fontWeight: 700, color }}>
          {initials}
        </span>
      )}
    </span>
  );
});

/* ------------------------------------------------------------------ *
 * Live status dot
 * ------------------------------------------------------------------ */

export type StoryStatusTone = "working" | "awaiting" | "idle" | "ended";

const STATUS_COLOR: Record<StoryStatusTone, string> = {
  working: COLORS.success,
  awaiting: COLORS.warning,
  idle: COLORS.textMuted,
  ended: COLORS.danger,
};

export function StoryStatusDot({ tone, size = 6 }: { tone: StoryStatusTone; size?: number }) {
  const color = STATUS_COLOR[tone];
  return (
    <span
      aria-hidden
      className={tone === "working" ? "ade-status-breathe" : undefined}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: tone === "working" ? `0 0 6px 1px color-mix(in srgb, ${color} 55%, transparent)` : undefined,
        flexShrink: 0,
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * PR chips (stacked/fanned)
 * ------------------------------------------------------------------ */

function prTone(state: LaneTabPrTag["state"]): string {
  if (state === "merged") return LANE_COLOR;
  if (state === "closed") return COLORS.textMuted;
  return PR_COLOR;
}

/**
 * Multiple PRs on one lane stack rather than wrap: the newest sits on top and
 * older ones peek out behind it, and hovering fans them into a row. A lane with
 * five superseded PRs should still read as one object at rest.
 */
export function StoryPrChips({
  prs,
  onOpen,
  max = 4,
}: {
  prs: readonly LaneTabPrTag[];
  onOpen?: (pr: LaneTabPrTag) => void;
  max?: number;
}) {
  const shown = useMemo(() => prs.slice(0, max), [prs, max]);
  if (!shown.length) return null;
  return (
    <span className="ade-lane-story-prstack" style={{ display: "inline-flex", alignItems: "center" }}>
      {shown.map((pr, index) => {
        const color = prTone(pr.state);
        return (
          <button
            key={pr.id}
            type="button"
            className="ade-lane-story-prchip"
            title={`#${pr.githubPrNumber} ${pr.title}`}
            style={{
              ...inlineBadge(color, {
                height: 20,
                padding: "0 7px",
                fontSize: 10,
                fontFamily: MONO_FONT,
                borderRadius: 5,
                cursor: onOpen ? "pointer" : "default",
                background: `color-mix(in srgb, ${color} 14%, var(--color-bg))`,
              }),
              // Newest on top; older ones peek up-right behind it.
              zIndex: shown.length - index,
              marginLeft: index === 0 ? 0 : -14,
              transform: index === 0 ? undefined : `translate(${index * 3}px, ${index * -2}px)`,
              opacity: index === 0 ? 1 : Math.max(0.35, 0.8 - index * 0.18),
            }}
            onClick={(event) => {
              event.stopPropagation();
              onOpen?.(pr);
            }}
          >
            #{pr.githubPrNumber}
          </button>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Node glyphs
 * ------------------------------------------------------------------ */

export type StoryNodeGlyphProps = {
  event: LaneEvent;
  color: string;
  humanAvatarUrl?: string | null;
};

/**
 * The mark drawn on the spine for one event. Shapes carry meaning: circles are
 * commits, rounded squares are PR lifecycle, rings are outcomes, diamonds are
 * branch moves.
 */
export function StoryNodeGlyph({ event, color, humanAvatarUrl }: StoryNodeGlyphProps) {
  const ringBg = COLORS.pageBg;
  switch (event.kind) {
    case "commit": {
      if (event.actor.kind === "human" && humanAvatarUrl) {
        return (
          <img
            src={humanAvatarUrl}
            alt=""
            width={18}
            height={18}
            style={{ borderRadius: "50%", display: "block", boxShadow: `0 0 0 2px ${ringBg}` }}
          />
        );
      }
      return (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 0 3px ${ringBg}`,
            display: "block",
          }}
        />
      );
    }
    case "pr_opened":
      return (
        <span style={glyphBox(20, color, 6)}>
          <GitPullRequest size={11} weight="bold" color={color} />
        </span>
      );
    case "pr_merged":
      return (
        <span style={glyphRing(22, PR_COLOR)}>
          <Check size={12} weight="bold" color={PR_COLOR} />
        </span>
      );
    case "pr_closed":
      return (
        <span style={glyphRing(20, COLORS.textMuted)}>
          <XIcon size={10} weight="bold" color={COLORS.textMuted} />
        </span>
      );
    case "pr_checks": {
      const failing = /fail|error/i.test(String((event.payload as { checksStatus?: string }).checksStatus ?? ""));
      const tone = failing ? COLORS.danger : PR_COLOR;
      return (
        <span style={glyphRing(16, tone)}>
          {failing ? <XIcon size={8} weight="bold" color={tone} /> : <Check size={8} weight="bold" color={tone} />}
        </span>
      );
    }
    case "pr_review":
      return (
        <span style={glyphRing(16, REVIEW_COLOR)}>
          <ChatCircleDots size={9} weight="fill" color={REVIEW_COLOR} />
        </span>
      );
    case "lane_created":
      return (
        <span style={glyphRing(22, color)}>
          {event.actor.kind === "human" && humanAvatarUrl ? (
            <img src={humanAvatarUrl} alt="" width={16} height={16} style={{ borderRadius: "50%" }} />
          ) : event.actor.provider ? (
            <ProviderLogo family={String(event.actor.provider)} size={12} />
          ) : (
            <GitCommit size={11} weight="bold" color={color} />
          )}
        </span>
      );
    case "lane_spawned":
      return (
        <span style={glyphBox(20, LANE_COLOR, 6)}>
          <GitBranch size={11} weight="bold" color={LANE_COLOR} />
        </span>
      );
    case "branch_switched":
    case "rebase":
      return (
        <span
          style={{
            width: 11,
            height: 11,
            background: LANE_COLOR,
            transform: "rotate(45deg)",
            borderRadius: 2,
            boxShadow: `0 0 0 3px ${ringBg}`,
            display: "block",
          }}
        />
      );
    default:
      return (
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px ${ringBg}`, display: "block" }} />
      );
  }
}

function glyphRing(size: number, color: string): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: COLORS.pageBg,
    border: `1.5px solid ${color}`,
    boxShadow: `0 0 0 2px ${COLORS.pageBg}`,
  };
}

function glyphBox(size: number, color: string, radius: number): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: radius,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: `color-mix(in srgb, ${color} 16%, ${COLORS.pageBg})`,
    border: `1px solid color-mix(in srgb, ${color} 48%, transparent)`,
    boxShadow: `0 0 0 2px ${COLORS.pageBg}`,
  };
}

/* ------------------------------------------------------------------ *
 * Legend key
 * ------------------------------------------------------------------ */

const KEY_ENTRIES: Array<{ label: string; color: string }> = [
  // Provider swatches come from the one palette the canvas paints with, so the
  // key can never drift from the dots it explains.
  ...["Claude", "Cursor", "Codex"].map((label) => ({
    label,
    color: storyProviderColor(label) ?? LANE_COLOR,
  })),
  { label: "you", color: COLORS.textSecondary },
  { label: "PR", color: PR_COLOR },
  { label: "review", color: REVIEW_COLOR },
  { label: "lane", color: LANE_COLOR },
];

/** Bottom-left swatch pill; labels only appear on hover so it stays out of the way. */
export function StoryLegend() {
  return (
    <div className="ade-lane-story-key" aria-label="Story key">
      {KEY_ENTRIES.map((entry) => (
        <span key={entry.label} className="ade-lane-story-key-item">
          <span className="ade-lane-story-key-dot" style={{ background: entry.color }} />
          <span className="ade-lane-story-key-label" style={{ fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            {entry.label}
          </span>
        </span>
      ))}
    </div>
  );
}
