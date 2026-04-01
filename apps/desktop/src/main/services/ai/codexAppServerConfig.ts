type McpServerRecord = Record<string, unknown>;

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((entry): entry is string => typeof entry === "string");
  return normalized.length === value.length ? normalized : undefined;
}

export function buildCodexAppServerMcpConfigOverrides(
  mcpServers?: Record<string, McpServerRecord>,
): Record<string, unknown> | undefined {
  if (!mcpServers) return undefined;

  const overrides: Record<string, unknown> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    const prefix = `mcp_servers.${name}`;

    const required = typeof server.required === "boolean" ? server.required : undefined;
    if (required !== undefined) {
      overrides[`${prefix}.required`] = required;
    }

    const enabled = typeof server.enabled === "boolean" ? server.enabled : undefined;
    if (enabled !== undefined) {
      overrides[`${prefix}.enabled`] = enabled;
    }

    const startupTimeoutSec =
      (typeof server.startupTimeoutSec === "number" ? server.startupTimeoutSec : undefined)
      ?? (typeof server.startup_timeout_sec === "number" ? server.startup_timeout_sec : undefined);
    if (startupTimeoutSec !== undefined) {
      overrides[`${prefix}.startup_timeout_sec`] = startupTimeoutSec;
    }

    const toolTimeoutSec =
      (typeof server.toolTimeoutSec === "number" ? server.toolTimeoutSec : undefined)
      ?? (typeof server.tool_timeout_sec === "number" ? server.tool_timeout_sec : undefined);
    if (toolTimeoutSec !== undefined) {
      overrides[`${prefix}.tool_timeout_sec`] = toolTimeoutSec;
    }

    const enabledTools = stringArrayOrUndefined(server.enabledTools)
      ?? stringArrayOrUndefined(server.enabled_tools);
    if (enabledTools !== undefined) {
      overrides[`${prefix}.enabled_tools`] = enabledTools;
    }

    const disabledTools = stringArrayOrUndefined(server.disabledTools)
      ?? stringArrayOrUndefined(server.disabled_tools);
    if (disabledTools !== undefined) {
      overrides[`${prefix}.disabled_tools`] = disabledTools;
    }

    if (typeof server.command === "string" && server.command.trim().length > 0) {
      overrides[`${prefix}.command`] = server.command;
      if (Array.isArray(server.args)) overrides[`${prefix}.args`] = server.args;
      if (server.env && typeof server.env === "object") overrides[`${prefix}.env`] = server.env;
      if (typeof server.cwd === "string" && server.cwd.trim().length > 0) overrides[`${prefix}.cwd`] = server.cwd;
      continue;
    }

    if (typeof server.url === "string" && server.url.trim().length > 0) {
      overrides[`${prefix}.url`] = server.url;
      if (typeof server.bearerToken === "string") overrides[`${prefix}.bearer_token`] = server.bearerToken;
      if (typeof server.bearerTokenEnvVar === "string") {
        overrides[`${prefix}.bearer_token_env_var`] = server.bearerTokenEnvVar;
      }
      if (server.httpHeaders && typeof server.httpHeaders === "object") {
        overrides[`${prefix}.http_headers`] = server.httpHeaders;
      }
      if (server.envHttpHeaders && typeof server.envHttpHeaders === "object") {
        overrides[`${prefix}.env_http_headers`] = server.envHttpHeaders;
      }
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
