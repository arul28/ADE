import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

type McpServerMap = Record<string, McpServerConfig>;

export type BuildAdeClaudeMcpServersArgs = {
  projectRoot: string;
  workspaceRoot: string;
  sessionId: string;
  laneId: string;
};

const MCP_CONFIG_FILENAMES = [".mcp.json", path.join(".claude", ".mcp.json")];

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function fileExists(filePath: string | undefined | null): filePath is string {
  return Boolean(filePath && fs.existsSync(filePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length ? values : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!isRecord(value)) return null;
  const type = trimToUndefined(value.type);
  const alwaysLoad = booleanValue(value.alwaysLoad);
  if (typeof value.command === "string" && value.command.trim().length > 0 && (!type || type === "stdio")) {
    return {
      ...(type ? { type: "stdio" as const } : {}),
      command: value.command.trim(),
      ...(stringArray(value.args) ? { args: stringArray(value.args) } : {}),
      ...(stringRecord(value.env) ? { env: stringRecord(value.env) } : {}),
      ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    };
  }
  const remoteType = type === "streamable-http" ? "http" : type;
  if ((remoteType === "http" || remoteType === "sse") && typeof value.url === "string" && value.url.trim().length > 0) {
    return {
      type: remoteType,
      url: value.url.trim(),
      ...(stringRecord(value.headers) ? { headers: stringRecord(value.headers) } : {}),
      ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    } as McpServerConfig;
  }
  return null;
}

function readMcpConfigFile(filePath: string): McpServerMap {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const mcpServers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!mcpServers) return {};
  const entries = Object.entries(mcpServers)
    .map(([name, config]) => [name.trim(), normalizeMcpServerConfig(config)] as const)
    .filter((entry): entry is readonly [string, McpServerConfig] => entry[0].length > 0 && Boolean(entry[1]));
  return Object.fromEntries(entries);
}

function resolveAdeCliCommandPath(): string | null {
  const envCli = trimToUndefined(process.env.ADE_CLI_PATH);
  if (fileExists(envCli)) return envCli;

  const envBin = trimToUndefined(process.env.ADE_CLI_BIN_DIR);
  const envBinCli = envBin ? path.join(envBin, process.platform === "win32" ? "ade.cmd" : "ade") : null;
  if (fileExists(envBinCli)) return envBinCli;

  const candidateRoots = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
  ];
  for (const root of candidateRoots) {
    const repoBuilt = path.join(root, "apps", "ade-cli", "dist", "cli.cjs");
    if (fileExists(repoBuilt)) return repoBuilt;
    const siblingBuilt = path.join(root, "ade-cli", "dist", "cli.cjs");
    if (fileExists(siblingBuilt)) return siblingBuilt;
  }

  return null;
}

export function discoverProjectClaudeMcpServers(cwd: string): McpServerMap {
  return MCP_CONFIG_FILENAMES.reduce<McpServerMap>((servers, filename) => ({
    ...servers,
    ...readMcpConfigFile(path.join(cwd, filename)),
  }), {});
}

export function buildAdeClaudeMcpServers(args: BuildAdeClaudeMcpServersArgs): McpServerMap {
  const cliPath = resolveAdeCliCommandPath();
  const command = cliPath && /\.(?:cjs|mjs|js)$/i.test(cliPath) ? process.execPath : cliPath ?? "ade";
  const commandArgs = cliPath && /\.(?:cjs|mjs|js)$/i.test(cliPath) ? [cliPath] : [];
  return {
    ade: {
      type: "stdio",
      command,
      args: [
        ...commandArgs,
        "--headless",
        "--project-root",
        args.projectRoot,
        "--workspace-root",
        args.workspaceRoot,
        "--role",
        "agent",
        "mcp",
      ],
      env: {
        ADE_DEFAULT_ROLE: "agent",
        ADE_CLI_HEADLESS: "1",
        ADE_PROJECT_ROOT: args.projectRoot,
        ADE_WORKSPACE_ROOT: args.workspaceRoot,
        ADE_CHAT_SESSION_ID: args.sessionId,
        ADE_LANE_ID: args.laneId,
        ADE_CLI_NODE: process.execPath,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
    },
  };
}

export function buildClaudeMcpServers(args: BuildAdeClaudeMcpServersArgs): McpServerMap {
  return buildAdeClaudeMcpServers(args);
}
