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
  mcpOAuthTokenState,
  mcpOAuthVaultKey,
  mcpRegistryState,
  sameMcpServerUrl,
  mcpSecretVaultKey,
  mcpSecretVaultKeyPrefix,
  mcpSecretVaultKeys,
  normalizeMcpRegistry,
  normalizeMcpRegistryServer,
  parseMcpOAuthToken,
  type McpOAuthToken,
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
  McpRegistrySignInResult,
  McpServerSignIn,
} from "../../../shared/types/mcpRegistry";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { readCachedMcpRegistry } from "./mcpRegistryCache";
import { scanProviderMcpConfigs, toFoundServers, type ProviderMcpScan } from "./mcpProviderConfigScan";
import { createMcpOAuthSignIns, probeMcpAuth, refreshMcpOAuthToken, type McpFetch } from "./mcpOAuth";

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
  /** Opens the browser for a sign-in. On this computer: the loopback redirect is here. */
  openUrl?: (url: string) => Promise<void>;
  fetch?: McpFetch;
  logger?: { warn: (event: string, meta?: Record<string, unknown>) => void } | null;
};

/**
 * Renew a sign-in this close to running out, or after it has, when the server
 * gave a refresh token. Many servers issue one-hour tokens, so this is what
 * keeps agents signed in.
 */
const REFRESH_WITHIN_MS = 15 * 60 * 1000;
/** How often this computer looks for sign-ins to renew while ADE runs. */
const RENEW_EVERY_MS = 5 * 60 * 1000;
/** How long one "does this server want a sign-in" answer is reused. */
const PROBE_TTL_MS = 10 * 60 * 1000;
const renewingMcpOAuthTokens = new Map<string, Promise<McpOAuthToken>>();

/**
 * What the registry holds for a server URL a provider wants a sign-in for.
 * `serverName` is the registry's name for it (the provider may call it
 * something else); `off` means it is switched off here, so no token is handed over.
 */
export type McpRegistryAuthLookup = {
  accessToken?: string;
  expiresIn?: number;
  registryConfigured: boolean;
  serverName?: string;
  off?: boolean;
};

export function createMcpRegistryAuthTokenResolver(args: {
  adeHome: string;
  readSecret: (key: string) => string | null | Promise<string | null>;
  writeSecret: (key: string, value: string) => boolean | Promise<boolean>;
  logger?: { warn: (event: string, meta?: Record<string, unknown>) => void } | null;
  fetch?: McpFetch;
}): (serverUrl: string) => Promise<McpRegistryAuthLookup> {
  const fetchImpl = args.fetch ?? fetch;
  return async (serverUrl) => {
    const url = serverUrl.trim();
    if (!url) return { registryConfigured: false };
    try {
      const { cached } = readCachedMcpRegistry(args.adeHome, null);
      if (!cached) return { registryConfigured: false };
      const server = cached.servers.find((candidate) => sameMcpServerUrl(candidate.url, url));
      if (!server) return { registryConfigured: false };
      if (mcpRegistryState(server, { machine: cached.off.machine, project: cached.off.project }) !== "on") {
        return { registryConfigured: true, serverName: server.name, off: true };
      }
      const key = mcpOAuthVaultKey(server.name);
      const token = parseMcpOAuthToken(await args.readSecret(key));
      if (!token || mcpOAuthTokenState(token, server) === "none") return { registryConfigured: true, serverName: server.name };
      let current = token;
      if (token.refreshToken && token.expiresAt && Date.parse(token.expiresAt) - Date.now() < REFRESH_WITHIN_MS) {
        let pending = renewingMcpOAuthTokens.get(key);
        if (!pending) {
          pending = (async () => {
            const refreshed = await refreshMcpOAuthToken(token, fetchImpl);
            if (typeof refreshed === "string") {
              args.logger?.warn("mcp_registry.oauth_refresh_failed", { reason: refreshed });
              return token;
            }
            if (await args.writeSecret(key, JSON.stringify(refreshed))) return refreshed;
            args.logger?.warn("mcp_registry.oauth_refresh_not_saved", { server: server.name });
            return token;
          })().finally(() => renewingMcpOAuthTokens.delete(key));
          renewingMcpOAuthTokens.set(key, pending);
        }
        current = await pending;
      }
      if (mcpOAuthTokenState(current, server) !== "valid") return { registryConfigured: true, serverName: server.name };
      const expiresIn = current.expiresAt
        ? Math.max(0, Math.ceil((Date.parse(current.expiresAt) - Date.now()) / 1000))
        : 3600;
      return { accessToken: current.accessToken, expiresIn, registryConfigured: true };
    } catch (error) {
      args.logger?.warn("mcp_registry.oauth_chat_lookup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { registryConfigured: false };
    }
  };
}

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
  const fetchImpl = options.fetch ?? fetch;
  const signIns = createMcpOAuthSignIns({
    openUrl: options.openUrl ?? (async () => { throw new Error("No browser is available here."); }),
    fetch: fetchImpl,
  });
  // Keyed by URL: the answer is about the server, not about its name here.
  const probes = new Map<string, { at: number; needsSignIn: boolean }>();

  const needsSignIn = async (url: string): Promise<boolean> => {
    const cached = probes.get(url);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.needsSignIn;
    const probe = await probeMcpAuth(url, fetchImpl);
    // Unreachable is not "needs a sign-in": the row must not offer one it can't do.
    const answer = probe.kind === "sign-in";
    if (probe.kind !== "unknown") probes.set(url, { at: Date.now(), needsSignIn: answer });
    return answer;
  };

  // One renewal per vault key at a time. A server that rotates refresh tokens
  // treats a second use of the old one as a replay and can revoke the grant.
  /** The server's stored sign-in, renewed first when it is due. */
  const currentSignIn = async (server: McpRegistryServer): Promise<McpRegistryResult<McpOAuthToken | null>> => {
    const key = mcpOAuthVaultKey(server.name);
    const stored = await vault.get(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, key);
    if (!stored.ok) return stored;
    const token = parseMcpOAuthToken(stored.value);
    if (!token || mcpOAuthTokenState(token, server) === "none" || !token.refreshToken || !token.expiresAt
      || Date.parse(token.expiresAt) - Date.now() >= REFRESH_WITHIN_MS) {
      return { ok: true, value: token };
    }
    let pending = renewingMcpOAuthTokens.get(key);
    if (!pending) {
      pending = (async () => {
        const renewed = await refreshMcpOAuthToken(token, fetchImpl);
        // The sign-in keeps working until it runs out, and the row then asks
        // for a new one, so a failed renewal is logged rather than shown.
        if (typeof renewed === "string") {
          options.logger?.warn("mcp_registry.oauth_refresh_failed", { reason: renewed });
          return token;
        }
        const saved = await vault.set(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, key, JSON.stringify(renewed));
        if (saved.ok) return renewed;
        options.logger?.warn("mcp_registry.oauth_refresh_not_saved", { reason: saved.message });
        return token;
      })().finally(() => renewingMcpOAuthTokens.delete(key));
      renewingMcpOAuthTokens.set(key, pending);
    }
    return { ok: true, value: await pending };
  };

  /** One server's sign-in as the page shows it, renewing it first when it is due. */
  const signInStatus = async (server: McpRegistryServer): Promise<McpRegistryResult<McpServerSignIn | null>> => {
    if (server.transport === "stdio" || !server.url) return { ok: true, value: null };
    const current = await currentSignIn(server);
    if (!current.ok) return current;
    const token = current.value;
    const state = mcpOAuthTokenState(token, server);
    if (state !== "none") return { ok: true, value: { server: server.name, state, expiresAt: token?.expiresAt ?? null } };
    // A server with a header of its own already says how it signs in.
    if (server.headerNames.length) return { ok: true, value: null };
    return { ok: true, value: (await needsSignIn(server.url)) ? { server: server.name, state: "needed", expiresAt: null } : null };
  };

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
      const statuses = await Promise.all(servers.map(signInStatus));
      const failed = statuses.find((status) => !status.ok);
      if (failed && !failed.ok) return failed;
      const signInList = statuses.flatMap((status) => (status.ok && status.value ? [status.value] : []));
      return { ok: true, value: { heldSecretKeys, missingCommands, signIns: signInList } };
    },

    /**
     * Signs one server in through the browser and keeps the token in the
     * account vault. Resolves when the browser comes back, is cancelled, or
     * times out.
     */
    async signIn(rawServer: unknown): Promise<McpRegistrySignInResult> {
      const server = normalizeMcpRegistryServer(rawServer);
      if (!server || server.transport === "stdio" || !server.url) {
        return { ok: false, rejected: true, message: "Only an HTTP or SSE server can be signed in to." };
      }
      const outcome = await signIns.signIn({ name: server.name, url: server.url });
      if (!outcome.ok) {
        return outcome.cancelled
          ? { ok: false, rejected: true, cancelled: true, message: outcome.message }
          : { ok: false, rejected: true, message: outcome.message };
      }
      const saved = await vault.set(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, mcpOAuthVaultKey(server.name), JSON.stringify(outcome.token));
      if (!saved.ok) return saved;
      probes.delete(server.url);
      return { ok: true, value: { server: server.name, state: "valid", expiresAt: outcome.token.expiresAt } };
    },

    cancelSignIn(server: string): boolean {
      return signIns.cancel(server);
    },

    async signOut(server: string): Promise<McpRegistryResult<null>> {
      if (!isValidMcpRegistryName(server)) return INVALID_SECRET;
      return await vault.remove(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, mcpOAuthVaultKey(server));
    },

    /**
     * Renews due sign-ins while ADE runs, so agents stay signed in without the
     * settings page being open. Chats on other computers read the renewed
     * token from the account vault. Returns the stop function.
     */
    startRenewal(): () => void {
      const renewDue = async () => {
        const servers = readCachedMcpRegistry(options.adeHome, null).cached?.servers ?? [];
        for (const server of servers) {
          if (server.transport === "stdio" || !server.url || !server.enabled) continue;
          await currentSignIn(server).catch((error: unknown) => {
            options.logger?.warn("mcp_registry.oauth_renewal_failed", { reason: error instanceof Error ? error.message : String(error) });
          });
        }
      };
      const timer = setInterval(() => void renewDue(), RENEW_EVERY_MS);
      timer.unref?.();
      void renewDue();
      return () => clearInterval(timer);
    },

    dispose(): void {
      signIns.dispose();
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
      // An edit keeps the sign-in; it is dropped only with the server. One for
      // an old URL is ignored at launch, and the next sign-in replaces it.
      return await removeServerSecrets(server, kept && kept.name === server ? [...mcpSecretVaultKeys(kept), mcpOAuthVaultKey(server)] : []);
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
