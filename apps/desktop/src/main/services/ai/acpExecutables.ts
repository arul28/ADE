/**
 * Binary resolution for the ACP provider CLIs and the Copilot runtime.
 *
 * ADE runs only its own pinned copy of each one, from the tools cache
 * (`~/.ade/tools`): an explicit environment override (a developer/test hook,
 * never shown in the UI), the current pin, then the previous pin while a new
 * one downloads. Never a CLI the user installed: no PATH walk, no install
 * directories. A miss is `fallback-command` with an empty path; the caller
 * starts the download (`pinnedToolDownload`) and reports why, and must not
 * spawn anything.
 *
 * Qwen's pin is a standalone bundle with its own Node, so its entry is that
 * Node and `args` carries the script it runs (`<node> <cli-entry.js> --acp`):
 * no cmd shim on Windows, no Electron-as-Node.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DetectedAuth } from "./authDetector";
import { cachedToolEntryPath, previousCachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { resolveCurrentPinnedTool, resolvePreviousPinnedTool } from "../../../../../ade-cli/src/services/tools/pinnedTool";
import type { ToolResolution } from "../../../../../ade-cli/src/services/tools/install";
import { isExecutableFile, resolveExecutableCandidatesFromKnownLocations } from "./cliExecutableResolver";
import type { AcpChatProvider } from "../../../shared/types/chat";
type ResolvableCliProvider = AcpChatProvider | "copilot";

/**
 * `auth`, `path` and `common-dir` are no longer produced; they stay in the
 * union for callers that name them.
 */
export type AcpExecutableResolution = {
  path: string;
  source: "env" | "tools-cache" | "auth" | "path" | "common-dir" | "fallback-command";
  /** Leading arguments the entry needs before the provider's own (Qwen's script). */
  args?: string[];
  /** The pin's named files (`harness`, `script`), absolute, when it came from the cache. */
  files?: Record<string, string>;
};

/** Where the Copilot SDK runtime came from; `tools-cache` is ADE's pinned download. */
export type CopilotSdkRuntimeResolution = {
  path: string;
  source: AcpExecutableResolution["source"] | "bundled";
};

/** Environment overrides ADE honors, in order, per provider. Developer/test hooks only. */
const ACP_EXECUTABLE_ENV_KEYS: Record<ResolvableCliProvider, readonly string[]> = {
  qwen: ["QWEN_EXECUTABLE", "QWEN_CODE_EXECUTABLE"],
  kimi: ["KIMI_EXECUTABLE", "KIMI_CODE_EXECUTABLE"],
  grok: ["GROK_EXECUTABLE", "XAI_GROK_EXECUTABLE"],
  copilot: ["COPILOT_EXECUTABLE", "GITHUB_COPILOT_EXECUTABLE"],
  devin: ["DEVIN_EXECUTABLE", "DEVIN_CLI_EXECUTABLE"],
  // The harness travels beside the server; an override names the server and
  // the dialect finds `localharness_external` next to it.
  antigravity: ["ANTIGRAVITY_ACP_EXECUTABLE", "AGY_ACP_SERVER_EXECUTABLE"],
};

/** The tools-cache name of each provider's pinned CLI (Copilot's terminal CLI; chats use the runtime). */
const ACP_EXECUTABLE_TOOLS: Record<ResolvableCliProvider, string> = {
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
  copilot: "copilot-cli",
  devin: "devin",
  antigravity: "antigravity",
};

function envOverride(provider: ResolvableCliProvider, env: NodeJS.ProcessEnv): string | null {
  for (const key of ACP_EXECUTABLE_ENV_KEYS[provider]) {
    const configured = env[key]?.trim();
    if (configured?.length) return configured;
  }
  return null;
}

type CacheContext = { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string };

function fromPin(resolution: ToolResolution | null, platform: NodeJS.Platform): AcpExecutableResolution | null {
  if (!resolution || !isExecutableFile(resolution.entryPath, platform)) return null;
  const script = resolution.files.script;
  return {
    path: resolution.entryPath,
    source: "tools-cache",
    ...(script ? { args: [script] } : {}),
    ...(Object.keys(resolution.files).length ? { files: resolution.files } : {}),
  };
}

/** ADE's pinned copy of `tool`: the current pin, else the previous one. */
function resolvePinnedExecutable(tool: string, context: CacheContext): AcpExecutableResolution | null {
  const platform = context.platform ?? process.platform;
  return fromPin(resolveCurrentPinnedTool(tool, context), platform)
    ?? fromPin(resolvePreviousPinnedTool(tool, context), platform);
}

/** Resolve one ACP provider CLI. Never throws, never searches the PATH. */
export function resolveAcpExecutable(
  provider: ResolvableCliProvider,
  args?: { auth?: DetectedAuth[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string },
): AcpExecutableResolution {
  const env = args?.env ?? process.env;
  const override = envOverride(provider, env);
  if (override) return { path: override, source: "env" };
  return resolvePinnedExecutable(ACP_EXECUTABLE_TOOLS[provider], { env, platform: args?.platform, arch: args?.arch })
    ?? { path: "", source: "fallback-command" };
}

/** Resolves ADE's Qwen Code (its bundled Node plus `args`). */
export function resolveQwenExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("qwen", args);
}

/** Resolves ADE's Kimi Code CLI. */
export function resolveKimiExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("kimi", args);
}

/** Resolves ADE's xAI Grok CLI. */
export function resolveGrokExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("grok", args);
}

/**
 * Resolves ADE's Antigravity ACP server (`agy_acp_server`). Its `files.harness`
 * is the `localharness_external` the server runs; the dialect exports it as
 * `ANTIGRAVITY_HARNESS_PATH`.
 */
export function resolveAntigravityExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("antigravity", args);
}

/** Resolves ADE's GitHub Copilot terminal CLI (`copilot-cli` pin). Chats use {@link resolveCopilotSdkRuntime}. */
export function resolveCopilotExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}): AcpExecutableResolution {
  return resolveAcpExecutable("copilot", args);
}

/**
 * The runtime Copilot chats run on, in the same order as Claude's binary: the
 * dev/test override, ADE's pinned download, the SDK's own platform package (a
 * source checkout, or an older build that shipped it), then the previous
 * pinned version while a new one downloads. Never the user's `copilot`.
 *
 * ADE's runtimes are the version the SDK was built against, so they speak its
 * protocol. They are headless only: they reuse the login the machine already
 * has (`copilot login`, `gh auth login`, or a token in the environment).
 */
export function resolveCopilotSdkRuntime(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string | null;
}): CopilotSdkRuntimeResolution {
  const env = args?.env ?? process.env;
  const override = envOverride("copilot", env);
  if (override) return { path: override, source: "env" };
  const platform = args?.platform ?? process.platform;
  const cacheContext = { env, platform: args?.platform, arch: args?.arch };
  const cached = cachedToolEntryPath("copilot", cacheContext);
  if (cached && isCopilotRuntime(cached, platform)) return { path: cached, source: "tools-cache" };
  const bundled = bundledCopilotSdkRuntime(args);
  if (bundled) return { path: bundled, source: "bundled" };
  const previous = previousCachedToolEntryPath("copilot", cacheContext);
  if (previous && isCopilotRuntime(previous, platform)) return { path: previous, source: "tools-cache" };
  return { path: "", source: "fallback-command" };
}

/** The runtime wrapper only starts with its `runtime.node` beside it. */
function isCopilotRuntime(candidate: string, platform: NodeJS.Platform): boolean {
  return isExecutableFile(candidate, platform) && fs.existsSync(path.join(path.dirname(candidate), "runtime.node"));
}

/** The SDK's platform package names for this host, as `@github/copilot-sdk` picks them. */
function copilotSdkRuntimePlatforms(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === "darwin" || platform === "win32") return [`${platform}-${arch}`];
  if (platform === "linux") return [`linux-${arch}`, `linuxmusl-${arch}`];
  return [];
}

function bundledCopilotSdkRuntime(args?: {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string | null;
}): string | null {
  const platform = args?.platform ?? process.platform;
  const arch = args?.arch ?? process.arch;
  const wrapper = platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
  const resourcesPath = args?.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null;
  // ESM (`tsx` from source) has no `__filename`; the script it runs is ADE's own.
  const script = process.argv[1];
  const fromFile = typeof __filename === "string" ? __filename : script && path.isAbsolute(script) ? script : null;
  for (const runtimePlatform of copilotSdkRuntimePlatforms(platform, arch)) {
    const packageName = `copilot-sdk-${runtimePlatform}`;
    const roots: string[] = [];
    if (resourcesPath) {
      for (const unpacked of ["app.asar.unpacked", `app-${arch}.asar.unpacked`]) {
        roots.push(path.join(resourcesPath, unpacked, "node_modules", "@github", packageName));
      }
    }
    // ADE's own install; `require.resolve` also searches the brain's NODE_PATH,
    // which points at the packaged app's unpacked node_modules.
    if (fromFile) {
      try {
        const packageJson = createRequire(fromFile).resolve(`@github/${packageName}/package.json`);
        // A copy inside an asar cannot be spawned; its unpacked twin can.
        roots.push(path.dirname(packageJson).replace(/([\\/]app(?:-[a-z0-9]+)?\.asar)(?=[\\/])/, "$1.unpacked"));
      } catch {
        // Not installed for this platform.
      }
    }
    for (const root of roots) {
      const candidate = path.join(root, "prebuilds", runtimePlatform, wrapper);
      if (isCopilotRuntime(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * Kimi's native binary uses Git Bash as its shell on Windows, so it cannot run
 * without Git for Windows installed. The check is win32-only; every other
 * platform returns `ok`.
 *
 * Returning a reason rather than throwing keeps the message in one place: the
 * chat runtime turns it into one visible error, and the tracked-CLI launcher
 * turns it into a launch failure, from the same text.
 */
export function checkKimiWindowsPrerequisites(args?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam. Reports whether a candidate path exists on disk. */
  exists?: (candidate: string) => boolean;
}): { ok: true } | { ok: false; message: string } {
  const platform = args?.platform ?? process.platform;
  if (platform !== "win32") return { ok: true };
  const env = args?.env ?? process.env;
  const exists = args?.exists ?? ((candidate: string) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  const roots = [
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : undefined,
  ].filter((root): root is string => Boolean(root?.trim().length));

  const candidates = roots.map((root) => `${root}\\Git\\bin\\bash.exe`);
  if (candidates.some(exists)) return { ok: true };

  // A Git Bash already on PATH is just as good, and it is how a scoop or
  // chocolatey install usually presents itself.
  const pathCandidates = resolveExecutableCandidatesFromKnownLocations("bash", env);
  if (pathCandidates.some((candidate) => candidate.path.toLowerCase().includes("git"))) {
    return { ok: true };
  }

  return {
    ok: false,
    message:
      "Kimi needs Git for Windows: Git Bash is the shell its binary runs commands through. "
      + "Install Git for Windows from https://git-scm.com/download/win, then try again.",
  };
}
