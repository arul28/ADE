import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { AdeCodeProvider } from "./types";
import type { RenderedChatLine } from "./format";

/**
 * Centralised design tokens for the ade-code TUI.
 *
 * Mirrors the ADE desktop renderer where it matters: accent #A78BFA (purple),
 * lane.color for lane chips, and per-provider brand colors and glyphs that map
 * the SVG marks used in the desktop ProviderLogos to single-cell BMP glyphs
 * safe for Ink's string-width handling.
 */

const ACCENT = "#A78BFA";
const ACCENT_DIM = "#6D5DBF";
const FG = "white";
const MUTED_FG = "gray";
const SUCCESS = "#22C55E";
const WARNING = "#F59E0B";
const DANGER = "#EF4444";
const TOOL = "cyan";
const REASONING = "gray";
const NOTICE = "gray";
const APPROVAL = "#F59E0B";
const ERROR = DANGER;

export type Tone = RenderedChatLine["tone"];

const TONE_COLORS: Record<Tone, string> = {
  user: ACCENT,
  assistant: FG,
  tool: TOOL,
  error: ERROR,
  notice: NOTICE,
  reasoning: REASONING,
  approval: APPROVAL,
};

type ProviderTheme = {
  glyph: string;
  color: string;
  label: string;
};

const PROVIDER_THEME: Record<AdeCodeProvider, ProviderTheme> = {
  claude: { glyph: "◆", color: "#D97757", label: "Claude" },
  codex: { glyph: "◇", color: "#10A37F", label: "Codex" },
  cursor: { glyph: "▲", color: FG, label: "Cursor" },
  droid: { glyph: "▣", color: "#22D3EE", label: "Droid" },
  opencode: { glyph: "◈", color: ACCENT, label: "OpenCode" },
};

const FALLBACK_PROVIDER: ProviderTheme = { glyph: "•", color: MUTED_FG, label: "Agent" };

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed";

const PLAN_STEP_GLYPH: Record<PlanStepStatus, string> = {
  in_progress: "◐",
  pending: "○",
  completed: "●",
  failed: "✕",
};

export function glyphFor(status: string | null | undefined): string {
  return PLAN_STEP_GLYPH[status as PlanStepStatus] ?? "○";
}

export const theme = {
  color: {
    accent: ACCENT,
    accentDim: ACCENT_DIM,
    fg: FG,
    mutedFg: MUTED_FG,
    notice: NOTICE,
    border: MUTED_FG,
    borderFocused: ACCENT,
    success: SUCCESS,
    warning: WARNING,
    danger: DANGER,
    tool: TOOL,
  },
  tone(tone: Tone): string {
    return TONE_COLORS[tone] ?? FG;
  },
  provider(provider: AdeCodeProvider | null | undefined): ProviderTheme {
    if (!provider) return FALLBACK_PROVIDER;
    return PROVIDER_THEME[provider] ?? FALLBACK_PROVIDER;
  },
  lane(lane: LaneSummary | null | undefined): string {
    return lane?.color || ACCENT;
  },
  glyphFor,
} as const;
