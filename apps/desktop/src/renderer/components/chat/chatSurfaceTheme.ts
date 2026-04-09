import type { CSSProperties } from "react";
import type { ChatSurfaceChipTone, ChatSurfaceMode } from "../../../shared/types";

export const CHAT_SURFACE_ACCENTS: Record<ChatSurfaceMode, string> = {
  standard: "#71717A",
  resolver: "#F97316",
  "mission-thread": "#38BDF8",
  "mission-feed": "#22C55E",
};

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

export function chatSurfaceVars(mode: ChatSurfaceMode, accentColor?: string | null): CSSProperties {
  const accent = resolveChatSurfaceAccent(mode, accentColor);
  return {
    ["--chat-accent" as string]: accent,
    ["--chat-accent-soft" as string]: colorToRgba(accent, 0.14),
    ["--chat-accent-faint" as string]: colorToRgba(accent, 0.08),
    ["--chat-accent-glow" as string]: colorToRgba(accent, 0.28),
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

export function chatChipToneClass(tone: ChatSurfaceChipTone = "accent"): string {
  return CHIP_TONE_STYLES[tone];
}
