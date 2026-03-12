import type { CSSProperties } from "react";
import type { ChatSurfaceChipTone, ChatSurfaceMode } from "../../../shared/types";

export const CHAT_SURFACE_ACCENTS: Record<ChatSurfaceMode, string> = {
  standard: "#A78BFA",
  resolver: "#F97316",
  "mission-thread": "#38BDF8",
  "mission-feed": "#22C55E",
};

const CHIP_TONE_STYLES: Record<ChatSurfaceChipTone, string> = {
  accent: "border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_88%,white_12%)]",
  success: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-400/30 bg-amber-500/10 text-amber-200",
  danger: "border-red-400/30 bg-red-500/10 text-red-200",
  info: "border-sky-400/30 bg-sky-500/10 text-sky-200",
  muted: "border-border/20 bg-surface-recessed/70 text-fg/55",
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
  return "#A78BFA";
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
  };
}

export function chatChipToneClass(tone: ChatSurfaceChipTone = "accent"): string {
  return CHIP_TONE_STYLES[tone];
}
