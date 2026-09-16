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
const identityConfirmHolds = new Map<string, number>();

/**
 * The key a hold with no session id is filed under.
 *
 * One brain process hosts every open project's scopes, and this module is a
 * singleton across all of them — so an unkeyed hold downgrades the CTO in every
 * project at once, not just the one on the call. Callers that can name their
 * session should; this is the bucket for the ones that cannot yet.
 */
const UNSCOPED_HOLD_KEY = "__unscoped__";

export function beginIdentityConfirmHold(sessionId?: string | null): () => void {
  const key = typeof sessionId === "string" && sessionId.trim().length
    ? sessionId.trim()
    : UNSCOPED_HOLD_KEY;
  identityConfirmHolds.set(key, (identityConfirmHolds.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (identityConfirmHolds.get(key) ?? 0) - 1;
    if (next > 0) identityConfirmHolds.set(key, next);
    else identityConfirmHolds.delete(key);
  };
}

/**
 * Is a hold up for this session?
 *
 * An unscoped hold still answers for everyone, because a caller that could not
 * name its session cannot be narrowed after the fact — and losing the gate
 * would be worse than over-applying it. A hold that DID name a session answers
 * only for that one.
 */
export function isIdentityConfirmHeld(sessionId?: string | null): boolean {
  if ((identityConfirmHolds.get(UNSCOPED_HOLD_KEY) ?? 0) > 0) return true;
  const key = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!key.length) return identityConfirmHolds.size > 0;
  return (identityConfirmHolds.get(key) ?? 0) > 0;
}

export function normalizeIdentityPermissionMode(
  identityKey: AgentChatIdentityKey | undefined,
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
  sessionId?: string | null,
): AgentChatSession["permissionMode"] {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return isIdentityConfirmHeld(sessionId) ? "default" : "full-auto";
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
