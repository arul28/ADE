import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";

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
    // Two spellings of one directory are one scope: `path.resolve` does not
    // fold drive-letter case on Windows, so `===` would mint a second token.
    && (left.projectRoot === right.projectRoot
      || pathsEqual(left.projectRoot, right.projectRoot))
    && left.tabCollection === right.tabCollection;
}

/**
 * Issuance seam for the two processes that build agent environments.
 *
 * The registry above is process-local and only Electron main can validate
 * against it. The runtime daemon (`ade serve`) runs in a separate process, so
 * it must ask Electron to mint and revoke capabilities over the authenticated
 * desktop bridge instead of calling the local registry. Desktop-hosted chats
 * keep using {@link localBrowserActorCapabilityIssuer}.
 *
 * `issue` resolves to `null` when no issuer is reachable (headless machine, no
 * desktop running). Callers then omit `ADE_BROWSER_ACTOR_TOKEN` instead of
 * failing the launch, and `ade browser` surfaces the bridge's own error.
 */
export type BrowserActorCapabilityIssuer = {
  /**
   * Present only when this process owns the registry above. Callers use it to
   * stay on their existing synchronous path — an agent launch in Electron main
   * must not gain a suspension point just because the daemon needs one.
   *
   * The cost of this fork is an implicit ordering rule in `agentChatService`
   * (`prepareBrowserActorCapability` must run before `buildAgentRuntimeEnv`),
   * which is why it is kept deliberately rather than collapsed into `issue`:
   * the extra `await` would land inside a launch stretch whose synchronous
   * dispatch ordering is load-bearing. See the CONSTRAINT note on
   * `prepareBrowserActorCapability`.
   */
  issueSync?: (capability: BuiltInBrowserActorCapability) => string;
  issue: (capability: BuiltInBrowserActorCapability) => Promise<string | null>;
  revoke: (chatSessionId: string) => Promise<void>;
};

export const localBrowserActorCapabilityIssuer: BrowserActorCapabilityIssuer = {
  issueSync: (capability) => issueBuiltInBrowserActorCapability(capability),
  issue: async (capability) => issueBuiltInBrowserActorCapability(capability),
  revoke: async (chatSessionId) => {
    revokeBuiltInBrowserActorCapability(chatSessionId);
  },
};
