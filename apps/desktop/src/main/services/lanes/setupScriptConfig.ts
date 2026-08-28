import path from "node:path";

import type { LaneSetupScriptConfig } from "../../../shared/types";
import { laneSetupScriptHasWork } from "../../../shared/types";

export type ResolvedSetupScript = {
  commands: string[];
  scriptPath?: string;
  injectPrimaryPath: boolean;
};

/**
 * Pick the platform-appropriate setup commands / script path out of a setup
 * script config. Returns null when nothing is configured for this platform, so
 * callers can skip the step entirely instead of emitting an empty one.
 *
 * A leaf module rather than part of `laneTemplateService`: the executor
 * (`laneEnvironmentService`) must resolve exactly the way the template UI
 * promises, and it has no business importing template CRUD to do so.
 */
export function resolveSetupScriptConfig(
  cfg: LaneSetupScriptConfig | undefined,
  platform: NodeJS.Platform = process.platform,
): ResolvedSetupScript | null {
  if (!laneSetupScriptHasWork(cfg)) return null;

  const isWindows = platform === "win32";

  // Platform-specific commands take precedence
  const commands = (isWindows
    ? (cfg.windowsCommands ?? cfg.commands ?? [])
    : (cfg.unixCommands ?? cfg.commands ?? [])
  )
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

  const scriptPath = (isWindows
    ? (cfg.windowsScriptPath ?? cfg.scriptPath)
    : (cfg.unixScriptPath ?? cfg.scriptPath)
  )?.trim();

  if (commands.length === 0 && !scriptPath) return null;

  return {
    commands,
    ...(scriptPath ? { scriptPath } : {}),
    injectPrimaryPath: cfg.injectPrimaryPath ?? false,
  };
}

/** Extensions Windows can actually launch a script file with. */
const WINDOWS_RUNNABLE_SCRIPT_EXTENSIONS = new Set([".ps1", ".cmd", ".bat", ".exe", ".com"]);

/**
 * Reject a script file Windows cannot execute, with a message that says what to
 * do about it.
 *
 * On win32 a `scripts/setup.sh` (or an extension-less script) is not runnable:
 * there is no shebang handling, and `shouldUseWindowsCmdWrapper` hands an
 * extension-less path to `cmd.exe`, which fails with a raw `ENOEXEC` /
 * "not recognized" that reads as an ADE bug rather than a config mistake. The
 * fix the user needs is `windowsScriptPath` (or `windowsCommands`), so name it.
 *
 * Returns null when the path is fine — or on any non-Windows platform, where
 * the executable bit and shebang decide.
 */
export function unsupportedWindowsScriptPathError(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") return null;
  const ext = path.win32.extname(scriptPath).toLowerCase();
  if (WINDOWS_RUNNABLE_SCRIPT_EXTENSIONS.has(ext)) return null;
  return `Windows cannot run the setup script "${scriptPath}"${
    ext ? ` (${ext} files are not executable on Windows)` : " (no runnable file extension)"
  }. Set a Windows setup script (windowsScriptPath) or Windows commands for this template.`;
}
