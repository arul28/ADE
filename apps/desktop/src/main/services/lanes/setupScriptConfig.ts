import type { LaneSetupScriptConfig } from "../../../shared/types";

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
  if (!cfg) return null;

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
