import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getErrorMessage, isEnoentError, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { securePrivatePath } from "../../lib/trustedWindowsTools";
import type { AccountVaultStore } from "../account/accountVaultStore";
import {
  isRemoteMcpScope,
  type RemoteMcpConnectionKind,
  type RemoteMcpConnectionSummary,
  type RemoteMcpScope,
} from "../../../../desktop/src/shared/types/remoteMcp";
import { isRemoteMcpMachineKey } from "./remoteMcpAccount";

/**
 * The account's ADE MCP connections, kept in the account vault so a token
 * works on every computer of the account.
 *
 * Vault item: scope `all`, kind `ade_mcp`, key `connection:<id>`, value the
 * JSON of `RemoteMcpConnection` without `lastUsedAt`. A connection's token is
 * never stored anywhere, only its SHA-256. Revoking deletes the item; each
 * computer drops it on its next vault pull (at most about a minute later,
 * see `remoteMcpService.authenticate`).
 *
 * Before accounts, each computer kept its own `<secrets>/remote-mcp.json`.
 * `readLegacyRemoteMcpFile` reads it once for the migration into the vault;
 * a connection copied from it keeps the computer it was made on
 * (`machineKey`), so it does not start reaching every computer of the account.
 */

/**
 * The stored record: what Settings and the CLI see, plus the token's hash, for
 * an app which registration it signed in with, and for a connection made
 * before accounts the one computer it may reach.
 */
type RemoteMcpConnection = Omit<RemoteMcpConnectionSummary, "onlyMachine"> & {
  tokenHash: string;
  clientKey?: string;
  machineKey?: string;
};

const MAX_REMOTE_MCP_CONNECTIONS = 50;
const MAX_REMOTE_MCP_LABEL_CHARS = 60;
export const REMOTE_MCP_TOKEN_PREFIX = "ade_mcp_";

export const REMOTE_MCP_VAULT_SCOPE = "all";
export const REMOTE_MCP_VAULT_KIND = "ade_mcp";
export const REMOTE_MCP_ACCOUNT_SECRET_KEY = "account-secret";
const CONNECTION_KEY_PREFIX = "connection:";

/** A write the account stores refused because the signed-in account changed under it. */
export const REMOTE_MCP_SAVE_FAILED = "ADE couldn't save this to your ADE account: the signed-in account changed. Try again.";

/** The slice of the account vault ADE MCP uses. */
export type RemoteMcpVault = Pick<AccountVaultStore, "list" | "get" | "set" | "remove" | "sync">;

function hashRemoteMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintRemoteMcpToken(): string {
  return `${REMOTE_MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Strips control characters and bounds a label a person or an app chose. */
export function cleanRemoteMcpLabel(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > MAX_REMOTE_MCP_LABEL_CHARS ? `${clean.slice(0, MAX_REMOTE_MCP_LABEL_CHARS - 1)}…` : clean;
}

function parseConnection(value: unknown): RemoteMcpConnection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[a-f0-9]{8,32}$/.test(record.id)) return null;
  if (typeof record.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(record.tokenHash)) return null;
  if (record.kind !== "app" && record.kind !== "token") return null;
  if (!isRemoteMcpScope(record.scope)) return null;
  return {
    id: record.id,
    kind: record.kind,
    label: cleanRemoteMcpLabel(record.label, record.kind === "app" ? "AI app" : "Token"),
    scope: record.scope,
    tokenHash: record.tokenHash,
    tokenHint: typeof record.tokenHint === "string" ? record.tokenHint.slice(-4) : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
    redirectHost: typeof record.redirectHost === "string" ? record.redirectHost.slice(0, 253) : null,
    ...(typeof record.clientKey === "string" && /^[a-f0-9]{64}$/.test(record.clientKey) ? { clientKey: record.clientKey } : {}),
    ...(isRemoteMcpMachineKey(record.machineKey) ? { machineKey: record.machineKey } : {}),
  };
}

/** What Settings and the CLI see: no hash or registration, and the one computer by name when there is one. */
function summarizeRemoteMcpConnection(
  connection: RemoteMcpConnection,
  machineName: (machineKey: string) => string | null,
): RemoteMcpConnectionSummary {
  const { tokenHash: _tokenHash, clientKey: _clientKey, machineKey, ...summary } = connection;
  return {
    ...summary,
    onlyMachine: machineKey ? { machineKey, name: machineName(machineKey) || machineKey.slice(0, 8) } : null,
  };
}

/** The vault value: everything but `lastUsedAt`, which each computer keeps itself. */
function vaultValue(connection: RemoteMcpConnection): string {
  const { lastUsedAt: _lastUsedAt, ...stored } = connection;
  return JSON.stringify(stored);
}

type StoreLogger = { warn?: (event: string, data?: Record<string, unknown>) => void };

export function createRemoteMcpStore(args: {
  vault: RemoteMcpVault;
  /** When the connection was last used, newest across the account; null if never. */
  lastUsedAt: (id: string) => string | null;
  /** A computer's name for a connection kept to one computer; null when unknown. */
  machineName: (machineKey: string) => string | null;
  logger?: StoreLogger;
  now?: () => Date;
}) {
  const now = args.now ?? (() => new Date());
  // Parsed vault values by key, reused while the item's stamp is unchanged so
  // a token check does not parse every connection's JSON per request.
  let parsed = new Map<string, { updatedAt: string; connection: RemoteMcpConnection | null }>();

  const read = (): RemoteMcpConnection[] => {
    const next = new Map<string, { updatedAt: string; connection: RemoteMcpConnection | null }>();
    const out: RemoteMcpConnection[] = [];
    for (const row of args.vault.list(REMOTE_MCP_VAULT_SCOPE)) {
      if (row.kind !== REMOTE_MCP_VAULT_KIND || !row.key.startsWith(CONNECTION_KEY_PREFIX)) continue;
      if (row.deleted || !row.readable) continue;
      const cached = parsed.get(row.key);
      let connection: RemoteMcpConnection | null;
      if (cached && cached.updatedAt === row.updatedAt) {
        connection = cached.connection;
      } else {
        const raw = args.vault.get(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, row.key);
        try {
          connection = raw ? parseConnection(JSON.parse(raw)) : null;
        } catch (error) {
          args.logger?.warn?.("remote_mcp.connection_unreadable", { key: row.key, error: getErrorMessage(error) });
          connection = null;
        }
        // The key names the record; a value claiming another id is not trusted.
        if (connection && `${CONNECTION_KEY_PREFIX}${connection.id}` !== row.key) connection = null;
      }
      next.set(row.key, { updatedAt: row.updatedAt, connection });
      if (connection) out.push(connection);
    }
    parsed = next;
    return out.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  };

  const summarize = (connection: RemoteMcpConnection): RemoteMcpConnectionSummary =>
    summarizeRemoteMcpConnection(connection, args.machineName);

  const withLastUsed = (connection: RemoteMcpConnection): RemoteMcpConnectionSummary => ({
    ...summarize(connection),
    lastUsedAt: args.lastUsedAt(connection.id) ?? connection.lastUsedAt ?? null,
  });

  const save = (connection: RemoteMcpConnection): void => {
    const ok = args.vault.set(
      REMOTE_MCP_VAULT_SCOPE,
      REMOTE_MCP_VAULT_KIND,
      `${CONNECTION_KEY_PREFIX}${connection.id}`,
      vaultValue(connection),
    );
    if (!ok) throw new Error(REMOTE_MCP_SAVE_FAILED);
  };

  const drop = (id: string): boolean =>
    args.vault.remove(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, `${CONNECTION_KEY_PREFIX}${id}`);

  return {
    list(): RemoteMcpConnectionSummary[] {
      return read().map(withLastUsed);
    },

    /** Whether the vault already holds this connection id (tombstones count as absent). */
    has(id: string): boolean {
      return read().some((entry) => entry.id === id);
    },

    /**
     * Copies a connection as it is (same id and hash), for the legacy
     * migration, kept to the computer it was made on.
     */
    importConnection(connection: RemoteMcpConnection, machineKey: string): void {
      save({ ...connection, machineKey });
    },

    /** Makes a connection and returns its token, which is not kept anywhere. */
    create(input: {
      kind: RemoteMcpConnectionKind;
      label: string;
      scope: RemoteMcpScope;
      redirectHost?: string | null;
      /**
       * The app registration this sign-in came from. Signing in again with the
       * same one replaces that connection, so an app that re-authorizes does
       * not pile up rows (or fill the cap) with tokens it no longer uses.
       */
      clientKey?: string;
    }): { token: string; connection: RemoteMcpConnectionSummary } {
      const current = read();
      const replaced = input.clientKey ? current.filter((entry) => entry.clientKey === input.clientKey) : [];
      if (current.length - replaced.length >= MAX_REMOTE_MCP_CONNECTIONS) {
        throw new Error(
          `Your ADE account already has ${MAX_REMOTE_MCP_CONNECTIONS} ADE MCP connections. Remove one in Settings first.`,
        );
      }
      const token = mintRemoteMcpToken();
      const connection: RemoteMcpConnection = {
        id: randomBytes(8).toString("hex"),
        kind: input.kind,
        label: cleanRemoteMcpLabel(input.label, input.kind === "app" ? "AI app" : "Token"),
        scope: input.scope,
        tokenHash: hashRemoteMcpToken(token),
        tokenHint: token.slice(-4),
        createdAt: now().toISOString(),
        lastUsedAt: null,
        redirectHost: input.redirectHost ?? null,
        ...(input.clientKey ? { clientKey: input.clientKey } : {}),
      };
      save(connection);
      for (const old of replaced) drop(old.id);
      return { token, connection: summarize(connection) };
    },

    update(id: string, patch: { scope?: RemoteMcpScope; label?: string }): RemoteMcpConnectionSummary {
      const found = read().find((entry) => entry.id === id);
      if (!found) throw new Error("That ADE MCP connection no longer exists.");
      const next: RemoteMcpConnection = {
        ...found,
        ...(patch.scope && isRemoteMcpScope(patch.scope) ? { scope: patch.scope } : {}),
        ...(patch.label !== undefined ? { label: cleanRemoteMcpLabel(patch.label, found.label) } : {}),
      };
      save(next);
      return withLastUsed(next);
    },

    remove(id: string): boolean {
      if (!read().some((entry) => entry.id === id)) return false;
      if (!drop(id)) throw new Error(REMOTE_MCP_SAVE_FAILED);
      return true;
    },

    /** The connection a bearer token belongs to, or null. Reads this computer's vault copy only. */
    authenticate(token: string): RemoteMcpConnectionSummary | null {
      if (!token.startsWith(REMOTE_MCP_TOKEN_PREFIX) || token.length > 200) return null;
      const presented = Buffer.from(hashRemoteMcpToken(token), "hex");
      let match: RemoteMcpConnection | null = null;
      for (const entry of read()) {
        // Compare every record so the time taken does not say which one matched.
        if (timingSafeEqual(presented, Buffer.from(entry.tokenHash, "hex")) && !match) match = entry;
      }
      return match ? withLastUsed(match) : null;
    },
  };
}

// ── The per-computer file from before accounts ─────────────────────────────

type LegacyRemoteMcpFile = {
  enabled: boolean;
  connections: RemoteMcpConnection[];
  /** Set once its contents went to the account. */
  migratedAt: string | null;
};

/** `<secrets>/remote-mcp.json`, or null when there is none (or it cannot be read). */
export function readLegacyRemoteMcpFile(filePath: string, logger?: StoreLogger): LegacyRemoteMcpFile | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // No file is the usual case; anything else (permissions, a directory) is worth a line.
    if (!isEnoentError(error)) logger?.warn?.("remote_mcp.legacy_store_unreadable", { error: getErrorMessage(error) });
    return null;
  }
  try {
    const parsedFile = JSON.parse(text) as Record<string, unknown>;
    if (!parsedFile || parsedFile.version !== 1) return null;
    return {
      enabled: parsedFile.enabled === true,
      connections: Array.isArray(parsedFile.connections)
        ? parsedFile.connections.map(parseConnection).filter((entry): entry is RemoteMcpConnection => entry !== null)
        : [],
      migratedAt: typeof parsedFile.migratedAt === "string" ? parsedFile.migratedAt : null,
    };
  } catch (error) {
    logger?.warn?.("remote_mcp.legacy_store_unreadable", { error: getErrorMessage(error) });
    return null;
  }
}

/**
 * Empties the legacy file once the account holds its contents. An older ADE
 * that reads it afterwards sees ADE MCP off with no connections.
 */
export function markLegacyRemoteMcpFileMigrated(filePath: string, at: Date): void {
  writeTextAtomic(
    filePath,
    `${JSON.stringify({ version: 1, enabled: false, connections: [], migratedAt: at.toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  securePrivatePath(filePath);
}
