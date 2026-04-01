import { describe, expect, it } from "vitest";
import { buildCodexAppServerMcpConfigOverrides } from "./codexAppServerConfig";

describe("buildCodexAppServerMcpConfigOverrides", () => {
  it("maps ADE stdio MCP server settings into Codex app-server config overrides", () => {
    const result = buildCodexAppServerMcpConfigOverrides({
      ade: {
        transport: "stdio",
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
        required: true,
        startup_timeout_sec: 30,
        tool_timeout_sec: 120,
      },
    });

    expect(result).toEqual({
      "mcp_servers.ade.required": true,
      "mcp_servers.ade.startup_timeout_sec": 30,
      "mcp_servers.ade.tool_timeout_sec": 120,
      "mcp_servers.ade.command": "node",
      "mcp_servers.ade.args": ["/tmp/mcp-server.js"],
      "mcp_servers.ade.env": { ADE_RUN_ID: "run-1" },
    });
  });

  it("supports camelCase timeout keys and HTTP MCP servers", () => {
    const result = buildCodexAppServerMcpConfigOverrides({
      docs: {
        transport: "http",
        url: "https://mcp.example.com",
        startupTimeoutSec: 15,
        toolTimeoutSec: 45,
        httpHeaders: { "x-tenant": "acme" },
        envHttpHeaders: { Authorization: "MCP_AUTH" },
      },
    });

    expect(result).toEqual({
      "mcp_servers.docs.startup_timeout_sec": 15,
      "mcp_servers.docs.tool_timeout_sec": 45,
      "mcp_servers.docs.url": "https://mcp.example.com",
      "mcp_servers.docs.http_headers": { "x-tenant": "acme" },
      "mcp_servers.docs.env_http_headers": { Authorization: "MCP_AUTH" },
    });
  });

  it("returns undefined when no MCP servers are configured", () => {
    expect(buildCodexAppServerMcpConfigOverrides()).toBeUndefined();
  });
});
