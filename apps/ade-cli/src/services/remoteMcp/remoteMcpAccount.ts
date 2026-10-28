import { createHmac, randomBytes } from "node:crypto";
import type { AccountSettingsStore } from "../account/accountSettingsStore";

/**
 * ADE MCP is one server per ADE account. What makes it one lives in the
 * account stores:
 *
 * - The account secret (vault: scope `all`, kind `ade_mcp`, key
 *   `account-secret`): 32 random bytes, base64url. The public account key in
 *   the URL is derived from it (`deriveRemoteMcpAccountKey`); the relay derives
 *   the same key from the secret each brain sends it, so a brain cannot claim
 *   an account it does not hold the secret of.
 * - Account settings (scope `all`): `ade_mcp.enabled`, one
 *   `ade_mcp.machine.<machineKey>` entry per computer that can serve, and
 *   `ade_mcp.lastUsed.<connectionId>`.
 */

export const REMOTE_MCP_SETTINGS_SCOPE = "all";
export const REMOTE_MCP_ENABLED_KEY = "ade_mcp.enabled";
const MACHINE_ENTRY_PREFIX = "ade_mcp.machine.";
const LAST_USED_PREFIX = "ade_mcp.lastUsed.";
const MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/;
const ENDPOINT_KEY_PATTERN = /^[a-f0-9]{32,64}$/;

/** The slice of the account settings store ADE MCP uses. */
export type RemoteMcpSettings = Pick<AccountSettingsStore, "list" | "get" | "set" | "remove" | "sync">;

export const remoteMcpMachineEntryKey = (machineKey: string): string => `${MACHINE_ENTRY_PREFIX}${machineKey}`;
export const remoteMcpLastUsedKey = (connectionId: string): string => `${LAST_USED_PREFIX}${connectionId}`;

export function isRemoteMcpMachineKey(value: unknown): value is string {
  return typeof value === "string" && MACHINE_KEY_PATTERN.test(value);
}

/** A fresh account secret: 32 random bytes, base64url. */
export function mintRemoteMcpAccountSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A secret the vault returned that is shaped like one this code minted. */
export function isRemoteMcpAccountSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The account key in `https://<relay>/a/<accountKey>/mcp`: the first 40 hex
 * characters of HMAC-SHA256(key = utf8(secret), msg = "ade-mcp-account").
 * The relay computes the same thing; keep the two in step.
 */
export function deriveRemoteMcpAccountKey(secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update("ade-mcp-account", "utf8").digest("hex").slice(0, 40);
}

/**
 * One computer's entry. The owner writes name, endpointKey and version; any
 * computer may flip `included` from Settings, and the owner keeps it.
 */
export type RemoteMcpMachineEntry = {
  machineKey: string;
  name: string;
  /** Empty when another computer excluded this one before it ever published. */
  endpointKey: string;
  included: boolean;
  version: string;
  updatedAt: string;
};

function parseMachineEntry(machineKey: string, value: unknown): RemoteMcpMachineEntry | null {
  if (!isRemoteMcpMachineKey(machineKey) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const endpointKey = typeof record.endpointKey === "string" && ENDPOINT_KEY_PATTERN.test(record.endpointKey)
    ? record.endpointKey
    : "";
  return {
    machineKey,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 120) : "",
    endpointKey,
    included: record.included !== false,
    version: typeof record.version === "string" ? record.version.slice(0, 40) : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export function readRemoteMcpMachineEntries(settings: RemoteMcpSettings): Map<string, RemoteMcpMachineEntry> {
  const entries = new Map<string, RemoteMcpMachineEntry>();
  for (const row of settings.list(REMOTE_MCP_SETTINGS_SCOPE)) {
    if (!row.key.startsWith(MACHINE_ENTRY_PREFIX)) continue;
    const machineKey = row.key.slice(MACHINE_ENTRY_PREFIX.length);
    const entry = parseMachineEntry(machineKey, row.value);
    if (entry) entries.set(machineKey, entry);
  }
  return entries;
}

export function readRemoteMcpMachineEntry(settings: RemoteMcpSettings, machineKey: string): RemoteMcpMachineEntry | null {
  return parseMachineEntry(machineKey, settings.get(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpMachineEntryKey(machineKey)));
}

export function writeRemoteMcpMachineEntry(settings: RemoteMcpSettings, entry: RemoteMcpMachineEntry): boolean {
  const { machineKey, ...value } = entry;
  return settings.set(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpMachineEntryKey(machineKey), value);
}

export function isRemoteMcpEnabledForAccount(settings: RemoteMcpSettings): boolean {
  return settings.get(REMOTE_MCP_SETTINGS_SCOPE, REMOTE_MCP_ENABLED_KEY) === true;
}

export function readRemoteMcpLastUsed(settings: RemoteMcpSettings, connectionId: string): string | null {
  const value = settings.get(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpLastUsedKey(connectionId));
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

declare const __ADE_VERSION__: string | undefined;

/** ADE's version, published in this computer's entry and sent as the forwarding user agent. */
export function remoteMcpAdeVersion(): string {
  const bundled = typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__.trim() : "";
  if (bundled && bundled !== "0.0.0") return bundled;
  return process.env.ADE_CLI_VERSION?.trim() || bundled || "0.0.0";
}
