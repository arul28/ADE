/**
 * Which setup commands are macOS-only. A template's shared "macOS and Linux"
 * commands also run on Linux (an ADE Cloud computer is Linux), so a template
 * written on a Mac can quietly fall back to its slow path there. The lane
 * setup (`setupScriptConfig.ts`) and the template editor
 * (`LaneTemplatesSection.tsx`) read the same check, so both say the same.
 */

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
