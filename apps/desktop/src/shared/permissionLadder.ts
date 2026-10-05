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
//
// DELIBERATELY SEPARATE from ADE's generic `AgentChatPermissionMode` words
// (`plan | default | edit | full-auto`), which `ade --permission-mode` and the
// CLI launch path speak and which `droidPermissionModeFromLegacyPermissionMode`
// in types/chat.ts translates. In that vocabulary `edit` is the CAUTIOUS
// editing tier (Droid `auto-low`) by the owner's original intent. The two
// tables therefore look inverted on the middle rungs, and that is fine: the
// ladder reads and writes each family's CONCRETE mode on a model switch, the
// legacy converter maps a generic CLI word to a tier at launch, and no code
// path converts between them. Do not "reconcile" them — doing so would shift
// `ade --permission-mode edit` and every persisted session carrying it.

import type {
  AgentChatAcpPermissionMode,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
} from "./types/chat";
import { ACP_PROVIDER_IDS } from "./acpProviderMetadata";

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

/** The concrete permission controls a chat surface holds for every family. */
export type PermissionLadderControls = {
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  cursorModeId: string | null | undefined;
};

/**
 * The level `family` currently sits on. ACP has no control of its own on a chat
 * surface: it rides the in-process mode the OpenCode control owns.
 */
export function permissionLevelForFamily(family: PermissionLadderFamily, controls: PermissionLadderControls): PermissionLevel {
  switch (family) {
    case "claude": return permissionLevelForClaude(controls.claudePermissionMode);
    case "codex": return permissionLevelForCodex(controls.codexSandbox, controls.codexApprovalPolicy);
    case "opencode":
    case "acp": return permissionLevelForOpenCode(controls.opencodePermissionMode);
    case "droid": return permissionLevelForDroid(controls.droidPermissionMode);
    case "cursor": return permissionLevelForCursorMode(controls.cursorModeId);
  }
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

// ---------------------------------------------------------------------------
// Parent ceiling — a spawned chat never runs with more freedom than its parent.
// ---------------------------------------------------------------------------
//
// An agent that may only ask before editing must not escape that by spawning a
// `full-auto` child, in any provider. The comparison runs on the ladder, so a
// Claude parent and a Codex child compare like for like. A field this module
// cannot read is resolved in the SAFE direction for its side: an unreadable
// parent counts as `ask` (it grants no extra headroom), an unreadable child
// counts as `full-auto` (so it is clamped to an explicit, known mode rather
// than left to a config file the ceiling cannot see).

/** Every field a session's permission posture can live in. */
export type SessionPermissionFields = {
  provider?: string | null;
  permissionMode?: string | null;
  claudePermissionMode?: AgentChatClaudePermissionMode | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy | null;
  codexSandbox?: AgentChatCodexSandbox | null;
  codexConfigSource?: string | null;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode | null;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  acpPermissionMode?: AgentChatAcpPermissionMode | null;
  cursorModeId?: string | null;
  interactionMode?: string | null;
};

const ACP_LADDER_PROVIDERS: ReadonlySet<string> = new Set(ACP_PROVIDER_IDS);

/** ADE's generic composer word, read as a level; null when it defers to a file. */
function levelForGenericMode(mode: string | null | undefined): PermissionLevel | null {
  switch (mode) {
    case "plan": return "plan";
    case "edit":
    case "auto": return "auto-edit";
    case "full-auto": return "full-auto";
    case "config-toml": return null;
    default: return "ask";
  }
}

/**
 * The ladder level a session's fields grant. `unknown` is what an unreadable
 * posture counts as: callers pass `ask` for a parent and `full-auto` for a child.
 */
export function sessionPermissionLevel(
  fields: SessionPermissionFields,
  unknown: PermissionLevel,
): PermissionLevel {
  const provider = fields.provider ?? "";
  if (provider === "claude") {
    const stored = fields.claudePermissionMode
      ? permissionLevelForClaude(fields.claudePermissionMode)
      : levelForGenericMode(fields.permissionMode) ?? unknown;
    // Plan mode with ask-level access behind it is the plan rung. With more
    // behind it, leaving plan mode restores that access, so it reads as such.
    if (fields.interactionMode === "plan" && permissionLevelRank(stored) <= permissionLevelRank("ask")) return "plan";
    return stored;
  }
  if (provider === "codex") {
    if (fields.codexConfigSource === "config-toml") return unknown;
    if (fields.codexSandbox && fields.codexApprovalPolicy) {
      return permissionLevelForCodex(fields.codexSandbox, fields.codexApprovalPolicy);
    }
    return levelForGenericMode(fields.permissionMode) ?? unknown;
  }
  if (provider === "cursor") {
    const mode = fields.cursorModeId?.trim().toLowerCase();
    if (mode === "full-auto") return "full-auto";
    if (mode === "ask" || mode === "plan") return "plan";
    if (fields.permissionMode === "full-auto" && !mode) return "full-auto";
    if (fields.permissionMode === "plan" && !mode) return "plan";
    // `agent` reads as `ask` on both sides: it is what the ceiling writes for
    // `ask` (CURSOR_BY_LEVEL), so a clamped Cursor child must read back at the
    // level it was clamped to, or every later check would refuse it.
    return "ask";
  }
  if (provider === "droid") {
    return fields.droidPermissionMode ? permissionLevelForDroid(fields.droidPermissionMode) : unknown;
  }
  if (provider === "opencode") {
    if (!fields.opencodePermissionMode || fields.opencodePermissionMode === "config-toml") {
      return levelForGenericMode(fields.permissionMode) ?? unknown;
    }
    return permissionLevelForOpenCode(fields.opencodePermissionMode);
  }
  if (ACP_LADDER_PROVIDERS.has(provider)) {
    return fields.acpPermissionMode
      ? permissionLevelForAcp(fields.acpPermissionMode)
      : levelForGenericMode(fields.permissionMode) ?? unknown;
  }
  if (provider === "pi") {
    // Pi reads `auto` like `default`: every workspace change is offered.
    if (fields.permissionMode === "auto") return "ask";
    return levelForGenericMode(fields.permissionMode ?? "default") ?? unknown;
  }
  return unknown;
}

const GENERIC_BY_LEVEL: Record<PermissionLevel, "plan" | "default" | "edit" | "full-auto"> = {
  "plan": "plan",
  "ask": "default",
  "auto-edit": "edit",
  "full-auto": "full-auto",
};

/** Concrete fields a ceiling writes; each is a value the provider accepts. */
export type PermissionFieldsPatch = {
  permissionMode?: "plan" | "default" | "edit" | "full-auto";
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: "flags";
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  acpPermissionMode?: AgentChatAcpPermissionMode;
  cursorModeId?: string;
  interactionMode?: "plan" | "default";
};

/**
 * The fields that put a `provider` session at exactly `level` (or the nearest
 * lower level it can express). Only the fields that provider reads are set.
 */
export function permissionFieldsForLevel(
  provider: string | null | undefined,
  level: PermissionLevel,
): PermissionFieldsPatch {
  const resolved = resolvePermissionLevel(
    level,
    provider === "opencode" ? "opencode" : provider === "cursor" ? "cursor" : undefined,
  );
  switch (provider) {
    case "claude":
      // The generic word too: Claude's normalization rebuilds the access mode
      // from `permissionMode`, so a stale `full-auto` there would undo the clamp.
      return {
        claudePermissionMode: resolved.claudePermissionMode,
        interactionMode: level === "plan" ? "plan" : "default",
        permissionMode: GENERIC_BY_LEVEL[level],
      };
    case "codex":
      return { codexApprovalPolicy: resolved.codexApprovalPolicy, codexSandbox: resolved.codexSandbox, codexConfigSource: "flags" };
    case "cursor":
      return { cursorModeId: resolved.cursorModeId, permissionMode: GENERIC_BY_LEVEL[resolved.level] };
    case "droid":
      return { droidPermissionMode: resolved.droidPermissionMode, interactionMode: level === "plan" ? "plan" : "default" };
    case "opencode":
      return { opencodePermissionMode: resolved.opencodePermissionMode };
    case "pi":
      return { permissionMode: GENERIC_BY_LEVEL[level] };
    default:
      return ACP_LADDER_PROVIDERS.has(provider ?? "")
        ? { acpPermissionMode: resolved.acpPermissionMode }
        : { permissionMode: GENERIC_BY_LEVEL[level] };
  }
}

/** Human label for a ladder level, for notices and errors. */
export function permissionLevelLabel(level: PermissionLevel): string {
  switch (level) {
    case "plan": return "plan only";
    case "ask": return "ask before changes";
    case "auto-edit": return "auto-accept edits";
    case "full-auto": return "full auto";
  }
}

/**
 * The clamp a ceiling puts on a session: null when `fields` already sit at or
 * below `ceiling`, otherwise the level asked for and the fields that bring the
 * session down to the ceiling in its own provider's vocabulary.
 */
export function permissionCeilingClamp(
  fields: SessionPermissionFields,
  ceiling: PermissionLevel,
): { requested: PermissionLevel; level: PermissionLevel; patch: PermissionFieldsPatch } | null {
  const requested = sessionPermissionLevel(fields, "full-auto");
  if (permissionLevelRank(requested) <= permissionLevelRank(ceiling)) return null;
  return { requested, level: ceiling, patch: permissionFieldsForLevel(fields.provider, ceiling) };
}

/** A permission level from untrusted JSON (a wire claim, a state file), or null. */
export function readPermissionLevel(value: unknown): PermissionLevel | null {
  return typeof value === "string" && (PERMISSION_LEVELS as readonly string[]).includes(value)
    ? value as PermissionLevel
    : null;
}

/** The more cautious of two optional ceilings; null when neither applies. */
export function lowerPermissionCeiling(
  a: PermissionLevel | null,
  b: PermissionLevel | null,
): PermissionLevel | null {
  if (!a) return b;
  if (!b) return a;
  return permissionLevelRank(a) <= permissionLevelRank(b) ? a : b;
}

/**
 * ADE's generic launch word (`ade --permission-mode`, CLI child spawns) capped
 * at `ceiling`: unchanged when it already fits, otherwise the generic word for
 * the ceiling. A word that defers to a config file counts as above any ceiling.
 */
export function clampGenericPermissionMode<T extends string>(
  mode: T | null | undefined,
  ceiling: PermissionLevel,
): T | "plan" | "default" | "edit" | "full-auto" | null | undefined {
  const level = levelForGenericMode(mode ?? "default") ?? "full-auto";
  return permissionLevelRank(level) <= permissionLevelRank(ceiling) ? mode : GENERIC_BY_LEVEL[ceiling];
}
