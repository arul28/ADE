import type { CSSProperties } from "react";
import type { ChatChromeTint } from "../../state/appStore";
import type { ChatSurfaceChipTone, ChatSurfaceMode } from "../../../shared/types";
import { PROVIDER_CHAT_ACCENTS as SHARED_PROVIDER_CHAT_ACCENTS } from "../../../shared/providerColors";
import { contrastRatio, mixColors, parseColor, toHex, WCAG_AA_TEXT_CONTRAST, type Rgb } from "../../../shared/theme/color";

export const CHAT_SURFACE_ACCENTS: Record<ChatSurfaceMode, string> = {
  standard: "#71717A",
  resolver: "#F97316",
};

/**
 * Per-provider chat-surface accent. Keeps Claude/Codex/etc. visually
 * consistent across desktop and mobile — Claude is always amber, Codex always
 * warm-white, regardless of which model variant is selected. Falls back to
 * the model's own registry color when the provider isn't in the table.
 * Mirror this map in `apps/ios/ADE/Views/Components/ADEDesignSystem.swift`
 * (`providerChatAccents`).
 */
export const PROVIDER_CHAT_ACCENTS: Record<string, string> = { ...SHARED_PROVIDER_CHAT_ACCENTS };

/**
 * Look up the unified chat accent for a provider id ("claude", "codex",
 * "anthropic", …). Returns null when the provider isn't recognized so callers
 * can fall back to per-model color.
 */
export function providerChatAccent(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const key = provider.trim().toLowerCase();
  return PROVIDER_CHAT_ACCENTS[key] ?? null;
}

/**
 * Accent used when nothing trustworthy identifies the chat on screen. Neutral
 * gray is the only honest answer there: a stale color would read as the
 * previous chat's provider.
 */
export const NEUTRAL_CHAT_ACCENT = "#A1A1AA";

/**
 * The accent a chat surface must paint for the chat currently on screen.
 *
 * Best evidence first: the rendered chat's own provider, then the provider an
 * embedding surface knows synchronously for the locked chat, then the composer
 * model's family, then its registry color, then neutral gray.
 *
 * The caller owns staleness: pass `null` for anything you cannot vouch for
 * this frame, so the answer falls through to a source you can — or to gray —
 * rather than landing on a stale color.
 */
export function chatAccentForRenderedChat(args: {
  /** Provider of the rendered chat's session, or null if the pane's is stale. */
  sessionProvider?: string | null;
  /** Provider the host surface knows synchronously for the locked chat. */
  lockSessionProvider?: string | null;
  /** Provider family of the composer's selected model, or null if stale. */
  modelFamily?: string | null;
  /** Per-model registry color, used when the family isn't in the accent table. */
  modelColor?: string | null;
}): string {
  return providerChatAccent(args.sessionProvider)
    ?? providerChatAccent(args.lockSessionProvider)
    ?? providerChatAccent(args.modelFamily)
    ?? args.modelColor
    ?? NEUTRAL_CHAT_ACCENT;
}

const CHIP_TONE_STYLES: Record<ChatSurfaceChipTone, string> = {
  accent: "border-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_88%,white_12%)]",
  success: "border-emerald-400/15 bg-emerald-500/6 text-emerald-300",
  warning: "border-amber-400/15 bg-amber-500/6 text-amber-300",
  danger: "border-red-400/15 bg-red-500/6 text-red-300",
  info: "border-sky-400/15 bg-sky-500/6 text-sky-300",
  muted: "border-fg/[0.06] bg-fg/[0.03] text-fg/50",
};

function hexChannel(segment: string): number {
  const parsed = Number.parseInt(segment, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return "#71717A";
}

export function colorToRgba(value: string, alpha: number): string {
  const normalized = normalizeHex(value);
  return `rgba(${hexChannel(normalized.slice(1, 3))}, ${hexChannel(normalized.slice(3, 5))}, ${hexChannel(normalized.slice(5, 7))}, ${alpha})`;
}

export function resolveChatSurfaceAccent(mode: ChatSurfaceMode, accentColor?: string | null): string {
  const trimmed = accentColor?.trim();
  return trimmed?.length ? normalizeHex(trimmed) : CHAT_SURFACE_ACCENTS[mode] ?? CHAT_SURFACE_ACCENTS.standard;
}

/** Gray zinc accent — no per-runtime provider tint in chrome or bubbles. */
const NEUTRAL_CHROME_ACCENT = "#52525b";

function buildAccentPalette(accent: string, m: number): CSSProperties {
  const a = (alpha: number) => Math.min(1, alpha * m);
  return {
    ["--chat-accent-soft" as string]: colorToRgba(accent, a(0.14)),
    ["--chat-accent-faint" as string]: colorToRgba(accent, a(0.08)),
    ["--chat-accent-glow" as string]: colorToRgba(accent, a(0.28)),
    ["--chat-liquid-highlight" as string]: colorToRgba(accent, a(0.18)),
    ["--chat-liquid-sheen" as string]: colorToRgba(accent, a(0.12)),
    ["--chat-liquid-shadow" as string]: colorToRgba(accent, a(0.16)),
  };
}

function sharedSurfaceTokens(accent: string, m: number): CSSProperties {
  return {
    ["--chat-accent" as string]: accent,
    ...buildAccentPalette(accent, m),
    ["--chat-surface-bg" as string]: "color-mix(in srgb, var(--color-card) 80%, var(--color-bg) 20%)",
    ["--chat-surface-raised" as string]: "color-mix(in srgb, var(--color-card) 88%, var(--color-bg) 12%)",
    ["--chat-panel-bg" as string]: "color-mix(in srgb, var(--color-surface-raised) 78%, var(--color-card) 22%)",
    ["--chat-panel-bg-strong" as string]: "color-mix(in srgb, var(--color-surface-raised) 88%, var(--color-card) 12%)",
    ["--chat-card-bg" as string]: "color-mix(in srgb, var(--color-surface-raised) 65%, var(--color-card) 35%)",
    ["--chat-card-bg-strong" as string]: "color-mix(in srgb, var(--color-surface-raised) 80%, var(--color-card) 20%)",
    ["--chat-composer-bg" as string]: "#14121F",
    ["--chat-panel-border" as string]: "color-mix(in srgb, var(--color-border) 72%, transparent)",
    ["--chat-card-border" as string]: "color-mix(in srgb, var(--color-border) 82%, transparent)",
    ["--chat-code-bg" as string]: "color-mix(in srgb, var(--color-surface-recessed) 88%, var(--color-bg) 12%)",
    ["--chat-code-border" as string]: "color-mix(in srgb, var(--color-border) 72%, transparent)",
    ["--chat-code-fg" as string]: "color-mix(in srgb, var(--color-fg) 86%, var(--color-muted-fg) 14%)",
    ["--chat-notice-bg" as string]: "color-mix(in srgb, var(--color-surface-recessed) 84%, var(--color-card) 16%)",
    ["--chat-notice-border" as string]: "color-mix(in srgb, var(--color-border) 78%, transparent)",
  };
}

/** Dark enough that shading it further would erase the bubble's edges. */
function isDeepChatAccent(accent: string): boolean {
  return chatAccentLuminance(accent) < 0.22;
}

function chatAccentLuminance(accent: string): number {
  const normalized = normalizeHex(accent);
  const r = hexChannel(normalized.slice(1, 3));
  const g = hexChannel(normalized.slice(3, 5));
  const b = hexChannel(normalized.slice(5, 7));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function isLightChatAccent(accent: string): boolean {
  return chatAccentLuminance(accent) > 0.72;
}

/**
 * Readable foreground for content painted on top of a `--chat-accent` fill
 * (e.g. a send-button icon). Light provider accents such as Codex/OpenAI need
 * a dark glyph; everything else stays white.
 */
export function chatAccentContrast(accentColor?: string | null): string {
  const trimmed = accentColor?.trim();
  return trimmed && isLightChatAccent(trimmed) ? "#1c1917" : "#ffffff";
}

/**
 * The accent the surface actually paints for a given chrome tint — neutral
 * tint swaps `--chat-accent` to gray, so contrast for content on that fill
 * must be computed from this, not the raw provider color.
 */
export function effectiveChatAccent(accentColor: string, chromeTint: ChatChromeTint): string {
  return chromeTint === "neutral" ? NEUTRAL_CHROME_ACCENT : accentColor;
}

function bubbleGradient(
  start: string,
  middleAt: number,
  end: string,
  middleMix?: { color: string; accentWeight: number },
) {
  const middle = middleMix
    ? `color-mix(in srgb, var(--chat-accent) ${middleMix.accentWeight * 100}%, ${middleMix.color})`
    : "var(--chat-accent)";
  return {
    background: `linear-gradient(135deg, ${start} 0%, ${middle} ${middleAt}%, ${end} 100%)`,
    midpoint: (accent: Rgb): Rgb => middleMix
      ? mixColors(accent, parseColor(middleMix.color)!, middleMix.accentWeight)
      : accent,
  };
}

/** The original violet blend for Claude and neutral chrome. */
const CHAT_USER_BUBBLE_GRADIENT_DEFAULT = bubbleGradient(
  "color-mix(in srgb, var(--chat-accent) 76%, #ffffff 6%)",
  50,
  "color-mix(in srgb, var(--chat-accent) 58%, #4c1d95 42%)",
  { color: "#7c3aed", accentWeight: 0.6 },
);

/** Codex/OpenAI's near-white accent is tempered with muted violet. */
const CHAT_USER_BUBBLE_GRADIENT_LIGHT = bubbleGradient(
  "color-mix(in srgb, var(--chat-accent) 24%, #575065 76%)",
  50,
  "color-mix(in srgb, var(--chat-accent) 16%, #493560 84%)",
  { color: "#6d4c9a", accentWeight: 0.18 },
);

/**
 * Accents that retain the established violet gradient family.
 *
 * Those stops mix toward a fixed violet, which is why a newly-coloured
 * provider could not read as its own colour. Claude keeps the original fill;
 * Codex uses its softer variant above.
 */
const ACCENTS_KEEPING_ORIGINAL_BUBBLE = new Set(
  [PROVIDER_CHAT_ACCENTS.claude, PROVIDER_CHAT_ACCENTS.codex].map((hex) => hex!.toLowerCase()),
);

/**
 * Every other provider shades from its own accent.
 *
 * Mixing toward a fixed violet meant two runtimes with different accents came
 * out the same purple; deriving the stops from `--chat-accent` is what makes a
 * per-provider colour visible as that colour.
 */
const CHAT_USER_BUBBLE_GRADIENT_ACCENT = bubbleGradient(
  "color-mix(in srgb, var(--chat-accent) 88%, #ffffff 12%)",
  52,
  "color-mix(in srgb, var(--chat-accent) 84%, #000000 16%)",
);

/**
 * Near-black accents (Cursor, Pi) — lift instead of deepen, or the bubble
 * disappears into the transcript background and stops reading as a bubble.
 */
const CHAT_USER_BUBBLE_GRADIENT_DEEP = bubbleGradient(
  "color-mix(in srgb, var(--chat-accent) 74%, #ffffff 26%)",
  52,
  "var(--chat-accent)",
  { color: "#ffffff", accentWeight: 0.86 },
);

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/** Keep the gradient's midpoint unless white message text needs a darker fill. */
function solidBubbleColor(midpoint: Rgb): string {
  if (contrastRatio(WHITE, midpoint) >= WCAG_AA_TEXT_CONTRAST) return toHex(midpoint);
  let low = 0;
  let high = 1;
  // Find the lightest readable mix to within one percentage point.
  for (let step = 0; step < 7; step++) {
    const weight = (low + high) / 2;
    if (contrastRatio(WHITE, mixColors(midpoint, BLACK, weight)) >= WCAG_AA_TEXT_CONTRAST) {
      low = weight;
    } else {
      high = weight;
    }
  }
  return toHex(mixColors(midpoint, BLACK, low));
}

function bubbleFillVars(accent: string, gradient: ReturnType<typeof bubbleGradient>): CSSProperties {
  return {
    ["--chat-user-bubble-gradient" as string]: gradient.background,
    ["--chat-user-bubble-solid" as string]: solidBubbleColor(gradient.midpoint(parseColor(accent)!)),
  };
}

/** Provider-colored chrome (default) — former “standard” lane accent strength. */
function coloredChatSurfaceVars(mode: ChatSurfaceMode, accentColor?: string | null): CSSProperties {
  const accent = resolveChatSurfaceAccent(mode, accentColor);
  const m = 1;
  const light = isLightChatAccent(accent);
  const deep = isDeepChatAccent(accent);
  const keepsOriginal = ACCENTS_KEEPING_ORIGINAL_BUBBLE.has(accent.toLowerCase());
  const gradient = keepsOriginal
    ? (light ? CHAT_USER_BUBBLE_GRADIENT_LIGHT : CHAT_USER_BUBBLE_GRADIENT_DEFAULT)
    : deep ? CHAT_USER_BUBBLE_GRADIENT_DEEP : CHAT_USER_BUBBLE_GRADIENT_ACCENT;
  return {
    ["--chat-user-border-accent-mix" as string]: light ? "22%" : deep ? "46%" : "28%",
    ["--chat-user-shadow-accent-mix" as string]: light ? "28%" : deep ? "44%" : "34%",
    ...bubbleFillVars(accent, gradient),
    ...sharedSurfaceTokens(accent, m),
  };
}

/** Monochrome chat — gray accent token, reduced glow (Slack-style base). */
function neutralChatSurfaceVars(): CSSProperties {
  const accent = NEUTRAL_CHROME_ACCENT;
  const m = 0.85;
  return {
    ["--chat-user-border-accent-mix" as string]: "20%",
    ["--chat-user-shadow-accent-mix" as string]: "24%",
    ...bubbleFillVars(accent, CHAT_USER_BUBBLE_GRADIENT_DEFAULT),
    ...sharedSurfaceTokens(accent, m),
  };
}

export function chatSurfaceVars(
  mode: ChatSurfaceMode,
  accentColor?: string | null,
  options?: { chromeTint?: ChatChromeTint },
): CSSProperties {
  const tint = options?.chromeTint ?? "colored";
  if (tint === "neutral") return neutralChatSurfaceVars();
  return coloredChatSurfaceVars(mode, accentColor);
}

export function chatChipToneClass(tone: ChatSurfaceChipTone = "accent"): string {
  return CHIP_TONE_STYLES[tone];
}
