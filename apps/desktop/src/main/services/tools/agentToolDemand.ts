import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { listPinnedTools, tryResolvePreviousTool, tryResolveTool, type ToolsContext } from "../../../../../ade-cli/src/services/tools/install";
import {
  pinnedToolFetchInFlight,
  pinnedToolNeedsFetch,
  startPinnedToolFetch,
} from "../../../../../ade-cli/src/services/tools/onDemand";
import { ENV_KEY_MAP } from "../ai/authDetector";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { resolveMuseConfigDir } from "../ai/museAuth";
import {
  claudeConfigHome,
  codexConfigHome,
  copilotConfigHome,
  openCodeDataDirs,
} from "../shared/providerConfigHomes";

/**
 * Which pinned agent tools this machine downloads on its own, at desktop launch
 * and `ade serve`.
 *
 * A tool is fetched when it is already in the cache (so an ADE update keeps it
 * current) or the machine shows signs of using its provider: the provider's own
 * CLI, its login files, or its tokens. Everything else waits until something
 * needs it: a chat, a one-shot task, or a status refresh that finds the
 * provider signed in (`ensurePinnedTool` / `startPinnedToolFetch`). A machine
 * that only uses Claude no longer downloads Codex, OpenCode, Copilot and Muse.
 *
 * Cheap on purpose: file and env checks and a PATH walk, never a spawn, so it
 * can run at startup. A tool this file does not know is always fetched, the old
 * behavior, so a newly pinned tool is never stranded by a missing signal.
 */

type DemandArgs = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Tools-cache context, e.g. `toolsRoot` in a test. */
  tools?: ToolsContext;
};

export type AgentToolDemand = { fetch: string[]; skip: string[] };

const COPILOT_TOKEN_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

function hasEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()));
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return resolveExecutableFromKnownLocations(command, env) != null;
  } catch {
    return false;
  }
}

/** gh's `hosts.yml`, where `gh auth login` stores the account Copilot reuses. */
function ghHostsFiles(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const configured = env.GH_CONFIG_DIR?.trim();
  if (configured) return [path.join(configured, "hosts.yml")];
  const files: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) files.push(path.join(xdg, "gh", "hosts.yml"));
  files.push(path.join(home, ".config", "gh", "hosts.yml"));
  if (platform === "win32") {
    files.push(path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "GitHub CLI", "hosts.yml"));
  }
  return files;
}

/** Signs that this machine uses the provider behind a pinned tool, or null for a tool with no rule. */
function providerSignals(tool: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): boolean | null {
  const homeArgs = { env, homeDir: home };
  switch (tool) {
    case "claude-code":
      return onPath("claude", env)
        || hasEnv(env, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
        || exists(path.join(claudeConfigHome(homeArgs), ".credentials.json"))
        || exists(path.join(home, ".claude.json"));
    case "codex":
      return onPath("codex", env) || exists(path.join(codexConfigHome(homeArgs), "auth.json"));
    case "copilot":
      return onPath("copilot", env)
        || hasEnv(env, COPILOT_TOKEN_ENV)
        || exists(path.join(copilotConfigHome(homeArgs), "config.json"))
        || ghHostsFiles(env, home, platform).some(exists);
    case "opencode":
      // OpenCode is also the engine for API-key, OpenRouter and local models.
      // Keys saved in ADE's own store are caught by the status refresh instead.
      return onPath("opencode", env)
        || hasEnv(env, [...Object.keys(ENV_KEY_MAP), "OPENROUTER_API_KEY"])
        || openCodeDataDirs({ ...homeArgs, platform }).some((dir) => exists(path.join(dir, "auth.json")))
        || onPath("ollama", env)
        || onPath("lms", env)
        || exists(path.join(home, ".ollama"))
        || exists(path.join(home, ".lmstudio"));
    case "muse":
      return onPath("muse", env) || exists(path.join(resolveMuseConfigDir({ ...env, HOME: home }), "auth.json"));
    default:
      return null;
  }
}

function inCache(tool: string, context: ToolsContext): boolean {
  try {
    return tryResolveTool(tool, context) != null || tryResolvePreviousTool(tool, context) != null;
  } catch {
    // No pin for this host, or a malformed manifest: ensure reports it per tool.
    return false;
  }
}

export function selectDemandedAgentTools(pinned: readonly string[], args: DemandArgs = {}): AgentToolDemand {
  const env = args.env ?? process.env;
  const home = args.homeDir ?? (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
  const platform = args.platform ?? process.platform;
  const context: ToolsContext = { env, platform, ...args.tools };
  const fetch: string[] = [];
  const skip: string[] = [];
  for (const tool of pinned) {
    const wanted = inCache(tool, context) || (providerSignals(tool, env, home, platform) ?? true);
    (wanted ? fetch : skip).push(tool);
  }
  return { fetch, skip };
}

/** The Settings provider whose switch governs a pinned tool. */
const TOOL_PROVIDER: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  muse: "muse",
  opencode: "opencode",
};

/**
 * Start downloading the pinned tools a status refresh finds this machine using
 * but missing: the launch fetch saw no sign of them, and since then the user
 * signed in (`gh auth login`, `claude` login) or saved an API key in ADE.
 * Without this a signed-in provider would read "not detected" until a chat
 * forced the download, and a provider with no models offers no chat to start.
 *
 * `opencodeBacked` is the status refresh's own verdict that API-key, OpenRouter
 * or local models are set up, which covers keys kept in ADE's store. A provider
 * switched off in Settings never downloads. Returns the tools it started.
 */
export function startDemandedAgentToolFetches(args: {
  enabled: (provider: string) => boolean;
  opencodeBacked: boolean;
  env?: NodeJS.ProcessEnv;
  listPinned?: () => string[];
}): string[] {
  const env = args.env ?? process.env;
  const missing = (args.listPinned ?? (() => listPinnedTools({ env })))()
    .filter((tool) => !pinnedToolFetchInFlight(tool) && pinnedToolNeedsFetch(tool, { env }))
    .filter((tool) => args.enabled(TOOL_PROVIDER[tool] ?? tool));
  if (!missing.length) return [];
  const demanded = new Set(selectDemandedAgentTools(missing, { env }).fetch);
  if (args.opencodeBacked) demanded.add("opencode");
  return missing.filter((tool) => demanded.has(tool) && startPinnedToolFetch(tool, { env }));
}
