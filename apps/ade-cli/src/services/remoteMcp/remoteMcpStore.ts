import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import type {
  RemoteMcpConnectionKind,
  RemoteMcpConnectionSummary,
  RemoteMcpScope,
} from "../../../../desktop/src/shared/types/remoteMcp";

export type { RemoteMcpConnectionKind, RemoteMcpConnectionSummary };

/**
 * This machine's ADE MCP: whether it is on, and every connection that
 * may use it. Lives with the machine's other secrets and is written only by
 * this brain (Settings and `ade mcp` both go through its actions).
 *
 * A connection's token is never stored, only its SHA-256. The token itself is
 * shown once, when it is made. Revoking deletes the record, so the token stops
 * working on the next request.
 */

/** The stored record: what Settings and the CLI see, plus the token's hash. */
export type RemoteMcpConnection = RemoteMcpConnectionSummary & { tokenHash: string };

type RemoteMcpFile = {
  version: 1;
  enabled: boolean;
  connections: RemoteMcpConnection[];
};

export const MAX_REMOTE_MCP_CONNECTIONS = 50;
export const MAX_REMOTE_MCP_LABEL_CHARS = 60;
export const REMOTE_MCP_TOKEN_PREFIX = "ade_mcp_";
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const EMPTY: RemoteMcpFile = { version: 1, enabled: false, connections: [] };

export function hashRemoteMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintRemoteMcpToken(): string {
  return `${REMOTE_MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Strips control characters and bounds a label a person or an app chose. */
export function cleanRemoteMcpLabel(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > MAX_REMOTE_MCP_LABEL_CHARS ? `${clean.slice(0, MAX_REMOTE_MCP_LABEL_CHARS - 1)}…` : clean;
}

function isScope(value: unknown): value is RemoteMcpScope {
  return value === "read" || value === "write";
}

function parseConnection(value: unknown): RemoteMcpConnection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[a-f0-9]{8,32}$/.test(record.id)) return null;
  if (typeof record.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(record.tokenHash)) return null;
  if (record.kind !== "app" && record.kind !== "token") return null;
  if (!isScope(record.scope)) return null;
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
  };
}

export function summarizeRemoteMcpConnection(connection: RemoteMcpConnection): RemoteMcpConnectionSummary {
  const { tokenHash: _tokenHash, ...summary } = connection;
  return summary;
}

export type RemoteMcpStore = ReturnType<typeof createRemoteMcpStore>;

export function createRemoteMcpStore(args: { filePath: string; now?: () => Date }) {
  const now = args.now ?? (() => new Date());
  let cache: { mtimeMs: number; size: number; file: RemoteMcpFile } | null = null;
  // lastUsedAt is bumped in memory on every call and persisted at most once a
  // minute per connection, so a busy app does not rewrite the file per request.
  const lastPersistedUse = new Map<string, number>();

  const read = (): RemoteMcpFile => {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(args.filePath);
    } catch {
      cache = null;
      return { ...EMPTY, connections: [] };
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.file;
    let file: RemoteMcpFile = { ...EMPTY, connections: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(args.filePath, "utf8")) as Record<string, unknown>;
      if (parsed && parsed.version === 1) {
        file = {
          version: 1,
          enabled: parsed.enabled === true,
          connections: Array.isArray(parsed.connections)
            ? parsed.connections.map(parseConnection).filter((entry): entry is RemoteMcpConnection => entry !== null)
            : [],
        };
      }
    } catch {
      // An unreadable file fails closed: off, with no connections. The next
      // write replaces it.
    }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, file };
    return file;
  };

  const write = (file: RemoteMcpFile): void => {
    writeTextAtomic(args.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    cache = null;
  };

  const update = (mutate: (file: RemoteMcpFile) => RemoteMcpFile): RemoteMcpFile => {
    const current = read();
    const next = mutate({ ...current, connections: current.connections.map((entry) => ({ ...entry })) });
    write(next);
    return next;
  };

  return {
    isEnabled(): boolean {
      return read().enabled;
    },

    setEnabled(enabled: boolean): void {
      update((file) => ({ ...file, enabled }));
    },

    list(): RemoteMcpConnectionSummary[] {
      return read().connections.map(summarizeRemoteMcpConnection);
    },

    /** Makes a connection and returns its token, which is not kept anywhere. */
    create(input: {
      kind: RemoteMcpConnectionKind;
      label: string;
      scope: RemoteMcpScope;
      redirectHost?: string | null;
    }): { token: string; connection: RemoteMcpConnectionSummary } {
      const current = read();
      if (current.connections.length >= MAX_REMOTE_MCP_CONNECTIONS) {
        throw new Error(
          `This computer already has ${MAX_REMOTE_MCP_CONNECTIONS} ADE MCP connections. Remove one in Settings first.`,
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
      };
      update((file) => ({ ...file, connections: [...file.connections, connection] }));
      return { token, connection: summarizeRemoteMcpConnection(connection) };
    },

    update(id: string, patch: { scope?: RemoteMcpScope; label?: string }): RemoteMcpConnectionSummary {
      let found: RemoteMcpConnection | null = null;
      update((file) => ({
        ...file,
        connections: file.connections.map((entry) => {
          if (entry.id !== id) return entry;
          found = {
            ...entry,
            ...(patch.scope && isScope(patch.scope) ? { scope: patch.scope } : {}),
            ...(patch.label !== undefined ? { label: cleanRemoteMcpLabel(patch.label, entry.label) } : {}),
          };
          return found;
        }),
      }));
      if (!found) throw new Error("That ADE MCP connection no longer exists.");
      return summarizeRemoteMcpConnection(found);
    },

    remove(id: string): boolean {
      let removed = false;
      update((file) => {
        const connections = file.connections.filter((entry) => entry.id !== id);
        removed = connections.length !== file.connections.length;
        return { ...file, connections };
      });
      lastPersistedUse.delete(id);
      return removed;
    },

    /** The connection a bearer token belongs to, or null. */
    authenticate(token: string): RemoteMcpConnectionSummary | null {
      if (!token.startsWith(REMOTE_MCP_TOKEN_PREFIX) || token.length > 200) return null;
      const presented = Buffer.from(hashRemoteMcpToken(token), "hex");
      let match: RemoteMcpConnection | null = null;
      for (const entry of read().connections) {
        // Compare every record so the time taken does not say which one matched.
        if (timingSafeEqual(presented, Buffer.from(entry.tokenHash, "hex")) && !match) match = entry;
      }
      return match ? summarizeRemoteMcpConnection(match) : null;
    },

    recordUse(id: string): void {
      const at = now();
      const last = lastPersistedUse.get(id) ?? 0;
      if (at.getTime() - last < LAST_USED_WRITE_INTERVAL_MS) return;
      lastPersistedUse.set(id, at.getTime());
      try {
        update((file) => ({
          ...file,
          connections: file.connections.map((entry) => (entry.id === id ? { ...entry, lastUsedAt: at.toISOString() } : entry)),
        }));
      } catch {
        // Last-used is informational; a failed write must not fail the call.
      }
    },
  };
}
