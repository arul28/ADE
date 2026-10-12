/**
 * The MCP registry as one chat launch sees it on this machine.
 *
 * Read off the account settings cache at launch, so a server added in Settings
 * reaches the next chat with no restart and no network round trip, and a chat
 * launched offline still gets the servers this machine already knows about.
 */

import fs from "node:fs";
import path from "node:path";

import { ACCOUNT_SCOPE_ALL, accountDeviceSettingKey, accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { callerMcpSupport, type CallerMcpServers } from "../../../shared/callerMcpServers";
import {
  MCP_OFF_SETTING_KEY,
  MCP_SERVERS_SETTING_KEY,
  mcpRegistryToCallerServers,
  normalizeMcpOffList,
  normalizeMcpRegistry,
} from "../../../shared/mcpRegistry";
import type { AgentChatProvider } from "../../../shared/types/chat";
import { accountSettingsCacheValue, readAccountSettingsCacheRows } from "../account/accountSettingsCacheFile";
import { readGitOriginUrl } from "../projects/recentProjectSummary";

/** This computer's sync device id, or null when it has none yet. */
function readLocalDeviceId(adeHome: string): string | null {
  try {
    const value = fs.readFileSync(path.join(adeHome, "secrets", "sync-device-id"), "utf8").trim();
    return value.length ? value : null;
  } catch {
    return null;
  }
}

export type McpRegistryLaunch = {
  /** The registry servers this provider can be handed here, or null when there are none. */
  servers: CallerMcpServers | null;
  /** `server: FIELD` for each secret value this machine does not hold. */
  missing: string[];
  /** Servers left out because this provider has no client for their transport. */
  unsupported: string[];
};

const NONE: McpRegistryLaunch = { servers: null, missing: [], unsupported: [] };

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
  const rows = readAccountSettingsCacheRows(args.adeHome);
  if (!rows) return NONE;
  const all = normalizeMcpRegistry(accountSettingsCacheValue(rows, ACCOUNT_SCOPE_ALL, MCP_SERVERS_SETTING_KEY));
  if (!all.length) return NONE;
  const deviceKey = accountDeviceSettingKey(readLocalDeviceId(args.adeHome), MCP_OFF_SETTING_KEY);
  const repoScope = accountRepoScopeKey(readGitOriginUrl(args.projectRoot));
  const off = {
    machine: deviceKey ? normalizeMcpOffList(accountSettingsCacheValue(rows, ACCOUNT_SCOPE_ALL, deviceKey)) : [],
    project: repoScope ? normalizeMcpOffList(accountSettingsCacheValue(rows, repoScope, MCP_OFF_SETTING_KEY)) : [],
  };
  const blockedTransports: readonly string[] = support.unsupportedTransports ?? [];
  const unsupported = all.filter((server) => blockedTransports.includes(server.transport)).map((server) => server.name);
  const deliverable = all.filter((server) => !blockedTransports.includes(server.transport));
  const resolved = mcpRegistryToCallerServers(deliverable, off, args.readSecret);
  return { servers: resolved.servers, missing: resolved.missing, unsupported };
}
