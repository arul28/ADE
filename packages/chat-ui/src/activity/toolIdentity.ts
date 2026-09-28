/**
 * One reading of a tool name, whichever provider spelled it.
 *
 * The same MCP tool reaches a host under three spellings: Claude names it
 * `mcp__versic__search`, Codex `versic:search`, and a permission policy
 * `mcp:versic:search`. A host that keyed its labels on one spelling missed the
 * other two and had to list every tool three times. Everything that compares
 * tool names in this package goes through `parseToolIdentity`, so it does not.
 *
 * Mirrors `parseToolIdentity` in `@ade-dev/sdk` (>= 0.3). It is a copy, not an
 * import, because the SDK is an optional peer and this runs in a browser; keep
 * the two rules identical.
 */

/** A tool name split into the MCP server that owns it and the tool itself. */
export type ToolIdentity = {
  /** The MCP server, or null for a provider built-in (`Bash`, `Read`, …). */
  server: string | null;
  /** The tool name without any server prefix. */
  tool: string;
};

/**
 * Split a tool name into `{ server, tool }`.
 *
 *   mcp__srv__tool  -> { server: "srv", tool: "tool" }   (Claude)
 *   mcp:srv:tool    -> { server: "srv", tool: "tool" }   (policy form)
 *   srv:tool        -> { server: "srv", tool: "tool" }   (Codex)
 *   tool            -> { server: null,  tool: "tool" }
 *
 * A name that has a prefix but nothing after it (`mcp__srv`, `srv:`) is read
 * as a bare tool rather than as a server with an empty tool, so a malformed
 * name never matches every tool on some server.
 */
export function parseToolIdentity(name: string): ToolIdentity {
  const raw = (name ?? "").trim();
  if (raw.startsWith("mcp__")) {
    const rest = raw.slice("mcp__".length);
    const separator = rest.indexOf("__");
    if (separator > 0 && separator + 2 < rest.length) {
      return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
    }
    return { server: null, tool: raw };
  }
  const body = raw.startsWith("mcp:") ? raw.slice("mcp:".length) : raw;
  const separator = body.indexOf(":");
  if (separator > 0 && separator + 1 < body.length) {
    return { server: body.slice(0, separator), tool: body.slice(separator + 1) };
  }
  return { server: null, tool: raw };
}
