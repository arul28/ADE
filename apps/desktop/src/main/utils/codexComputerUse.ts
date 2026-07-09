import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type CodexComputerUseMcpConfig = {
  command: string;
  args: ["mcp"];
  enabled: true;
};

export type ResolveCodexComputerUseOptions = {
  platform?: NodeJS.Platform;
  codexHome?: string;
  configText?: string | null;
  verifySignature?: (filePath: string) => boolean;
};

const COMPUTER_USE_PLUGIN_SECTION = 'plugins."computer-use@openai-bundled"';
const COMPUTER_USE_MCP_SECTION = "mcp_servers.computer_use";
const OPENAI_TEAM_IDENTIFIER = "2DC432GLL2";
const COMPUTER_USE_CLIENT_IDENTIFIER = "com.openai.sky.CUAService.cli";
const CLIENT_RELATIVE_PATH = path.join(
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);

function readSectionBody(configText: string, sectionName: string): string | null {
  const lines = configText.replace(/\r\n?/g, "\n").split("\n");
  let active = false;
  const body: string[] = [];
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1]?.trim();
    if (header != null) {
      if (active) break;
      active = header === sectionName;
      continue;
    }
    if (active) body.push(line);
  }
  return active ? body.join("\n") : null;
}

function enabledValue(sectionBody: string): boolean | null {
  const match = sectionBody.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/im);
  if (!match) return null;
  return match[1]?.toLowerCase() === "true";
}

/**
 * Computer Use is powerful enough that ADE never enables it merely because a
 * cached binary happens to exist. The user must have enabled the bundled
 * plugin, or explicitly configured the canonical `computer_use` MCP server.
 */
export function codexComputerUseOptedIn(configText: string): boolean {
  const plugin = readSectionBody(configText, COMPUTER_USE_PLUGIN_SECTION);
  if (plugin != null && enabledValue(plugin) === true) return true;

  const mcp = readSectionBody(configText, COMPUTER_USE_MCP_SECTION);
  if (mcp == null) return false;
  // MCP servers are enabled by default when configured. An explicit false is
  // authoritative; otherwise the section itself is the user's opt-in.
  return enabledValue(mcp) !== false;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const signatureVerificationCache = new Map<string, boolean>();

export function isOpenAiSignedComputerUseClient(filePath: string): boolean {
  let cacheKey = filePath;
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return false;
  }
  const cached = signatureVerificationCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const verification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", filePath],
    { encoding: "utf8", timeout: 5_000 },
  );
  const result = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", filePath],
    { encoding: "utf8", timeout: 5_000 },
  );
  const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const valid = verification.status === 0
    && result.status === 0
    && details.includes(`Identifier=${COMPUTER_USE_CLIENT_IDENTIFIER}`)
    && details.includes(`TeamIdentifier=${OPENAI_TEAM_IDENTIFIER}`);
  signatureVerificationCache.set(cacheKey, valid);
  return valid;
}

function compareVersionDirectoryNames(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return left.localeCompare(right);
}

export function codexComputerUseClientCandidates(codexHome: string): string[] {
  const candidates = [path.join(codexHome, "computer-use", CLIENT_RELATIVE_PATH)];
  const cacheRoot = path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
  try {
    const versions = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => compareVersionDirectoryNames(right, left));
    for (const version of versions) {
      candidates.push(path.join(cacheRoot, version, CLIENT_RELATIVE_PATH));
    }
  } catch {
    // The stable installation path above can still be available without a
    // plugin cache. Missing cache directories are expected on first install.
  }
  return candidates;
}

export function resolveCodexComputerUseMcpConfig(
  options: ResolveCodexComputerUseOptions = {},
): CodexComputerUseMcpConfig | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const codexHome = options.codexHome?.trim()
    || process.env.CODEX_HOME?.trim()
    || path.join(os.homedir(), ".codex");
  let configText = options.configText;
  if (configText === undefined) {
    try {
      configText = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    } catch {
      configText = null;
    }
  }
  if (!configText || !codexComputerUseOptedIn(configText)) return null;

  const verifySignature = options.verifySignature ?? isOpenAiSignedComputerUseClient;
  const command = codexComputerUseClientCandidates(codexHome)
    .find((candidate) => isExecutable(candidate) && verifySignature(candidate));
  if (!command) return null;
  return { command, args: ["mcp"], enabled: true };
}
