import type { AgentChatProvider } from "../../../shared/types";
import { resolveClaudeSlashCommandInvocation } from "./claudeSlashCommandDiscovery";
import { resolveCodexSlashCommandInvocation } from "./codexSlashCommandDiscovery";
import { resolveCursorSlashCommandInvocation } from "./cursorSlashCommandDiscovery";

export type SlashCommandExpansionContext = {
  provider: AgentChatProvider;
  cwd: string;
  trimmedInput: string;
  slashCommand: string | null;
  /**
   * Slash-command keys (`/name`, lower case) the chat's own harness runs: its
   * built-ins plus whatever its live runtime advertised. ADE leaves these
   * alone so the harness can run them; every other name is ADE's to expand.
   */
  harnessCommandNames: ReadonlySet<string>;
  /**
   * The chat's environment, carrying its provider-account `CODEX_HOME`. Absent
   * means the process environment, which is the machine's default account.
   */
  env?: NodeJS.ProcessEnv;
};

/**
 * The prompt ADE sends in place of a leading `/<name> <args>`, or null when
 * ADE has no file for that name.
 *
 * ADE's project commands and skills (`.claude/commands`, `.claude/skills`,
 * `.agents/skills`, `.ade/skills`, user and bundled skill roots) are expanded
 * the same way for every provider. A harness that does not know them would
 * otherwise get the literal `/ship` — OpenCode answers that with "Command not
 * found" and fails the turn. Codex prompt files and Cursor command files are
 * the two harness-specific roots ADE also expands.
 */
export function resolveProviderSlashCommandPrompt(
  context: SlashCommandExpansionContext,
): string | null {
  if (context.slashCommand == null) return null;
  if (context.harnessCommandNames.has(context.slashCommand)) return null;

  const adePrompt = (): string | null =>
    resolveClaudeSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText ?? null;

  switch (context.provider) {
    case "codex":
      return adePrompt()
        ?? resolveCodexSlashCommandInvocation(context.cwd, context.trimmedInput, context.env)?.promptText
        ?? null;
    case "cursor":
      return resolveCursorSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText
        ?? adePrompt();
    default:
      return adePrompt();
  }
}
