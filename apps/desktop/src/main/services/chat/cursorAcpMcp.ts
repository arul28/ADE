import type { McpServer } from "@agentclientprotocol/sdk";
import type { ExternalMcpServerConfig } from "../../../shared/types/externalMcp";

/** Maps ADE external MCP stdio configs to ACP MCP server entries. */
export function externalMcpConfigsToAcpStdio(configs: ExternalMcpServerConfig[]): McpServer[] {
  const out: McpServer[] = [];
  for (const c of configs) {
    if (c.transport !== "stdio") continue;
    const command = c.command?.trim();
    if (!command) continue;
    const env: Array<{ name: string; value: string }> = [];
    if (c.env) {
      for (const [name, value] of Object.entries(c.env)) {
        if (!name.trim()) continue;
        env.push({ name: name.trim(), value: String(value ?? "") });
      }
    }
    out.push({
      name: c.name,
      command,
      args: Array.isArray(c.args) ? c.args.map((a) => String(a)) : [],
      env,
    });
  }
  return out;
}
