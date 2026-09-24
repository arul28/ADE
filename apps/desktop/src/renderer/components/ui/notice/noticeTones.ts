/**
 * The one tone palette every notice surface (banners, toasts, callouts, notice
 * dialogs) paints from.
 *
 * Every value resolves against the theme variables in `index.css`, so a tone
 * reads correctly in both the dark and light themes without a per-theme branch.
 * Colour is carried by the icon, the icon tile, a faint border tint and the
 * primary action — never by flooding the whole row — so a red failure still
 * looks like part of the app instead of an alarm stuck on top of it.
 */

export type NoticeTone = "error" | "warning" | "info" | "success" | "accent" | "neutral";

export type NoticeToneTokens = {
  /** The raw tone colour (icons, dots). */
  color: string;
  /** Tone-tinted text that stays readable on the card surface in both themes. */
  text: string;
  /** Soft fill for icon tiles, badges and primary buttons. */
  soft: string;
  /** Stronger fill for a primary button's hover state. */
  softHover: string;
  /** Border for icon tiles, badges and primary buttons. */
  ring: string;
  /** The card's own border: the neutral border, nudged toward the tone. */
  edge: string;
};

const TONE_VAR: Record<NoticeTone, string> = {
  error: "var(--color-error)",
  warning: "var(--color-warning)",
  info: "var(--color-info)",
  success: "var(--color-success)",
  accent: "var(--color-accent)",
  neutral: "var(--color-muted-fg)",
};

export function noticeTone(tone: NoticeTone): NoticeToneTokens {
  const color = TONE_VAR[tone];
  if (tone === "neutral") {
    return {
      color,
      text: "var(--color-fg)",
      soft: "color-mix(in srgb, var(--color-fg) 6%, transparent)",
      softHover: "color-mix(in srgb, var(--color-fg) 10%, transparent)",
      ring: "color-mix(in srgb, var(--color-fg) 14%, transparent)",
      edge: "var(--color-border)",
    };
  }
  return {
    color,
    text: `color-mix(in srgb, ${color} 72%, var(--color-fg))`,
    soft: `color-mix(in srgb, ${color} 14%, transparent)`,
    softHover: `color-mix(in srgb, ${color} 22%, transparent)`,
    ring: `color-mix(in srgb, ${color} 32%, transparent)`,
    edge: `color-mix(in srgb, ${color} 26%, var(--color-border))`,
  };
}

/** Sort rank: the more urgent tone sorts first. */
export const NOTICE_TONE_RANK: Record<NoticeTone, number> = {
  error: 0,
  warning: 1,
  info: 2,
  accent: 3,
  success: 4,
  neutral: 5,
};

/**
 * The card material shared by floating banners and toasts: the theme card
 * colour, a hair of translucency with blur, and the app's float shadow.
 */
export const NOTICE_FLOAT_SURFACE = {
  background: "color-mix(in srgb, var(--color-card) 96%, transparent)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow: "var(--shadow-float)",
} as const;

/** The in-flow variant (docked / inline banners): same card, no lift. */
export const NOTICE_DOCKED_SURFACE = {
  background: "color-mix(in srgb, var(--color-card) 72%, transparent)",
} as const;
