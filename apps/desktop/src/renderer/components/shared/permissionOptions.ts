// ---------------------------------------------------------------------------
// Shared permission option definitions used by chat, PR resolver, and
// automation UIs to keep per-provider permission choices in sync.
// ---------------------------------------------------------------------------

import type { AgentChatPermissionMode, ChatSurfaceProfile } from "../../../shared/types";

export type SafetyLevel = "safe" | "semi-auto" | "full-auto" | "danger" | "custom";

export type PermissionOption = {
  value: AgentChatPermissionMode;
  label: string;
  shortDesc: string;
  detail: string;
  allows: string[];
  gates?: string[];
  blocks?: string[];
  warning?: string;
  safety: SafetyLevel;
};

function normalizePermissionFamily(family: string): string {
  if (family === "claude") return "anthropic";
  if (family === "codex") return "openai";
  return family;
}

export function resolvePersistentIdentityGuardedPermissionMode(opts: {
  family: string;
  isCliWrapped: boolean;
}): AgentChatPermissionMode {
  const family = normalizePermissionFamily(opts.family);
  return opts.isCliWrapped && family === "anthropic" ? "default" : "edit";
}

export function normalizePermissionModeForProfile(opts: {
  profile?: ChatSurfaceProfile;
  family: string;
  isCliWrapped: boolean;
  mode?: AgentChatPermissionMode;
}): AgentChatPermissionMode {
  if (opts.profile !== "persistent_identity") {
    return opts.mode ?? "plan";
  }
  if (opts.mode === "full-auto") {
    return "full-auto";
  }
  return resolvePersistentIdentityGuardedPermissionMode(opts);
}

/**
 * Return the list of permission options appropriate for a given model family.
 *
 * @param opts.family   - ProviderFamily string (e.g. "anthropic", "openai", …)
 * @param opts.isCliWrapped - whether the model is invoked through a CLI wrapper
 */
export function getPermissionOptions(opts: {
  family: string;
  isCliWrapped: boolean;
  profile?: ChatSurfaceProfile;
}): PermissionOption[] {
  if (opts.profile === "persistent_identity") {
    const guardedMode = resolvePersistentIdentityGuardedPermissionMode(opts);
    return [
      {
        value: guardedMode,
        label: "Default",
        shortDesc: "Persistent session with the backend's default guardrails",
        detail: "Run this long-lived identity with the active backend's default operating mode. The agent keeps session continuity, but sensitive actions still respect the provider's normal safety checks.",
        allows: ["Persistent session continuity", "Normal model/tool access for this identity"],
        gates: ["Sensitive writes or commands according to the active backend"],
        safety: "semi-auto",
      },
      {
        value: "full-auto",
        label: "Full Access",
        shortDesc: "Persistent session with full tool access",
        detail: "Run this long-lived identity with full access. This is the trusted persistent-operator mode for a project operator that can work continuously without per-action permission prompts.",
        allows: ["All configured tools for this session", "Model switches that follow the surface's chat policy while keeping the same identity"],
        warning: "Use this when you want the agent to operate as a trusted persistent teammate.",
        safety: "danger",
      },
    ];
  }

  // Claude CLI models (anthropic)
  if (opts.isCliWrapped && opts.family === "anthropic") {
    return [
      {
        value: "default",
        label: "Default",
        shortDesc: "Prompts before each tool type on first use",
        detail: "Standard behavior. Read operations are free; writes, edits, and Bash commands require your approval on first use per session.",
        allows: ["File reads", "Grep / Glob / LS", "Plan generation"],
        gates: ["File writes & edits", "Bash commands", "WebFetch / WebSearch", "Subagent (Task) spawning"],
        safety: "safe",
      },
      {
        value: "auto",
        label: "Auto",
        shortDesc: "Claude judges each tool call",
        detail: "Claude judges each tool call. Uses a model classifier instead of asking you.",
        allows: ["Claude-classified safe tool calls"],
        gates: ["Tool calls Claude classifies as needing review"],
        safety: "semi-auto",
      },
      {
        value: "edit",
        label: "Accept Edits",
        shortDesc: "File ops auto-approved; shell still gates",
        detail: "Read, Write, Edit, and MultiEdit are auto-approved for the session. Bash, WebFetch, and Task spawning still require manual approval on first invocation.",
        allows: ["File reads", "File writes & edits", "Grep / Glob / LS"],
        gates: ["Bash commands", "WebFetch / WebSearch", "Subagent (Task) spawning"],
        safety: "semi-auto",
      },
      {
        value: "plan",
        label: "Plan",
        shortDesc: "Read-only — no writes or shell execution",
        detail: "Analysis-only mode. Claude can read files, search the codebase, and produce an implementation plan — but cannot write, edit, or execute any commands.",
        allows: ["Read", "Grep", "Glob", "LS"],
        blocks: ["Write", "Edit", "Bash", "WebFetch", "Task"],
        safety: "safe",
      },
      {
        value: "full-auto",
        label: "Bypass",
        shortDesc: "All permission checks disabled",
        detail: "Every tool across all 16 Claude Code tools runs without prompting. No interruptions. Designed for containerized or fully sandboxed CI environments.",
        allows: ["All 16 tools \u2014 unrestricted"],
        warning: "\u26a0 Only safe in containers, VMs, or sandboxed environments where actions can be reverted.",
        safety: "danger",
      },
    ];
  }

  // Codex CLI (openai)
  if (opts.isCliWrapped && opts.family === "openai") {
    return [
      {
        value: "default",
        label: "Default permissions",
        shortDesc: "Codex's default permission preset",
        detail: "Workspace-write sandbox with approval policy set to on-request. Codex can read, edit, and run commands in the workspace; it asks before editing outside the workspace or accessing network.",
        allows: ["File reads", "File writes & patches inside the workspace", "Shell commands in workspace-write sandbox"],
        gates: ["Edits outside the workspace", "Network access"],
        safety: "semi-auto",
      },
      {
        value: "plan",
        label: "Plan mode",
        shortDesc: "Safe read-only browsing",
        detail: "Read-only sandbox with approval policy set to on-request. Codex can read files and answer questions, but needs approval to make edits, run commands, or access network.",
        allows: ["File exploration", "Code search", "Plan generation"],
        gates: ["File writes & patches", "Shell commands", "Network access"],
        safety: "safe",
      },
      {
        value: "full-auto",
        label: "Full access",
        shortDesc: "Unrestricted \u2014 skips all approval prompts",
        detail: "No sandbox and no approvals. Codex runs shell commands and applies patches without interruption. Use only in an externally sandboxed environment.",
        allows: ["shell \u2014 unrestricted", "apply_patch \u2014 unrestricted", "Network access"],
        warning: "\u26a0 Removes all sandboxing. Only safe in trusted, isolated environments.",
        safety: "danger",
      },
      {
        value: "config-toml",
        label: "Custom (config.toml)",
        shortDesc: "No flags passed \u2014 uses config.toml",
        detail: "No --approval-policy or --sandbox flags are passed to the Codex runtime. Runtime behavior is controlled by Codex config files (for example, ~/.codex/config.toml).",
        allows: ["Determined by config.toml"],
        gates: [],
        safety: "custom",
      },
    ];
  }

  // Factory Droid CLI
  if (opts.isCliWrapped && opts.family === "factory") {
    return [
      {
        value: "plan",
        label: "Read-only",
        shortDesc: "Droid without autonomy",
        detail: "Launches Droid without --auto. Best for inspection, planning, and low-risk review work.",
        allows: ["File reads", "Code search", "Plan generation"],
        gates: ["File writes", "Shell commands"],
        safety: "safe",
      },
      {
        value: "edit",
        label: "Auto low",
        shortDesc: "Droid with --auto low",
        detail: "Allows safe file edits and non-destructive operations while keeping Droid on its lower-risk autonomy tier.",
        allows: ["File reads", "File writes in project scope"],
        gates: ["Higher-risk operations per Droid policy"],
        safety: "semi-auto",
      },
      {
        value: "default",
        label: "Auto medium",
        shortDesc: "Droid with --auto medium",
        detail: "Allows local development operations such as package installs, builds, tests, and local git commands.",
        allows: ["Project file edits", "Builds and tests", "Local development commands"],
        gates: ["Production changes", "sudo", "git push", "Sensitive operations"],
        safety: "semi-auto",
      },
      {
        value: "full-auto",
        label: "Auto high",
        shortDesc: "Droid with --auto high",
        detail: "Highest normal Droid autonomy tier for broad automation. This does not use --skip-permissions-unsafe.",
        allows: ["Broader tool and command access per Droid policy"],
        warning: "\u26a0 Review Droid permissions and Factory docs before enabling.",
        safety: "danger",
      },
    ];
  }

  // Cursor Agent CLI
  if (opts.isCliWrapped && opts.family === "cursor") {
    return [
      {
        value: "default",
        label: "Agent",
        shortDesc: "Cursor Agent's normal approval flow",
        detail: "Starts Cursor Agent in its default coding mode. The CLI asks before terminal commands and follows Cursor's configured workspace policy.",
        allows: ["File reads", "Edits through Cursor Agent", "Command proposals with approval"],
        gates: ["Terminal commands unless allowed by Cursor policy"],
        safety: "semi-auto",
      },
      {
        value: "plan",
        label: "Plan",
        shortDesc: "Read-only planning mode",
        detail: "Starts Cursor Agent with --mode plan for analysis and planning without edits.",
        allows: ["Code search", "File reads", "Plan generation"],
        blocks: ["File edits", "Command execution"],
        safety: "safe",
      },
      {
        value: "edit",
        label: "Ask",
        shortDesc: "Read-only Q&A mode",
        detail: "Starts Cursor Agent with --mode ask for explanations and questions without code changes.",
        allows: ["Questions", "Explanations", "Read-only context use"],
        blocks: ["File edits", "Command execution"],
        safety: "safe",
      },
      {
        value: "full-auto",
        label: "Force",
        shortDesc: "Cursor --force / yolo mode",
        detail: "Starts Cursor Agent with --force so commands are allowed unless explicitly denied by Cursor policy.",
        allows: ["Edits and commands allowed by Cursor policy"],
        warning: "Use only when you trust the lane and Cursor workspace policy.",
        safety: "danger",
      },
    ];
  }

  // OpenCode CLI
  if (opts.isCliWrapped && opts.family === "opencode") {
    return [
      {
        value: "default",
        label: "Ask",
        shortDesc: "Ask before tool actions",
        detail: "Starts OpenCode with an inline permission policy that asks before tool actions.",
        allows: ["Reads and tool calls after approval"],
        gates: ["Bash, edits, and other tools"],
        safety: "safe",
      },
      {
        value: "plan",
        label: "Plan",
        shortDesc: "OpenCode plan agent",
        detail: "Starts OpenCode in its plan agent, which disables write, edit, patch, and bash tools by default.",
        allows: ["Read-only analysis", "Plan generation"],
        blocks: ["File writes", "Edits", "Patch application", "Shell commands"],
        safety: "safe",
      },
      {
        value: "edit",
        label: "Edit",
        shortDesc: "Allow edits; ask for the rest",
        detail: "Starts OpenCode with edit permission allowed while other tool actions still ask.",
        allows: ["File edits"],
        gates: ["Bash and other tools"],
        safety: "semi-auto",
      },
      {
        value: "full-auto",
        label: "Allow",
        shortDesc: "Allow configured OpenCode tools",
        detail: "Starts OpenCode with inline permission set to allow. OpenCode still respects explicit denies in agent or project configuration.",
        allows: ["Configured OpenCode tools without prompts"],
        warning: "Only use in trusted or isolated lanes.",
        safety: "danger",
      },
      {
        value: "config-toml",
        label: "Config",
        shortDesc: "Use OpenCode config",
        detail: "No inline permission environment is passed. OpenCode uses opencode.json and your global configuration.",
        allows: ["Determined by OpenCode config"],
        safety: "custom",
      },
    ];
  }

  // API and local models
  return [
    {
      value: "plan",
      label: "Supervised",
      shortDesc: "Agent requests approval before any file edits or commands",
      detail: "Safest mode for API/local models \u2014 every modification requires your go-ahead before execution.",
      allows: ["File reads", "Code search", "Plan generation"],
      gates: ["File writes & edits", "Bash commands", "Web access", "Agent spawning"],
      safety: "safe",
    },
    {
      value: "edit",
      label: "Auto-Edit",
      shortDesc: "File reads and edits auto-approved; commands need approval",
      detail: "Agent modifies files autonomously but pauses for shell commands, web fetches, and subagent spawning.",
      allows: ["File reads", "File writes & edits", "Code search"],
      gates: ["Bash commands", "Web access", "Agent spawning"],
      safety: "semi-auto",
    },
    {
      value: "full-auto",
      label: "Full Auto",
      shortDesc: "Fully autonomous across all operations \u2014 no interruptions",
      detail: "Agent proceeds without prompting across reads, edits, commands, and web. Recommended only in sandboxed environments.",
      allows: ["Everything"],
      warning: "\u26a0 Only use in isolated/containerized environments.",
      safety: "danger",
    },
  ];
}

export function safetyBadgeLabel(safety: SafetyLevel): string {
  switch (safety) {
    case "safe": return "SAFE";
    case "semi-auto": return "SEMI-AUTO";
    case "full-auto": return "FULL-AUTO";
    case "danger": return "DANGER";
    case "custom": return "CUSTOM";
  }
}

export function safetyColorHex(safety: SafetyLevel): string {
  switch (safety) {
    case "safe": return "#22C55E";
    case "semi-auto": return "#F59E0B";
    case "full-auto":
    case "danger": return "#EF4444";
    case "custom": return "#8B5CF6";
  }
}

/** Tailwind-based color classes — used by chat composer hover pane. */
export function safetyColors(safety: SafetyLevel) {
  switch (safety) {
    case "safe":
      return {
        border: "border-l-emerald-500/60",
        badge: "text-emerald-400/70",
        activeBg: "bg-accent/15 ring-1 ring-accent/25",
      };
    case "semi-auto":
      return {
        border: "border-l-amber-400/60",
        badge: "text-amber-400/70",
        activeBg: "bg-amber-500/10 ring-1 ring-amber-400/20",
      };
    case "full-auto":
      return {
        border: "border-l-red-400/60",
        badge: "text-red-400/70",
        activeBg: "bg-red-500/8 ring-1 ring-red-500/20",
      };
    case "danger":
      return {
        border: "border-l-red-500/70",
        badge: "text-red-400/80",
        activeBg: "bg-red-500/8 ring-1 ring-red-500/20",
      };
    case "custom":
      return {
        border: "border-l-violet-500/60",
        badge: "text-violet-400/70",
        activeBg: "bg-accent/15 ring-1 ring-accent/25",
      };
  }
}

/**
 * Map a ProviderFamily string to the permission-family key used by
 * provider permission config ("claude" | "codex" | "cursor" | "droid" | "opencode").
 *
 * Only CLI-wrapped anthropic → "claude" and CLI-wrapped openai → "codex".
 * All API / local models (even anthropic-api or openai-api) use "opencode".
 */
export function familyToPermissionKey(
  family: string,
  isCliWrapped: boolean,
): "claude" | "codex" | "cursor" | "droid" | "opencode" {
  if (isCliWrapped) {
    if (family === "anthropic") return "claude";
    if (family === "openai") return "codex";
    if (family === "cursor") return "cursor";
    if (family === "factory") return "droid";
  }
  return "opencode";
}

/** Human-readable label for a permission family key */
export function permissionFamilyLabel(key: "claude" | "codex" | "cursor" | "droid" | "opencode"): string {
  switch (key) {
    case "claude": return "Claude Code workers";
    case "codex": return "Codex workers";
    case "cursor": return "Cursor workers";
    case "droid": return "Droid workers";
    case "opencode": return "OpenCode workers";
  }
}
