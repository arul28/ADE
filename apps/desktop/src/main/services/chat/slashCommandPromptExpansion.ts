import type { AgentChatProvider } from "../../../shared/types";
import { resolveClaudeSlashCommandInvocation } from "./claudeSlashCommandDiscovery";
import { resolveCodexSlashCommandInvocation } from "./codexSlashCommandDiscovery";
import { resolveCursorSlashCommandInvocation } from "./cursorSlashCommandDiscovery";

export type SlashCommandExpansionContext = {
  provider: AgentChatProvider;
  cwd: string;
  trimmedInput: string;
  slashCommand: string | null;
  claudeBuiltInNames: ReadonlySet<string>;
  codexBuiltInNames: ReadonlySet<string>;
  claudeRuntimeSlashCommandNames: ReadonlySet<string>;
  codexRuntimeSlashCommandNames: ReadonlySet<string>;
};

export function resolveProviderSlashCommandPrompt(
  context: SlashCommandExpansionContext,
): string | null {
  if (context.slashCommand == null) return null;

  switch (context.provider) {
    case "claude": {
      if (
        context.claudeBuiltInNames.has(context.slashCommand)
        || context.claudeRuntimeSlashCommandNames.has(context.slashCommand)
      ) {
        return null;
      }
      return resolveClaudeSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText ?? null;
    }
    case "codex": {
      if (
        context.codexBuiltInNames.has(context.slashCommand)
        || context.codexRuntimeSlashCommandNames.has(context.slashCommand)
      ) {
        return null;
      }
      const claudeProjectPrompt = resolveClaudeSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText;
      if (claudeProjectPrompt) return claudeProjectPrompt;
      return resolveCodexSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText ?? null;
    }
    case "cursor":
      return resolveCursorSlashCommandInvocation(context.cwd, context.trimmedInput)?.promptText ?? null;
    default:
      return null;
  }
}
