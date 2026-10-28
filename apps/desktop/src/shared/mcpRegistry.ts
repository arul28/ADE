/**
 * The MCP server registry — servers defined once in ADE, for every agent.
 *
 * Each provider CLI keeps its own MCP config, so a server added to Claude does
 * not reach Codex, and a second machine starts with none. A registry server is
 * defined once, travels with the account, and is handed to every chat ADE
 * launches, next to whatever the provider's own config already loads.
 *
 * This module is the whole data model and nothing else — no React, no IPC, no
 * file system. Three values in the account settings store, all plain JSON:
 *
 * - `mcp.servers` (scope `all`): the list, for the whole account.
 * - `device.<id>.mcp.off` (scope `all`): names switched off on one computer.
 * - `mcp.off` (scope `repo:<remote>`): names switched off in one repository.
 *
 * The one rule with teeth: **a registry server never carries a secret.** The
 * list holds the NAMES of its env variables and headers; their values live in
 * the account vault under {@link mcpSecretVaultKey}. Settings rows are stored
 * and synced as readable JSON, the vault is sealed, and a list that held a
 * Bearer token would put it in the wrong one.
 */

import { normalizeCallerMcpServers, type CallerMcpServers } from "./callerMcpServers";
import type { AgentChatMcpServerConfig } from "./types/chat";

/** Account-scoped: the server list. */
export const MCP_SERVERS_SETTING_KEY = "mcp.servers";
/** The per-device and per-repository "switched off here" lists share one key name. */
export const MCP_OFF_SETTING_KEY = "mcp.off";
/** The vault kind registry secrets are stored as. The relay's kind list is closed; this one is its generic member. */
export const MCP_SECRET_VAULT_KIND = "secret";

export const MCP_REGISTRY_LIMITS = {
  maxServers: 32,
  maxNameLength: 64,
  maxFieldNameLength: 128,
  maxArgs: 64,
  maxFieldNames: 32,
  maxStringLength: 2_000,
} as const;

export type McpRegistryTransport = "stdio" | "http" | "sse";

/** What each transport is called on the settings page, in the order it is offered. */
export const MCP_TRANSPORT_LABEL: Readonly<Record<McpRegistryTransport, string>> = {
  stdio: "Command",
  http: "HTTP",
  sse: "SSE",
};

export type McpRegistryServer = {
  /** The name agents see the server's tools under. Unique in the list. */
  name: string;
  transport: McpRegistryTransport;
  /** `stdio`: the program to start, and its arguments. */
  command?: string;
  args?: string[];
  /** `http` / `sse`: where the server answers. */
  url?: string;
  /** Names of the env variables (stdio) whose values are in the vault. */
  envNames: string[];
  /** Names of the headers (http / sse) whose values are in the vault. */
  headerNames: string[];
  /** Off for the whole account without deleting the definition. */
  enabled: boolean;
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Env variable and header names: what a shell and an HTTP header line accept. */
const FIELD_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length && trimmed.length <= MCP_REGISTRY_LIMITS.maxStringLength ? trimmed : null;
}

export function isValidMcpRegistryName(name: string): boolean {
  return name.length <= MCP_REGISTRY_LIMITS.maxNameLength && NAME_PATTERN.test(name);
}

/** True for a name an env variable or a header can be stored under. */
export function isValidMcpFieldName(name: string): boolean {
  return name.length <= MCP_REGISTRY_LIMITS.maxFieldNameLength && FIELD_NAME_PATTERN.test(name);
}

function fieldNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!isValidMcpFieldName(name) || names.includes(name)) continue;
    names.push(name);
    if (names.length >= MCP_REGISTRY_LIMITS.maxFieldNames) break;
  }
  return names;
}

/** One server, or null when it is not a server ADE could launch. */
export function normalizeMcpRegistryServer(value: unknown): McpRegistryServer | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!isValidMcpRegistryName(name)) return null;
  const transport = value.transport;
  const enabled = value.enabled !== false;
  if (transport === "stdio") {
    const command = boundedString(value.command);
    if (!command) return null;
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string" && arg.length <= MCP_REGISTRY_LIMITS.maxStringLength)
        .slice(0, MCP_REGISTRY_LIMITS.maxArgs)
      : [];
    return { name, transport, command, ...(args.length ? { args } : {}), envNames: fieldNames(value.envNames), headerNames: [], enabled };
  }
  if (transport === "http" || transport === "sse") {
    const url = boundedString(value.url);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    return { name, transport, url, envNames: [], headerNames: fieldNames(value.headerNames), enabled };
  }
  return null;
}

/** The stored list. Unknown shapes and duplicate names are dropped, never thrown on. */
export function normalizeMcpRegistry(value: unknown): McpRegistryServer[] {
  if (!Array.isArray(value)) return [];
  const servers: McpRegistryServer[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const server = normalizeMcpRegistryServer(entry);
    if (!server || seen.has(server.name)) continue;
    seen.add(server.name);
    servers.push(server);
    if (servers.length >= MCP_REGISTRY_LIMITS.maxServers) break;
  }
  return servers;
}

/** A stored "switched off here" list. */
export function normalizeMcpOffList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && isValidMcpRegistryName(entry) && !names.includes(entry)) names.push(entry);
  }
  return names;
}

/** Which of a server's two name lists a secret value belongs to. */
export type McpSecretField = "env" | "header";

/** Where one secret value of one server lives in the vault. */
export function mcpSecretVaultKey(serverName: string, field: McpSecretField, fieldName: string): string {
  return `mcp/${serverName}/${field}/${fieldName}`;
}

/** The start of every vault key one server owns. Removing a server removes these. */
export function mcpSecretVaultKeyPrefix(serverName: string): string {
  return `mcp/${serverName}/`;
}

/**
 * True when two server URLs name the same endpoint. A provider reports the
 * URL from its own config, which may differ from the saved one in host case,
 * a default port or a trailing slash; a sign-in must still be found for it.
 */
export function sameMcpServerUrl(left: string | null | undefined, right: string | null | undefined): boolean {
  const key = (value: string | null | undefined): string => {
    const text = value?.trim() ?? "";
    try {
      const url = new URL(text);
      url.hash = "";
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    } catch {
      return text;
    }
  };
  const a = key(left);
  return a.length > 0 && a === key(right);
}

/**
 * Where a server's browser sign-in is kept: one vault item holding a
 * {@link McpOAuthToken} as JSON. It is not one of the server's named values,
 * so the page never asks for it as a missing secret.
 */
export function mcpOAuthVaultKey(serverName: string): string {
  return `mcp/${serverName}/oauth/token`;
}

/** A browser sign-in ADE did for a server, as the vault keeps it. */
export type McpOAuthToken = {
  v: 1;
  /** The server URL it was issued for. A server whose URL changed is signed out. */
  url: string;
  accessToken: string;
  refreshToken: string | null;
  /** ISO time, or null when the server did not say. */
  expiresAt: string | null;
  scope: string | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  resource: string;
};

/** A stored sign-in, or null for anything that is not one. */
export function parseMcpOAuthToken(raw: string | null | undefined): McpOAuthToken | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const text = (entry: unknown): string | null => (typeof entry === "string" && entry.length ? entry : null);
  const url = text(value.url);
  const accessToken = text(value.accessToken);
  const clientId = text(value.clientId);
  const tokenEndpoint = text(value.tokenEndpoint);
  if (!url || !accessToken || !clientId || !tokenEndpoint) return null;
  return {
    v: 1,
    url,
    accessToken,
    refreshToken: text(value.refreshToken),
    expiresAt: text(value.expiresAt),
    scope: text(value.scope),
    clientId,
    clientSecret: text(value.clientSecret),
    tokenEndpoint,
    resource: text(value.resource) ?? url,
  };
}

/** Whether a sign-in is for this server as it is defined now, and still in date. */
export function mcpOAuthTokenState(
  token: McpOAuthToken | null,
  server: Pick<McpRegistryServer, "url">,
  now: number = Date.now(),
): "none" | "valid" | "expired" {
  if (!token || token.url !== server.url) return "none";
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return "expired";
  return "valid";
}

/** Every vault key a server reads at launch, in the order its names are listed. */
export function mcpSecretVaultKeys(server: McpRegistryServer): string[] {
  return [
    ...server.envNames.map((name) => mcpSecretVaultKey(server.name, "env", name)),
    ...server.headerNames.map((name) => mcpSecretVaultKey(server.name, "header", name)),
  ];
}

/** Why a server is or is not handed to chats in one place. */
export type McpRegistryState = "on" | "off-account" | "off-machine" | "off-project";

export function mcpRegistryState(
  server: McpRegistryServer,
  off: { machine: readonly string[]; project: readonly string[] },
): McpRegistryState {
  if (!server.enabled) return "off-account";
  if (off.machine.includes(server.name)) return "off-machine";
  if (off.project.includes(server.name)) return "off-project";
  return "on";
}

/**
 * The registry as a provider adapter takes servers: the same shape an SDK
 * embedder injects, so every provider's existing conversion applies.
 *
 * `secret` answers one vault key, or null when this machine does not hold the
 * value. A server with a missing value is still returned, without that field:
 * a public server whose optional header was never filled in must keep working,
 * and `missing` names what was left out so the caller can say so.
 */
export function mcpRegistryToCallerServers(
  servers: readonly McpRegistryServer[],
  off: { machine: readonly string[]; project: readonly string[] },
  secret: (vaultKey: string) => string | null,
): { servers: CallerMcpServers | null; missing: string[]; signInExpired: string[] } {
  const out: Record<string, AgentChatMcpServerConfig> = {};
  const missing: string[] = [];
  const signInExpired: string[] = [];
  for (const server of servers) {
    if (mcpRegistryState(server, off) !== "on") continue;
    if (server.transport === "stdio") {
      const env: Record<string, string> = {};
      for (const name of server.envNames) {
        const value = secret(mcpSecretVaultKey(server.name, "env", name));
        if (value == null) missing.push(`${server.name}: ${name}`);
        else env[name] = value;
      }
      out[server.name] = {
        type: "stdio",
        command: server.command ?? "",
        ...(server.args?.length ? { args: [...server.args] } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
      continue;
    }
    const headers: Record<string, string> = {};
    for (const name of server.headerNames) {
      const value = secret(mcpSecretVaultKey(server.name, "header", name));
      if (value == null) missing.push(`${server.name}: ${name}`);
      else headers[name] = value;
    }
    // ADE's own browser sign-in, as the header every provider understands. A
    // header the user set by hand wins: it is the more deliberate choice.
    const signIn = parseMcpOAuthToken(secret(mcpOAuthVaultKey(server.name)));
    const signInState = mcpOAuthTokenState(signIn, server);
    if (signIn && signInState === "valid" && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
      headers.Authorization = `Bearer ${signIn.accessToken}`;
    } else if (signInState === "expired") {
      signInExpired.push(server.name);
    }
    out[server.name] = {
      type: server.transport,
      url: server.url ?? "",
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  // The embedder path's own validation is the last word on what a provider
  // can be handed (reserved names, URL shape, the server cap).
  return { servers: Object.keys(out).length ? normalizeCallerMcpServers(out) : null, missing, signInExpired };
}
