import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export type CodexComputerUseMcpConfig = {
  command: string;
  args: ["mcp"];
  enabled: true;
};

export type ResolveCodexComputerUseOptions = {
  platform?: NodeJS.Platform;
  codexHome?: string;
  configText?: string | null;
  verifySignature?: (filePath: string) => boolean | Promise<boolean>;
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

type CodesignExecutionResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

function executeCodesign(args: string[]): Promise<CodesignExecutionResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        "/usr/bin/codesign",
        args,
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            ok: error == null,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
    }
  });
}

function signatureVerificationFingerprint(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    // Include filesystem identity and change metadata, not just size/mtime.
    // A replaced binary can preserve its size and mtime; inode/ctime ensure the
    // replacement is verified again before ADE passes it to Codex.
    return [
      filePath,
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join("\0");
  } catch {
    return null;
  }
}

// Cache the in-flight Promise as well as the settled result. Concurrent launch
// and resume requests for the same binary must share one cold codesign pass.
const signatureVerificationCache = new Map<string, Promise<boolean>>();

export async function isOpenAiSignedComputerUseClient(filePath: string): Promise<boolean> {
  const cacheKey = signatureVerificationFingerprint(filePath);
  if (!cacheKey) return false;
  const cached = signatureVerificationCache.get(cacheKey);
  if (cached) return await cached;

  // Keep only the current fingerprint for this path so plugin upgrades do not
  // accumulate stale verification entries for the lifetime of the runtime.
  const pathPrefix = `${filePath}\0`;
  for (const key of signatureVerificationCache.keys()) {
    if (key !== cacheKey && key.startsWith(pathPrefix)) {
      signatureVerificationCache.delete(key);
    }
  }

  const pending = (async (): Promise<boolean> => {
    const [verification, identity] = await Promise.all([
      executeCodesign(["--verify", "--strict", "--verbose=2", filePath]),
      executeCodesign(["-dv", "--verbose=4", filePath]),
    ]);
    const details = `${identity.stdout}\n${identity.stderr}`;
    return verification.ok
      && identity.ok
      && details.includes(`Identifier=${COMPUTER_USE_CLIENT_IDENTIFIER}`)
      && details.includes(`TeamIdentifier=${OPENAI_TEAM_IDENTIFIER}`);
  })().catch(() => false);
  signatureVerificationCache.set(cacheKey, pending);
  return await pending;
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

export async function resolveCodexComputerUseMcpConfig(
  options: ResolveCodexComputerUseOptions = {},
): Promise<CodexComputerUseMcpConfig | null> {
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
  for (const command of codexComputerUseClientCandidates(codexHome)) {
    if (!isExecutable(command)) continue;
    if (await verifySignature(command)) {
      return { command, args: ["mcp"], enabled: true };
    }
  }
  return null;
}
