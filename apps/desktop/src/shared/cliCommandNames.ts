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

const CLI_NAME_PREFIX = new RegExp(`^${ADE_CLI_NAME_SOURCE}\\s+`, "i");
// Whitespace or the end must follow the colon: `daex://…` is a link, not an error line.
// Case-sensitive: the CLI writes errors as `daex:`; its capitalized `DAEX: …` notes are not errors.
const CLI_ERROR_PREFIX = new RegExp(`^${ADE_CLI_NAME_SOURCE}:(?:\\s+|$)`);

/**
 * `text` without a leading CLI name: `daex 1.2.3` (or an older CLI's
 * `ade 1.2.3`) from `--version` reads `1.2.3`. Case-insensitive; any other
 * text is returned as is.
 */
export function stripCliNamePrefix(text: string): string {
  return text.replace(CLI_NAME_PREFIX, "");
}

/**
 * The message on one of the CLI's error lines, `daex: <message>` (older CLIs
 * write `ade: <message>`), or null when the line has no such prefix.
 * Case-sensitive, like the iOS mirror.
 */
export function cliErrorLineText(line: string): string | null {
  const match = CLI_ERROR_PREFIX.exec(line);
  return match ? line.slice(match[0].length) : null;
}

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
