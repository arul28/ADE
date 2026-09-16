// ---------------------------------------------------------------------------
// Permission ladder — one level, every provider.
// ---------------------------------------------------------------------------
//
// Each agent CLI names its autonomy differently: Claude has `plan` through
// `bypassPermissions`, Codex splits the question into an approval policy AND a
// sandbox, Droid counts from `read-only` to `agi`, OpenCode and ACP each have
// their own words. Switching model family therefore used to drop the user
// wherever that family's default happened to sit — you could be on the most
// permissive Claude mode, switch to Droid, and silently land on the most
// cautious one.
//
// This module states the one thing the user actually means — how much the agent
// may do without asking — as four ordered levels, and maps each level onto every
// provider's own vocabulary. Switching family keeps the level.
//
// Two rules keep it honest:
//   - A family that cannot express the exact level gets the NEAREST LOWER one.
//     Rounding up would hand an agent more freedom than the user chose.
//   - The user's exact per-family choice is remembered separately, so returning
//     to Droid restores `agi` even though the ladder itself only knows
//     "full-auto". The ladder decides what an UNVISITED family starts on.

import type {
  AgentChatAcpPermissionMode,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
} from "./types/chat";

/** Ordered from most cautious to most autonomous. The order is the contract. */
export const PERMISSION_LEVELS = ["plan", "ask", "auto-edit", "full-auto"] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export type PermissionLadderFamily =
  | "claude"
  | "codex"
  | "opencode"
  | "droid"
  | "acp"
  | "cursor";

export function permissionLevelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

/**
 * What each family does at each level. A family that genuinely lacks a level
 * maps it to `null`, and `resolvePermissionLevel` then steps DOWN the ladder.
 */
const CLAUDE_BY_LEVEL: Record<PermissionLevel, AgentChatClaudePermissionMode> = {
  "plan": "plan",
  "ask": "default",
  "auto-edit": "acceptEdits",
  "full-auto": "bypassPermissions",
};

const CODEX_BY_LEVEL: Record<PermissionLevel, { approvalPolicy: AgentChatCodexApprovalPolicy; sandbox: AgentChatCodexSandbox }> = {
  "plan": { approvalPolicy: "untrusted", sandbox: "read-only" },
  "ask": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "on-failure", sandbox: "workspace-write" },
  "full-auto": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

const OPENCODE_BY_LEVEL: Record<PermissionLevel, AgentChatOpenCodePermissionMode | null> = {
  "plan": "plan",
  "ask": "edit",
  // OpenCode has no separate auto-edit tier; `edit` is the nearest lower rung.
  "auto-edit": null,
  "full-auto": "full-auto",
};

const DROID_BY_LEVEL: Record<PermissionLevel, AgentChatDroidPermissionMode> = {
  "plan": "read-only",
  "ask": "auto-low",
  "auto-edit": "auto-medium",
  "full-auto": "auto-high",
};

const ACP_BY_LEVEL: Record<PermissionLevel, AgentChatAcpPermissionMode> = {
  "plan": "plan",
  "ask": "default",
  "auto-edit": "auto-edit",
  "full-auto": "yolo",
};

const CURSOR_BY_LEVEL: Record<PermissionLevel, string | null> = {
  "plan": "ask",
  "ask": "agent",
  // Cursor's `agent` covers both asking and auto-editing.
  "auto-edit": null,
  "full-auto": "full-auto",
};

/** The level a given family's concrete mode represents. */
export function permissionLevelForClaude(mode: AgentChatClaudePermissionMode): PermissionLevel {
  switch (mode) {
    case "plan": return "plan";
    case "default": return "ask";
    case "acceptEdits": return "auto-edit";
    case "bypassPermissions": return "full-auto";
    // `auto` predates the ladder and behaves as an accept-edits tier.
    case "auto": return "auto-edit";
  }
}

export function permissionLevelForCodex(sandbox: AgentChatCodexSandbox, approvalPolicy: AgentChatCodexApprovalPolicy): PermissionLevel {
  // BOTH axes are required for full autonomy. Codex's approval policy and its
  // sandbox are independent controls, so "never ask" with `workspace-write` is
  // a user who still wants a sandbox. Treating that as `full-auto` would hand
  // Claude `bypassPermissions` on a family switch — unsandboxed, in a family
  // with no sandbox axis at all — which is exactly the rounding up this
  // module promises never to do.
  if (sandbox === "danger-full-access" && approvalPolicy === "never") return "full-auto";
  if (sandbox === "read-only" || approvalPolicy === "untrusted") return "plan";
  if (approvalPolicy === "never" || approvalPolicy === "on-failure") return "auto-edit";
  return "ask";
}

export function permissionLevelForOpenCode(mode: AgentChatOpenCodePermissionMode): PermissionLevel {
  if (mode === "plan") return "plan";
  if (mode === "full-auto") return "full-auto";
  // `config-toml` defers to the user's own file; treat it as the ask tier
  // rather than claiming a freedom the file may not grant.
  return "ask";
}

export function permissionLevelForDroid(mode: AgentChatDroidPermissionMode): PermissionLevel {
  switch (mode) {
    case "read-only": return "plan";
    case "auto-low": return "ask";
    case "auto-medium": return "auto-edit";
    case "auto-high": return "full-auto";
    case "agi": return "full-auto";
  }
}

export function permissionLevelForAcp(mode: AgentChatAcpPermissionMode): PermissionLevel {
  switch (mode) {
    case "plan": return "plan";
    case "default": return "ask";
    case "auto-edit": return "auto-edit";
    case "auto": return "auto-edit";
    case "yolo": return "full-auto";
  }
}

/** The level a Cursor mode id represents, for carrying a level away from Cursor. */
export function permissionLevelForCursorMode(modeId: string | null | undefined): PermissionLevel {
  if (modeId === "ask") return "plan";
  if (modeId === "full-auto") return "full-auto";
  // Cursor's `agent` spans ask and auto-edit; the cautious rung is the honest
  // reading, because rounding up is what this module forbids.
  return "ask";
}

/**
 * Step down from `level` until `table` can express it. Returns the exact level
 * when supported, otherwise the nearest lower one, and the most cautious rung
 * as the floor.
 */
function nearestSupported<T>(table: Record<PermissionLevel, T | null>, level: PermissionLevel): { level: PermissionLevel; value: T } {
  for (let rank = permissionLevelRank(level); rank >= 0; rank -= 1) {
    const candidate = PERMISSION_LEVELS[rank]!;
    const value = table[candidate];
    if (value !== null && value !== undefined) return { level: candidate, value };
  }
  // Every table defines "plan", so this is unreachable in practice; returning
  // the most cautious rung is still the right failure direction.
  return { level: "plan", value: table.plan as T };
}

export type ResolvedPermission = {
  /** The level actually applied, after any downgrade. */
  level: PermissionLevel;
  /** True when the family could not express the requested level. */
  downgraded: boolean;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  acpPermissionMode: AgentChatAcpPermissionMode;
  cursorModeId: string;
};

/** Map one level onto every provider, applying the nearest-lower rule. */
export function resolvePermissionLevel(level: PermissionLevel, family?: PermissionLadderFamily): ResolvedPermission {
  const opencode = nearestSupported(OPENCODE_BY_LEVEL, level);
  const cursor = nearestSupported(CURSOR_BY_LEVEL, level);

  // Only the family being switched TO can be downgraded; the other tables are
  // filled in for whatever the surface reads.
  const applied = family === "opencode" ? opencode : family === "cursor" ? cursor : { level };
  const appliedLevel = applied.level;
  const downgraded = appliedLevel !== level;

  return {
    level: appliedLevel,
    downgraded,
    claudePermissionMode: CLAUDE_BY_LEVEL[level],
    codexApprovalPolicy: CODEX_BY_LEVEL[level].approvalPolicy,
    codexSandbox: CODEX_BY_LEVEL[level].sandbox,
    opencodePermissionMode: opencode.value,
    droidPermissionMode: DROID_BY_LEVEL[level],
    acpPermissionMode: ACP_BY_LEVEL[level],
    cursorModeId: cursor.value,
  };
}
