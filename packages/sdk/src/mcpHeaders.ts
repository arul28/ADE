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

function headerNamesOf(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];
  return Object.keys(headers as Record<string, unknown>).filter((name) => name.length > 0);
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
      const names = new Set<string>();
      if (Array.isArray(entry.headerNames)) {
        for (const header of entry.headerNames) if (typeof header === "string" && header) names.add(header);
      }
      if (entry.headers !== undefined) {
        migrated = true;
        for (const header of headerNamesOf(entry.headers)) names.add(header);
      }
      servers[name] = {
        type: entry.type,
        url: entry.url,
        ...(names.size > 0 ? { headerNames: [...names] } : {}),
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
