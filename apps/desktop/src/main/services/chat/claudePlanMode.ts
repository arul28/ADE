import type {
  AgentChatClaudePermissionMode,
  AgentChatInteractionMode,
  AgentChatSession,
} from "../../../shared/types";

/**
 * Plan-mode transitions for Claude sessions.
 *
 * Extracted from `agentChatService.ts` so the invariant here is testable on
 * its own: entering plan mode must move the *access* mode too, not just the
 * interaction mode.
 *
 * Before that, a `bypassPermissions` session entering plan mode kept
 * `claudePermissionMode === "bypassPermissions"`. Three things broke at once:
 * the composer chip still read Bypass, nothing was actually restricted, and
 * the `ExitPlanMode` gate — which reads `claudePermissionMode ?? permissionMode`
 * — saw bypass and auto-approved the plan without ever rendering the approval
 * card. Plan mode was cosmetic in exactly the sessions where review matters.
 */

/** Everything `claudePermissionMode` can hold except the plan sentinel. */
export type ClaudeAccessMode = Exclude<AgentChatClaudePermissionMode, "plan">;

export type PlanModeSessionFields = Pick<
  AgentChatSession,
  "permissionMode" | "interactionMode" | "claudePermissionMode" | "claudePrePlanAccessMode"
>;

export function normalizeClaudeAccessMode(
  value: AgentChatClaudePermissionMode | undefined | null,
): ClaudeAccessMode | undefined {
  if (value === "default" || value === "auto" || value === "acceptEdits" || value === "bypassPermissions") {
    return value;
  }
  return undefined;
}

export function legacyPermissionModeToClaudeAccessMode(
  mode: AgentChatSession["permissionMode"] | undefined,
): ClaudeAccessMode | undefined {
  switch (mode) {
    case "auto":
      return "auto";
    case "edit":
      return "acceptEdits";
    case "full-auto":
      return "bypassPermissions";
    case "default":
      return "default";
    default:
      return undefined;
  }
}

export function claudeAccessModeToLegacyPermissionMode(
  mode: ClaudeAccessMode,
): AgentChatSession["permissionMode"] {
  switch (mode) {
    case "auto":
      return "auto";
    case "acceptEdits":
      return "edit";
    case "bypassPermissions":
      return "full-auto";
    default:
      return "default";
  }
}

/** The access mode a session is effectively running under, ignoring plan. */
export function resolveClaudeAccessMode(
  session: Pick<PlanModeSessionFields, "claudePermissionMode" | "permissionMode">,
  fallback: AgentChatClaudePermissionMode = "default",
): ClaudeAccessMode {
  return normalizeClaudeAccessMode(session.claudePermissionMode)
    ?? legacyPermissionModeToClaudeAccessMode(session.permissionMode)
    ?? normalizeClaudeAccessMode(fallback)
    ?? "default";
}

/**
 * Move a session into or out of plan mode, mutating it in place.
 *
 * Entering stashes the suspended access mode on the session so leaving
 * restores it; without the stash, exiting would resolve through the fallback
 * and silently demote a full-auto session to `default`.
 */
export function applyClaudePlanModeTransition(
  session: PlanModeSessionFields,
  nextInteractionMode: AgentChatInteractionMode,
): void {
  session.interactionMode = nextInteractionMode;

  if (nextInteractionMode === "plan") {
    // Guard against entering plan mode from plan mode, which would otherwise
    // stash the "plan" sentinel and lose the real mode.
    if (session.claudePermissionMode !== "plan") {
      session.claudePrePlanAccessMode = resolveClaudeAccessMode(session);
    }
    session.permissionMode = "plan";
    session.claudePermissionMode = "plan";
    return;
  }

  const restored = normalizeClaudeAccessMode(session.claudePrePlanAccessMode)
    ?? resolveClaudeAccessMode(session);
  session.claudePrePlanAccessMode = null;
  session.claudePermissionMode = restored;
  session.permissionMode = claudeAccessModeToLegacyPermissionMode(restored);
}

/**
 * Whether a session is genuinely in plan mode.
 *
 * `ExitPlanMode` uses this to decide whether the plan needs approval. A
 * session that is in plan mode is never simultaneously "bypassing
 * permissions", regardless of what it was doing before.
 */
export function isSessionInPlanMode(
  session: Pick<PlanModeSessionFields, "permissionMode" | "interactionMode" | "claudePermissionMode">,
): boolean {
  return session.permissionMode === "plan"
    || session.interactionMode === "plan"
    || session.claudePermissionMode === "plan";
}
