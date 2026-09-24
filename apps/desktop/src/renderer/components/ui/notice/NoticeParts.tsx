import type { CSSProperties, ReactNode } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Info,
  Sparkle,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { openExternalUrl } from "../../../lib/openExternal";
import { noticeTone, type NoticeTone } from "./noticeTones";
import "./notice.css";

/**
 * Building blocks shared by every notice surface: the tone icon tile, action
 * buttons, the close button, badges and meta chips. `Banner` and `ToastCard`
 * compose these; feature code should use those two, not these parts directly,
 * unless it is building a new notice primitive in this folder.
 */

const SANS = "var(--font-sans)";

export function defaultNoticeIcon(tone: NoticeTone, size: number): ReactNode {
  if (tone === "error") return <XCircle size={size} weight="fill" />;
  if (tone === "warning") return <WarningCircle size={size} weight="fill" />;
  if (tone === "success") return <CheckCircle size={size} weight="fill" />;
  if (tone === "accent") return <Sparkle size={size} weight="fill" />;
  return <Info size={size} weight="fill" />;
}

export type NoticeIconSize = "sm" | "md" | "lg";

const ICON_TILE: Record<NoticeIconSize, { box: number; glyph: number; radius: number }> = {
  sm: { box: 22, glyph: 13, radius: 6 },
  md: { box: 28, glyph: 15, radius: 8 },
  lg: { box: 32, glyph: 16, radius: 9 },
};

/**
 * The tone-tinted square that leads a notice. Pass `icon` for a logo or a
 * feature glyph (GitHub, Linear, a lane dot); omit it for the tone default.
 * `busy` swaps the glyph for a spinner without changing the tile's size.
 */
export function NoticeIcon({
  tone,
  icon,
  size = "md",
  busy = false,
  bare = false,
}: {
  tone: NoticeTone;
  icon?: ReactNode;
  size?: NoticeIconSize;
  busy?: boolean;
  /** Render the glyph alone, without the tile (floating one-line pills). */
  bare?: boolean;
}): JSX.Element {
  const tokens = noticeTone(tone);
  const dims = ICON_TILE[size];
  const glyph = busy ? (
    <CircleNotch size={dims.glyph} weight="bold" className="ade-notice-spin" />
  ) : (
    icon ?? defaultNoticeIcon(tone, dims.glyph)
  );
  if (bare) {
    return (
      <span
        aria-hidden="true"
        style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, color: tokens.color }}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: dims.box,
        height: dims.box,
        borderRadius: dims.radius,
        color: tokens.color,
        background: tokens.soft,
        border: `1px solid ${tokens.ring}`,
      }}
    >
      {glyph}
    </span>
  );
}

export type NoticeActionVariant = "primary" | "solid" | "secondary" | "link";

export type NoticeAction = {
  label: string;
  /** Run on click. Optional when `href` is set. */
  onClick?: () => void;
  /** An external URL, opened through ADE's external-link bridge. Adds the ↗ glyph. */
  href?: string;
  /**
   * `primary` (default for the first action) is a tone-tinted pill, `solid` a
   * filled tone pill for the one action that matters most, `secondary` an
   * outlined neutral pill, `link` quiet text.
   */
  variant?: NoticeActionVariant;
  /** Leading glyph (Phosphor icon at the button's size, or a logo). */
  icon?: ReactNode;
  /** Shown but not pressable. */
  disabled?: boolean;
  /** The action it started is still running: spinner, and not pressable. */
  busy?: boolean;
  /** Announce whether this action's associated disclosure is open. */
  expanded?: boolean;
  /** Tooltip. */
  title?: string;
  /** For disclosure actions ("Details"): rendered as `aria-expanded`. */
  expanded?: boolean;
};

export type NoticeButtonSize = "sm" | "md";

export function NoticeButton({
  action,
  tone,
  size = "sm",
  fallbackVariant = "secondary",
  onAfterClick,
}: {
  action: NoticeAction;
  tone: NoticeTone;
  size?: NoticeButtonSize;
  fallbackVariant?: NoticeActionVariant;
  /** Runs after the action's own handler (e.g. a toast dismissing itself). */
  onAfterClick?: () => void;
}): JSX.Element {
  const tokens = noticeTone(tone);
  const variant = action.variant ?? fallbackVariant;
  const height = size === "md" ? 28 : 24;
  const glyph = size === "md" ? 13 : 12;
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height,
    padding: variant === "link" ? "0 2px" : size === "md" ? "0 12px" : "0 10px",
    borderRadius: 999,
    fontFamily: SANS,
    fontSize: size === "md" ? 12 : 11.5,
    fontWeight: variant === "secondary" || variant === "link" ? 500 : 600,
    whiteSpace: "nowrap",
    cursor: "pointer",
    flexShrink: 0,
  };
  let style: CSSProperties;
  if (variant === "solid") {
    style = {
      ...base,
      color: "var(--color-bg)",
      background: tone === "neutral" ? "var(--color-fg)" : tokens.color,
      border: "1px solid transparent",
    };
  } else if (variant === "primary") {
    style = {
      ...base,
      color: tokens.text,
      background: tokens.soft,
      border: `1px solid ${tokens.ring}`,
      ["--ade-notice-soft-hover" as string]: tokens.softHover,
    };
  } else if (variant === "link") {
    style = { ...base, color: tokens.text, background: "transparent", border: "none" };
  } else {
    style = {
      ...base,
      color: "var(--color-secondary-fg)",
      background: "transparent",
      border: "1px solid color-mix(in srgb, var(--color-border) 88%, var(--color-fg) 12%)",
    };
  }
  const external = Boolean(action.href);
  const disabled = Boolean(action.disabled || action.busy);
  return (
    <button
      type="button"
      className="ade-notice-btn"
      data-variant={variant}
      style={style}
      disabled={disabled}
      aria-busy={action.busy || undefined}
      aria-expanded={action.expanded}
      title={action.title}
      onClick={() => {
        if (action.onClick) action.onClick();
        else if (action.href) openExternalUrl(action.href);
        onAfterClick?.();
      }}
    >
      {action.busy ? (
        <CircleNotch size={glyph} weight="bold" className="ade-notice-spin" aria-hidden="true" />
      ) : action.icon ? (
        <span aria-hidden="true" style={{ display: "inline-flex" }}>{action.icon}</span>
      ) : null}
      {action.label}
      {external && !action.busy ? <ArrowSquareOut size={glyph - 1} aria-hidden="true" /> : null}
    </button>
  );
}

export function NoticeActions<A extends NoticeAction>({
  actions,
  tone,
  size = "sm",
  onAfterClick,
  style,
}: {
  actions: A[] | undefined;
  tone: NoticeTone;
  size?: NoticeButtonSize;
  /** Receives the clicked action with its full type (e.g. a toast's `keepOpen`). */
  onAfterClick?: (action: A) => void;
  style?: CSSProperties;
}): JSX.Element | null {
  if (!actions || actions.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", ...style }}>
      {actions.map((action, index) => (
        <NoticeButton
          key={`${action.label}-${index}`}
          action={action}
          tone={tone}
          size={size}
          fallbackVariant={index === 0 ? "primary" : "secondary"}
          onAfterClick={onAfterClick ? () => onAfterClick(action) : undefined}
        />
      ))}
    </div>
  );
}

export function NoticeCloseButton({
  onClick,
  label,
  title = "Dismiss",
  size = 22,
}: {
  onClick: () => void;
  label: string;
  title?: string;
  size?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      className="ade-notice-close"
      onClick={onClick}
      title={title}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        padding: 0,
        borderRadius: 999,
        border: "none",
        background: "transparent",
        color: "var(--color-muted-fg)",
        cursor: "pointer",
      }}
    >
      <X size={12} weight="bold" aria-hidden="true" />
    </button>
  );
}

/** Small tone pill ("Checks failing", "Idle sessions"). */
export function NoticeBadge({ tone, children }: { tone: NoticeTone; children: ReactNode }): JSX.Element {
  const tokens = noticeTone(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        fontFamily: SANS,
        fontSize: 10.5,
        fontWeight: 600,
        color: tokens.text,
        background: tokens.soft,
        border: `1px solid ${tokens.ring}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Neutral metadata chip (a lane with its colour dot, a branch, a repo). */
export function NoticeChip({
  icon,
  children,
  color,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  /** Tints the chip text (a lane's colour). */
  color?: string | null;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: "100%",
        height: 20,
        padding: "0 7px",
        borderRadius: 999,
        fontFamily: SANS,
        fontSize: 10.5,
        color: color ?? "var(--color-muted-fg)",
        background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-fg) 9%, transparent)",
        overflow: "hidden",
      }}
    >
      {icon ? <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span> : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</span>
    </span>
  );
}
