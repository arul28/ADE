import type { AgentChatIdentityKey, AgentChatProvider, AgentChatSession } from "../../../shared/types";

export function guardedIdentityPermissionModeForProvider(_provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return "plan";
}

function isPrimaryPinnedIdentity(identityKey: AgentChatIdentityKey | undefined): boolean {
  return identityKey === "cto" || Boolean(identityKey?.startsWith("agent:"));
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
  requestedLaneId: string,
  canonicalLaneId: string,
): string | null {
  if (isPrimaryPinnedIdentity(identityKey)) {
    return canonicalLaneId;
  }
  return requestedLaneId || null;
}
