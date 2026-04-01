// ---------------------------------------------------------------------------
// Shared permission option definitions — used by both chat composer and
// mission dialog to keep per-provider permission UIs in sync.
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
        detail: "Run this long-lived identity with the active backend's default operating mode. The agent keeps its memory and session continuity, but sensitive actions still respect the provider's normal safety checks.",
        allows: ["Persistent memory and session continuity", "Normal model/tool access for this identity"],
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
        value: "plan",
        label: "Plan",
        shortDesc: "Propose-only \u2014 approval required for everything",
        detail: "Read-only sandbox with untrusted approval policy. Codex explores and proposes; every shell command and file patch requires your go-ahead before it runs.",
        allows: ["File exploration", "Code search", "Plan generation"],
        gates: ["All shell commands (shell tool)", "All file patches (apply_patch)", "All plan updates (update_plan)"],
        safety: "safe",
      },
      {
        value: "edit",
        label: "Guarded edit",
        shortDesc: "Writable sandbox with approval on failures",
        detail: "Workspace-write sandbox with approval policy set to on-failure. Codex can edit files and run commands autonomously inside the worktree, but escalations and sandbox failures still stop for approval.",
        allows: ["File reads", "File writes & patches", "Shell commands in workspace-write sandbox"],
        gates: ["Escalations after sandbox failure", "Operations that exceed workspace sandbox"],
        safety: "semi-auto",
      },
      {
        value: "full-auto",
        label: "Full auto",
        shortDesc: "Unrestricted \u2014 skips all approval prompts",
        detail: "Danger-full-access sandbox, approval policy: never. Codex runs shell commands and applies patches without interruption. No filesystem or network restrictions.",
        allows: ["shell \u2014 unrestricted", "apply_patch \u2014 unrestricted", "Network access"],
        warning: "\u26a0 Removes all sandboxing. Only safe in trusted, isolated environments.",
        safety: "danger",
      },
      {
        value: "config-toml",
        label: "Custom",
        shortDesc: "No flags passed \u2014 uses config.toml",
        detail: "No --approval-policy or --sandbox flags are passed to the Codex runtime. Runtime behavior is controlled by Codex config files (for example, ~/.codex/config.toml).",
        allows: ["Determined by config.toml"],
        gates: [],
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
 * MissionProviderPermissions ("claude" | "codex" | "unified").
 *
 * Only CLI-wrapped anthropic → "claude" and CLI-wrapped openai → "codex".
 * All API / local models (even anthropic-api or openai-api) use "unified".
 */
export function familyToPermissionKey(family: string, isCliWrapped: boolean): "claude" | "codex" | "unified" | "cursor" {
  if (isCliWrapped) {
    if (family === "anthropic") return "claude";
    if (family === "openai") return "codex";
    if (family === "cursor") return "cursor";
  }
  return "unified";
}

/** Human-readable label for a permission family key */
export function permissionFamilyLabel(key: "claude" | "codex" | "cursor" | "unified"): string {
  switch (key) {
    case "claude": return "Claude Code workers";
    case "codex": return "Codex workers";
    case "cursor": return "Cursor workers";
    case "unified": return "API / Local model workers";
  }
}
