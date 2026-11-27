/**
 * The names the CLI answers to at command position: `daex` (the primary
 * command) and `ade` (a permanent alias; transcripts, old skills and saved
 * prompts use it). Code that recognizes the CLI in a command line, a tool
 * call, a process list or terminal output accepts both, the same way.
 *
 * No imports: the main process, the renderer and the CLI import this file.
 */

export const ADE_CLI_COMMAND_NAMES = ["daex", "ade"] as const;

export type AdeCliCommandName = (typeof ADE_CLI_COMMAND_NAMES)[number];

/**
 * Regex source for either name, with no anchors, boundaries or flags:
 * `(?:daex|ade)`. Build recognizers with `new RegExp(...)` around it.
 */
export const ADE_CLI_NAME_SOURCE = `(?:${ADE_CLI_COMMAND_NAMES.join("|")})`;

const WINDOWS_LAUNCHER_SUFFIX = /\.(?:exe|cmd|ps1)$/;

/**
 * True when `word` names the CLI: a bare name or a path to it, with an
 * optional Windows launcher suffix. `ade`, `daex`, `/usr/local/bin/daex`,
 * `C:\tools\ade.exe`, `daex.cmd`. Case-insensitive.
 */
export function isAdeCliCommandWord(word: string): boolean {
  const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase();
  return (ADE_CLI_COMMAND_NAMES as readonly string[]).includes(name.replace(WINDOWS_LAUNCHER_SUFFIX, ""));
}
