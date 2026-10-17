/**
 * Binary resolution for the four ACP provider CLIs.
 *
 * Same shape as `droidExecutable.ts`: an explicit environment override wins,
 * then a path the auth detector already proved exists, then PATH and the known
 * install directories, then the bare command as a last resort.
 *
 * Two provider-specific notes:
 *
 * - `qwen` is an npm bin, so on Windows it resolves to a `.cmd` shim.
 *   `resolveCliSpawnInvocation` in the ACP connection rewrites that into the
 *   form Node will spawn, so a shim is a usable answer here. `copilot` is an
 *   npm bin too, but the Copilot SDK spawns it with no shell, so its resolver
 *   follows the shim to the native `copilot.exe` (see below).
 * - `kimi` is a native binary and `grok` is a Rust binary, so
 *   `preferNativeExecutablePath` picks the real executable when a shim sits
 *   beside it.
 */

import fs from "node:fs";
import path from "node:path";
import type { DetectedAuth } from "./authDetector";
import { resolveExecutableCandidatesFromKnownLocations } from "./cliExecutableResolver";
import { preferNativeExecutablePath } from "../shared/processExecution";
import type { AcpChatProvider } from "../../../shared/types/chat";
type ResolvableCliProvider = AcpChatProvider | "copilot";

export type AcpExecutableResolution = {
  path: string;
  source: "env" | "auth" | "path" | "common-dir" | "fallback-command";
};

/** Environment overrides ADE honors, in order, per provider. */
const ACP_EXECUTABLE_ENV_KEYS: Record<ResolvableCliProvider, readonly string[]> = {
  qwen: ["QWEN_EXECUTABLE", "QWEN_CODE_EXECUTABLE"],
  kimi: ["KIMI_EXECUTABLE", "KIMI_CODE_EXECUTABLE"],
  grok: ["GROK_EXECUTABLE", "XAI_GROK_EXECUTABLE"],
  copilot: ["COPILOT_EXECUTABLE", "GITHUB_COPILOT_EXECUTABLE"],
  devin: ["DEVIN_EXECUTABLE", "DEVIN_CLI_EXECUTABLE"],
};

/** The command name each provider installs. */
const ACP_EXECUTABLE_COMMANDS: Record<ResolvableCliProvider, string> = {
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
  copilot: "copilot",
  devin: "devin",
};

function findAcpAuthPath(provider: ResolvableCliProvider, auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== provider) continue;
    const candidate = entry.path.trim();
    // The detector's last resort is the bare command name, which tells us
    // nothing the fallback below would not already say.
    if (candidate && candidate !== ACP_EXECUTABLE_COMMANDS[provider]) return candidate;
  }
  return null;
}

/** Resolve one ACP provider CLI. Never throws; always returns something spawnable. */
export function resolveAcpExecutable(
  provider: ResolvableCliProvider,
  args?: { auth?: DetectedAuth[]; env?: NodeJS.ProcessEnv },
): AcpExecutableResolution {
  const env = args?.env ?? process.env;
  const command = ACP_EXECUTABLE_COMMANDS[provider];

  for (const key of ACP_EXECUTABLE_ENV_KEYS[provider]) {
    const configured = env[key]?.trim();
    if (configured?.length) return { path: configured, source: "env" };
  }

  const authPath = findAcpAuthPath(provider, args?.auth);
  if (authPath) return { path: authPath, source: "auth" };

  const candidates = resolveExecutableCandidatesFromKnownLocations(command, env);
  const preferred = preferNativeExecutablePath(candidates.map((candidate) => candidate.path));
  const resolved = candidates.find((candidate) => candidate.path === preferred);
  if (resolved) {
    return { path: resolved.path, source: resolved.source === "path" ? "path" : "common-dir" };
  }

  return { path: command, source: "fallback-command" };
}

/** Resolves the Qwen Code CLI binary (`qwen`). */
export function resolveQwenExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("qwen", args);
}

/** Resolves the Kimi Code CLI binary (`kimi`). */
export function resolveKimiExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("kimi", args);
}

/** Resolves the xAI Grok CLI binary (`grok`). */
export function resolveGrokExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): AcpExecutableResolution {
  return resolveAcpExecutable("grok", args);
}

/** Resolves the GitHub Copilot CLI binary (`copilot`). */
export function resolveCopilotExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}): AcpExecutableResolution {
  const resolved = resolveAcpExecutable("copilot", args);
  const native = copilotNativeExecutableForShim(resolved.path, args?.platform ?? process.platform, args?.arch ?? process.arch);
  return native ? { ...resolved, path: native } : resolved;
}

/**
 * The real `copilot.exe` behind an npm shim on Windows.
 *
 * `npm i -g @github/copilot` writes `copilot.cmd`/`copilot.ps1` beside a
 * `node_modules` tree whose platform package (`@github/copilot-win32-<arch>`)
 * carries a native `copilot.exe`. The Copilot SDK spawns the CLI path with no
 * shell, and Node refuses to spawn a `.cmd` that way (CVE-2024-27980), so chats
 * need the `.exe`. npm may nest the platform package or hoist it.
 */
function copilotNativeExecutableForShim(shimPath: string, platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== "win32") return null;
  const ext = path.win32.extname(shimPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1" && ext !== "") return null;
  const shimDir = path.win32.dirname(shimPath);
  const platformPackage = path.win32.join("@github", `copilot-win32-${arch}`, "copilot.exe");
  const candidates = [
    path.win32.join(shimDir, "node_modules", "@github", "copilot", "node_modules", platformPackage),
    path.win32.join(shimDir, "node_modules", platformPackage),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) ?? null;
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
