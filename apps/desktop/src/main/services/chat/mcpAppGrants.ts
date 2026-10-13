import { createHash } from "node:crypto";

import type { McpAppGrant } from "../../../shared/mcpApp";

/**
 * "Always allow" answers for an MCP App's tool calls.
 *
 * One grant is one MCP server + one tool name, for this project. It lives in
 * the project's key-value store (`ade.db`, key {@link MCP_APP_GRANTS_KEY}), so
 * it survives a restart and goes away with the project's ADE state.
 *
 * A grant also holds a fingerprint of the server's definition (its command
 * and arguments, or its URL) when ADE can read one. A server removed and added
 * again under the same name with another command is then a different server:
 * the fingerprint differs and the grant does not apply. A grant made without a
 * fingerprint applies only while the server still has none, and one made with
 * a fingerprint never applies to a server ADE cannot fingerprint.
 *
 * A grant is not a way around anything else: the tool must still be open to
 * apps, the call must still come right after a click in the app's frame, and
 * it still runs through the chat's live session.
 */

export const MCP_APP_GRANTS_KEY = "agent-chat:mcp-app-grants:v1";
/** Grants kept per project; the oldest goes first. */
const MAX_GRANTS = 200;

type StoredGrants = { grants: McpAppGrant[] };

/**
 * What identifies a server's definition: how it is started or where it is.
 * Environment variables and headers are left out on purpose: they hold
 * secrets, and rotating a token is not a different server.
 */
export function mcpServerFingerprint(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const record = config as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : null;
  const url = typeof record.url === "string" ? record.url : null;
  if (!command && !url) return null;
  const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
  return createHash("sha256").update(JSON.stringify(command ? ["command", command, args] : ["url", url])).digest("hex").slice(0, 32);
}

export type McpAppGrantStore = {
  has(server: string, tool: string, fingerprint: string | null): boolean;
  add(server: string, tool: string, fingerprint: string | null): void;
  /** Removes every grant for the server and tool, whatever its fingerprint. True when one existed. */
  remove(server: string, tool: string): boolean;
  list(server: string): McpAppGrant[];
};

export function createMcpAppGrantStore(deps: {
  load: () => unknown;
  save: (value: StoredGrants) => void;
  now?: () => number;
}): McpAppGrantStore {
  const read = (): McpAppGrant[] => {
    const raw = deps.load();
    const grants = raw && typeof raw === "object" && Array.isArray((raw as StoredGrants).grants) ? (raw as StoredGrants).grants : [];
    return grants.filter((grant): grant is McpAppGrant =>
      Boolean(grant)
      && typeof grant.server === "string"
      && typeof grant.tool === "string"
      && (grant.fingerprint === null || typeof grant.fingerprint === "string")
      && typeof grant.grantedAt === "string");
  };
  return {
    has: (server, tool, fingerprint) =>
      read().some((grant) => grant.server === server && grant.tool === tool && grant.fingerprint === fingerprint),
    add(server, tool, fingerprint) {
      // Only the grant for this same definition is replaced. A Claude chat
      // knows a server's fingerprint and a Codex chat may not, and dropping
      // every grant for the name made each provider's "Always" undo the other's.
      const kept = read().filter((grant) =>
        !(grant.server === server && grant.tool === tool && grant.fingerprint === fingerprint));
      kept.push({ server, tool, fingerprint, grantedAt: new Date((deps.now ?? Date.now)()).toISOString() });
      deps.save({ grants: kept.slice(-MAX_GRANTS) });
    },
    remove(server, tool) {
      const all = read();
      const kept = all.filter((grant) => !(grant.server === server && grant.tool === tool));
      if (kept.length === all.length) return false;
      deps.save({ grants: kept });
      return true;
    },
    list: (server) => read().filter((grant) => grant.server === server),
  };
}
