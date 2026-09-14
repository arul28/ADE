import type { AgentChatIdentityKey, AgentChatProvider, AgentChatSession } from "../../../shared/types";

function guardedIdentityPermissionModeForProvider(_provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return "plan";
}

export function isPrimaryPinnedIdentity(identityKey: AgentChatIdentityKey | undefined): boolean {
  return identityKey === "cto";
}

/**
 * A live voice call holds the CTO in confirm-first mode.
 *
 * The CTO is pinned to full-auto everywhere else on purpose, and callers must
 * not be able to layer a different mode on top casually. A voice call is the
 * one case that changes the pin, and `"default"` is precisely the mode it
 * needs: reads run free and narrate, mutations raise an approval through
 * `canUseTool` (see `claudeToolNeedsApproval`). A call can therefore do
 * everything the chat can do — it just has to ask out loud first.
 *
 * Not `"plan"`, which refuses writes outright: that made a call read-only and
 * left the whole spoken-confirmation system unreachable. Not `"full-auto"`
 * either — an open microphone is an open door, and a misheard sentence must not
 * reach a tool that writes without a word from the user.
 *
 * The hold lives here rather than on the session because a session-level change
 * cannot hold. Every writer of an identity session's permission mode routes
 * through `normalizeIdentityPermissionMode` — including the
 * `ensureIdentitySession` path that re-normalizes a reused session before every
 * turn — so a mode written once is snapped back on the next turn. This is the
 * single point all of them pass.
 *
 * A counter, not a boolean, so overlapping holds cannot release each other
 * early. Each `begin` answers its own release, and a release is idempotent.
 */
let identityConfirmHolds = 0;

export function beginIdentityConfirmHold(): () => void {
  identityConfirmHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    identityConfirmHolds = Math.max(0, identityConfirmHolds - 1);
  };
}

export function isIdentityConfirmHeld(): boolean {
  return identityConfirmHolds > 0;
}

export function normalizeIdentityPermissionMode(
  identityKey: AgentChatIdentityKey | undefined,
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
): AgentChatSession["permissionMode"] {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return isIdentityConfirmHeld() ? "default" : "full-auto";
  }
  return mode === "plan" ? "plan" : guardedIdentityPermissionModeForProvider(provider);
}

export function resolveIdentityExecutionLane(
  identityKey: AgentChatIdentityKey,
  requestedLaneId: string | null | undefined,
  canonicalLaneId: string | null,
): string | null {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return canonicalLaneId;
  }
  const trimmedRequested = typeof requestedLaneId === "string" ? requestedLaneId.trim() : "";
  return trimmedRequested.length ? trimmedRequested : null;
}
