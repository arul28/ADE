/**
 * The MCP registry as this computer last saved it, read off the account
 * settings cache: the one copy both a chat launch and Settings > MCP servers
 * read, so the two can never disagree about which servers are on here.
 */

import fs from "node:fs";
import path from "node:path";

import { ACCOUNT_SCOPE_ALL, accountDeviceSettingKey, accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import {
  MCP_OFF_SETTING_KEY,
  MCP_SERVERS_SETTING_KEY,
  normalizeMcpOffList,
  normalizeMcpRegistry,
} from "../../../shared/mcpRegistry";
import type { McpRegistryContext } from "../../../shared/types/mcpRegistry";
import { accountSettingsCacheValue, readAccountSettingsCacheRows } from "../account/accountSettingsCacheFile";
import { readGitOriginUrl } from "../projects/recentProjectSummary";

/**
 * This computer's sync device id, or null when it has none yet.
 *
 * A read and nothing else: `getOrCreateLocalAccountMachineIdentity` would mint
 * an id for a computer that has none, which reading a list must never do.
 */
export function readLocalDeviceId(adeHome: string): string | null {
  try {
    const value = fs.readFileSync(path.join(adeHome, "secrets", "sync-device-id"), "utf8").trim();
    return value.length ? value : null;
  } catch {
    return null;
  }
}

/**
 * Where this computer and this project file their "switched off here" lists,
 * and the servers and both lists as the settings cache holds them. `cached` is
 * null when there is no cache to read.
 */
export function readCachedMcpRegistry(adeHome: string, projectRoot: string | null): McpRegistryContext {
  const deviceOffKey = accountDeviceSettingKey(readLocalDeviceId(adeHome), MCP_OFF_SETTING_KEY);
  const repoScope = projectRoot ? accountRepoScopeKey(readGitOriginUrl(projectRoot)) : null;
  const rows = readAccountSettingsCacheRows(adeHome);
  return {
    deviceOffKey,
    repoScope,
    cached: rows ? {
      servers: normalizeMcpRegistry(accountSettingsCacheValue(rows, ACCOUNT_SCOPE_ALL, MCP_SERVERS_SETTING_KEY)),
      off: {
        machine: deviceOffKey ? normalizeMcpOffList(accountSettingsCacheValue(rows, ACCOUNT_SCOPE_ALL, deviceOffKey)) : [],
        project: repoScope ? normalizeMcpOffList(accountSettingsCacheValue(rows, repoScope, MCP_OFF_SETTING_KEY)) : [],
      },
    } : null,
  };
}
