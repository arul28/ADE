import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { listPinnedTools, tryResolvePreviousTool, tryResolveTool, type ToolsContext } from "../../../../../ade-cli/src/services/tools/install";
import { pinnedToolDownload, pinnedToolFetchInFlight, pinnedToolNeedsFetch } from "../../../../../ade-cli/src/services/tools/onDemand";
import { ENV_KEY_MAP } from "../ai/authDetector";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { resolveMuseConfigDir } from "../ai/museAuth";
import {
  claudeConfigHome,
  codexConfigHome,
  COPILOT_TOKEN_ENV_KEYS,
  copilotConfigHome,
  devinCredentialFiles,
  factoryConfigHome,
  ghHostsFiles,
  grokConfigHome,
  kimiCodeConfigHome,
  openCodeDataDirs,
  qwenConfigHome,
} from "../shared/providerConfigHomes";

/**
 * Which pinned agent tools this machine downloads on its own, at desktop launch
 * and `ade serve`.
 *
 * A tool is fetched when it is already in the cache (so an ADE update keeps it
 * current) or the machine shows signs of using its provider: the provider's own
 * CLI, its login files, or its tokens. Everything else waits until something
 * needs it: a chat, a one-shot task, or a status refresh that finds the
 * provider signed in (`pinnedToolDownload`, `startDemandedAgentToolFetches`). A machine
 * that only uses Claude no longer downloads Codex, OpenCode, Copilot and Muse.
 *
 * Cheap on purpose: file and env checks and a PATH walk, never a spawn, so it
 * can run at startup. The user's own CLI on the PATH only counts as a sign of
 * use (ADE never runs it). A tool this file has no rule for is never fetched
 * at launch: it downloads the first time something needs it.
 */

type DemandArgs = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Tools-cache context, e.g. `toolsRoot` in a test. */
  tools?: ToolsContext;
};

export type AgentToolDemand = { fetch: string[]; skip: string[] };

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
    // The terminal CLI follows the same account as the SDK runtime.
    case "copilot":
    case "copilot-cli":
      return onPath("copilot", env)
        || hasEnv(env, COPILOT_TOKEN_ENV_KEYS)
        || exists(path.join(copilotConfigHome(homeArgs), "config.json"))
        || ghHostsFiles({ env, homeDir: home, platform }).some(exists);
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
    case "droid":
      // Factory keeps no credential file ADE can read (authDetector.ts), so a
      // Factory home of any kind is the sign.
      return onPath("droid", env) || hasEnv(env, ["FACTORY_API_KEY"]) || exists(factoryConfigHome(homeArgs));
    case "grok":
      return onPath("grok", env) || hasEnv(env, ["XAI_API_KEY"]) || exists(path.join(grokConfigHome(homeArgs), "auth.json"));
    case "qwen": {
      const qwenHome = qwenConfigHome(homeArgs);
      return onPath("qwen", env)
        || hasEnv(env, ["QWEN_API_KEY", "DASHSCOPE_API_KEY"])
        || ["oauth_creds.json", ".env", "settings.json"].some((file) => exists(path.join(qwenHome, file)));
    }
    case "kimi": {
      const kimiHome = kimiCodeConfigHome(homeArgs);
      return onPath("kimi", env) || exists(path.join(kimiHome, "config.toml")) || exists(path.join(kimiHome, "credentials"));
    }
    case "devin":
      return onPath("devin", env) || hasEnv(env, ["WINDSURF_API_KEY"]) || devinCredentialFiles({ ...homeArgs, platform }).some(exists);
    case "antigravity": {
      // The agy CLI and the ACP server keep their state under GEMINI_HOME. A
      // bare GEMINI_API_KEY is not a sign: plenty of tools read it.
      const geminiHome = env.GEMINI_HOME?.trim() ? path.resolve(env.GEMINI_HOME.trim()) : path.join(home, ".gemini");
      return onPath("agy", env)
        || exists(path.join(geminiHome, "antigravity-acp"))
        || exists(path.join(geminiHome, "antigravity-cli"));
    }
    case "cursor-cli": {
      // cli-config.json lives under CURSOR_CONFIG_DIR (default ~/.cursor); the
      // login is auth.json in Cursor's per-platform config dir.
      const configDir = env.CURSOR_CONFIG_DIR?.trim() ? path.resolve(env.CURSOR_CONFIG_DIR.trim()) : path.join(home, ".cursor");
      return onPath("cursor-agent", env)
        || hasEnv(env, ["CURSOR_API_KEY"])
        || exists(path.join(configDir, "cli-config.json"))
        || exists(cursorAuthFile(env, home, platform));
    }
    // Node is only ADE's runtime for Pi's terminal CLI, so it follows Pi.
    case "pi":
    case "node": {
      const agentDir = env.PI_CODING_AGENT_DIR?.trim() ? path.resolve(env.PI_CODING_AGENT_DIR.trim()) : path.join(home, ".pi", "agent");
      return onPath("pi", env) || exists(path.join(agentDir, "auth.json"));
    }
    default:
      return null;
  }
}

/** Where Cursor's CLI keeps its login (`getAuthFilePath` in the shipped CLI). */
function cursorAuthFile(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  if (platform === "darwin") return path.join(home, ".cursor", "auth.json");
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "cursor", "auth.json");
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
    const wanted = inCache(tool, context) || (providerSignals(tool, env, home, platform) ?? false);
    (wanted ? fetch : skip).push(tool);
  }
  return { fetch, skip };
}

/** The Settings provider whose switch governs a pinned tool. */
const TOOL_PROVIDER: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  "copilot-cli": "copilot",
  "cursor-cli": "cursor",
  node: "pi",
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
}): string[] {
  const missing = listPinnedTools()
    .filter((tool) => !pinnedToolFetchInFlight(tool) && pinnedToolNeedsFetch(tool))
    .filter((tool) => args.enabled(TOOL_PROVIDER[tool] ?? tool));
  if (!missing.length) return [];
  const demanded = new Set(selectDemandedAgentTools(missing).fetch);
  if (args.opencodeBacked) demanded.add("opencode");
  const started: string[] = [];
  for (const tool of missing) {
    if (!demanded.has(tool)) continue;
    const download = pinnedToolDownload(tool);
    if (download) started.push(tool);
  }
  return started;
}
