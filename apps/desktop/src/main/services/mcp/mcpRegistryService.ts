/**
 * The main-process half of Settings > MCP servers.
 *
 * The renderer reads and writes the registry's three settings rows itself,
 * through the account settings bridge it already has. This service is the part
 * it cannot do: say where this computer and this project file their rows, look
 * at this computer (is the command installed, is the secret value here, what do
 * the provider CLIs already have), and put secret values in the account vault.
 *
 * The vault path is the narrow one on purpose. It writes and removes only
 * registry secrets (`mcp/<server>/...`, kind `secret`, scope `all`) and it
 * answers "does this computer hold this key" with yes or no. No call here
 * returns a secret value.
 */

import fs from "node:fs";
import path from "node:path";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import {
  MCP_SECRET_VAULT_KIND,
  isValidMcpFieldName,
  isValidMcpRegistryName,
  mcpSecretVaultKey,
  mcpSecretVaultKeyPrefix,
  mcpSecretVaultKeys,
  normalizeMcpRegistry,
  normalizeMcpRegistryServer,
  type McpRegistryServer,
} from "../../../shared/mcpRegistry";
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";
import type {
  McpRegistryCheck,
  McpRegistryContext,
  McpRegistryImportResult,
  McpRegistryResult,
  McpRegistryScan,
  McpRegistrySecretRef,
} from "../../../shared/types/mcpRegistry";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { readCachedMcpRegistry } from "./mcpRegistryCache";
import { scanProviderMcpConfigs, toFoundServers, type ProviderMcpScan } from "./mcpProviderConfigScan";

/** The four vault calls this service makes. `createAccountVaultBridge` satisfies it. */
export type McpRegistryVault = {
  list(scope?: string | null): Promise<AccountVaultResult<AccountVaultItem[]>>;
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
  set(scope: string, kind: string, key: string, value: string): Promise<AccountVaultResult<null>>;
  remove(scope: string, kind: string, key: string): Promise<AccountVaultResult<null>>;
};

export type McpRegistryServiceOptions = {
  vault: McpRegistryVault;
  /** This computer's ADE home (`~/.ade`), where its sync device id is kept. */
  adeHome: string;
  /** Replaceable so a test can scan a made-up home. */
  scan?: (args: { projectRoot: string | null }) => ProviderMcpScan;
  /** Replaceable so a test need not depend on what this computer has installed. */
  commandExists?: (command: string) => boolean;
};

const INVALID_SECRET: McpRegistryResult<null> = {
  ok: false,
  rejected: true,
  message: "That is not a name ADE can store a value under.",
};

/**
 * True when a `stdio` server's program can be started here.
 *
 * A bare name is looked up the way a provider CLI would find it: on PATH and
 * in the usual install folders, with Windows' `PATHEXT` endings. A path is
 * checked as a path.
 */
function defaultCommandExists(command: string): boolean {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  return resolveExecutableFromKnownLocations(command) != null;
}

function secretKey(ref: McpRegistrySecretRef | null | undefined): string | null {
  if (!ref || typeof ref.server !== "string" || typeof ref.name !== "string") return null;
  if (ref.field !== "env" && ref.field !== "header") return null;
  if (!isValidMcpRegistryName(ref.server) || !isValidMcpFieldName(ref.name)) return null;
  return mcpSecretVaultKey(ref.server, ref.field, ref.name);
}

export function createMcpRegistryService(options: McpRegistryServiceOptions) {
  const { vault } = options;
  const scanConfigs = options.scan ?? ((args) => scanProviderMcpConfigs(args));
  const commandExists = options.commandExists ?? defaultCommandExists;

  /** Removes every vault item under one server, except the keys named. */
  const removeServerSecrets = async (server: string, keep: readonly string[] = []): Promise<McpRegistryResult<null>> => {
    if (!isValidMcpRegistryName(server)) return INVALID_SECRET;
    const listed = await vault.list(ACCOUNT_SCOPE_ALL);
    if (!listed.ok) return listed;
    const prefix = mcpSecretVaultKeyPrefix(server);
    for (const item of listed.value) {
      if (item.kind !== MCP_SECRET_VAULT_KIND || item.deleted === true) continue;
      if (!item.key.startsWith(prefix) || keep.includes(item.key)) continue;
      const removed = await vault.remove(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, item.key);
      if (!removed.ok) return removed;
    }
    return { ok: true, value: null };
  };

  return {
    /** Where this computer and this project keep their "switched off here" lists. */
    context(projectRoot: string | null | undefined): McpRegistryContext {
      return readCachedMcpRegistry(options.adeHome, projectRoot?.trim() || null);
    },

    /** What this computer holds and can start, for the servers given. */
    async check(rawServers: unknown): Promise<McpRegistryResult<McpRegistryCheck>> {
      const servers = normalizeMcpRegistry(rawServers);
      const heldSecretKeys: string[] = [];
      for (const key of servers.flatMap(mcpSecretVaultKeys)) {
        const value = await vault.get(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, key);
        // No brain to ask is "cannot say", which must not read as "missing".
        if (!value.ok) return value;
        if (value.value != null && value.value.length > 0) heldSecretKeys.push(key);
      }
      const missingCommands = servers
        .filter((server) => server.transport === "stdio" && !commandExists(server.command ?? ""))
        .map((server) => server.name);
      return { ok: true, value: { heldSecretKeys, missingCommands } };
    },

    async setSecret(ref: McpRegistrySecretRef, value: unknown): Promise<McpRegistryResult<null>> {
      const key = secretKey(ref);
      if (!key || typeof value !== "string" || !value.length) return INVALID_SECRET;
      return await vault.set(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, key, value);
    },

    async removeSecret(ref: McpRegistrySecretRef): Promise<McpRegistryResult<null>> {
      const key = secretKey(ref);
      if (!key) return INVALID_SECRET;
      return await vault.remove(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, key);
    },

    /**
     * Drops the vault items a server no longer names. With no `keep`, all of
     * them: that is what removing the server does.
     */
    async pruneSecrets(server: string, keep?: McpRegistryServer | null): Promise<McpRegistryResult<null>> {
      const kept = keep ? normalizeMcpRegistryServer(keep) : null;
      return await removeServerSecrets(server, kept && kept.name === server ? mcpSecretVaultKeys(kept) : []);
    },

    /** The servers the provider CLIs have here. Names only. */
    scan(projectRoot: string | null | undefined): McpRegistryScan {
      return toFoundServers(scanConfigs({ projectRoot: projectRoot?.trim() || null }));
    },

    /**
     * Moves one found server's values into the vault and answers with its
     * definition, for the renderer to add to the list. The values go from the
     * provider's file to the vault inside this process.
     */
    async importServer(name: string, projectRoot: string | null | undefined): Promise<McpRegistryImportResult> {
      const found = scanConfigs({ projectRoot: projectRoot?.trim() || null }).servers
        .find((server) => server.name === name);
      const server = found ? normalizeMcpRegistryServer({
        ...found,
        envNames: Object.keys(found.env),
        headerNames: Object.keys(found.headers),
        enabled: true,
      }) : null;
      if (!found || !server) {
        return { ok: false, rejected: true, message: "That server is no longer in a provider's settings on this computer." };
      }
      // Start clean: a server removed and imported again must not pick up a
      // value left under a name it no longer has.
      const cleared = await removeServerSecrets(server.name);
      if (!cleared.ok) return cleared;
      const values: Array<[McpRegistrySecretRef["field"], string, string]> = [
        ...server.envNames.map((field): [McpRegistrySecretRef["field"], string, string] => ["env", field, found.env[field] ?? ""]),
        ...server.headerNames.map((field): [McpRegistrySecretRef["field"], string, string] => ["header", field, found.headers[field] ?? ""]),
      ];
      for (const [field, fieldName, value] of values) {
        // An empty value is a variable the provider reads from its own
        // environment. Nothing to store; the page shows it as missing.
        if (!value.length) continue;
        const stored = await vault.set(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, mcpSecretVaultKey(server.name, field, fieldName), value);
        if (!stored.ok) return stored;
      }
      return { ok: true, value: server };
    },
  };
}
