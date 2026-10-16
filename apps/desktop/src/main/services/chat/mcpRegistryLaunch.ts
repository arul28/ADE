/**
 * The MCP registry as one chat launch sees it on this machine.
 *
 * Read off the account settings cache at launch, so a server added in Settings
 * reaches the next chat with no restart and no network round trip, and a chat
 * launched offline still gets the servers this machine already knows about.
 */

import { callerMcpSupport, type CallerMcpServers } from "../../../shared/callerMcpServers";
import { mcpRegistryToCallerServers } from "../../../shared/mcpRegistry";
import type { AgentChatProvider } from "../../../shared/types/chat";
import { readCachedMcpRegistry } from "../mcp/mcpRegistryCache";

export type McpRegistryLaunch = {
  /** The registry servers this provider can be handed here, or null when there are none. */
  servers: CallerMcpServers | null;
  /** `server: FIELD` for each secret value this machine does not hold. */
  missing: string[];
  /** Servers left out because this provider has no client for their transport. */
  unsupported: string[];
  /** Servers whose browser sign-in has run out: they start signed out. */
  signInExpired: string[];
};

const NONE: McpRegistryLaunch = { servers: null, missing: [], unsupported: [], signInExpired: [] };

export function resolveMcpRegistryForLaunch(args: {
  adeHome: string;
  projectRoot: string;
  provider: AgentChatProvider;
  /** One vault value by key, or null when this machine does not hold it. */
  readSecret: (vaultKey: string) => string | null;
}): McpRegistryLaunch {
  const support = callerMcpSupport(args.provider);
  // A provider with no MCP surface gets nothing, silently: the registry is
  // "every agent that can", not a reason to refuse a chat.
  if (!support || support.level === "unsupported") return NONE;
  const { cached } = readCachedMcpRegistry(args.adeHome, args.projectRoot);
  if (!cached?.servers.length) return NONE;
  const { servers: all, off } = cached;
  const blockedTransports: readonly string[] = support.unsupportedTransports ?? [];
  const unsupported = all.filter((server) => blockedTransports.includes(server.transport)).map((server) => server.name);
  const deliverable = all.filter((server) => !blockedTransports.includes(server.transport));
  const resolved = mcpRegistryToCallerServers(deliverable, off, args.readSecret);
  return { servers: resolved.servers, missing: resolved.missing, unsupported, signInExpired: resolved.signInExpired };
}

/**
 * What a chat is told about the registry servers it did not fully get: one
 * line per kind of gap, none when there is no gap.
 */
export function mcpRegistryLaunchNotices(registry: McpRegistryLaunch): string[] {
  return [
    ...(registry.missing.length
      ? [`These MCP servers started without a secret value this computer does not have (add it in Settings > MCP servers): ${registry.missing.join(", ")}.`]
      : []),
    ...(registry.unsupported.length
      ? [`This provider cannot connect to these MCP servers, so they were left out: ${registry.unsupported.join(", ")}.`]
      : []),
    ...(registry.signInExpired.length
      ? [`The sign-in for these MCP servers has run out, so they started signed out (sign in again in Settings > MCP servers): ${registry.signInExpired.join(", ")}.`]
      : []),
  ];
}
