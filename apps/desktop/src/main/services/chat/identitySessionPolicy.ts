import type { AgentChatIdentityKey, AgentChatProvider, AgentChatSession } from "../../../shared/types";

function guardedIdentityPermissionModeForProvider(_provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return "plan";
}

export function isPrimaryPinnedIdentity(identityKey: AgentChatIdentityKey | undefined): boolean {
  return identityKey === "cto";
}

/**
 * A live voice call holds the CTO read-only.
 *
 * The CTO is pinned to full-auto everywhere else on purpose, and callers must
 * not be able to layer a stricter mode on top casually. A voice call is the one
 * case that inverts the pin: an open microphone is an open door, and a misheard
 * sentence must not reach a tool that writes.
 *
 * The hold lives here rather than on the session because a session-level
 * downgrade cannot hold. Every writer of an identity session's permission mode
 * routes through `normalizeIdentityPermissionMode` — including the
 * `ensureIdentitySession` path that re-normalizes a reused session before every
 * turn — so a mode written once is snapped back on the next turn. This is the
 * single point all of them pass.
 *
 * A counter, not a boolean, so overlapping holds cannot release each other
 * early. Each `begin` answers its own release, and a release is idempotent.
 */
let identityReadOnlyHolds = 0;

export function beginIdentityReadOnlyHold(): () => void {
  identityReadOnlyHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    identityReadOnlyHolds = Math.max(0, identityReadOnlyHolds - 1);
  };
}

export function isIdentityReadOnlyHeld(): boolean {
  return identityReadOnlyHolds > 0;
}

export function normalizeIdentityPermissionMode(
  identityKey: AgentChatIdentityKey | undefined,
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
): AgentChatSession["permissionMode"] {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return isIdentityReadOnlyHeld() ? "plan" : "full-auto";
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
