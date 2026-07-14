import { randomBytes } from "node:crypto";
import path from "node:path";

const CAPABILITY_BYTES = 32;

export type BuiltInBrowserActorCapability = {
  chatSessionId: string;
  laneId: string | null;
  projectRoot: string | null;
  tabCollection: "personal" | null;
};

const capabilitiesByToken = new Map<string, BuiltInBrowserActorCapability>();
const tokenByChatSession = new Map<string, string>();

export function issueBuiltInBrowserActorCapability(
  capability: BuiltInBrowserActorCapability,
): string {
  const chatSessionId = capability.chatSessionId.trim();
  if (!chatSessionId) throw new Error("Browser actor capabilities require a chat session id.");
  const existingToken = tokenByChatSession.get(chatSessionId) ?? null;
  const normalized: BuiltInBrowserActorCapability = {
    chatSessionId,
    laneId: normalizedString(capability.laneId),
    projectRoot: normalizedPath(capability.projectRoot),
    tabCollection: capability.tabCollection === "personal" ? "personal" : null,
  };
  if (normalized.tabCollection === "personal") normalized.projectRoot = null;
  if (existingToken) {
    const existing = capabilitiesByToken.get(existingToken) ?? null;
    if (existing && sameCapabilityScope(existing, normalized)) return existingToken;
    capabilitiesByToken.delete(existingToken);
  }
  const token = randomBytes(CAPABILITY_BYTES).toString("base64url");
  capabilitiesByToken.set(token, normalized);
  tokenByChatSession.set(chatSessionId, token);
  return token;
}

export function revokeBuiltInBrowserActorCapability(chatSessionId: string): void {
  const normalizedChatSessionId = chatSessionId.trim();
  if (!normalizedChatSessionId) return;
  const token = tokenByChatSession.get(normalizedChatSessionId) ?? null;
  tokenByChatSession.delete(normalizedChatSessionId);
  if (token) capabilitiesByToken.delete(token);
}

export function resolveBuiltInBrowserActorCapability(
  token: string | null | undefined,
): BuiltInBrowserActorCapability | null {
  const normalizedToken = normalizedString(token);
  if (!normalizedToken) return null;
  const capability = capabilitiesByToken.get(normalizedToken) ?? null;
  return capability ? { ...capability } : null;
}

export function resetBuiltInBrowserActorCapabilitiesForTest(): void {
  capabilitiesByToken.clear();
  tokenByChatSession.clear();
}

function normalizedString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizedPath(value: string | null | undefined): string | null {
  const normalized = normalizedString(value);
  return normalized ? path.resolve(normalized) : null;
}

function sameCapabilityScope(
  left: BuiltInBrowserActorCapability,
  right: BuiltInBrowserActorCapability,
): boolean {
  return left.chatSessionId === right.chatSessionId
    && left.laneId === right.laneId
    && left.projectRoot === right.projectRoot
    && left.tabCollection === right.tabCollection;
}
