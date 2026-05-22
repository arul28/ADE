import type { CSSProperties } from "react";
import type { ChatChromeTint } from "../../state/appStore";
import type { ChatSurfaceChipTone, ChatSurfaceMode } from "../../../shared/types";

export const CHAT_SURFACE_ACCENTS: Record<ChatSurfaceMode, string> = {
  standard: "#71717A",
  resolver: "#F97316",
  "mission-thread": "#38BDF8",
  "mission-feed": "#22C55E",
  orchestrator: "#8B5CF6",
};

/// Per-provider chat-surface accent. Keeps Claude/Codex/etc. visually
/// consistent across desktop and mobile — Claude is always amber, Codex always
/// warm-white, regardless of which model variant is selected. Falls back to
/// the model's own registry color when the provider isn't in the table.
/// Mirror this map in `apps/ios/ADE/Views/Components/ADEDesignSystem.swift`
/// (`providerChatAccents`).
export const PROVIDER_CHAT_ACCENTS: Record<string, string> = {
  claude: "#D97706",
  anthropic: "#D97706",
  codex: "#E7E5E4",
  openai: "#E7E5E4",
  cursor: "#A78BFA",
  opencode: "#2563EB",
  google: "#F59E0B",
  gemini: "#F59E0B",
  mistral: "#F97316",
  deepseek: "#3B82F6",
  xai: "#DC2626",
  grok: "#DC2626",
  groq: "#06B6D4",
};

/// Look up the unified chat accent for a provider id ("claude", "codex",
/// "anthropic", …). Returns null when the provider isn't recognized so callers
/// can fall back to per-model color.
export function providerChatAccent(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const key = provider.trim().toLowerCase();
  return PROVIDER_CHAT_ACCENTS[key] ?? null;
}

const CHIP_TONE_STYLES: Record<ChatSurfaceChipTone, string> = {
  accent: "border-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_88%,white_12%)]",
  success: "border-emerald-400/15 bg-emerald-500/6 text-emerald-300",
  warning: "border-amber-400/15 bg-amber-500/6 text-amber-300",
  danger: "border-red-400/15 bg-red-500/6 text-red-300",
  info: "border-sky-400/15 bg-sky-500/6 text-sky-300",
  muted: "border-white/[0.06] bg-white/[0.03] text-fg/50",
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
  return trimmed?.length ? normalizeHex(trimmed) : CHAT_SURFACE_ACCENTS[mode];
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

function isLightChatAccent(accent: string): boolean {
  const normalized = normalizeHex(accent);
  const r = hexChannel(normalized.slice(1, 3));
  const g = hexChannel(normalized.slice(3, 5));
  const b = hexChannel(normalized.slice(5, 7));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72;
}

const CHAT_USER_BUBBLE_GRADIENT_DEFAULT =
  "linear-gradient(135deg, color-mix(in srgb, var(--chat-accent) 76%, #ffffff 6%) 0%, color-mix(in srgb, var(--chat-accent) 60%, #7c3aed 40%) 50%, color-mix(in srgb, var(--chat-accent) 58%, #4c1d95 42%) 100%)";

/** Codex/OpenAI and other very light accents — pull the highlight stop down slightly. */
const CHAT_USER_BUBBLE_GRADIENT_LIGHT =
  "linear-gradient(135deg, color-mix(in srgb, var(--chat-accent) 74%, #78716c 10%) 0%, color-mix(in srgb, var(--chat-accent) 58%, #7c3aed 42%) 50%, color-mix(in srgb, var(--chat-accent) 56%, #4c1d95 44%) 100%)";

/** Provider-colored chrome (default) — former “standard” lane accent strength. */
function coloredChatSurfaceVars(mode: ChatSurfaceMode, accentColor?: string | null): CSSProperties {
  const accent = resolveChatSurfaceAccent(mode, accentColor);
  const m = 1;
  const light = isLightChatAccent(accent);
  return {
    ["--chat-user-border-accent-mix" as string]: light ? "22%" : "28%",
    ["--chat-user-shadow-accent-mix" as string]: light ? "28%" : "34%",
    ["--chat-user-bubble-gradient" as string]: light
      ? CHAT_USER_BUBBLE_GRADIENT_LIGHT
      : CHAT_USER_BUBBLE_GRADIENT_DEFAULT,
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
    ["--chat-user-bubble-gradient" as string]: CHAT_USER_BUBBLE_GRADIENT_DEFAULT,
    ...sharedSurfaceTokens(accent, m),
  };
}

/** Rainbow orchestrator accent tokens — used for Work-tab orchestrator chats. */
export function orchestratorSurfaceVars(): CSSProperties {
  const accent = CHAT_SURFACE_ACCENTS.orchestrator;
  return {
    ...coloredChatSurfaceVars("orchestrator", accent),
    ["--chat-orchestrator-ring" as string]: "conic-gradient(from 0deg, #f472b6, #fb923c, #facc15, #4ade80, #38bdf8, #a78bfa, #f472b6)",
    ["--chat-orchestrator-glow" as string]: colorToRgba(accent, 0.24),
  };
}

export function chatSurfaceVars(
  mode: ChatSurfaceMode,
  accentColor?: string | null,
  options?: { chromeTint?: ChatChromeTint },
): CSSProperties {
  const tint = options?.chromeTint ?? "colored";
  if (mode === "orchestrator") return orchestratorSurfaceVars();
  if (tint === "neutral") return neutralChatSurfaceVars();
  return coloredChatSurfaceVars(mode, accentColor);
}

export function chatChipToneClass(tone: ChatSurfaceChipTone = "accent"): string {
  return CHIP_TONE_STYLES[tone];
}
