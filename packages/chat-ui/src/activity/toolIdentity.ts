/**
 * One tool name, four spellings.
 *
 * The same MCP tool reaches a host under different names depending on who
 * produced the string: Claude's transcript says `mcp__versic__search`, a
 * permission policy says `mcp:versic:search`, Codex and several ACP dialects
 * say `versic:search`, and a built-in is bare (`Bash`). A host that labels
 * tool chips or matches its own rules had to list every tool three times and
 * keep a private matcher in step with this package. This is that matcher.
 */

/** A tool name split into the server that owns it and the tool itself. */
export type ToolIdentity = {
  /** The MCP server, or null for a built-in or a name with no server part. */
  server: string | null;
  /** The tool name on that server, or the whole name when there is none. */
  tool: string;
};

/**
 * Split a tool name into `{ server, tool }`.
 *
 * Accepts, in this order:
 *   - `mcp__<server>__<tool>` — Claude's spelling. The server is the segment
 *     up to the next `__`; everything after it is the tool, so a tool whose
 *     own name contains `__` survives intact.
 *   - `mcp:<server>:<tool>` — the permission-policy spelling. `*` is a valid
 *     tool here and is returned as-is.
 *   - `<server>:<tool>` — Codex and ACP dialects.
 *   - `<tool>` — a built-in. `server` is null.
 *
 * Never throws. Surrounding whitespace is trimmed. A name that starts with
 * an `mcp__` or `mcp:` prefix but has an empty server or tool segment
 * (`mcp__srv`, `mcp:srv`, `srv:`) is returned whole as a bare tool rather than
 * split into an invented server: a half-formed MCP name is not evidence of
 * which server owns it.
 *
 * A verbatim copy of `parseToolIdentity` in `@ade-dev/sdk` (>= 0.3,
 * `packages/sdk/src/toolIdentity.ts`), so the two files diff cleanly. It is a
 * copy, not an import, because the SDK is an optional peer and this runs in a
 * browser; change the two together.
 */
export function parseToolIdentity(name: string): ToolIdentity {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.startsWith("mcp__")) {
    const rest = trimmed.slice("mcp__".length);
    const split = rest.indexOf("__");
    if (split > 0 && split + 2 < rest.length) {
      return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
    }
    return { server: null, tool: trimmed };
  }
  if (trimmed.startsWith("mcp:")) {
    const rest = trimmed.slice("mcp:".length);
    const split = rest.indexOf(":");
    if (split > 0 && split + 1 < rest.length) {
      return { server: rest.slice(0, split), tool: rest.slice(split + 1) };
    }
    return { server: null, tool: trimmed };
  }
  const split = trimmed.indexOf(":");
  if (split > 0 && split + 1 < trimmed.length) {
    return { server: trimmed.slice(0, split), tool: trimmed.slice(split + 1) };
  }
  return { server: null, tool: trimmed };
}
