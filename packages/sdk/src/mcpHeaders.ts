import { createHash } from "node:crypto";
import type { McpServerConfig } from "./types.js";

/**
 * MCP header values are credentials, and they never touch disk here.
 *
 * A host's MCP server usually authenticates with a bearer token in
 * `headers.Authorization`. Until 0.3 the SDK wrote that token into
 * `<home>/threads.json` so a recreate could rebuild the thread, which left a
 * plaintext credential in the SDK home and — worse — replayed a STALE one on
 * every resume after the host rotated it, so old threads failed MCP auth for
 * good. The durable record now keeps only the header NAMES. The values are
 * resolved again at every create, resume and restart, from the caller's
 * `refresh.mcpServers` or from the client's `mcpHeaders` callback.
 *
 * RUNTIME TWIN. The runtime withholds header values from its own durable
 * session record the same way: `withholdCallerMcpHeaderValues` (and
 * `normalizeHeaderNames`) in `apps/desktop/src/shared/callerMcpServers.ts`.
 * Keep the two in step — names only, trimmed, empty names dropped, and
 * deduplicated case-insensitively (HTTP header names are case-insensitive, so
 * `Authorization` and `authorization` are one header), first spelling kept.
 */

/** A caller MCP server as it is persisted: header names, never header values. */
export type StoredMcpServerConfig =
  | { type: "http" | "sse"; url: string; headerNames?: string[] }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/**
 * Supplies MCP header values for one server of one thread.
 *
 * Called at every create, resume and restart that needs them; the result is
 * sent to the runtime and never persisted by the SDK. Return undefined for a
 * server that needs no headers.
 */
export type McpHeadersResolver = (
  key: string,
  serverName: string,
) => Record<string, string> | undefined;

function isRemote(
  server: McpServerConfig | StoredMcpServerConfig,
): server is Extract<McpServerConfig, { type: "http" | "sse" }> {
  return server.type === "http" || server.type === "sse";
}

/**
 * Header names, trimmed, empty ones dropped, deduplicated case-insensitively
 * with the first spelling kept — the runtime's `normalizeHeaderNames` rule.
 */
function uniqueHeaderNames(names: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of names) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function headerNamesOf(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];
  return uniqueHeaderNames(Object.keys(headers as Record<string, unknown>));
}

/**
 * The durable form of a server map: every header value dropped, its name kept.
 *
 * Names are kept so a resume can tell "this server needed an Authorization
 * header and nobody supplied one" apart from "this server needs none", and say
 * so rather than connecting unauthenticated in silence.
 */
export function toStoredMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, StoredMcpServerConfig> {
  const stored: Record<string, StoredMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (isRemote(server)) {
      const headerNames = headerNamesOf(server.headers);
      stored[name] = {
        type: server.type,
        url: server.url,
        ...(headerNames.length > 0 ? { headerNames } : {}),
      };
    } else {
      stored[name] = { ...server };
    }
  }
  return stored;
}

/**
 * Reads a persisted server map, stripping header values a pre-0.3 SDK wrote.
 *
 * Returns `migrated: true` when anything was stripped, so the store can
 * rewrite the file and take the plaintext credential off disk.
 */
export function readStoredMcpServers(
  value: unknown,
): { servers: Record<string, StoredMcpServerConfig>; migrated: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const servers: Record<string, StoredMcpServerConfig> = {};
  let migrated = false;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if ((entry.type === "http" || entry.type === "sse") && typeof entry.url === "string") {
      const listed = Array.isArray(entry.headerNames) ? entry.headerNames : [];
      if (entry.headers !== undefined) migrated = true;
      const names = uniqueHeaderNames([...listed, ...headerNamesOf(entry.headers)]);
      servers[name] = {
        type: entry.type,
        url: entry.url,
        ...(names.length > 0 ? { headerNames: names } : {}),
      };
    } else if (entry.type === "stdio" && typeof entry.command === "string") {
      servers[name] = entry as StoredMcpServerConfig;
    }
  }
  return { servers, migrated };
}

/**
 * A server map ready for the wire, with header values filled in.
 *
 * For each remote server: headers the caller passed explicitly win, and the
 * `resolve` callback fills in when the caller passed none. A server whose
 * stored record names headers that neither source supplied is listed in
 * `missing` — it is still sent (unauthenticated), because refusing to open
 * the thread would take the transcript away too, and the caller logs the gap.
 */
export function withResolvedHeaders(
  key: string,
  servers: Record<string, McpServerConfig | StoredMcpServerConfig>,
  resolve: McpHeadersResolver | undefined,
): { servers: Record<string, McpServerConfig>; missing: Array<{ server: string; headerNames: string[] }> } {
  const out: Record<string, McpServerConfig> = {};
  const missing: Array<{ server: string; headerNames: string[] }> = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isRemote(server)) {
      out[name] = { ...(server as Extract<McpServerConfig, { type: "stdio" }>) };
      continue;
    }
    const explicit =
      "headers" in server && server.headers && Object.keys(server.headers).length > 0
        ? server.headers
        : undefined;
    let headers = explicit;
    if (!headers && resolve) {
      const supplied = resolve(key, name);
      if (supplied && typeof supplied === "object" && Object.keys(supplied).length > 0) {
        headers = { ...supplied };
      }
    }
    const wanted = "headerNames" in server && Array.isArray(server.headerNames) ? server.headerNames : [];
    if (!headers && wanted.length > 0) missing.push({ server: name, headerNames: [...wanted] });
    out[name] = { type: server.type, url: server.url, ...(headers ? { headers } : {}) };
  }
  return { servers: out, missing };
}

/** The one log line for servers that went out without the headers they need. */
export function missingHeadersWarning(
  key: string,
  missing: ReadonlyArray<{ server: string; headerNames: string[] }>,
): string | null {
  if (missing.length === 0) return null;
  const list = missing.map((entry) => `${entry.server} (${entry.headerNames.join(", ")})`).join("; ");
  return (
    `ade sdk: thread "${key}" MCP servers need header values the SDK does not persist: ${list}. ` +
    `They were sent without them. Pass refresh.mcpServers to threads.open, or an mcpHeaders ` +
    `callback to createAdeChat, so the host supplies current credentials.`
  );
}

/**
 * A one-way fingerprint of a resolved server map, header values included.
 *
 * Lets a client tell "these are the servers I already pushed" from a real
 * change without keeping the credentials around to compare: a renderer reload
 * that sends the same `refresh` must not make `updateSession` restart the
 * provider for nothing. Key order does not matter. Held in memory only; never
 * persisted.
 */
export function mcpServersFingerprint(servers: Record<string, McpServerConfig>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((name) => [name, canonical((value as Record<string, unknown>)[name])]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(servers))).digest("hex");
}
