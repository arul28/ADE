/** Normalize a slash-command name to `/lowercase`. */
export function claudeSlashCommandKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.length) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Claude Code commands that only make sense in a real terminal (exit the
 * process, paint a TUI statusline). Agent chat surfaces — Work, automation,
 * personal, desktop, iOS, TUI — must never list them.
 */
export const CLAUDE_TERMINAL_ONLY_SLASH_COMMANDS = ["/exit", "/quit", "/statusline"] as const;

export function collectClaudeTerminalSlashCommandNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const key = claudeSlashCommandKey(entry);
      if (key) names.push(key);
      continue;
    }
    if (entry && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") {
        const key = claudeSlashCommandKey(name);
        if (key) names.push(key);
      }
    }
  }
  return names;
}

export function isClaudeTerminalOnlySlashCommand(
  name: string,
  extra: Iterable<string> = [],
): boolean {
  const key = claudeSlashCommandKey(name);
  if (!key) return false;
  if ((CLAUDE_TERMINAL_ONLY_SLASH_COMMANDS as readonly string[]).includes(key)) return true;
  for (const extraName of extra) {
    if (claudeSlashCommandKey(extraName) === key) return true;
  }
  return false;
}

export function filterClaudeGuiSlashCommands<T extends { name: string }>(
  commands: readonly T[],
  extra: Iterable<string> = [],
): T[] {
  return commands.filter((command) => !isClaudeTerminalOnlySlashCommand(command.name, extra));
}
