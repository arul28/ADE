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
// Darker violets used for the wordmark's layered 3D drop shadow.
const VIOLET_DEEPER = "#5B21B6";
const VIOLET_DEEPEST = "#3B1675";

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
// and by the per-provider glyph chips in PROVIDER_THEME below). These mirror the
// model picker's brand marks (PROVIDER_MARKS in ModelPickerPane.tsx) 1:1 so the
// glyph + color you see beside a chat in the drawer matches the one in the
// picker — no more bespoke/off-brand provider marks.
const CLAUDE = "#D97757";
const CODEX = "#F0F0F2";
const CURSOR = "#0EA5E9";
const OPENCODE = "#F0F0F2";
const PI = "#F97316";
const DROID = "#06B6D4";
const OLLAMA = "#F0F0F2";
const LMSTUDIO = "#8B5CF6";
const SHELL = "#F59E0B";
const COPILOT = "#A855F7";

const TOOL = "cyan";
const REASONING = T4;
const NOTICE = T3;
const APPROVAL = ATTENTION;

// Plan-mode signal color (used by the prompt border tint, the provider glyph
// tint, and the persistent plan-mode banner when permission mode === plan).
const PLAN_MODE = "#22D3EE";

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

// Provider brand glyphs: the exact terminal-fallback marks the model picker
// uses (PROVIDER_MARKS / ROW_MARKS in ModelPickerPane.tsx). `✻` (U+273B) is
// Anthropic's canonical sparkle; `◎` is OpenAI's mark for Codex; `⬢`/`✺` map to
// Cursor/Droid. Keeping these in sync with the picker means a lane's runtime is
// shown with the same brand glyph everywhere in the TUI.
const PROVIDER_THEME: Record<AdeCodeProvider, ProviderTheme> = {
  claude: { glyph: "✻", wordmark: "Claude", color: CLAUDE, label: "Claude" },
  codex: { glyph: "◎", wordmark: "Codex", color: CODEX, label: "Codex" },
  cursor: { glyph: "⬢", wordmark: "Cursor", color: CURSOR, label: "Cursor" },
  droid: { glyph: "✺", wordmark: "Droid", color: DROID, label: "Droid" },
  opencode: { glyph: "▣", wordmark: "OpenCode", color: OPENCODE, label: "OpenCode" },
  pi: { glyph: "◈", wordmark: "Pi", color: PI, label: "Pi" },
  ollama: { glyph: "◕", wordmark: "Ollama", color: OLLAMA, label: "Ollama" },
  lmstudio: { glyph: "≋", wordmark: "LM Studio", color: LMSTUDIO, label: "LM Studio" },
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
    violetDeeper: VIOLET_DEEPER,
    violetDeepest: VIOLET_DEEPEST,

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
    planMode: PLAN_MODE,

    // Code highlighting (highlight.js token category → terminal color)
    // Inline `code` uses violet to match the desktop's purple chip styling.
    codeInline: "#A78BFA",
    codeKeyword: "#C792EA",
    codeString: "#C3E88D",
    codeNumber: "#F78C6C",
    codeComment: "#676E95",
    codeFunction: "#82AAFF",
    codeType: "#FFCB6B",
    codeVariable: "#EEFFFF",
    codeTag: "#F07178",
    codeMeta: "#6B6A7A",

    // Subagent / file badges
    subagentRail: "#A78BFA",
    fileBadge: {
      tsx: "#3178C6",
      ts: "#3178C6",
      jsx: "#F7DF1E",
      js: "#F7DF1E",
      json: "#5C5C5C",
      md: "#519ABA",
      py: "#3776AB",
      rs: "#CE412B",
      go: "#00ADD8",
      swift: "#FA7343",
      sh: "#89E051",
      yaml: "#CB171E",
      yml: "#CB171E",
      html: "#E34F26",
      css: "#1572B6",
      sql: "#336791",
      default: "#6B6A7A",
    },
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
