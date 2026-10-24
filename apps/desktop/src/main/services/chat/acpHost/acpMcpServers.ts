import type { CallerMcpServers } from "../../../../shared/callerMcpServers";
import type { AcpMcpServer } from "./acpProtocolTypes";

/**
 * ADE's MCP servers (in `CallerMcpServers` form) as the `mcpServers` an ACP
 * session opens with. A server without its command or URL is left out.
 */
export function acpMcpServersFromCaller(servers: CallerMcpServers | null): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  const pairs = (values: Record<string, string> | undefined) =>
    Object.entries(values ?? {}).map(([key, value]) => ({ name: key, value }));
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (server.type === "stdio" && server.command) {
      out.push({ name, command: server.command, args: [...(server.args ?? [])], env: pairs(server.env) });
    } else if ((server.type === "http" || server.type === "sse") && server.url) {
      out.push({ type: server.type, name, url: server.url, headers: pairs(server.headers) });
    }
  }
  return out;
}
