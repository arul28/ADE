import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { AdeCodeProvider } from "./types";
import type { RenderedChatLine } from "./format";

/**
 * Centralised design tokens for the ade-code TUI.
 *
 * Tokens mirror the Claude Design wireframe terminal.css 1:1 so the TUI looks
 * like the same family as the desktop app and the design mockups.
 */

// Surfaces / borders
const SURFACE_1 = "#16141E";
const BORDER = "#302C42";
const BORDER_ACTIVE = "#38334E";
const BORDER_SOFT = "#211E2E";

// Text levels
const T1 = "#F0F0F2";
const T2 = "#A8A8B4";
const T3 = "#908FA0";
const T4 = "#6B6A7A";
const T5 = "#4A4955";

// Brand violet family
const VIOLET = "#A78BFA";
const VIOLET_DEEP = "#7C3AED";

// Status family
const RUNNING = "#22C55E";
const ATTENTION = "#F59E0B";
const ATTENTION_2 = "#FBBF24";
const INFO = "#3B82F6";
const ERROR = "#EF4444";
const DONE = "#22C55E";
const WARNING = ATTENTION;
const DANGER = ERROR;

// Provider brand colors (used both by FooterControls.tsx via `theme.color.*`
// and by the per-provider glyph chips in PROVIDER_THEME below).
const CLAUDE = "#D97757";
const CODEX = "#22C55E";
const CURSOR = "#0EA5E9";
const OPENCODE = "#6366F1";
const DROID = "#06B6D4";
const SHELL = "#F59E0B";
const COPILOT = "#A855F7";

const TOOL = "cyan";
const REASONING = T4;
const NOTICE = T3;
const APPROVAL = ATTENTION;

export type Tone = RenderedChatLine["tone"];

const TONE_COLORS: Record<Tone, string> = {
  user: VIOLET,
  assistant: T1,
  tool: TOOL,
  error: ERROR,
  notice: NOTICE,
  reasoning: REASONING,
  approval: APPROVAL,
};

type ProviderTheme = {
  glyph: string;
  wordmark: string;
  color: string;
  label: string;
};

const PROVIDER_THEME: Record<AdeCodeProvider, ProviderTheme> = {
  claude: { glyph: "◆", wordmark: "Claude", color: CLAUDE, label: "Claude" },
  codex: { glyph: "◇", wordmark: "Codex", color: CODEX, label: "Codex" },
  cursor: { glyph: "▲", wordmark: "Cursor", color: CURSOR, label: "Cursor" },
  droid: { glyph: "▣", wordmark: "Droid", color: DROID, label: "Droid" },
  opencode: { glyph: "◈", wordmark: "OpenCode", color: OPENCODE, label: "OpenCode" },
};

const FALLBACK_PROVIDER: ProviderTheme = { glyph: "•", wordmark: "Agent", color: T4, label: "Agent" };

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

// Lane / agent status semantics used across drawer, lane-details, agents pane.
export type LaneStatusKind = "running" | "attention" | "idle" | "failed" | "primary";

const LANE_STATUS_COLOR: Record<LaneStatusKind, string> = {
  running: RUNNING,
  attention: ATTENTION,
  idle: T4,
  failed: ERROR,
  primary: VIOLET,
};

export function laneStatusColor(kind: LaneStatusKind): string {
  return LANE_STATUS_COLOR[kind] ?? T4;
}

// Agent status semantics inside the agents pane (Subagents / Teammates).
export type AgentStatusKind = "running" | "ok" | "waiting" | "error";

const AGENT_STATUS_COLOR: Record<AgentStatusKind, string> = {
  running: RUNNING,
  ok: T3,
  waiting: ATTENTION,
  error: ERROR,
};

const AGENT_STATUS_GLYPH: Record<AgentStatusKind, string> = {
  running: "●",
  ok: "✓",
  waiting: "◐",
  error: "✗",
};

export function agentStatusColor(kind: AgentStatusKind): string {
  return AGENT_STATUS_COLOR[kind] ?? T3;
}

export function agentStatusGlyph(kind: AgentStatusKind): string {
  return AGENT_STATUS_GLYPH[kind] ?? "○";
}

// Status rail glyph (left vertical bar) used in drawer rows + agents pane selected row.
const RAIL_GLYPH = "▎";

export const theme = {
  color: {
    // Brand
    accent: VIOLET,
    accentDim: VIOLET_DEEP,
    violet: VIOLET,
    violetDeep: VIOLET_DEEP,

    // Text
    fg: T1,
    t1: T1,
    t2: T2,
    t3: T3,
    t4: T4,
    t5: T5,
    mutedFg: T3,

    // Surfaces / borders
    surface1: SURFACE_1,
    border: BORDER,
    borderActive: BORDER_ACTIVE,
    borderSoft: BORDER_SOFT,
    borderFocused: VIOLET,

    // Status
    running: RUNNING,
    attention: ATTENTION,
    attention2: ATTENTION_2,
    info: INFO,
    error: ERROR,
    done: DONE,
    warning: WARNING,
    danger: DANGER,

    // Executors (used by FooterControls / palettes)
    shell: SHELL,
    copilot: COPILOT,

    // Misc
    tool: TOOL,
  },
  tone(tone: Tone): string {
    return TONE_COLORS[tone] ?? T1;
  },
  provider(provider: AdeCodeProvider | null | undefined): ProviderTheme {
    if (!provider) return FALLBACK_PROVIDER;
    return PROVIDER_THEME[provider] ?? FALLBACK_PROVIDER;
  },
  lane(lane: LaneSummary | null | undefined): string {
    return lane?.color || VIOLET;
  },
  laneStatusColor,
  agentStatusColor,
  agentStatusGlyph,
  rail: RAIL_GLYPH,
} as const;
