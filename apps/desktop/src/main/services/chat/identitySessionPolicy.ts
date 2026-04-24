import type { AgentChatIdentityKey, AgentChatProvider, AgentChatSession } from "../../../shared/types";

function guardedIdentityPermissionModeForProvider(_provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return "plan";
}

export function isPrimaryPinnedIdentity(identityKey: AgentChatIdentityKey | undefined): boolean {
  if (identityKey === "cto") return true;
  if (!identityKey || !identityKey.startsWith("agent:")) return false;
  // Require a non-empty trimmed suffix so `agent:` and `agent:   ` do not
  // masquerade as a worker identity. Matches the stricter checks in
  // resolveWorkerIdentityAgentId / normalizeIdentityKey.
  return identityKey.slice("agent:".length).trim().length > 0;
}

export function normalizeIdentityPermissionMode(
  identityKey: AgentChatIdentityKey | undefined,
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
): AgentChatSession["permissionMode"] {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return "full-auto";
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
