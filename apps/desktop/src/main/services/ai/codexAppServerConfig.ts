type McpServerRecord = Record<string, unknown>;

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((entry): entry is string => typeof entry === "string");
  return normalized.length === value.length ? normalized : undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([k, v]) => typeof k === "string" && typeof v === "string",
  );
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
      (isFiniteNonNegative(server.startupTimeoutSec) ? server.startupTimeoutSec : undefined)
      ?? (isFiniteNonNegative(server.startup_timeout_sec) ? server.startup_timeout_sec : undefined);
    if (startupTimeoutSec !== undefined) {
      overrides[`${prefix}.startup_timeout_sec`] = startupTimeoutSec;
    }

    const toolTimeoutSec =
      (isFiniteNonNegative(server.toolTimeoutSec) ? server.toolTimeoutSec : undefined)
      ?? (isFiniteNonNegative(server.tool_timeout_sec) ? server.tool_timeout_sec : undefined);
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
      const args = stringArrayOrUndefined(server.args);
      if (args !== undefined) overrides[`${prefix}.args`] = args;
      if (isStringRecord(server.env)) overrides[`${prefix}.env`] = server.env;
      if (typeof server.cwd === "string" && server.cwd.trim().length > 0) overrides[`${prefix}.cwd`] = server.cwd;
      continue;
    }

    if (typeof server.url === "string" && server.url.trim().length > 0) {
      overrides[`${prefix}.url`] = server.url;
      if (typeof server.bearerToken === "string") overrides[`${prefix}.bearer_token`] = server.bearerToken;
      if (typeof server.bearerTokenEnvVar === "string") {
        overrides[`${prefix}.bearer_token_env_var`] = server.bearerTokenEnvVar;
      }
      if (isStringRecord(server.httpHeaders)) {
        overrides[`${prefix}.http_headers`] = server.httpHeaders;
      }
      if (isStringRecord(server.envHttpHeaders)) {
        overrides[`${prefix}.env_http_headers`] = server.envHttpHeaders;
      }
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
