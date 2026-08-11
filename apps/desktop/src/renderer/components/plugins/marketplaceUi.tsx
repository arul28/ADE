import React from "react";
import { CheckCircle, Circle, Minus, Star, Warning } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { formatCount, type CoverageState, type MachineCoverageRow } from "./marketplaceModel";
import type { PluginIdentity } from "./pluginIcons";

/**
 * The Marketplace's small parts.
 *
 * Everything here is token-backed — no raw hex, no palette classes — because
 * the Marketplace is the surface where a plugin theme is evaluated, and a
 * gallery that does not itself move when a theme is previewed would be lying
 * about what the theme does. That rules out `ui/EmptyState`, which is written
 * against fixed dark hexes; {@link MarketplaceEmpty} is the token-backed
 * equivalent and is the only reason a local one exists.
 */

/* ── Identity ───────────────────────────────────────────────────────────── */

/**
 * A plugin's tile: its image, or its glyph on a wash of its own colour.
 *
 * The wash rather than a flat fill because these sit in a dense list and eight
 * saturated squares in a column is a colour chart, not a catalogue. The colour
 * carries recognition and the glyph carries meaning, which is the same division
 * every app launcher makes.
 *
 * An image that fails to load falls back to the glyph and stays there for the
 * life of the component. Retrying would flicker a broken tile on every render
 * of a list that re-renders on every install event, and a plugin whose icon
 * host is down should look plain, not unstable.
 */
export function PluginIconTile({
  identity,
  size,
  label,
}: {
  identity: PluginIdentity;
  /** Tile edge in px. The glyph is drawn at 52% of it. */
  size: number;
  /** Alt text for the image form. Decorative in the glyph form. */
  label: string;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const { Icon, color, imageUrl } = identity;
  const radius = size >= 40 ? RADII.lg : RADII.sm;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: radius,
        overflow: "hidden",
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
      }}
    >
      {imageUrl && !imageFailed ? (
        <img
          src={imageUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <Icon size={Math.round(size * 0.52)} weight="regular" color={color} aria-hidden />
      )}
    </span>
  );
}

/* ── Chips and badges ───────────────────────────────────────────────────── */

export function FilterChip({
  label,
  active,
  count,
  onClick,
  tour,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
  tour?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-tour={tour}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 26,
        padding: "0 10px",
        fontFamily: SANS_FONT,
        fontSize: 11.5,
        fontWeight: active ? 600 : 500,
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        background: active
          ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
          : "transparent",
        border: `1px solid ${active
          ? "color-mix(in srgb, var(--color-accent) 38%, transparent)"
          : COLORS.borderMuted}`,
        borderRadius: 999,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {count !== undefined ? (
        <span style={{ color: COLORS.textDim, fontWeight: 400 }}>{count}</span>
      ) : null}
    </button>
  );
}

/**
 * The official mark. Deliberately quiet — a badge, not a medal.
 *
 * It says the whole thing in one chip: a card used to carry "ADE" as author
 * text AND an "Official" chip beside it, which is the same fact twice and left
 * the author column meaningless for everyone else. The detail page still names
 * the author, where there is room for it to be a link.
 */
export function OfficialBadge() {
  return (
    <span
      title="Published by ADE"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 6px",
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.01em",
        color: COLORS.accent,
        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        border: `1px solid ${COLORS.accentBorder}`,
        borderRadius: RADII.sm,
        whiteSpace: "nowrap",
      }}
    >
      <CheckCircle size={9} weight="fill" aria-hidden />
      Official ADE plugin
    </span>
  );
}

export function QuietTag({ children, tone = "muted" }: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "warning";
}) {
  const color = tone === "accent" ? COLORS.accent : tone === "warning" ? COLORS.warning : COLORS.textDim;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 500,
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 24%, transparent)`,
        borderRadius: RADII.sm,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* ── Stats ──────────────────────────────────────────────────────────────── */

/**
 * Installs and stars.
 *
 * Renders nothing when neither number is known rather than `0 installs`. An
 * unmeasured plugin and an unpopular one are different facts and the gallery
 * must not conflate them.
 */
export function ListingStats({ installs, stars }: { installs: number | null; stars: number | null }) {
  const installText = formatCount(installs);
  const starText = formatCount(stars);
  if (!installText && !starText) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textDim,
        whiteSpace: "nowrap",
      }}
    >
      {installText ? <span>{installText} installs</span> : null}
      {starText ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <Star size={10} weight="fill" aria-hidden />
          {starText}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A repository's stars, on their own.
 *
 * Separate from {@link ListingStats} because a card shows one number and the
 * detail rail shows two: folding them together produced a card that said
 * "12 installs 4" whenever an install count happened to exist. Null renders
 * nothing at all — a plugin nobody has counted is unranked, not unloved.
 */
export function StarCount({ stars }: { stars: number | null }) {
  const text = formatCount(stars);
  if (!text) return null;
  return (
    <span
      title={`${stars} ${stars === 1 ? "star" : "stars"} on GitHub`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textDim,
        whiteSpace: "nowrap",
      }}
    >
      <Star size={11} weight="fill" aria-hidden />
      {text}
    </span>
  );
}

/* ── Coverage ───────────────────────────────────────────────────────────── */

export const COVERAGE_LABEL: Record<CoverageState, string> = {
  installed: "Installed",
  disabled: "Turned off",
  outdated: "Update available",
  missing: "Not installed",
  unknown: "Unknown — machine offline",
};

export function coverageColor(state: CoverageState): string {
  switch (state) {
    case "installed":
      return COLORS.success;
    case "outdated":
      return COLORS.warning;
    case "disabled":
      return COLORS.textMuted;
    case "unknown":
      return COLORS.borderMuted;
    case "missing":
    default:
      return COLORS.textDim;
  }
}

/**
 * The row-level coverage read: one dot per machine.
 *
 * Hollow for "not installed here", filled for present, a hairline ring for a
 * machine that could not be asked. Capped at six dots with a count after —
 * beyond that the shape stops being readable and the number is the answer
 * anyway.
 */
export function CoverageDots({ rows }: { rows: readonly MachineCoverageRow[] }) {
  if (rows.length <= 1) return null;
  const shown = rows.slice(0, 6);
  const present = rows.filter((row) => row.state === "installed" || row.state === "outdated").length;
  return (
    <span
      title={`On ${present} of ${rows.length} machines`}
      aria-label={`On ${present} of ${rows.length} machines`}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      {shown.map((row) => {
        const filled = row.state === "installed" || row.state === "outdated";
        return (
          <span
            key={row.machineKey}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: filled ? coverageColor(row.state) : "transparent",
              border: `1px solid ${filled ? "transparent" : coverageColor(row.state)}`,
            }}
          />
        );
      })}
      {rows.length > shown.length ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>
          +{rows.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

export function CoverageGlyph({ state }: { state: CoverageState }) {
  const color = coverageColor(state);
  const Glyph = state === "installed" ? CheckCircle
    : state === "outdated" ? Warning
      : state === "unknown" ? Minus
        : Circle;
  return <Glyph size={13} weight={state === "installed" ? "fill" : "regular"} color={color} aria-hidden />;
}

/* ── Meter ──────────────────────────────────────────────────────────────── */

/**
 * A used-against-budget bar.
 *
 * Not `ChatCardMeter`: that one divides a fixed total into pass/fail/run/queue
 * buckets and is sized in `--chat-*` tokens, so it neither means nor measures
 * the right thing outside a transcript. This is the two-value form — used, and
 * what is left — and it turns amber near the ceiling because the writer starts
 * rejecting rows there rather than growing.
 */
export function BudgetMeter({
  used,
  budget,
  label,
  valueText,
}: {
  used: number;
  budget: number;
  label: string;
  valueText: string;
}) {
  const ratio = budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  const near = ratio >= 0.85;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</span>
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: near ? COLORS.warning : COLORS.textDim,
          }}
        >
          {valueText}
        </span>
      </div>
      <div
        role="presentation"
        style={{
          height: 4,
          borderRadius: 999,
          background: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(ratio * 100)}%`,
            height: "100%",
            background: near ? COLORS.warning : COLORS.accent,
            borderRadius: 999,
          }}
        />
      </div>
    </div>
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

export function MarketplaceEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        justifyItems: "center",
        textAlign: "center",
        padding: "44px 20px",
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.lg,
      }}
    >
      <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
        {title}
      </span>
      <p
        style={{
          margin: 0,
          maxWidth: "46ch",
          fontFamily: SANS_FONT,
          fontSize: 11.5,
          lineHeight: 1.55,
          color: COLORS.textMuted,
        }}
      >
        {description}
      </p>
      {action ? <div style={{ marginTop: 4 }}>{action}</div> : null}
    </div>
  );
}

/** Row-shaped skeletons, so the list does not reflow when the data lands. */
export function ListingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading plugins" className="motion-safe:animate-pulse" style={{ display: "grid", gap: 2 }}>
      {Array.from({ length: rows }, (_unused, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: RADII.md,
          }}
        >
          <span style={{ width: 28, height: 28, borderRadius: RADII.sm, background: COLORS.recessedBg }} />
          <span style={{ display: "grid", gap: 6, flex: 1 }}>
            <span style={{ height: 11, width: `${28 + index * 6}%`, background: COLORS.recessedBg, borderRadius: 4 }} />
            <span style={{ height: 9, width: `${46 + index * 4}%`, background: COLORS.recessedBg, borderRadius: 4 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Inline, non-blocking failure text. Errors here never take the page. */
export function InlineNotice({
  tone = "warning",
  children,
  action,
}: {
  tone?: "warning" | "muted";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const color = tone === "warning" ? COLORS.warning : COLORS.textMuted;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        fontFamily: SANS_FONT,
        fontSize: 11.5,
        color: tone === "warning" ? COLORS.textSecondary : COLORS.textMuted,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
        borderRadius: RADII.md,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {action}
    </div>
  );
}

/** Section heading for the right rail. Sentence case, hairline rule under it. */
export function RailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.01em",
            color: COLORS.textMuted,
          }}
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
