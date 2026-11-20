/**
 * Which setup commands are macOS-only. A template's shared "macOS and Linux"
 * commands also run on Linux (an ADE Cloud computer is Linux), so a template
 * written on a Mac can quietly fall back to its slow path there. The lane
 * setup (`setupScriptConfig.ts`) and the template editor
 * (`LaneTemplatesSection.tsx`) read the same check, so both say the same.
 *
 * It also holds the one list of a setup script's platform fields, so the
 * config coercer, the "has work" check and the template editor loop over the
 * same fields instead of each naming all ten.
 */

import type { LaneSetupScriptConfig } from "./types/config";

export type LaneSetupPlatformKey = "shared" | "unix" | "macos" | "linux" | "windows";
export type LaneSetupCommandsKey = "commands" | "unixCommands" | "macosCommands" | "linuxCommands" | "windowsCommands";
export type LaneSetupScriptPathKey = "scriptPath" | "unixScriptPath" | "macosScriptPath" | "linuxScriptPath" | "windowsScriptPath";

export type LaneSetupPlatformField = {
  key: LaneSetupPlatformKey;
  /** Short name for summaries ("macOS: …"); null for the shared any-OS fields. */
  label: string | null;
  commandsKey: LaneSetupCommandsKey;
  scriptKey: LaneSetupScriptPathKey;
};

/** Every platform's pair of setup fields, most general first (the stored key order). */
export const LANE_SETUP_PLATFORM_FIELDS: readonly LaneSetupPlatformField[] = [
  { key: "shared", label: null, commandsKey: "commands", scriptKey: "scriptPath" },
  { key: "unix", label: "macOS/Linux", commandsKey: "unixCommands", scriptKey: "unixScriptPath" },
  { key: "macos", label: "macOS", commandsKey: "macosCommands", scriptKey: "macosScriptPath" },
  { key: "linux", label: "Linux", commandsKey: "linuxCommands", scriptKey: "linuxScriptPath" },
  { key: "windows", label: "Windows", commandsKey: "windowsCommands", scriptKey: "windowsScriptPath" },
];

/**
 * Tools that exist only on macOS; a shared macOS/Linux command using one is a
 * macOS command. Not Homebrew paths: a PATH line naming them is harmless on Linux.
 */
const MACOS_ONLY_TOOL = /(^|[\s;&|(`$"'])(cp\s+-[a-zA-Z]*c[a-zA-Z]*\b|clonefile\b|xcode-select\b|xcrun\b|ditto\b|defaults\s+(read|write)\b|launchctl\b|pbcopy\b|pbpaste\b)/;

/** The first macOS-only tool a command list calls, or null. */
export function macosOnlyToolIn(commands: readonly string[]): string | null {
  for (const command of commands) {
    const match = MACOS_ONLY_TOOL.exec(command);
    if (match) return match[2]!.trim();
  }
  return null;
}

/**
 * The macOS-only tool the commands Linux would run call, or null. Linux runs
 * its own commands, then the shared macOS/Linux ones, then the any-OS ones;
 * once Linux has its own commands nothing macOS-only reaches it.
 */
export function macosOnlyToolOnLinux(cfg: LaneSetupScriptConfig): string | null {
  if (cfg.linuxCommands?.length) return null;
  const commands = cfg.linuxCommands ?? cfg.unixCommands ?? cfg.commands ?? [];
  return macosOnlyToolIn(commands.map((command) => command.trim()).filter((command) => command.length > 0));
}
